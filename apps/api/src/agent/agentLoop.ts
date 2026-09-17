import type Anthropic from "@anthropic-ai/sdk";
import { getTool, toAnthropicTools } from "../tools/registry.js";
import type { ToolDefinition, ToolResult } from "../tools/types.js";
import { log } from "../utils/logger.js";
import { withTimeout } from "../utils/timeout.js";

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
  /** Fires with the growing "reply" text as Claude streams the final `respond` call, for UI streaming. */
  onReplyDelta?: (partialReply: string) => void;
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
  const { anthropic, model, system, onReplyDelta } = options;
  const messages: Anthropic.MessageParam[] = [...options.messages];
  const rawTools = [...toAnthropicTools(), RESPOND_TOOL];
  // The tool definitions and system prompt are identical on every call this
  // process makes - only `messages` varies. Marking the end of the tools
  // list as a cache breakpoint lets Anthropic skip re-processing that whole
  // static prefix on every iteration of this loop, and on every other chat
  // turn/user, instead of just the (much smaller) growing conversation.
  const tools: Anthropic.Tool[] = rawTools.map((tool, i) =>
    i === rawTools.length - 1 ? { ...tool, cache_control: { type: "ephemeral" } } : tool
  );
  const seenCalls = new Set<string>();
  let pendingAction: PendingAction | undefined;
  // Sliding cache breakpoint over `messages`, only ever placed once we know
  // there will be another iteration (right after growing the array, not
  // before the first call) - a single-iteration turn (no tool calls) never
  // pays the extra cache-write cost for a breakpoint that would never be
  // reused. Moved forward each iteration rather than added to, so it never
  // stacks up more than one of the four cache breakpoints Anthropic allows
  // per request (the other two being the tools/system ones above).
  let cachedMessageBlock: Anthropic.ToolResultBlockParam | null = null;

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    log("iteration:start", { iteration });

    // Only the "respond" tool's input is ever meant to reach the user, so we
    // track which tool_use block is currently streaming and only forward its
    // partial "reply" field - a business tool's raw arguments never leak out
    // as a stream of characters.
    let activeToolName: string | null = null;
    const stream = anthropic.messages.stream({
      model,
      max_tokens: 1024,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      tools,
      tool_choice: { type: "any" },
      messages,
    });

    stream.on("streamEvent", (event) => {
      if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
        activeToolName = event.content_block.name;
      }
    });

    if (onReplyDelta) {
      stream.on("inputJson", (_partialJson, jsonSnapshot) => {
        if (activeToolName !== RESPOND_TOOL.name) return;
        const partial = jsonSnapshot as { reply?: unknown };
        if (typeof partial.reply === "string") {
          onReplyDelta(partial.reply);
        }
      });
    }

    const response = await stream.finalMessage();

    // cache_read_input_tokens > 0 is the actual proof the cache breakpoints
    // above are paying off, not just present in the request - without this,
    // a broken breakpoint (e.g. a prefix that silently stopped matching)
    // would look identical to a working one from the outside.
    log("iteration:usage", {
      iteration,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheCreationTokens: response.usage.cache_creation_input_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens,
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

    // Two passes: first classify every requested call synchronously (unknown
    // tool, bad args, duplicate-in-turn, write-gating) so `seenCalls` and
    // `pendingAction` are updated deterministically and in order; then run
    // whatever's left - independent read-tool calls - concurrently, since
    // Claude can fan out to several lookups in one turn with no data
    // dependency between them (e.g. two different orders). Order is
    // preserved via `position` regardless of which promise resolves first.
    const resultBlocks: Anthropic.ToolResultBlockParam[] = new Array(toolUseBlocks.length);
    const pendingExecutions: { position: number; blockId: string; tool: ToolDefinition; args: unknown }[] = [];

    toolUseBlocks.forEach((block, position) => {
      const callKey = `${block.name}:${JSON.stringify(block.input)}`;
      log("tool:requested", { name: block.name, args: block.input });

      const tool = getTool(block.name);
      if (!tool) {
        log("tool:unknown", { name: block.name });
        resultBlocks[position] = toolResultBlock(block.id, `Unknown tool "${block.name}". It is not registered and cannot be called.`, true);
        return;
      }

      const validation = tool.validate(block.input);
      if (!validation.valid) {
        log("tool:validation_failed", { name: block.name, error: validation.error });
        resultBlocks[position] = toolResultBlock(block.id, `Invalid arguments: ${validation.error}`, true);
        return;
      }

      if (seenCalls.has(callKey)) {
        log("tool:duplicate_call_blocked", { name: block.name, args: validation.value });
        resultBlocks[position] = toolResultBlock(
          block.id,
          "This exact call was already made earlier in this turn. Reuse that result instead of calling again.",
          true
        );
        return;
      }
      seenCalls.add(callKey);

      // WRITE tools never execute inside the loop. The backend - not Claude -
      // decides that a real action requires a separate, explicit user
      // confirmation step (see POST /api/chat/confirm in index.ts) before the
      // handler is ever called.
      if (tool.operationType === "write") {
        pendingAction = { tool: tool.name, args: validation.value, summary: describePendingAction(tool.name, validation.value) };
        log("tool:write_awaiting_confirmation", { name: block.name, args: validation.value });
        resultBlocks[position] = toolResultBlock(block.id, {
          status: "awaiting_confirmation",
          message: "This is a write operation. Do not call it again. Call respond to ask the user to explicitly confirm - do not call any more business tools this turn.",
        });
        return;
      }

      pendingExecutions.push({ position, blockId: block.id, tool, args: validation.value });
    });

    await Promise.all(
      pendingExecutions.map(async ({ position, blockId, tool, args }) => {
        let result: ToolResult;
        try {
          result = await withTimeout(tool.handler(args), TOOL_TIMEOUT_MS, "Tool");
        } catch (err) {
          log("tool:execution_failed", { name: tool.name, error: err instanceof Error ? err.message : String(err) });
          result = { success: false, error: "The tool failed to execute. Please try again." };
        }
        log("tool:result", { name: tool.name, success: result.success });
        resultBlocks[position] = toolResultBlock(blockId, result, !result.success);
      })
    );

    messages.push({ role: "user", content: resultBlocks });

    // We're definitely calling Claude again this turn, so mark the end of
    // what we're about to send as cacheable: next iteration's prefix will be
    // exactly this, so it's a cache hit for everything except the new blocks
    // that iteration adds.
    if (cachedMessageBlock) delete cachedMessageBlock.cache_control;
    cachedMessageBlock = resultBlocks[resultBlocks.length - 1];
    cachedMessageBlock.cache_control = { type: "ephemeral" };
  }

  log("iterations:max_reached", { maxIterations: MAX_ITERATIONS });
  return {
    finalText: "I wasn't able to finish handling this within the allowed number of steps. Could you simplify or rephrase your question?",
    sources: [],
    iterations: MAX_ITERATIONS,
    pendingAction,
  };
}
