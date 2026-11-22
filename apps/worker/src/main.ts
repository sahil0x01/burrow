import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { createDeepSeekLLM, deepSeekFlashPricing } from "@burrow/agent/deepseek";
import { createDockerSandbox } from "@burrow/agent/docker";
import { createDb } from "@burrow/db";
import { createRunExecutor } from "./run-executor.ts";
import { runWorker } from "./worker.ts";

// Usage: node --env-file=.env apps/worker/src/main.ts
// Needs DEEPSEEK_API_KEY. Optional: BURROW_WORKSPACES (where each run's repo copy goes).
// Start as many as you like; each claims different runs.

const deepSeekApiKey = process.env.DEEPSEEK_API_KEY;
if (!deepSeekApiKey) {
  console.error("DEEPSEEK_API_KEY is not set. Run with --env-file=.env");
  process.exit(2);
}

const db = createDb();
const workerId = `${hostname()}:${process.pid}`;
const workspacesDir = process.env.BURROW_WORKSPACES ?? join(tmpdir(), "burrow-runs");

// First Ctrl+C: finish the current run, then exit. Second Ctrl+C: exit now; the run is
// cut off and its job stays "running" (M8 adds leases so another worker can take it over).
const stop = new AbortController();
const shutdown = () => {
  if (stop.signal.aborted) process.exit(130);
  console.log(`[${workerId}] stopping after the current run (Ctrl+C again to quit now)`);
  stop.abort();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(`[${workerId}] waiting for runs (workspaces: ${workspacesDir})`);
await runWorker({
  db,
  workerId,
  signal: stop.signal,
  executeRun: createRunExecutor({
    db,
    llm: createDeepSeekLLM({ apiKey: deepSeekApiKey, model: "deepseek-flash" }),
    pricing: deepSeekFlashPricing,
    createSandbox: (workdir) => createDockerSandbox({ workdir }),
    workspacesDir,
  }),
});
await db.$client.end();
console.log(`[${workerId}] stopped`);
