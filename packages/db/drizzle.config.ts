import { defineConfig } from "drizzle-kit";
import { LOCAL_DATABASE_URL } from "./src/client.ts";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  dbCredentials: { url: process.env.DATABASE_URL ?? LOCAL_DATABASE_URL },
});
