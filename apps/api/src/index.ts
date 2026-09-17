import "dotenv/config";
import express, { type Request, type Response } from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { randomUUID } from "node:crypto";
import { answerChat, countTokens, type ChatHistoryMessage } from "./chat/answerChat.js";
import { getTool } from "./tools/registry.js";
import { log, withRequestId } from "./utils/logger.js";
import { withTimeout } from "./utils/timeout.js";

interface ChatRequestBody {
  message: string;
  history?: ChatHistoryMessage[];
}

const app = express();
const PORT = process.env.PORT || 4000;
const CONFIRM_TOOL_TIMEOUT_MS = 8000;
// A legitimate question doesn't need to be an essay - reject oversized
// messages outright (almost certainly abuse or a mistake, worth surfacing
// immediately) rather than silently truncating them.
const MAX_MESSAGE_TOKENS = 500;

// In-memory, per-IP - fine for a single-instance dev/demo deployment. A
// multi-instance production deployment would need a shared store (e.g.
// Redis) instead, and per-user rather than per-IP limits once there's real
// authentication.
const chatLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down and try again in a minute." },
});

// Tighter than chatLimiter since this endpoint actually executes a write.
const confirmLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down and try again in a minute." },
});

app.use(cors());
app.use(express.json());

interface ConfirmRequestBody {
  tool: string;
  args: unknown;
}

// Templated, not phrased by Claude: once a write tool actually executes, the
// confirmation message is built directly from the tool's own result, with no
// LLM round-trip. This keeps "did the write happen" fully in backend control.
function describeExecutedAction(name: string, args: any, data: any): string {
  if (name === "createSupportTicket") {
    const orderPart = args.orderId ? ` for order ${args.orderId}` : "";
    return `Support ticket ${data.ticketId} has been created${orderPart}. Our team will follow up on: "${args.reason}".`;
  }
  return `Done: ${name} completed successfully.`;
}

// Server-Sent Events: the agent loop can take several sequential Claude
// round-trips (RAG retrieval, tool calls, then the final answer), so instead
// of making the caller wait for the whole turn we stream the final "respond"
// text back as it's generated. Once this starts writing, the HTTP status is
// already committed to 200 - failures from here on are reported as an
// "error" SSE event, not a status code.
function sendEvent(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

app.post("/api/chat", chatLimiter, async (req: Request<{}, {}, ChatRequestBody>, res: Response) => {
  const { message, history } = req.body;

  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message is required" });
  }

  const messageTokens = countTokens(message);
  if (messageTokens > MAX_MESSAGE_TOKENS) {
    return res.status(400).json({ error: `Message is too long (${messageTokens} tokens, max ${MAX_MESSAGE_TOKENS}).` });
  }

  // Carried through every log() call this request triggers (in answerChat,
  // the agent loop, tools, etc.) via async-local storage, and echoed back to
  // the caller so a specific bad answer can be traced back to its log lines.
  const requestId = randomUUID();
  res.setHeader("X-Request-Id", requestId);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  await withRequestId(requestId, async () => {
    try {
      log("chat:request", { message });

      const result = await answerChat({
        message,
        history: Array.isArray(history) ? history : [],
        onReplyDelta: (partial) => sendEvent(res, "reply_delta", { reply: partial }),
      });

      sendEvent(res, "done", { reply: result.reply, sources: result.sources, pendingAction: result.pendingAction });
      res.end();
    } catch (err) {
      console.error("Chat request failed:", err instanceof Error ? err.message : err);
      sendEvent(res, "error", { error: "Failed to get a response from Claude" });
      res.end();
    }
  });
});

// Separate from the agent loop entirely - the write tool is executed here,
// directly by the backend, once the user has explicitly confirmed. Claude is
// not consulted again. The backend re-validates independently of whatever
// the client sends, so a tampered/incomplete confirm request still fails.
app.post("/api/chat/confirm", confirmLimiter, async (req: Request<{}, {}, ConfirmRequestBody>, res: Response) => {
  const { tool: toolName, args } = req.body;

  if (!toolName || typeof toolName !== "string") {
    return res.status(400).json({ error: "tool is required" });
  }

  const tool = getTool(toolName);
  if (!tool) {
    return res.status(400).json({ error: `Unknown tool "${toolName}".` });
  }
  if (tool.operationType !== "write") {
    return res.status(400).json({ error: `"${toolName}" is not a write tool and does not require confirmation.` });
  }

  const validation = tool.validate(args);
  if (!validation.valid) {
    return res.status(400).json({ error: `Invalid arguments: ${validation.error}` });
  }

  const requestId = randomUUID();
  res.setHeader("X-Request-Id", requestId);

  await withRequestId(requestId, async () => {
    log("confirm:executing", { tool: toolName, args: validation.value });

    try {
      const result = await withTimeout(tool.handler(validation.value), CONFIRM_TOOL_TIMEOUT_MS, "Write tool");
      log("confirm:result", { tool: toolName, success: result.success });

      if (!result.success) {
        return res.json({ reply: `I couldn't complete that: ${result.error}` });
      }

      res.json({ reply: describeExecutedAction(toolName, validation.value, result.data) });
    } catch (err) {
      console.error("Confirmed tool execution failed:", err instanceof Error ? err.message : err);
      res.status(502).json({ error: "The action failed to execute. Please try again." });
    }
  });
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
