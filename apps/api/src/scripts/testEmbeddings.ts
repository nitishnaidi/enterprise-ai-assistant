// Feed any PDF/TXT and inspect the embeddings Voyage returns for its chunks -
// no database involved yet, just extraction -> chunking -> embedding.
// Usage: npm run test:embeddings --workspace api -- <path-to-pdf-or-txt>
import "dotenv/config";
import { extractText } from "../services/textExtraction.js";
import { chunkText } from "../services/chunker.js";
import { embeddingProvider } from "../services/embeddings.js";

function preview(text: string, length = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length)}...` : flat;
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: npm run test:embeddings --workspace api -- <path-to-pdf-or-txt>");
    process.exit(1);
  }

  const text = await extractText(filePath);
  const chunks = chunkText(text);
  console.log(`${filePath}: extracted ${text.length} characters, split into ${chunks.length} chunk(s)\n`);

  const embeddings = await embeddingProvider.embedDocuments(chunks.map((c) => c.text));

  chunks.forEach((chunk, i) => {
    const embedding = embeddings[i];
    console.log(`--- Chunk ${chunk.index} (${chunk.tokenCount} tokens) ---`);
    console.log(`Text preview: ${preview(chunk.text)}`);
    console.log(`Embedding dimensions: ${embedding.length}`);
    console.log(`First 5 values: [${embedding.slice(0, 5).map((v) => v.toFixed(4)).join(", ")}, ...]`);
    console.log();
  });
}

main().catch((err) => {
  console.error("Embedding test failed:", err);
  process.exit(1);
});
