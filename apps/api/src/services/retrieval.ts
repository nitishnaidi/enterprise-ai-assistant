import pgvector from "pgvector/pg";
import { pool } from "../db/pool.js";

export interface RetrievedChunk {
  documentName: string;
  chunkIndex: number;
  content: string;
  /** Cosine distance: 0 = identical direction, 2 = opposite. Lower is more similar. */
  distance: number;
}

// Cosine distance (`<=>`) rather than L2 (`<->`): embedding magnitude carries
// no meaning here, only direction (semantic similarity) does, and cosine
// distance is what Voyage's own docs benchmark retrieval quality against.
export async function searchSimilarChunks(
  queryEmbedding: number[],
  topK = 5
): Promise<RetrievedChunk[]> {
  const result = await pool.query(
    `SELECT document_name, chunk_index, content, embedding <=> $1 AS distance
     FROM document_chunks
     ORDER BY embedding <=> $1
     LIMIT $2`,
    [pgvector.toSql(queryEmbedding), topK]
  );

  return result.rows.map((row) => ({
    documentName: row.document_name,
    chunkIndex: row.chunk_index,
    content: row.content,
    distance: Number(row.distance),
  }));
}

// Cosine similarity ranks by "same neighborhood in embedding space," which
// can miss a chunk that contains an exact token the query cares about (an
// order ID, a clause number, a specific product name) if that token doesn't
// shift the chunk's overall semantic direction much. Postgres full-text
// search is the complementary signal: it doesn't understand meaning, but it
// never misses an exact/stemmed term match. Both candidate sets get merged
// before rerank, which is what actually judges relevance either way.
export async function searchByKeyword(query: string, topK = 5): Promise<RetrievedChunk[]> {
  const result = await pool.query(
    `SELECT document_name, chunk_index, content,
            ts_rank(to_tsvector('english', content), plainto_tsquery('english', $1)) AS rank
     FROM document_chunks
     WHERE to_tsvector('english', content) @@ plainto_tsquery('english', $1)
     ORDER BY rank DESC
     LIMIT $2`,
    [query, topK]
  );

  return result.rows.map((row) => ({
    documentName: row.document_name,
    chunkIndex: row.chunk_index,
    content: row.content,
    // Not a cosine distance - this candidate didn't come from vector search,
    // so there's nothing meaningful to compare it against. It still gets a
    // fair shot at the Context block via rerank, which judges relevance
    // directly from the text rather than from this field.
    distance: NaN,
  }));
}

// Vector and keyword search can surface the same chunk. De-dupe by
// (document, chunk index) across however many candidate lists are passed,
// keeping the first occurrence - callers should pass the vector list first
// so a chunk found by both keeps its real cosine distance rather than NaN.
export function mergeCandidates(...lists: RetrievedChunk[][]): RetrievedChunk[] {
  const seen = new Set<string>();
  const merged: RetrievedChunk[] = [];
  for (const list of lists) {
    for (const chunk of list) {
      const key = `${chunk.documentName}#${chunk.chunkIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(chunk);
    }
  }
  return merged;
}
