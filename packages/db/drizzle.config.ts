import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  dbCredentials: {
    // Falls back to the local Postgres from compose.yaml.
    url: process.env.DATABASE_URL ?? "postgres://burrow:burrow@127.0.0.1:5433/burrow",
  },
});
