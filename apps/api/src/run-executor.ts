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

export type ExecuteRun = (run: Run, repo: Repo) => Promise<void>;

// Runs the agent for a run and records everything it does as events. Never throws: any
// failure becomes a `run_error` event and the run is marked failed.
export function createRunExecutor(options: RunExecutorOptions): ExecuteRun {
  const { db, llm, pricing, createSandbox, workspacesDir } = options;

  return async (run, repo) => {
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
      // A copy, so the registered folder is never changed and two runs never share files.
      const workdir = join(workspacesDir, run.id);
      await cp(repo.path, workdir, { recursive: true, errorOnExist: true, force: false });
      record("run_started", { workdir });
      await flush();

      sandbox = await createSandbox(workdir);
      await runAgent({
        llm,
        tools: [
          readFileTool,
          writeFileTool,
          createRunCommandTool({ approve: allowOnly(AUTO_APPROVED_COMMANDS) }),
        ],
        context: { sandbox },
        systemPrompt: CODING_AGENT_SYSTEM_PROMPT,
        task: run.task,
        maxSteps: 30,
        pricing,
        maxCostUsd: 0.05,
        maxWallTimeMs: 10 * 60_000,
        onEvent: (event: AgentEvent) => {
          const { type, ...data } = event;
          // The last event also sets the run's final status, in the same transaction.
          const status =
            event.type === "done"
              ? event.result.outcome === "done"
                ? "succeeded"
                : "failed"
              : undefined;
          record(type, data, status);
        },
      });
      await flush();
    } catch (error) {
      // Wait for earlier writes (this never rejects), so run_error is the last event. It is
      // written directly: if the database is what failed, this may fail too; then we can only log.
      await writes;
      const message = error instanceof Error ? error.message : String(error);
      await appendEvent(
        db,
        run.id,
        { type: "run_error", data: { message } },
        { status: "failed" },
      ).catch((recordError: unknown) => {
        console.error(`Could not record the failure of run ${run.id}:`, recordError);
      });
    } finally {
      await sandbox?.destroy().catch((destroyError: unknown) => {
        console.error(`Could not destroy the sandbox of run ${run.id}:`, destroyError);
      });
    }
  };
}
