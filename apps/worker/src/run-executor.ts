import { cp } from "node:fs/promises";
import { join } from "node:path";
import {
  allowOnly,
  AUTO_APPROVED_COMMANDS,
  CODING_AGENT_SYSTEM_PROMPT,
  createRunCommandTool,
  readFileTool,
  runAgent,
  writeFileTool,
  type AgentEvent,
  type AgentResult,
  type LLM,
  type Pricing,
  type Sandbox,
} from "@burrow/agent";
import { appendEvent, type Db, type Repo, type Run, type RunStatus } from "@burrow/db";

export type RunExecutorOptions = {
  db: Db;
  llm: LLM;
  pricing: Pricing;
  createSandbox: (workdir: string) => Promise<Sandbox>;
  // Each run works on its own copy of the repo, in <workspacesDir>/<run id>.
  workspacesDir: string;
};

// `attempt` is 1 for the first try, 2 for the first retry, and so on. When `signal` is
// aborted (the run was cancelled), the agent stops before its next step.
export type ExecuteRun = (
  run: Run,
  repo: Repo,
  attempt: number,
  signal: AbortSignal,
) => Promise<void>;

// The run status each way the agent can end.
const finalStatus = {
  done: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
} as const satisfies Record<AgentResult["outcome"], RunStatus>;

// Runs the agent for a run and records everything it does as events. The agent's own
// outcome (done, or stopped by a limit) ends the run with its final status. Anything that
// crashes the attempt (the copy, the model API, the database) is thrown, after all earlier
// events are written, so the worker can decide whether to retry.
export function createRunExecutor(options: RunExecutorOptions): ExecuteRun {
  const { db, llm, pricing, createSandbox, workspacesDir } = options;

  return async (run, repo, attempt, signal) => {
    // The agent emits events without waiting, but appendEvent is async. Chaining every write
    // onto the previous one keeps them in the order they happened. The chain itself never
    // rejects (a rejection nobody awaits yet would crash the whole server); the first failed
    // write is kept in `writeError`, later writes are skipped, and the run fails below.
    let writes: Promise<void> = Promise.resolve();
    let writeError: unknown;
    const record = (type: string, data: unknown, status?: RunStatus) => {
      writes = writes
        .then(async () => {
          if (writeError === undefined) {
            await appendEvent(db, run.id, { type, data }, status && { status });
          }
        })
        .catch((error: unknown) => {
          writeError ??= error;
        });
    };
    const flush = async () => {
      await writes;
      if (writeError !== undefined) throw writeError;
    };

    let sandbox: Sandbox | undefined;
    try {
      // A fresh copy per attempt, so the registered folder is never changed, two runs never
      // share files, and a retry does not start from a half-finished attempt.
      const workdir = join(workspacesDir, run.id, `attempt-${attempt}`);
      await cp(repo.path, workdir, { recursive: true, errorOnExist: true, force: false });
      record("run_started", { attempt, workdir }, "running");
      await flush();

      sandbox = await createSandbox(workdir);
      await runAgent({
        llm,
        tools: [
          readFileTool,
          writeFileTool,
          createRunCommandTool(allowOnly(AUTO_APPROVED_COMMANDS)),
        ],
        context: { sandbox },
        systemPrompt: CODING_AGENT_SYSTEM_PROMPT,
        task: run.task,
        maxSteps: 30,
        pricing,
        maxCostUsd: 0.05,
        maxWallTimeMs: 10 * 60_000,
        signal,
        onEvent: (event: AgentEvent) => {
          const { type, ...data } = event;
          // The last event also sets the run's final status, in the same transaction.
          const status = event.type === "done" ? finalStatus[event.result.outcome] : undefined;
          record(type, data, status);
        },
      });
      await flush();
    } catch (error) {
      // Let earlier writes finish first (this never rejects), so whatever the worker records
      // about this failure comes after them.
      await writes;
      throw error;
    } finally {
      await sandbox?.destroy().catch((destroyError: unknown) => {
        console.error(`Could not destroy the sandbox of run ${run.id}:`, destroyError);
      });
    }
  };
}
