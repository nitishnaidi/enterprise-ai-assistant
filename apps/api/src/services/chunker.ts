import { encode, decode } from "gpt-tokenizer";

export interface ChunkOptions {
  /** Target chunk size in tokens. 500-800 is the sweet spot: small enough for */
  /** focused retrieval, large enough to keep a paragraph's context intact. */
  chunkTokens?: number;
  /** Tokens repeated between consecutive chunks, so an idea that spans a chunk */
  /** boundary still appears whole in at least one chunk. */
  overlapTokens?: number;
}

export interface Chunk {
  index: number;
  text: string;
  tokenCount: number;
}

// We use gpt-tokenizer purely as a token-counting ruler to size chunks
// consistently - it is not tied to Claude's own tokenizer, which OpenAI/
// Anthropic don't expose publicly. Any reasonable tokenizer works fine here;
// what matters is chunking by tokens instead of raw characters.
export function chunkText(text: string, options: ChunkOptions = {}): Chunk[] {
  const chunkTokens = options.chunkTokens ?? 650;
  const overlapTokens = options.overlapTokens ?? 100;
  const step = chunkTokens - overlapTokens;

  const tokens = encode(text);
  if (tokens.length === 0) return [];

  const chunks: Chunk[] = [];
  let start = 0;
  let index = 0;

  while (start < tokens.length) {
    const end = Math.min(start + chunkTokens, tokens.length);
    const tokenSlice = tokens.slice(start, end);

    chunks.push({
      index,
      text: decode(tokenSlice).trim(),
      tokenCount: tokenSlice.length,
    });

    index += 1;
    if (end >= tokens.length) break;
    start += step;
  }

  return chunks;
}
