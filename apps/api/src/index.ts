import "dotenv/config";
import express, { type Request, type Response } from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";
import { embeddingProvider } from "./services/embeddings.js";
import { searchSimilarChunks, type RetrievedChunk } from "./services/retrieval.js";
import { rerankTexts } from "./services/reranker.js";
import { runAgentLoop } from "./agent/agentLoop.js";
import { getTool, getAllTools } from "./tools/registry.js";
import { log } from "./utils/logger.js";
import { withTimeout } from "./utils/timeout.js";

interface ChatHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

interface ChatRequestBody {
  message: string;
  history?: ChatHistoryMessage[];
}

const app = express();
const PORT = process.env.PORT || 4000;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
// Retrieval runs in two stages: a wide, cheap cosine-similarity search for
// recall (CANDIDATE_K), then a rerank pass that actually reads the query
// against each candidate for precision, cut down to FINAL_K.
const CANDIDATE_K = 20;
const FINAL_K = 5;
// Cosine distance above this is "different topic", not just "not the top
// match" - drop it before spending a rerank call on it. 0 = identical
// direction, 2 = opposite; this is a coarse recall-stage filter, tune against
// real query/document pairs rather than trusting the number in the abstract.
const MAX_DISTANCE = 0.6;
// Voyage relevance_score is 0-1. Below this, the chunk is on-topic enough to
// have survived the distance filter but the reranker doesn't consider it an
// actual match for the question - don't let it into the Context block.
const MIN_RERANK_SCORE = 0.3;
// Bounds on external calls in the request path, so a slow/hung upstream
// (Voyage, order-service) fails fast instead of hanging the request.
const EMBED_TIMEOUT_MS = 5000;
const RERANK_TIMEOUT_MS = 5000;
const CONFIRM_TOOL_TIMEOUT_MS = 8000;

const SYSTEM_PROMPT = `You are an enterprise assistant. You have two distinct sources of information, and you must use the right one for each question:

1. A "Context" block of retrieved policy/document excerpts, included with every question below. Use this for general knowledge questions (policies, rules, how-to).
2. Tools, which return live, order-specific business data (e.g. a specific order's status or items). Use these when the question is about a specific order, ticket, or other live data that the Context block cannot contain.

Some questions need both: e.g. whether a specific order can be returned requires looking up that order with a tool AND applying the policy rules from Context.

Rules for using Context:
- Base policy answers strictly on the provided context. Do not use outside knowledge or invent information that isn't supported by the context.
- If the context does not contain enough information to answer, say so clearly instead of guessing (e.g. "I don't have enough information in the provided documents to answer that.").
- If the question is ambiguous or could reasonably be read more than one way, do not silently pick one reading and answer as if it were the only one. State which reading(s) you're addressing, and if the context only covers some of them, say so explicitly instead of extending a clause to a situation it doesn't actually describe.
- Only apply a specific clause, condition, or exception from the context when the question genuinely matches what it describes. A superficially similar wording is not a match - if you're stretching the context to cover the question, say that the exact scenario isn't addressed rather than presenting an inferred answer as certain.

Rules for using tools:
- Only call a tool when you have all the information it requires. If a required argument (like an order ID) is missing from the conversation, ask the user for it instead of guessing or calling the tool with an incomplete or made-up value.
- Never fabricate a tool result. Only use data that a tool actually returned.
- If a tool reports the order/item wasn't found, or that it failed, tell the user plainly rather than inventing an answer.
- Tools that create or change something (like creating a support ticket) are real actions and require confirmation before they run. To request one, call the tool once with the arguments you intend to use - the system will intercept it, hold it for confirmation, and ask you to have the user confirm. Do not call that tool again until the user has explicitly agreed in a later message.
- If a request needs an action you have no tool for, say so rather than attempting it another way.

How to respond:
- You must always finish by calling the "respond" tool - it is the only way to communicate with the user. Never rely on plain text.
- In "sourcesUsed", list only the Context document filenames and/or tool names your reply actually relies on. Leave out anything that was available but that you didn't end up using. Use an empty array for replies that don't depend on a specific document or tool result (greetings, clarifying questions, refusals).`;

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn(
    "Warning: ANTHROPIC_API_KEY is not set. /api/chat will fail until it is configured in apps/api/.env"
  );
}

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || "missing-api-key",
});

