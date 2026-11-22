import { eq } from "drizzle-orm";
import type { Db } from "./client.ts";
import { enqueueJob, type DbOrTx } from "./queue.ts";
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
