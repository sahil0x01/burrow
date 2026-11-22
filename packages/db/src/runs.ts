import { eq } from "drizzle-orm";
import type { Db } from "./client.ts";
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

// A new run starts as "running": in M3 runs start immediately (M4 adds a queue).
export async function createRun(db: Db, run: { repoId: string; task: string }): Promise<Run> {
  const [row] = await db
    .insert(runs)
    .values({ ...run, status: "running" })
    .returning();
  if (!row) throw new Error("Insert returned no row");
  return row;
}

export async function getRun(db: Db, id: string): Promise<Run | undefined> {
  const [row] = await db.select().from(runs).where(eq(runs.id, id));
  return row;
}
