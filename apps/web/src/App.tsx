import { useState } from "react";

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  sources?: string[];
}

interface ChatResponse {
  reply: string;
  sources?: string[];
  error?: string;
}

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || loading) return;

    setMessages((prev) => [...prev, { role: "user", text }]);
    setInput("");
    setLoading(true);

    try {
      const history = messages.map((m) => ({
        role: m.role === "user" ? "user" : "assistant",
        content: m.text,
      }));

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, history }),
      });
      const data: ChatResponse = await res.json();
      const reply = res.ok ? data.reply : `Error: ${data.error}`;
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: reply, sources: data.sources },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: "Error: could not reach server" },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") sendMessage();
  };

  return (
    <div className="chat-container">
      <h1>Enterprise AI Assistant</h1>
      <div className="chat-window">
        {messages.map((msg, i) => (
          <div key={i} className={`message ${msg.role}`}>
            <span className="label">{msg.role === "user" ? "You" : "Assistant"}</span>
            <p>{msg.text}</p>
            {msg.sources && msg.sources.length > 0 && (
              <p className="sources">Sources: {msg.sources.join(", ")}</p>
            )}
          </div>
        ))}
        {loading && <div className="message assistant">Thinking...</div>}
      </div>
      <div className="chat-input">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type your message..."
        />
        <button onClick={sendMessage} disabled={loading}>
          Send
        </button>
      </div>
    </div>
  );
}
