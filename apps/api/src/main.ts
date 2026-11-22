import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeepSeekLLM, deepSeekFlashPricing } from "@burrow/agent/deepseek";
import { createDockerSandbox } from "@burrow/agent/docker";
import { createDb } from "@burrow/db";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { createRunExecutor } from "./run-executor.ts";

// Usage: node --env-file=.env apps/api/src/main.ts
// Needs BURROW_API_KEY (make one with `openssl rand -hex 32`) and DEEPSEEK_API_KEY.
// Optional: PORT (default 3000), BURROW_WORKSPACES (where each run's repo copy goes).

const apiKey = process.env.BURROW_API_KEY;
if (!apiKey || apiKey.length < 32) {
  console.error(
    "BURROW_API_KEY must be set to at least 32 characters (try `openssl rand -hex 32`). Run with --env-file=.env",
  );
  process.exit(2);
}
const deepSeekApiKey = process.env.DEEPSEEK_API_KEY;
if (!deepSeekApiKey) {
  console.error("DEEPSEEK_API_KEY is not set. Run with --env-file=.env");
  process.exit(2);
}

const db = createDb();
const port = Number(process.env.PORT ?? 3000);
const workspacesDir = process.env.BURROW_WORKSPACES ?? join(tmpdir(), "burrow-runs");

const executeRun = createRunExecutor({
  db,
  llm: createDeepSeekLLM({ apiKey: deepSeekApiKey, model: "deepseek-flash" }),
  pricing: deepSeekFlashPricing,
  createSandbox: (workdir) => createDockerSandbox({ workdir }),
  workspacesDir,
});

// Only reachable from this machine until deploys (M5) put it behind TLS.
const server = serve(
  { fetch: createApp({ db, apiKey, executeRun }).fetch, hostname: "127.0.0.1", port },
  () => {
    console.log(`Listening on http://127.0.0.1:${port}`);
    console.log(`Run workspaces: ${workspacesDir}`);
  },
);

// Ctrl+C: stop taking requests, then close the database pool so the process exits.
// Runs still in progress are cut off and stay "running"; M4 moves them to a worker.
const shutdown = () => {
  server.close(() => void db.$client.end());
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
