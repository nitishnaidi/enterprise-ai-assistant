// Cosine similarity over embeddings is a recall tool, not a precision one: it
// ranks by how close two vectors point, which is a cheap proxy for "about the
// same topic" - it doesn't actually read the query against each candidate the
// way a reranker does. This calls Voyage's rerank endpoint, which scores each
// candidate document against the query text directly, to re-order/filter the
// cosine-similarity shortlist before it becomes the Context block.
const VOYAGE_RERANK_ENDPOINT = "https://api.voyageai.com/v1/rerank";

export interface RerankResult {
  /** Index into the `documents` array that was passed in. */
  index: number;
  /** Voyage relevance score, 0 (irrelevant) to 1 (highly relevant). */
  relevanceScore: number;
}

interface VoyageRerankResponse {
  data: { index: number; relevance_score: number }[];
}

export async function rerankTexts(
  query: string,
  documents: string[],
  topK: number
): Promise<RerankResult[]> {
  if (documents.length === 0) return [];

  const apiKey = process.env.VOYAGE_API_KEY || "missing-api-key";
  const model = process.env.VOYAGE_RERANK_MODEL || "rerank-2.5-lite";

  const response = await fetch(VOYAGE_RERANK_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      documents,
      model,
      top_k: topK,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Voyage rerank request failed (${response.status}): ${body}`);
  }

  const result = (await response.json()) as VoyageRerankResponse;
  return result.data.map((item) => ({
    index: item.index,
    relevanceScore: item.relevance_score,
  }));
}
