import "dotenv/config";
import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
const PORT = process.env.PORT || 4000;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

if (!process.env.OPENAI_API_KEY) {
  console.warn("Warning: OPENAI_API_KEY is not set. /api/chat will fail until it is configured in server/.env");
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "missing-api-key" });

app.use(cors());
app.use(express.json());

app.post("/api/chat", async (req, res) => {
  const { message, history } = req.body;

  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message is required" });
  }

  const messages = [
    { role: "system", content: "You are a helpful enterprise assistant." },
    ...(Array.isArray(history) ? history : []),
    { role: "user", content: message },
  ];

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages,
    });

    const reply = completion.choices[0]?.message?.content ?? "";
    res.json({ reply });
  } catch (err) {
    console.error("OpenAI request failed:", err.message);
    res.status(502).json({ error: "Failed to get a response from OpenAI" });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
