-- Runs automatically on first container init (docker-entrypoint-initdb.d).
-- Re-running requires a fresh volume: `docker compose down -v`.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS document_chunks (
  id SERIAL PRIMARY KEY,
  document_id UUID NOT NULL,
  document_name TEXT NOT NULL,
  chunk_index INT NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  embedding VECTOR(512) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS document_chunks_document_id_idx ON document_chunks (document_id);
