import { randomUUID } from "node:crypto";
import { createDb, createRepo } from "@burrow/db";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createApp } from "./app.ts";

// Uses the real Postgres, like the event store tests: skipped locally when it is not
// running, always run in CI.
const db = createDb();
const postgresIsRunning = await db.$client
  .query("select 1")
  .then(() => true)
  .catch(() => false);

const apiKey = "test-key";
const app = createApp({ db, apiKey });

function request(path: string, init: RequestInit & { key?: string } = {}) {
  const { key = apiKey, ...rest } = init;
  return app.request(path, {
    ...rest,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
  });
}

describe.skipIf(!postgresIsRunning && !process.env.CI)("api", () => {
  let repoId: string;

  beforeAll(async () => {
    repoId = (await createRepo(db, { name: `test-${randomUUID()}`, path: "/nowhere" })).id;
  });

  afterAll(async () => {
    await db.$client.query("delete from runs where repo_id = $1", [repoId]);
    await db.$client.query("delete from repos where id = $1", [repoId]);
    await db.$client.end();
  });

  it("rejects requests without the right API key", async () => {
    expect((await app.request("/runs/x")).status).toBe(401);
    expect((await request("/runs/x", { key: "wrong" })).status).toBe(401);
  });

  it("creates a run and reads it back", async () => {
    const created = await request("/runs", {
      method: "POST",
      body: JSON.stringify({ repoId, task: "  Fix the tests  " }),
    });
    expect(created.status).toBe(201);
    const run = (await created.json()) as { id: string };
    expect(run).toMatchObject({ repoId, task: "Fix the tests", status: "running" });

    const fetched = await request(`/runs/${run.id}`);
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toEqual(run);
  });

  it("rejects a bad body with 400", async () => {
    for (const body of [{}, { repoId: "nope", task: "x" }, { repoId, task: "   " }]) {
      const res = await request("/runs", { method: "POST", body: JSON.stringify(body) });
      expect(res.status).toBe(400);
      expect(await res.json()).toHaveProperty("error");
    }
  });

  it("returns 404 for a repo or run that does not exist", async () => {
    const res = await request("/runs", {
      method: "POST",
      body: JSON.stringify({ repoId: randomUUID(), task: "x" }),
    });
    expect(res.status).toBe(404);

    expect((await request(`/runs/${randomUUID()}`)).status).toBe(404);
    expect((await request("/runs/not-a-uuid")).status).toBe(404);
  });
});
