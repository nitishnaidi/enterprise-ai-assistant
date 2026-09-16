// Deliberately a standalone CLI script, not an HTTP route on the Express app -
// ingestion is a separate offline workflow from the chat/query path.
// Usage: npm run ingest --workspace api -- <path-to-pdf-or-txt>
import "dotenv/config";
import { randomUUID } from "node:crypto";
import path from "node:path";
import pgvector from "pgvector/pg";
import { extractText } from "../services/textExtraction.js";
import { chunkText } from "../services/chunker.js";
import { embeddingProvider } from "../services/embeddings.js";
import { pool } from "../db/pool.js";

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: npm run ingest --workspace api -- <path-to-pdf-or-txt>");
    process.exit(1);
  }

  const documentName = path.basename(filePath);
  const documentId = randomUUID();

  console.log(`Extracting text from ${documentName}...`);
  const text = await extractText(filePath);

  const chunks = chunkText(text);
  console.log(`Split into ${chunks.length} chunk(s). Generating embeddings...`);

  const embeddings = await embeddingProvider.embedDocuments(chunks.map((c) => c.text));

  // document_name is this pipeline's natural key for "the same document" -
  // re-ingesting a filename that's already present replaces its old chunks
  // instead of leaving them in the table to keep competing with the new
  // content at retrieval time. Delete + insert run in one transaction so a
  // failed re-ingest can't leave the document with zero chunks.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rowCount } = await client.query(`DELETE FROM document_chunks WHERE document_name = $1`, [documentName]);
    if (rowCount) {
      console.log(`Replacing ${rowCount} existing chunk(s) previously ingested from "${documentName}".`);
    }

    console.log(`Storing ${chunks.length} chunk(s) in Postgres...`);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      await client.query(
        `INSERT INTO document_chunks (document_id, document_name, chunk_index, content, metadata, embedding)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          documentId,
          documentName,
          chunk.index,
          chunk.text,
          JSON.stringify({ tokenCount: chunk.tokenCount, ingestedAt: new Date().toISOString() }),
          pgvector.toSql(embeddings[i]),
        ]
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  console.log(`Done. Ingested ${chunks.length} chunk(s) from "${documentName}" (document_id: ${documentId}).`);
  await pool.end();
}

main().catch(async (err) => {
  console.error("Ingestion failed:", err);
  await pool.end();
  process.exit(1);
});
