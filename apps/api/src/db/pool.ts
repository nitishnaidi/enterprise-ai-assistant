import pg from "pg";
import pgvector from "pgvector/pg";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Registers the vector type codec on every new connection so pgvector.toSql()
  // values round-trip correctly through node-postgres.
  async onConnect(client) {
    await pgvector.registerTypes(client);
  },
});
