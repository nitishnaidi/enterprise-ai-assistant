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
