import { setTimeout as sleep } from "node:timers/promises";
import {
  appendEvent,
  claimJob,
  completeJob,
  failJob,
  getRepo,
  getRun,
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

    // Delivery is at least once: this job may already have finished its run (say the
    // worker stopped right after the final event, before completing the job). Then there
    // is nothing left to do, and running the agent again would be wrong.
    if (run.status === "succeeded" || run.status === "failed") {
      await completeJob(db, job.id, workerId);
      return;
    }

    const repo = await getRepo(db, run.repoId);
    if (!repo) throw new Error(`Repo not found: ${run.repoId}`);

    console.log(`[${workerId}] run ${run.id}: attempt ${job.attempts} started`);
    await executeRun(run, repo, job.attempts);
    await completeJob(db, job.id, workerId);
    console.log(`[${workerId}] run ${run.id}: finished`);
  } catch (error) {
    // The attempt crashed. Put the job back with a delay, or fail it if no attempts are left,
    // and tell anyone watching the run what happened.
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
