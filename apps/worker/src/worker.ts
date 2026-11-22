import { setTimeout as sleep } from "node:timers/promises";
import {
  appendEvent,
  claimJob,
  completeJob,
  failJob,
  getRepo,
  getRun,
  isFinished,
  RUN_JOB_TYPE,
  type Db,
  type Job,
} from "@burrow/db";
import { z } from "zod";
import type { ExecuteRun } from "./run-executor.ts";

export type WorkerOptions = {
  db: Db;
  // Shown in jobs.locked_by, so you can see which worker holds which job.
  workerId: string;
  executeRun: ExecuteRun;
  // When aborted, the worker finishes its current job and stops taking new ones.
  signal: AbortSignal;
  // How long to wait before looking again when the queue is empty. Default 1 s.
  pollIntervalMs?: number;
  // Delay before the first retry; it doubles after each failed attempt. Default 5 s.
  retryBaseDelayMs?: number;
  // How often a running run is checked for a cancel request. Default 1 s.
  cancelPollMs?: number;
  // Tests use their own job type, so they never take real queued runs.
  jobType?: string;
};

const runJobPayload = z.object({ runId: z.uuid() });

// Claims run jobs one at a time and executes them until `signal` is aborted.
export async function runWorker(options: WorkerOptions): Promise<void> {
  const { db, workerId, signal, pollIntervalMs = 1_000, jobType = RUN_JOB_TYPE } = options;

  while (!signal.aborted) {
    try {
      const job = await claimJob(db, workerId, [jobType]);
      if (job) {
        await processJob(options, job);
        continue;
      }
    } catch (error) {
      // Most likely the database is unreachable. Keep the worker alive and try again later.
      console.error(`[${workerId}] queue error:`, error);
    }
    // Nothing to do (or an error): wait, but wake up at once if we are told to stop.
    await sleep(pollIntervalMs, undefined, { signal }).catch(() => {});
  }
}

async function processJob(options: WorkerOptions, job: Job): Promise<void> {
  const { db, workerId, executeRun, retryBaseDelayMs = 5_000 } = options;
  let runId: string | undefined;

  try {
    runId = runJobPayload.parse(job.payload).runId;
    const run = await getRun(db, runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    if (await settled(options, job, run.id)) return;

    const repo = await getRepo(db, run.repoId);
    if (!repo) throw new Error(`Repo not found: ${run.repoId}`);

    console.log(`[${workerId}] run ${run.id}: attempt ${job.attempts} started`);
    const cancel = watchForCancel(options, run.id);
    try {
      await executeRun(run, repo, job.attempts, cancel.signal);
    } finally {
      cancel.stop();
    }
    await completeJob(db, job.id, workerId);
    console.log(`[${workerId}] run ${run.id}: finished`);
  } catch (error) {
    // The run may have been cancelled or finished while this attempt was crashing (for
    // example, a cancel arrived just before the attempt marked the run running, and that
    // status change was refused). Then there is nothing to retry.
    if (runId && (await settled(options, job, runId))) return;

    // Otherwise put the job back with a delay, or fail it if no attempts are left, and tell
    // anyone watching the run what happened.
    const message = error instanceof Error ? error.message : String(error);
    const status = await failJob(db, job.id, workerId, message, {
      baseDelayMs: retryBaseDelayMs,
    });
    console.error(`[${workerId}] run ${runId ?? "?"}: attempt ${job.attempts} failed: ${message}`);
    if (runId && status) {
      await appendEvent(
        db,
        runId,
        {
          type: "attempt_failed",
          data: { attempt: job.attempts, message, willRetry: status === "queued" },
        },
        { status: status === "queued" ? "queued" : "failed" },
      );
    }
  }
}

// If the run needs no (more) work, completes the job and returns true:
// - it already finished: delivery is at least once, so this job may have run before (say the
//   worker stopped right after the final event, before completing the job);
// - a cancel was requested: mark it cancelled instead of starting or retrying it.
async function settled(options: WorkerOptions, job: Job, runId: string): Promise<boolean> {
  const { db, workerId } = options;
  const run = await getRun(db, runId);
  if (!run) return false;

  if (!isFinished(run.status) && run.cancelRequestedAt !== null) {
    await appendEvent(db, runId, { type: "cancelled", data: {} }, { status: "cancelled" });
  } else if (!isFinished(run.status)) {
    return false;
  }
  await completeJob(db, job.id, workerId);
  console.log(
    `[${workerId}] run ${runId}: nothing to do (${run.cancelRequestedAt ? "cancelled" : run.status})`,
  );
  return true;
}

// Checks the run every cancelPollMs while it executes, and aborts the signal once a cancel
// has been requested. The agent sees it before its next step.
function watchForCancel(options: WorkerOptions, runId: string) {
  const { db, cancelPollMs = 1_000 } = options;
  const cancel = new AbortController();
  const done = new AbortController();

  void (async () => {
    while (!done.signal.aborted && !cancel.signal.aborted) {
      await sleep(cancelPollMs, undefined, { signal: done.signal }).catch(() => {});
      if (done.signal.aborted) return;
      const run = await getRun(db, runId).catch(() => undefined);
      if (run?.cancelRequestedAt) cancel.abort();
    }
  })();

  return { signal: cancel.signal, stop: () => done.abort() };
}
