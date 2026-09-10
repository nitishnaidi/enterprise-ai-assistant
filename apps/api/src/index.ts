import "dotenv/config";
import express, { type Request, type Response } from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";

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

app.post("/api/chat", async (req: Request<{}, {}, ChatRequestBody>, res: Response) => {
  const { message, history } = req.body;

  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message is required" });
  }

  const messages: ChatHistoryMessage[] = [
    ...(Array.isArray(history) ? history : []),
    { role: "user", content: message },
  ];

  try {
    const completion = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      system: "You are a helpful enterprise assistant.",
      messages,
    });

    const reply = completion.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");

    res.json({ reply });
  } catch (err) {
    console.error("Claude request failed:", err instanceof Error ? err.message : err);
    res.status(502).json({ error: "Failed to get a response from Claude" });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
