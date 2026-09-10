// Verifies retrieval on its own, no Claude involved - so you can judge whether
// the retrieved chunks actually look relevant before trusting an LLM to use them.
// Usage: npm run test:retrieval --workspace api -- "What is the return window?"
import "dotenv/config";
import { embeddingProvider } from "../services/embeddings.js";
import { searchSimilarChunks } from "../services/retrieval.js";
import { pool } from "../db/pool.js";

async function main() {
  const question = process.argv[2];
  if (!question) {
    console.error('Usage: npm run test:retrieval --workspace api -- "your question"');
    process.exit(1);
  }

  console.log(`Question: ${question}\n`);

  const queryEmbedding = await embeddingProvider.embedQuery(question);
  const chunks = await searchSimilarChunks(queryEmbedding, 5);

  if (chunks.length === 0) {
    console.log("No chunks found. Have you run `npm run ingest` yet?");
  } else {
    chunks.forEach((chunk, i) => {
      console.log(`--- Result ${i + 1} (distance: ${chunk.distance.toFixed(4)}) ---`);
      console.log(`Document: ${chunk.documentName} (chunk ${chunk.chunkIndex})`);
      console.log(chunk.content);
      console.log();
    });
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error("Retrieval test failed:", err);
  await pool.end();
  process.exit(1);
});
