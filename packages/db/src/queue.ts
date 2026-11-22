import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { Db } from "./client.ts";
import { jobs } from "./schema.ts";

export type Job = typeof jobs.$inferSelect;

// The database or an open transaction, so a job can be enqueued together with other writes.
export type DbOrTx = PgDatabase<NodePgQueryResultHKT>;

// Adds a job unless one with the same key already exists. Returns whether it was added.
export async function enqueueJob(
  db: DbOrTx,
  job: { type: string; key: string; payload: unknown; maxAttempts?: number },
): Promise<boolean> {
  const added = await db
    .insert(jobs)
    .values(job)
    .onConflictDoNothing({ target: jobs.key })
    .returning({ id: jobs.id });
  return added.length > 0;
}

// Takes the oldest due job of one of these types and marks it running for this worker, or
// returns undefined if there is none. Safe to call from many workers at once: each gets a
// different job (see ADR 0002).
export async function claimJob(
  db: Db,
  workerId: string,
  types: readonly string[],
): Promise<Job | undefined> {
  const next = db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.status, "queued"), lte(jobs.runAt, sql`now()`), inArray(jobs.type, types)))
    .orderBy(asc(jobs.runAt), asc(jobs.id))
    .limit(1)
    // Lock the row we pick; rows other workers have locked are skipped, not waited for.
    .for("update", { skipLocked: true });

  const [job] = await db
    .update(jobs)
    .set({
      status: "running",
      attempts: sql`${jobs.attempts} + 1`,
      lockedBy: workerId,
      lockedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    // `id = (subquery)` makes Postgres pick (and lock) the job exactly once, as an InitPlan,
    // whatever plan it chooses. With `id IN (subquery)` it may instead plan a join that runs
    // the locking subquery again for every row it scans.
    .where(eq(jobs.id, sql`(${next})`))
    .returning();
  return job;
}

// Only the worker that holds a running job may finish it. Returns false if this worker no
// longer holds it, so a slow worker cannot overwrite what happened since.
const heldBy = (jobId: string, workerId: string) =>
  and(eq(jobs.id, jobId), eq(jobs.status, "running"), eq(jobs.lockedBy, workerId));

export async function completeJob(db: Db, jobId: string, workerId: string): Promise<boolean> {
  const done = await db
    .update(jobs)
    .set({ status: "succeeded", lockedBy: null, lockedAt: null, updatedAt: sql`now()` })
    .where(heldBy(jobId, workerId))
    .returning({ id: jobs.id });
  return done.length > 0;
}

// Records a failed attempt. If attempts are left the job goes back to the queue, due after
// a delay that doubles each time (baseDelayMs, 2×, 4×, …); otherwise it fails for good.
// Returns the job's new status, or undefined if this worker no longer holds it.
export async function failJob(
  db: Db,
  jobId: string,
  workerId: string,
  error: string,
  options: { baseDelayMs?: number } = {},
): Promise<"queued" | "failed" | undefined> {
  const baseDelayMs = options.baseDelayMs ?? 5_000;
  const retry = sql`${jobs.attempts} < ${jobs.maxAttempts}`;
  const [job] = await db
    .update(jobs)
    .set({
      status: sql`case when ${retry} then 'queued' else 'failed' end`,
      runAt: sql`case when ${retry}
        then now() + ${baseDelayMs} * power(2, ${jobs.attempts} - 1) * interval '1 millisecond'
        else ${jobs.runAt} end`,
      lastError: error,
      lockedBy: null,
      lockedAt: null,
      updatedAt: sql`now()`,
    })
    .where(heldBy(jobId, workerId))
    .returning({ status: jobs.status });
  return job?.status === "queued" || job?.status === "failed" ? job.status : undefined;
}
