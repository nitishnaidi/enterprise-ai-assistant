import type Anthropic from "@anthropic-ai/sdk";
import { getTool, toAnthropicTools } from "../tools/registry.js";
import type { ToolResult } from "../tools/types.js";
import { log } from "../utils/logger.js";

const MAX_ITERATIONS = 4;
const TOOL_TIMEOUT_MS = 5000;

export interface PendingAction {
  tool: string;
  args: unknown;
  summary: string;
}

export interface AgentLoopResult {
  finalText: string;
  iterations: number;
  pendingAction?: PendingAction;
}

interface RunAgentLoopOptions {
  anthropic: Anthropic;
  model: string;
  system: string;
  messages: Anthropic.MessageParam[];
}

function isTextBlock(block: Anthropic.ContentBlock): block is Anthropic.TextBlock {
  return block.type === "text";
}

function isToolUseBlock(block: Anthropic.ContentBlock): block is Anthropic.ToolUseBlock {
  return block.type === "tool_use";
}

function textOf(content: Anthropic.ContentBlock[]): string {
  return content.filter(isTextBlock).map((b) => b.text).join("");
}

function toolResultBlock(toolUseId: string, content: unknown, isError = false): Anthropic.ToolResultBlockParam {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: typeof content === "string" ? content : JSON.stringify(content),
    is_error: isError,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Tool timed out after ${ms}ms`)), ms)),
  ]);
}

function describePendingAction(name: string, args: any): string {
  if (name === "createSupportTicket") {
    const orderPart = args.orderId ? ` for order ${args.orderId}` : "";
    return `I can create a support ticket${orderPart} - reason: "${args.reason}", description: "${args.description}". Would you like me to proceed?`;
  }
  return `I'd like to run "${name}" with ${JSON.stringify(args)}. Would you like me to proceed?`;
}

// The manual agent loop: send messages + tool definitions to Claude, inspect
// the response, and either return text or execute a requested tool and loop
// again. Claude only ever *names* a tool and *proposes* arguments - this
// function is the only place those proposals turn into real execution, and
// it enforces the read/write trust boundary before that happens.
export async function runAgentLoop(options: RunAgentLoopOptions): Promise<AgentLoopResult> {
  const { anthropic, model, system } = options;
  const messages: Anthropic.MessageParam[] = [...options.messages];
  const tools = toAnthropicTools();
  const seenCalls = new Set<string>();

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    log("iteration:start", { iteration });

    const response = await anthropic.messages.create({
      model,
      max_tokens: 1024,
      system,
      tools,
      messages,
    });

    const toolUseBlocks = response.content.filter(isToolUseBlock);

    if (toolUseBlocks.length === 0) {
      const finalText = textOf(response.content);
      log("iteration:final_text", { iteration, length: finalText.length });
      return { finalText, iterations: iteration };
    }

    messages.push({ role: "assistant", content: response.content });

    const resultBlocks: Anthropic.ToolResultBlockParam[] = [];
    let pendingAction: PendingAction | undefined;

    for (const block of toolUseBlocks) {
      const callKey = `${block.name}:${JSON.stringify(block.input)}`;
      log("tool:requested", { name: block.name, args: block.input });

      const tool = getTool(block.name);
      if (!tool) {
        log("tool:unknown", { name: block.name });
        resultBlocks.push(toolResultBlock(block.id, `Unknown tool "${block.name}". It is not registered and cannot be called.`, true));
        continue;
      }

      const validation = tool.validate(block.input);
      if (!validation.valid) {
        log("tool:validation_failed", { name: block.name, error: validation.error });
        resultBlocks.push(toolResultBlock(block.id, `Invalid arguments: ${validation.error}`, true));
        continue;
      }

      if (seenCalls.has(callKey)) {
        log("tool:duplicate_call_blocked", { name: block.name, args: validation.value });
        resultBlocks.push(
          toolResultBlock(block.id, "This exact call was already made earlier in this turn. Reuse that result instead of calling again.", true)
        );
        continue;
      }
      seenCalls.add(callKey);

      // WRITE tools never execute inside the loop. The backend - not Claude -
      // decides that a real action requires a separate, explicit user
      // confirmation step (see POST /api/chat/confirm in index.ts) before the
      // handler is ever called.
      if (tool.operationType === "write") {
        pendingAction = { tool: tool.name, args: validation.value, summary: describePendingAction(tool.name, validation.value) };
        log("tool:write_awaiting_confirmation", { name: block.name, args: validation.value });
        resultBlocks.push(
          toolResultBlock(block.id, {
            status: "awaiting_confirmation",
            message: "This is a write operation. Do not call it again. Ask the user to explicitly confirm, then stop - do not call any more tools this turn.",
          })
        );
        continue;
      }

      let result: ToolResult;
      try {
        result = await withTimeout(tool.handler(validation.value), TOOL_TIMEOUT_MS);
      } catch (err) {
        log("tool:execution_failed", { name: block.name, error: err instanceof Error ? err.message : String(err) });
        result = { success: false, error: "The tool failed to execute. Please try again." };
      }

      log("tool:result", { name: block.name, success: result.success });
      resultBlocks.push(toolResultBlock(block.id, result, !result.success));
    }

    messages.push({ role: "user", content: resultBlocks });

    if (pendingAction) {
      // One more call so Claude can phrase the confirmation question in its
      // own words - but whatever it says, we never process further tool_use
      // blocks from this response, so it cannot execute the write tool here
      // even if it tries again.
      const followUp = await anthropic.messages.create({ model, max_tokens: 1024, system, tools, messages });
      const followUpText = textOf(followUp.content);
      return { finalText: followUpText || pendingAction.summary, iterations: iteration, pendingAction };
    }
  }

  log("iterations:max_reached", { maxIterations: MAX_ITERATIONS });
  return {
    finalText: "I wasn't able to finish handling this within the allowed number of steps. Could you simplify or rephrase your question?",
    iterations: MAX_ITERATIONS,
  };
}
