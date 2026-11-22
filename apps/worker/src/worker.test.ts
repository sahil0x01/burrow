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
  requestCancel,
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
      cancelPollMs: 10,
    });
    const deadline = Date.now() + 5_000;
    while (!(await done()) && Date.now() < deadline) await sleep(10);
    stop.abort();
    await worker;
  }

  // Stand in for the executor: mark the run running, then finish it.
  const start = (runId: string) =>
    appendEvent(db, runId, { type: "run_started", data: {} }, { status: "running" });
  const finish = async (runId: string) => {
    await start(runId);
    await appendEvent(db, runId, { type: "done", data: {} }, { status: "succeeded" });
  };

  it("executes a queued run and completes its job", async () => {
    const run = await queueTestRun();
    const calls: number[] = [];

    await runWorkerUntil(
      async (r, repo, attempt) => {
        expect(repo.id).toBe(repoId);
        calls.push(attempt);
        await finish(r.id);
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
      async (r, _repo, attempt) => {
        calls.push(attempt);
        if (attempt === 1) throw new Error("model API timeout");
        await finish(r.id);
      },
      async () => (await jobOf(run)).status === "succeeded",
    );

    expect(calls).toEqual([1, 2]);
    const events = await listEventsAfter(db, run.id, 0);
    expect(events.map((e) => [e.type, e.data])).toEqual([
      ["attempt_failed", { attempt: 1, message: "model API timeout", willRetry: true }],
      ["run_started", {}],
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
    await finish(run.id);
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

  it("stops a running run when it is cancelled", async () => {
    const run = await queueTestRun();
    let cancelled = false;

    await runWorkerUntil(
      // Like the agent: keep taking steps until the signal says stop, then end as cancelled.
      async (r, _repo, _attempt, signal) => {
        await start(r.id);
        while (!signal.aborted) await sleep(5);
        await appendEvent(db, r.id, { type: "done", data: {} }, { status: "cancelled" });
      },
      async () => {
        if (!cancelled && (await getRun(db, run.id))?.status === "running") {
          expect(await requestCancel(db, run.id)).toBe("requested");
          cancelled = true;
        }
        return (await jobOf(run)).status === "succeeded";
      },
    );

    expect((await getRun(db, run.id))?.status).toBe("cancelled");
    const types = (await listEventsAfter(db, run.id, 0)).map((e) => e.type);
    expect(types).toEqual(["run_started", "cancel_requested", "done"]);
  });

  it("never starts a run cancelled while it was queued", async () => {
    const run = await queueTestRun();
    expect(await requestCancel(db, run.id)).toBe("cancelled");
    let executed = false;

    await runWorkerUntil(
      async () => {
        executed = true;
      },
      async () => (await jobOf(run)).status === "succeeded",
    );

    expect(executed).toBe(false);
    expect((await getRun(db, run.id))?.status).toBe("cancelled");
  });

  it("does not retry when a cancel arrives just as the attempt starts", async () => {
    // The race: the worker checked the run (queued, not cancelled), then a cancel landed
    // before the attempt marked it running. That status change is refused, and the worker
    // must see the run is cancelled instead of retrying it.
    const run = await queueTestRun();
    const calls: number[] = [];

    await runWorkerUntil(
      async (r, _repo, attempt) => {
        calls.push(attempt);
        await requestCancel(db, r.id);
        await start(r.id);
      },
      async () => (await jobOf(run)).status === "succeeded",
    );

    expect(calls).toEqual([1]);
    expect((await getRun(db, run.id))?.status).toBe("cancelled");
    const types = (await listEventsAfter(db, run.id, 0)).map((e) => e.type);
    expect(types).toEqual(["cancelled"]);
  });
});
