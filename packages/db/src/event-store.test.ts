import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { createDb } from "./client.ts";
import { appendEvent, listEventsAfter } from "./event-store.ts";
import { createRepo, createRun, getRun } from "./runs.ts";
import { repos, runs } from "./schema.ts";

// These tests talk to a real Postgres with migrations applied (`docker compose up -d --wait`,
// then `pnpm migrate` in packages/db). Skipped locally when it is not running; in CI they
// always run, so a broken database setup fails the build instead of skipping quietly.
const db = createDb();
const postgresIsRunning = await db.$client
  .query("select 1")
  .then(() => true)
  .catch(() => false);

describe.skipIf(!postgresIsRunning && !process.env.CI)("event store", () => {
  // Every test makes its own repo and run, so tests never see each other's rows.
  const repoIds: string[] = [];

  async function newRun() {
    const repo = await createRepo(db, { name: `test-${randomUUID()}`, path: "/nowhere" });
    repoIds.push(repo.id);
    return createRun(db, { repoId: repo.id, task: "test task" });
  }

  afterAll(async () => {
    if (repoIds.length > 0) {
      // Deleting the runs also deletes their events (on delete cascade).
      await db.delete(runs).where(inArray(runs.repoId, repoIds));
      await db.delete(repos).where(inArray(repos.id, repoIds));
    }
    await db.$client.end();
  });

  it("numbers events 1, 2, 3 per run", async () => {
    const run = await newRun();
    const other = await newRun();

    expect(await appendEvent(db, run.id, { type: "a", data: {} })).toBe(1);
    expect(await appendEvent(db, run.id, { type: "b", data: {} })).toBe(2);
    expect(await appendEvent(db, other.id, { type: "a", data: {} })).toBe(1);
    expect(await appendEvent(db, run.id, { type: "c", data: {} })).toBe(3);
  });

  it("never gives two concurrent appends the same seq", async () => {
    const run = await newRun();

    const seqs = await Promise.all(
      Array.from({ length: 20 }, (_, i) => appendEvent(db, run.id, { type: "e", data: { i } })),
    );

    expect(seqs.toSorted((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it("lists events after a seq, oldest first, with their data", async () => {
    const run = await newRun();
    for (const type of ["a", "b", "c", "d"]) {
      await appendEvent(db, run.id, { type, data: { type } });
    }

    const all = await listEventsAfter(db, run.id, 0);
    const rest = await listEventsAfter(db, run.id, 2);

    expect(all.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(rest.map((e) => [e.seq, e.type, e.data])).toEqual([
      [3, "c", { type: "c" }],
      [4, "d", { type: "d" }],
    ]);
    expect(rest[0]?.version).toBe(1);
    expect(await listEventsAfter(db, run.id, 4)).toEqual([]);
  });

  it("changes the run status together with the event", async () => {
    const run = await newRun();

    await appendEvent(db, run.id, { type: "step", data: {} });
    expect((await getRun(db, run.id))?.status).toBe("queued");

    await appendEvent(db, run.id, { type: "started", data: {} }, { status: "running" });
    expect((await getRun(db, run.id))?.status).toBe("running");

    await appendEvent(db, run.id, { type: "done", data: {} }, { status: "succeeded" });
    expect((await getRun(db, run.id))?.status).toBe("succeeded");
  });

  it("rejects an event for a run that does not exist", async () => {
    await expect(appendEvent(db, randomUUID(), { type: "a", data: {} })).rejects.toThrow(
      "Run not found",
    );
  });
});
