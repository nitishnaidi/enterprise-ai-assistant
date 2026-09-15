// Shared timeout guard for any promise-based I/O in the request path. Without
// it, a slow upstream (Voyage, order-service, Anthropic) can hang a request
// indefinitely instead of failing fast with a clear error.
export function withTimeout<T>(promise: Promise<T>, ms: number, label = "Operation"): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}
