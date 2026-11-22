import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalSandbox, type Completion, type LLM } from "@burrow/agent";
import { createDb, createRepo, createRun, getRun, listEventsAfter, type Repo } from "@burrow/db";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createRunExecutor } from "./run-executor.ts";

// Real Postgres (skipped locally when it is not running, always run in CI), a scripted
// LLM instead of DeepSeek, and the local sandbox on a temp folder instead of Docker.
const db = createDb();
const postgresIsRunning = await db.$client
  .query("select 1")
  .then(() => true)
  .catch(() => false);

const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
const pricing = { inputPerMillion: 0, cachedInputPerMillion: 0, outputPerMillion: 0 };

const scriptedLLM = (replies: Completion[]): LLM => {
  let calls = 0;
  return {
    async complete() {
      const reply = replies[calls++];
      if (!reply) throw new Error("The model API is down");
      return reply;
    },
  };
};

describe.skipIf(!postgresIsRunning && !process.env.CI)("run executor", () => {
  let tempDir: string;
  let repo: Repo;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "burrow-executor-test-"));
    const repoDir = join(tempDir, "repo");
    await mkdir(repoDir);
    await writeFile(join(repoDir, "README.md"), "original");
    repo = await createRepo(db, { name: `test-${randomUUID()}`, path: repoDir });
  });

  afterAll(async () => {
    await db.$client.query("delete from runs where repo_id = $1", [repo.id]);
    await db.$client.query("delete from repos where id = $1", [repo.id]);
    await db.$client.end();
    await rm(tempDir, { recursive: true, force: true });
  });

  const execute = (llm: LLM) =>
    createRunExecutor({
      db,
      llm,
      pricing,
      createSandbox: async (workdir) => createLocalSandbox(workdir),
      workspacesDir: join(tempDir, "workspaces"),
    });

  it("records every agent event and marks the run running, then succeeded", async () => {
    const run = await createRun(db, { repoId: repo.id, task: "Change the README." });
    const llm = scriptedLLM([
      {
        message: {
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: "call_1",
              name: "write_file",
              arguments: JSON.stringify({ path: "README.md", content: "changed" }),
            },
          ],
        },
        stopReason: "tool_calls",
        usage,
      },
      {
        message: { role: "assistant", content: "Done.", toolCalls: [] },
        stopReason: "stop",
        usage,
      },
    ]);

    await execute(llm)(run, repo, 1);

    const events = await listEventsAfter(db, run.id, 0);
    expect(events.map((e) => e.type)).toEqual([
      "run_started",
      "model_call",
      "tool_call",
      "tool_result",
      "model_call",
      "done",
    ]);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(events.at(-1)?.data).toMatchObject({ result: { outcome: "done", answer: "Done." } });
    expect((await getRun(db, run.id))?.status).toBe("succeeded");

    // The agent changed its own copy; the registered folder is untouched.
    const workdir = join(tempDir, "workspaces", run.id, "attempt-1");
    expect(events[0]?.data).toEqual({ attempt: 1, workdir });
    expect(await readFile(join(workdir, "README.md"), "utf8")).toBe("changed");
    expect(await readFile(join(repo.path, "README.md"), "utf8")).toBe("original");
  });

  it("throws a crash to the caller after writing the events before it", async () => {
    const run = await createRun(db, { repoId: repo.id, task: "Anything." });

    await expect(execute(scriptedLLM([]))(run, repo, 2)).rejects.toThrow("The model API is down");

    // The worker decides what happens next (retry or fail), so the run is still running here.
    const events = await listEventsAfter(db, run.id, 0);
    expect(events.map((e) => [e.type, e.data])).toEqual([
      ["run_started", { attempt: 2, workdir: join(tempDir, "workspaces", run.id, "attempt-2") }],
    ]);
    expect((await getRun(db, run.id))?.status).toBe("running");
  });
});
