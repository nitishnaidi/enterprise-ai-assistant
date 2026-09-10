import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

app.post("/api/chat", (req, res) => {
  const { message } = req.body;

  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message is required" });
  }

  res.json({ reply: `You said: ${message}` });
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
