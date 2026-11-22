import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  appendEvent,
  createDb,
  createRepo,
  createRun,
  enqueueJob,
  getRun,
  listEventsAfter,
  type Run,
} from "@burrow/db";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { ExecuteRun } from "./run-executor.ts";
import { runWorker } from "./worker.ts";

// Real Postgres (skipped locally when it is not running, always run in CI) and a fake
// executeRun, so these tests are about the job lifecycle, not the agent.
const db = createDb();
const postgresIsRunning = await db.$client
  .query("select 1")
  .then(() => true)
  .catch(() => false);

describe.skipIf(!postgresIsRunning && !process.env.CI)("worker", () => {
  // Its own job type: the worker under test never takes real queued runs from this database.
  const jobType = `test-${randomUUID()}`;
  let repoId: string;

  beforeAll(async () => {
    repoId = (await createRepo(db, { name: `test-${randomUUID()}`, path: "/nowhere" })).id;
  });

  afterAll(async () => {
    await db.$client.query("delete from jobs where type = $1", [jobType]);
    await db.$client.query("delete from runs where repo_id = $1", [repoId]);
    await db.$client.query("delete from repos where id = $1", [repoId]);
    await db.$client.end();
  });

  async function queueTestRun(maxAttempts = 3) {
    const run = await createRun(db, { repoId, task: "x" });
    await enqueueJob(db, {
      type: jobType,
      key: `${jobType}:${run.id}`,
      payload: { runId: run.id },
      maxAttempts,
    });
    return run;
  }

  const jobOf = async (run: Run) => {
    const { rows } = await db.$client.query(
      "select status, attempts, last_error from jobs where key = $1",
      [`${jobType}:${run.id}`],
    );
    return rows[0] as { status: string; attempts: number; last_error: string | null };
  };

  // Runs a worker until `done` returns true (or 5 s pass), then stops it.
  async function runWorkerUntil(executeRun: ExecuteRun, done: () => Promise<boolean>) {
    const stop = new AbortController();
    const worker = runWorker({
      db,
      workerId: "test-worker",
      executeRun,
      signal: stop.signal,
      jobType,
      pollIntervalMs: 10,
      retryBaseDelayMs: 0,
    });
    const deadline = Date.now() + 5_000;
    while (!(await done()) && Date.now() < deadline) await sleep(10);
    stop.abort();
    await worker;
  }

  // Stands in for the agent: finishes the run like the real executor does.
  const finish: ExecuteRun = async (run) => {
    await appendEvent(db, run.id, { type: "done", data: {} }, { status: "succeeded" });
  };

  it("executes a queued run and completes its job", async () => {
    const run = await queueTestRun();
    const calls: number[] = [];

    await runWorkerUntil(
      async (r, repo, attempt) => {
        expect(repo.id).toBe(repoId);
        calls.push(attempt);
        await finish(r, repo, attempt);
      },
      async () => (await jobOf(run)).status === "succeeded",
    );

    expect(calls).toEqual([1]);
    expect(await jobOf(run)).toMatchObject({ status: "succeeded", attempts: 1 });
    expect((await getRun(db, run.id))?.status).toBe("succeeded");
  });

  it("retries a crashed attempt and tells the run", async () => {
    const run = await queueTestRun();
    const calls: number[] = [];

    await runWorkerUntil(
      async (r, repo, attempt) => {
        calls.push(attempt);
        if (attempt === 1) throw new Error("model API timeout");
        await finish(r, repo, attempt);
      },
      async () => (await jobOf(run)).status === "succeeded",
    );

    expect(calls).toEqual([1, 2]);
    const events = await listEventsAfter(db, run.id, 0);
    expect(events.map((e) => [e.type, e.data])).toEqual([
      ["attempt_failed", { attempt: 1, message: "model API timeout", willRetry: true }],
      ["done", {}],
    ]);
    expect((await getRun(db, run.id))?.status).toBe("succeeded");
  });

  it("fails the run when no attempts are left", async () => {
    const run = await queueTestRun(2);

    await runWorkerUntil(
      async () => {
        throw new Error("still down");
      },
      async () => (await jobOf(run)).status === "failed",
    );

    expect(await jobOf(run)).toMatchObject({
      status: "failed",
      attempts: 2,
      last_error: "still down",
    });
    const events = await listEventsAfter(db, run.id, 0);
    expect(events.map((e) => e.data)).toEqual([
      { attempt: 1, message: "still down", willRetry: true },
      { attempt: 2, message: "still down", willRetry: false },
    ]);
    expect((await getRun(db, run.id))?.status).toBe("failed");
  });

  it("does not execute a run that already finished", async () => {
    // As if a worker wrote the final event and stopped before completing the job.
    const run = await queueTestRun();
    await finish(run, { id: repoId, name: "", path: "", createdAt: new Date() }, 1);
    let executed = false;

    await runWorkerUntil(
      async () => {
        executed = true;
      },
      async () => (await jobOf(run)).status === "succeeded",
    );

    expect(executed).toBe(false);
    expect(await jobOf(run)).toMatchObject({ status: "succeeded" });
  });
});
