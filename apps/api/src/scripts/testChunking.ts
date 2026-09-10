// Verifies extraction + chunking on their own, before embeddings or the
// database are involved at all.
// Usage: npm run test:chunking --workspace api -- ./sample-docs/returns-policy.txt
import { extractText } from "../services/textExtraction.js";
import { chunkText } from "../services/chunker.js";

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: npm run test:chunking --workspace api -- <path-to-pdf-or-txt>");
    process.exit(1);
  }

  const text = await extractText(filePath);
  console.log(`Extracted ${text.length} characters from ${filePath}\n`);

  const chunks = chunkText(text);
  console.log(`Split into ${chunks.length} chunk(s):\n`);

  for (const chunk of chunks) {
    console.log(`--- Chunk ${chunk.index} (${chunk.tokenCount} tokens) ---`);
    console.log(chunk.text);
    console.log();
  }
}

main().catch((err) => {
  console.error("Chunking test failed:", err);
  process.exit(1);
});
