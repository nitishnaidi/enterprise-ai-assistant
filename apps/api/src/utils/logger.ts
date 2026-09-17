import { AsyncLocalStorage } from "node:async_hooks";

// Carries a per-request id through every log() call for the life of a
// request without threading it through every function signature in the RAG
// pipeline / agent loop / tools - anything called (even indirectly) from
// inside withRequestId() picks it up automatically via async context.
const requestContext = new AsyncLocalStorage<{ requestId: string }>();

export function withRequestId<T>(requestId: string, fn: () => T): T {
  return requestContext.run({ requestId }, fn);
}

// Dev-only tracing so you can see WHY the agent did what it did: whether RAG
// was used, which tool it picked, what arguments it sent, whether validation
// passed, what came back. Never logs API keys or .env contents - only the
// shapes of requests/results that flow through the agent loop.
const isDev = process.env.NODE_ENV !== "production";

// Structured, single-line JSON per event (rather than a free-text prefix)
// so a real deployment can ship these lines to a log pipeline and actually
// query/filter/aggregate them - e.g. "every rag:rerank_failed for this
// requestId" or "average cache_read_input_tokens across iterations".
export function log(event: string, data?: Record<string, unknown>): void {
  if (!isDev) return;
  const requestId = requestContext.getStore()?.requestId;
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      event,
      ...(requestId ? { requestId } : {}),
      ...(data ?? {}),
    })
  );
}
