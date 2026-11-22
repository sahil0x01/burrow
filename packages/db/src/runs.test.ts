import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { createDb } from "./client.ts";
import { createRepo, queueRun } from "./runs.ts";

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
});
