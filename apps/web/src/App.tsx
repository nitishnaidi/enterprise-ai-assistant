import { useState } from "react";

interface PendingAction {
  tool: string;
  args: unknown;
  summary: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  sources?: string[];
  pendingAction?: PendingAction;
  pendingResolved?: boolean;
}

interface ConfirmResponse {
  reply: string;
  error?: string;
}

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  // sendMessage shows progress via its own streamed placeholder bubble, so
  // this is only for confirmPendingAction, which has no bubble to patch.
  const [confirmLoading, setConfirmLoading] = useState(false);

  // The backend streams the answer over Server-Sent Events instead of
  // returning one JSON blob, so the reply appears as Claude generates it
  // instead of after the whole agent loop finishes. An empty assistant
  // bubble is appended up front and patched in place as events arrive.
  const applyToLastMessage = (patch: Partial<ChatMessage>) => {
    setMessages((prev) => prev.map((m, i) => (i === prev.length - 1 ? { ...m, ...patch } : m)));
  };

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || loading) return;

    const history = messages.map((m) => ({
      role: m.role === "user" ? "user" : "assistant",
      content: m.text,
    }));

    setMessages((prev) => [...prev, { role: "user", text }, { role: "assistant", text: "Thinking..." }]);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, history }),
      });

      if (!res.ok || !res.body) {
        throw new Error(`Request failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let separatorIndex: number;
        while ((separatorIndex = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + 2);

          const eventType = rawEvent.match(/^event: (.+)$/m)?.[1] ?? "message";
          const dataLine = rawEvent.match(/^data: (.+)$/m)?.[1];
          if (!dataLine) continue;
          const data = JSON.parse(dataLine);

          if (eventType === "reply_delta") {
            applyToLastMessage({ text: data.reply });
          } else if (eventType === "done") {
            applyToLastMessage({ text: data.reply, sources: data.sources, pendingAction: data.pendingAction });
          } else if (eventType === "error") {
            applyToLastMessage({ text: `Error: ${data.error}` });
          }
        }
      }
    } catch (err) {
      applyToLastMessage({ text: "Error: could not reach server" });
    } finally {
      setLoading(false);
    }
  };

  // Confirm/Cancel never go through Claude - Confirm calls a dedicated
  // backend endpoint that re-validates and executes the write tool directly;
  // Cancel is purely local since nothing was ever executed to undo.
  const confirmPendingAction = async (index: number, action: PendingAction) => {
    setMessages((prev) => prev.map((m, i) => (i === index ? { ...m, pendingResolved: true } : m)));
    setLoading(true);
    setConfirmLoading(true);
    try {
      const res = await fetch("/api/chat/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: action.tool, args: action.args }),
      });
      const data: ConfirmResponse = await res.json();
      const reply = res.ok ? data.reply : `Error: ${data.error}`;
      setMessages((prev) => [...prev, { role: "assistant", text: reply }]);
    } catch {
      setMessages((prev) => [...prev, { role: "assistant", text: "Error: could not reach server" }]);
    } finally {
      setLoading(false);
      setConfirmLoading(false);
    }
  };

  const cancelPendingAction = (index: number) => {
    setMessages((prev) => [
      ...prev.map((m, i) => (i === index ? { ...m, pendingResolved: true } : m)),
      { role: "assistant", text: "Okay, I won't go ahead with that." },
    ]);
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
            {msg.pendingAction && !msg.pendingResolved && (
              <div className="pending-actions">
                <button className="confirm-btn" onClick={() => confirmPendingAction(i, msg.pendingAction!)} disabled={loading}>
                  Confirm
                </button>
                <button className="cancel-btn" onClick={() => cancelPendingAction(i)} disabled={loading}>
                  Cancel
                </button>
              </div>
            )}
          </div>
        ))}
        {confirmLoading && <div className="message assistant">Thinking...</div>}
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
