import { eq, sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import { appendToLockedRun, lockRun } from "./event-store.ts";
import { enqueueJob, type DbOrTx } from "./queue.ts";
import { isFinished } from "./run-status.ts";
import { repos, runs } from "./schema.ts";

export type Repo = typeof repos.$inferSelect;
export type Run = typeof runs.$inferSelect;

export async function createRepo(db: Db, repo: { name: string; path: string }): Promise<Repo> {
  const [row] = await db.insert(repos).values(repo).returning();
  if (!row) throw new Error("Insert returned no row");
  return row;
}

export async function getRepo(db: Db, id: string): Promise<Repo | undefined> {
  const [row] = await db.select().from(repos).where(eq(repos.id, id));
  return row;
}

// The job type workers claim to execute a run. Its payload is { runId }.
export const RUN_JOB_TYPE = "run";

// Inserts a run as "queued". On its own it is never picked up: use queueRun, which also
// adds the job a worker claims. (Tests use createRun alone to get a run row.)
export async function createRun(db: DbOrTx, run: { repoId: string; task: string }): Promise<Run> {
  const [row] = await db
    .insert(runs)
    .values({ ...run, status: "queued" })
    .returning();
  if (!row) throw new Error("Insert returned no row");
  return row;
}

// Creates a run and the job that will execute it, in one transaction: either both exist or
// neither does, so a run can never sit "queued" with no job to pick it up.
export async function queueRun(db: Db, run: { repoId: string; task: string }): Promise<Run> {
  return db.transaction(async (tx) => {
    const created = await createRun(tx, run);
    await enqueueJob(tx, {
      type: RUN_JOB_TYPE,
      key: `run:${created.id}`,
      payload: { runId: created.id },
    });
    return created;
  });
}

export async function getRun(db: Db, id: string): Promise<Run | undefined> {
  const [row] = await db.select().from(runs).where(eq(runs.id, id));
  return row;
}

// What POST /runs/:id/cancel did:
// - "cancelled": the run was waiting, so it is cancelled right away.
// - "requested": a worker is running it; it will stop before the agent's next step.
// - "finished": too late, it already ended. "not_found": no such run.
export type CancelResult = "cancelled" | "requested" | "finished" | "not_found";

export async function requestCancel(db: Db, runId: string): Promise<CancelResult> {
  return db.transaction(async (tx) => {
    // Holding the run's lock means no worker can start or finish it while we decide.
    const run = await lockRun(tx, runId);
    if (!run) return "not_found";
    if (isFinished(run.status)) return "finished";

    const alreadyRequested = run.cancelRequestedAt !== null;
    await tx
      .update(runs)
      .set({ cancelRequestedAt: sql`coalesce(${runs.cancelRequestedAt}, now())` })
      .where(eq(runs.id, runId));

    if (run.status === "queued") {
      // No agent is running it. A worker that claims its job later sees it is finished
      // and just completes the job.
      await appendToLockedRun(tx, runId, run.status, { type: "cancelled", data: {} }, "cancelled");
      return "cancelled";
    }
    // Asking twice is fine; only the first request is recorded as an event.
    if (!alreadyRequested) {
      await appendToLockedRun(tx, runId, run.status, { type: "cancel_requested", data: {} });
    }
    return "requested";
  });
}
