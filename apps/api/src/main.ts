import { createDb } from "@burrow/db";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";

// Usage: node --env-file=.env apps/api/src/main.ts
// Needs BURROW_API_KEY (make one with `openssl rand -hex 32`); PORT defaults to 3000.

const apiKey = process.env.BURROW_API_KEY;
if (!apiKey || apiKey.length < 32) {
  console.error(
    "BURROW_API_KEY must be set to at least 32 characters (try `openssl rand -hex 32`). Run with --env-file=.env",
  );
  process.exit(2);
}

const db = createDb();
const port = Number(process.env.PORT ?? 3000);

// Only reachable from this machine until deploys (M5) put it behind TLS.
const server = serve({ fetch: createApp({ db, apiKey }).fetch, hostname: "127.0.0.1", port }, () =>
  console.log(`Listening on http://127.0.0.1:${port}`),
);

// Ctrl+C: stop taking requests, then close the database pool so the process exits.
const shutdown = () => {
  server.close(() => void db.$client.end());
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
