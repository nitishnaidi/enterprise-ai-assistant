import type Anthropic from "@anthropic-ai/sdk";
import { getTool, toAnthropicTools } from "../tools/registry.js";
import type { ToolResult } from "../tools/types.js";
import { log } from "../utils/logger.js";

const MAX_ITERATIONS = 4;
const TOOL_TIMEOUT_MS = 5000;

// Not a business tool - this is how Claude talks to the user at all. Plain
// text output is never accepted (tool_choice: "any" below forbids it), so
// every reply, including a clarifying question or a write-confirmation
// prompt, has to come with a structured, self-reported sourcesUsed list. The
// backend still doesn't trust that list blindly - see the sanitization in
// index.ts - but it's far more precise than guessing from what was merely
// retrieved or callable.
const RESPOND_TOOL: Anthropic.Tool = {
  name: "respond",
  description:
    'Give your final answer to the user. This is the ONLY way to communicate with the user - never output plain text instead of calling this.',
  input_schema: {
    type: "object",
    properties: {
      reply: {
        type: "string",
        description: "The natural-language answer to show the user, in a normal conversational tone.",
      },
      sourcesUsed: {
        type: "array",
        items: { type: "string" },
        description:
          'Every source this reply materially depends on: Context document filenames (e.g. "returns-policy.txt") you actually used, and/or tool names (e.g. "getOrder") whose results you used. Do not list a document or tool that was available but that you did not end up relying on. Use an empty array if the reply does not depend on any specific document or tool result (e.g. a greeting or a clarifying question).',
      },
    },
    required: ["reply", "sourcesUsed"],
  },
};

export interface PendingAction {
  tool: string;
  args: unknown;
  summary: string;
}

export interface AgentLoopResult {
  finalText: string;
  sources: string[];
  iterations: number;
  pendingAction?: PendingAction;
}

interface RunAgentLoopOptions {
  anthropic: Anthropic;
  model: string;
  system: string;
  messages: Anthropic.MessageParam[];
}

function isToolUseBlock(block: Anthropic.ContentBlock): block is Anthropic.ToolUseBlock {
  return block.type === "tool_use";
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
// the response, and either execute a requested business tool and loop again,
// or - once Claude calls "respond" - return its structured final answer.
// Claude only ever *names* a tool and *proposes* arguments; this function is
// the only place those proposals turn into real execution, and it enforces
// the read/write trust boundary before that happens.
export async function runAgentLoop(options: RunAgentLoopOptions): Promise<AgentLoopResult> {
  const { anthropic, model, system } = options;
  const messages: Anthropic.MessageParam[] = [...options.messages];
  const tools = [...toAnthropicTools(), RESPOND_TOOL];
  const seenCalls = new Set<string>();
  let pendingAction: PendingAction | undefined;

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    log("iteration:start", { iteration });

    const response = await anthropic.messages.create({
      model,
      max_tokens: 1024,
      system,
      tools,
      tool_choice: { type: "any" },
      messages,
    });

    const toolUseBlocks = response.content.filter(isToolUseBlock);
    const respondBlock = toolUseBlocks.find((b) => b.name === RESPOND_TOOL.name);

    if (respondBlock) {
      const input = respondBlock.input as { reply?: unknown; sourcesUsed?: unknown };
      const reply = typeof input.reply === "string" ? input.reply : pendingAction?.summary ?? "";
      const sourcesUsed = Array.isArray(input.sourcesUsed)
        ? input.sourcesUsed.filter((s): s is string => typeof s === "string")
        : [];
      log("agent:respond", { iteration, sourcesUsed });
      return { finalText: reply, sources: sourcesUsed, iterations: iteration, pendingAction };
    }

    if (toolUseBlocks.length === 0) {
      // Shouldn't happen with tool_choice: "any", but fail closed rather than crash.
      log("agent:no_tool_use_returned", { iteration });
      return {
        finalText: "Sorry, I wasn't able to generate a response. Please try again.",
        sources: [],
        iterations: iteration,
        pendingAction,
      };
    }

    messages.push({ role: "assistant", content: response.content });

    const resultBlocks: Anthropic.ToolResultBlockParam[] = [];

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
            message: "This is a write operation. Do not call it again. Call respond to ask the user to explicitly confirm - do not call any more business tools this turn.",
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
  }

  log("iterations:max_reached", { maxIterations: MAX_ITERATIONS });
  return {
    finalText: "I wasn't able to finish handling this within the allowed number of steps. Could you simplify or rephrase your question?",
    sources: [],
    iterations: MAX_ITERATIONS,
    pendingAction,
  };
}
