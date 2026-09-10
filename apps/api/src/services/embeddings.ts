// Abstraction boundary for embeddings: ingestion and retrieval code only ever
// talk to this interface. Swapping providers later (OpenAI, a local model,
// etc.) means writing one new class here - nothing else in the RAG pipeline
// needs to change.
export interface EmbeddingProvider {
  readonly dimensions: number;
  /** Embeds chunks going INTO storage. */
  embedDocuments(texts: string[]): Promise<number[][]>;
  /** Embeds a user's search QUESTION. Kept separate from embedDocuments because */
  /** Voyage (like most modern embedding APIs) applies a different internal */
  /** prompt for "this is something to be searched for" vs "this is something */
  /** to be found" - using the right one measurably improves retrieval quality. */
  embedQuery(text: string): Promise<number[]>;
}

const VOYAGE_ENDPOINT = "https://api.voyageai.com/v1/embeddings";
const BATCH_SIZE = 128;

interface VoyageEmbeddingResponse {
  data: { embedding: number[]; index: number }[];
}

export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  private readonly apiKey: string;
  private readonly model: string;

  constructor() {
    this.apiKey = process.env.VOYAGE_API_KEY || "missing-api-key";
    this.model = process.env.VOYAGE_MODEL || "voyage-3.5-lite";
    this.dimensions = Number(process.env.EMBEDDING_DIMENSIONS || 512);

    if (!process.env.VOYAGE_API_KEY) {
      console.warn(
        "Warning: VOYAGE_API_KEY is not set. Embedding calls will fail until it is configured in apps/api/.env"
      );
    }
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const batchEmbeddings = await this.request(batch, "document");
      results.push(...batchEmbeddings);
    }
    return results;
  }

  async embedQuery(text: string): Promise<number[]> {
    const [embedding] = await this.request([text], "query");
    return embedding;
  }

  private async request(input: string[], inputType: "document" | "query"): Promise<number[][]> {
    const response = await fetch(VOYAGE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        input,
        model: this.model,
        input_type: inputType,
        output_dimension: this.dimensions,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Voyage embeddings request failed (${response.status}): ${body}`);
    }

    const result = (await response.json()) as VoyageEmbeddingResponse;
    return result.data
      .sort((a, b) => a.index - b.index)
      .map((item) => item.embedding);
  }
}

export const embeddingProvider: EmbeddingProvider = new VoyageEmbeddingProvider();
