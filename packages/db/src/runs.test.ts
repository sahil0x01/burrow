import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { createDb } from "./client.ts";
import { appendEvent, listEventsAfter } from "./event-store.ts";
import { createRepo, createRun, getRun, queueRun, requestCancel } from "./runs.ts";

// Real Postgres (skipped locally when it is not running, always run in CI).
const db = createDb();
const postgresIsRunning = await db.$client
  .query("select 1")
  .then(() => true)
  .catch(() => false);

describe.skipIf(!postgresIsRunning && !process.env.CI)("queueRun", () => {
  const repoIds: string[] = [];

  afterAll(async () => {
    for (const repoId of repoIds) {
      await db.$client.query(
        "delete from jobs where key in (select 'run:' || id from runs where repo_id = $1)",
        [repoId],
      );
      await db.$client.query("delete from runs where repo_id = $1", [repoId]);
      await db.$client.query("delete from repos where id = $1", [repoId]);
    }
    await db.$client.end();
  });

  it("creates a queued run and its job", async () => {
    const repo = await createRepo(db, { name: `test-${randomUUID()}`, path: "/nowhere" });
    repoIds.push(repo.id);

    const run = await queueRun(db, { repoId: repo.id, task: "x" });

    expect(run.status).toBe("queued");
    const { rows } = await db.$client.query(
      "select type, payload, status from jobs where key = $1",
      [`run:${run.id}`],
    );
    expect(rows).toEqual([{ type: "run", payload: { runId: run.id }, status: "queued" }]);
  });

  describe("requestCancel", () => {
    async function newRun() {
      const repo = await createRepo(db, { name: `test-${randomUUID()}`, path: "/nowhere" });
      repoIds.push(repo.id);
      return createRun(db, { repoId: repo.id, task: "x" });
    }
    const types = async (runId: string) => (await listEventsAfter(db, runId, 0)).map((e) => e.type);

    it("cancels a queued run at once", async () => {
      const run = await newRun();

      expect(await requestCancel(db, run.id)).toBe("cancelled");

      expect((await getRun(db, run.id))?.status).toBe("cancelled");
      expect(await types(run.id)).toEqual(["cancelled"]);
    });

    it("only asks a running run to stop, and records the request once", async () => {
      const run = await newRun();
      await appendEvent(db, run.id, { type: "run_started", data: {} }, { status: "running" });

      expect(await requestCancel(db, run.id)).toBe("requested");
      expect(await requestCancel(db, run.id)).toBe("requested");

      const after = await getRun(db, run.id);
      expect(after?.status).toBe("running");
      expect(after?.cancelRequestedAt).toBeInstanceOf(Date);
      expect(await types(run.id)).toEqual(["run_started", "cancel_requested"]);
    });

    it("leaves a finished run alone", async () => {
      const run = await newRun();
      await requestCancel(db, run.id);

      expect(await requestCancel(db, run.id)).toBe("finished");
      expect(await requestCancel(db, randomUUID())).toBe("not_found");
    });

    it("refuses status changes the state machine does not allow", async () => {
      const run = await newRun();
      await requestCancel(db, run.id);

      await expect(
        appendEvent(db, run.id, { type: "run_started", data: {} }, { status: "running" }),
      ).rejects.toThrow("cannot go from cancelled to running");
      // Nothing was written.
      expect(await types(run.id)).toEqual(["cancelled"]);
    });
  });
});
