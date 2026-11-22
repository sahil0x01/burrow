import { randomUUID } from "node:crypto";
import { appendEvent, createDb, createRepo, createRun } from "@burrow/db";
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
// Fast polling, so the live-stream test does not wait half a second per check.
const app = createApp({ db, apiKey, pollIntervalMs: 20 });

function request(
  path: string,
  init: Omit<RequestInit, "headers"> & { key?: string; headers?: Record<string, string> } = {},
) {
  const { key = apiKey, headers, ...rest } = init;
  return app.request(path, {
    ...rest,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, ...headers },
  });
}

// Reads a whole SSE response (it must end) and returns its events as [id, type, data].
async function readEvents(res: Response) {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((block) => block.trim() !== "")
    .map((block) => {
      const field = (name: string) =>
        block
          .split("\n")
          .find((line) => line.startsWith(`${name}: `))
          ?.slice(name.length + 2);
      return [field("id"), field("event"), JSON.parse(field("data") ?? "null")];
    });
}

describe.skipIf(!postgresIsRunning && !process.env.CI)("api", () => {
  let repoId: string;

  beforeAll(async () => {
    repoId = (await createRepo(db, { name: `test-${randomUUID()}`, path: "/nowhere" })).id;
  });

  afterAll(async () => {
    // Jobs do not reference runs with a foreign key, so delete them by their key.
    await db.$client.query(
      "delete from jobs where key in (select 'run:' || id from runs where repo_id = $1)",
      [repoId],
    );
    await db.$client.query("delete from runs where repo_id = $1", [repoId]);
    await db.$client.query("delete from repos where id = $1", [repoId]);
    await db.$client.end();
  });

  it("rejects requests without the right API key", async () => {
    expect((await app.request("/runs/x")).status).toBe(401);
    expect((await request("/runs/x", { key: "wrong" })).status).toBe(401);
  });

  it("queues a run with its job and reads it back", async () => {
    const created = await request("/runs", {
      method: "POST",
      body: JSON.stringify({ repoId, task: "  Fix the tests  " }),
    });
    expect(created.status).toBe(201);
    const run = (await created.json()) as { id: string };
    expect(run).toMatchObject({ repoId, task: "Fix the tests", status: "queued" });

    const { rows: jobs } = await db.$client.query(
      "select type, payload, status from jobs where key = $1",
      [`run:${run.id}`],
    );
    expect(jobs).toEqual([{ type: "run", payload: { runId: run.id }, status: "queued" }]);

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

  describe("GET /runs/:id/events", () => {
    async function finishedRun(count: number) {
      const run = await createRun(db, { repoId, task: "x" });
      for (let i = 1; i <= count; i++) {
        // Like a real run: the first event moves it to running, the last one finishes it.
        const status = i === count ? "succeeded" : i === 1 ? "running" : undefined;
        await appendEvent(
          db,
          run.id,
          { type: i === count ? "done" : "step", data: { i } },
          status && { status },
        );
      }
      return run;
    }

    it("sends every event of a finished run, then ends", async () => {
      const run = await finishedRun(3);

      const res = await request(`/runs/${run.id}/events`);

      expect(res.headers.get("Content-Type")).toBe("text/event-stream");
      expect(await readEvents(res)).toEqual([
        ["1", "step", { i: 1 }],
        ["2", "step", { i: 2 }],
        ["3", "done", { i: 3 }],
      ]);
    });

    it("resumes after Last-Event-ID", async () => {
      const run = await finishedRun(3);

      const res = await request(`/runs/${run.id}/events`, { headers: { "Last-Event-ID": "2" } });

      expect(await readEvents(res)).toEqual([["3", "done", { i: 3 }]]);
    });

    it("streams events of an unfinished run as they are written", async () => {
      // Still queued: the stream stays open until the run succeeds or fails.
      const run = await createRun(db, { repoId, task: "x" });
      await appendEvent(db, run.id, { type: "step", data: { i: 1 } }, { status: "running" });

      // Start reading before the run finishes.
      const events = Promise.resolve(request(`/runs/${run.id}/events`)).then(readEvents);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await appendEvent(db, run.id, { type: "step", data: { i: 2 } });
      await appendEvent(db, run.id, { type: "done", data: { i: 3 } }, { status: "failed" });

      expect(await events).toEqual([
        ["1", "step", { i: 1 }],
        ["2", "step", { i: 2 }],
        ["3", "done", { i: 3 }],
      ]);
    });

    it("rejects a Last-Event-ID that is not a whole number", async () => {
      const run = await finishedRun(2);
      for (const id of ["abc", "-1", "1.5"]) {
        const res = await request(`/runs/${run.id}/events`, { headers: { "Last-Event-ID": id } });
        expect(res.status).toBe(400);
      }
    });

    it("returns 404 for a run that does not exist", async () => {
      expect((await request(`/runs/${randomUUID()}/events`)).status).toBe(404);
    });
  });

  describe("POST /runs/:id/cancel", () => {
    const cancel = (id: string) => request(`/runs/${id}/cancel`, { method: "POST" });

    it("cancels a queued run with 200", async () => {
      const run = await createRun(db, { repoId, task: "x" });

      const res = await cancel(run.id);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ result: "cancelled" });
    });

    it("asks a running run to stop with 202", async () => {
      const run = await createRun(db, { repoId, task: "x" });
      await appendEvent(db, run.id, { type: "run_started", data: {} }, { status: "running" });

      const res = await cancel(run.id);

      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ result: "requested" });
    });

    it("returns 409 for a finished run and 404 for a missing one", async () => {
      const run = await createRun(db, { repoId, task: "x" });
      await cancel(run.id);

      expect((await cancel(run.id)).status).toBe(409);
      expect((await cancel(randomUUID())).status).toBe(404);
      expect((await cancel("not-a-uuid")).status).toBe(404);
    });

    it("ends the event stream of a cancelled run", async () => {
      const run = await createRun(db, { repoId, task: "x" });
      await cancel(run.id);

      const res = await request(`/runs/${run.id}/events`);

      expect(await readEvents(res)).toEqual([["1", "cancelled", {}]]);
    });
  });
});