app.use(cors());
app.use(express.json());

// Turns retrieved chunks into the block of text Claude actually reads. Each
// chunk is labeled with its source document so Claude can cite it, and so we
// can sanity-check in logs which chunks fed a given answer.
function buildContextBlock(chunks: { documentName: string; chunkIndex: number; content: string }[]): string {
  if (chunks.length === 0) {
    return "No relevant documents were found for this question.";
  }

  return chunks
    .map(
      (chunk) =>
        `[Source: ${chunk.documentName}, chunk ${chunk.chunkIndex}]\n${chunk.content}`
    )
    .join("\n\n---\n\n");
}

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

app.post("/api/chat", async (req: Request<{}, {}, ChatRequestBody>, res: Response) => {
  const { message, history } = req.body;

  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message is required" });
  }

  try {
    log("chat:request", { message });

    const queryEmbedding = await withTimeout(embeddingProvider.embedQuery(message), EMBED_TIMEOUT_MS, "Embedding");
    const candidates = await searchSimilarChunks(queryEmbedding, CANDIDATE_K);
    const withinDistance = candidates.filter((chunk) => chunk.distance <= MAX_DISTANCE);
    log("rag:candidates", {
      count: candidates.length,
      withinDistance: withinDistance.length,
      topDistance: candidates[0]?.distance,
    });

    let retrievedChunks: RetrievedChunk[] = [];
    if (withinDistance.length > 0) {
      try {
        const reranked = await withTimeout(
          rerankTexts(
            message,
            withinDistance.map((chunk) => chunk.content),
            FINAL_K
          ),
          RERANK_TIMEOUT_MS,
          "Rerank"
        );
        retrievedChunks = reranked
          .filter((r) => r.relevanceScore >= MIN_RERANK_SCORE)
          .map((r) => withinDistance[r.index]);
      } catch (err) {
        // Reranking is a precision upgrade on top of the cosine shortlist,
        // not a hard dependency - if Voyage is slow or down, fall back to
        // the plain cosine ranking rather than failing the whole answer.
        log("rag:rerank_failed", { error: err instanceof Error ? err.message : String(err) });
        retrievedChunks = withinDistance.slice(0, FINAL_K);
      }
    }
    log("rag:retrieved", {
      count: retrievedChunks.length,
      topSource: retrievedChunks[0]?.documentName,
    });

    const contextBlock = buildContextBlock(retrievedChunks);
    const userTurn = `Context:\n\n${contextBlock}\n\nQuestion: ${message}`;

    const messages: ChatHistoryMessage[] = [
      ...(Array.isArray(history) ? history : []),
      { role: "user", content: userTurn },
    ];

    const result = await runAgentLoop({
      anthropic,
      model: ANTHROPIC_MODEL,
      system: SYSTEM_PROMPT,
      messages,
    });
    log("chat:response", { iterations: result.iterations, hasPendingAction: Boolean(result.pendingAction) });

    // Claude self-reports sourcesUsed, but we still don't trust it blindly:
    // only names that were actually retrieved as context or are real
    // registered tools can appear here. This is what stops it from claiming
    // a document/tool it didn't really rely on - or one that doesn't exist.
    const retrievableNames = new Set([
      ...retrievedChunks.map((chunk) => chunk.documentName),
      ...getAllTools().map((tool) => tool.name),
    ]);
    const sources = [...new Set(result.sources.filter((name) => retrievableNames.has(name)))];
    if (sources.length !== result.sources.length) {
      log("chat:sources_filtered", { claimed: result.sources, kept: sources });
    }

    res.json({ reply: result.finalText, sources, pendingAction: result.pendingAction });
  } catch (err) {
    console.error("Chat request failed:", err instanceof Error ? err.message : err);
    res.status(502).json({ error: "Failed to get a response from Claude" });
  }
});

// Separate from the agent loop entirely - the write tool is executed here,
// directly by the backend, once the user has explicitly confirmed. Claude is
// not consulted again. The backend re-validates independently of whatever
// the client sends, so a tampered/incomplete confirm request still fails.
app.post("/api/chat/confirm", async (req: Request<{}, {}, ConfirmRequestBody>, res: Response) => {
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

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
