import "dotenv/config";
import express, { type Request, type Response } from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";
import { embeddingProvider } from "./services/embeddings.js";
import { searchSimilarChunks } from "./services/retrieval.js";

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
const TOP_K = 5;

const SYSTEM_PROMPT = `You are an enterprise assistant that answers questions using ONLY the context documents provided with each question.

Rules:
- Base your answer strictly on the provided context. Do not use outside knowledge or invent information that isn't supported by the context.
- If the context does not contain enough information to answer, say so clearly instead of guessing (e.g. "I don't have enough information in the provided documents to answer that.").
- If the question is ambiguous or could reasonably be read more than one way, do not silently pick one reading and answer as if it were the only one. State which reading(s) you're addressing, and if the context only covers some of them, say so explicitly instead of extending a clause to a situation it doesn't actually describe.
- Only apply a specific clause, condition, or exception from the context when the question genuinely matches what it describes. A superficially similar wording is not a match - if you're stretching the context to cover the question, say that the exact scenario isn't addressed rather than presenting an inferred answer as certain.
- When you do answer from the context, name the source document(s) that support your answer.`;

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

app.post("/api/chat", async (req: Request<{}, {}, ChatRequestBody>, res: Response) => {
  const { message, history } = req.body;

  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message is required" });
  }

  try {
    const queryEmbedding = await embeddingProvider.embedQuery(message);
    const retrievedChunks = await searchSimilarChunks(queryEmbedding, TOP_K);

    const contextBlock = buildContextBlock(retrievedChunks);
    const userTurn = `Context:\n\n${contextBlock}\n\nQuestion: ${message}`;

    const messages: ChatHistoryMessage[] = [
      ...(Array.isArray(history) ? history : []),
      { role: "user", content: userTurn },
    ];

    const completion = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages,
    });

    const reply = completion.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");

    const sources = [...new Set(retrievedChunks.map((chunk) => chunk.documentName))];

    res.json({ reply, sources });
  } catch (err) {
    console.error("Chat request failed:", err instanceof Error ? err.message : err);
    res.status(502).json({ error: "Failed to get a response from Claude" });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
