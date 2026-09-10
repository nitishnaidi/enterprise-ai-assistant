// Dev-only tracing so you can see WHY the agent did what it did: whether RAG
// was used, which tool it picked, what arguments it sent, whether validation
// passed, what came back. Never logs API keys or .env contents - only the
// shapes of requests/results that flow through the agent loop.
const isDev = process.env.NODE_ENV !== "production";

export function log(event: string, data?: Record<string, unknown>): void {
  if (!isDev) return;
  const timestamp = new Date().toISOString();
  if (data) {
    console.log(`[agent ${timestamp}] ${event}`, JSON.stringify(data));
  } else {
    console.log(`[agent ${timestamp}] ${event}`);
  }
}
