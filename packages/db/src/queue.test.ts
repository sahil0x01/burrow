import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { createDb } from "./client.ts";
import { claimJob, completeJob, enqueueJob, failJob } from "./queue.ts";
import { jobs } from "./schema.ts";

// Real Postgres (skipped locally when it is not running, always run in CI).
const db = createDb();
const postgresIsRunning = await db.$client
  .query("select 1")
  .then(() => true)
  .catch(() => false);

describe.skipIf(!postgresIsRunning && !process.env.CI)("queue", () => {
  // Each test uses its own job type, so it only ever claims its own jobs.
  const types: string[] = [];
  const newType = () => {
    const type = `test-${randomUUID()}`;
    types.push(type);
    return type;
  };
  const enqueue = (type: string, key: string = randomUUID(), maxAttempts?: number) =>
    enqueueJob(db, { type, key, payload: { key }, ...(maxAttempts && { maxAttempts }) });
  const jobsOf = (type: string) => db.select().from(jobs).where(eq(jobs.type, type));

  afterAll(async () => {
    for (const type of types) {
      await db.delete(jobs).where(eq(jobs.type, type));
    }
    await db.$client.end();
  });

  it("adds a job only once per key", async () => {
    const type = newType();
    const key = `run:${randomUUID()}`;

    expect(await enqueue(type, key)).toBe(true);
    expect(await enqueue(type, key)).toBe(false);
    expect(await jobsOf(type)).toHaveLength(1);
  });

  it("claims the oldest job and marks it running for this worker", async () => {
    const type = newType();
    // Keys are unique across all jobs, so prefix them with this test's type.
    await enqueue(type, `${type}:first`);
    await enqueue(type, `${type}:second`);

    const job = await claimJob(db, "worker-1", [type]);

    expect(job).toMatchObject({
      key: `${type}:first`,
      status: "running",
      attempts: 1,
      lockedBy: "worker-1",
    });
    expect(job?.lockedAt).toBeInstanceOf(Date);
  });

  it("returns nothing when no job is due", async () => {
    const type = newType();
    await enqueue(type);
    await db
      .update(jobs)
      .set({ runAt: sql`now() + interval '1 hour'` })
      .where(eq(jobs.type, type));

    expect(await claimJob(db, "worker-1", [type])).toBeUndefined();
    expect(await claimJob(db, "worker-1", [newType()])).toBeUndefined();
  });

  it("never gives the same job to two workers", async () => {
    const type = newType();
    for (let i = 0; i < 20; i++) await enqueue(type);

    // 5 workers claim at the same time until the queue is empty.
    const claimed: string[] = [];
    await Promise.all(
      Array.from({ length: 5 }, async (_, w) => {
        for (;;) {
          const job = await claimJob(db, `worker-${w}`, [type]);
          if (!job) return;
          claimed.push(job.id);
        }
      }),
    );

    expect(claimed).toHaveLength(20);
    expect(new Set(claimed).size).toBe(20);
  });

  it("skips a job another worker is busy claiming instead of waiting for it", async () => {
    const type = newType();
    await enqueue(type, `${type}:first`);
    await enqueue(type, `${type}:second`);

    // Another connection locks the first job and keeps its transaction open, like a
    // worker paused in the middle of claiming it.
    const other = await db.$client.connect();
    try {
      await other.query("begin");
      await other.query("select id from jobs where key = $1 for update", [`${type}:first`]);

      // Without SKIP LOCKED this claim would wait for that lock; with it, it moves on.
      const timeout = new Promise<"waited">((resolve) => setTimeout(resolve, 1_000, "waited"));
      const job = await Promise.race([claimJob(db, "worker-2", [type]), timeout]);

      expect(job).toMatchObject({ key: `${type}:second` });
    } finally {
      await other.query("rollback");
      other.release();
    }
  });

  it("lets only the worker holding a job complete it", async () => {
    const type = newType();
    await enqueue(type);
    const job = await claimJob(db, "worker-1", [type]);
    if (!job) throw new Error("expected a job");

    expect(await completeJob(db, job.id, "worker-2")).toBe(false);
    expect(await completeJob(db, job.id, "worker-1")).toBe(true);
    expect(await completeJob(db, job.id, "worker-1")).toBe(false);
    expect((await jobsOf(type))[0]).toMatchObject({
      status: "succeeded",
      lockedBy: null,
      lockedAt: null,
    });
  });

  it("puts a failed job back with a growing delay, then fails it for good", async () => {
    const type = newType();
    await enqueue(type, undefined, 2);

    const first = await claimJob(db, "worker-1", [type]);
    if (!first) throw new Error("expected a job");
    expect(await failJob(db, first.id, "worker-1", "boom 1")).toBe("queued");

    // Not due yet: the default delay after the first attempt is 5 s.
    const [waiting] = await jobsOf(type);
    expect(waiting).toMatchObject({ status: "queued", attempts: 1, lastError: "boom 1" });
    expect(await claimJob(db, "worker-1", [type])).toBeUndefined();
    const delayMs = (waiting?.runAt.getTime() ?? 0) - (waiting?.updatedAt.getTime() ?? 0);
    expect(delayMs).toBe(5_000);

    // Make it due now and fail the last attempt.
    await db
      .update(jobs)
      .set({ runAt: sql`now()` })
      .where(eq(jobs.type, type));
    const second = await claimJob(db, "worker-2", [type]);
    expect(second?.attempts).toBe(2);
    expect(await failJob(db, first.id, "worker-2", "boom 2")).toBe("failed");
    expect((await jobsOf(type))[0]).toMatchObject({
      status: "failed",
      attempts: 2,
      lastError: "boom 2",
    });
  });

  it("doubles the delay with every attempt", async () => {
    const type = newType();
    await enqueue(type, undefined, 5);
    const delays: number[] = [];

    for (let attempt = 1; attempt <= 3; attempt++) {
      await db
        .update(jobs)
        .set({ runAt: sql`now()` })
        .where(eq(jobs.type, type));
      const job = await claimJob(db, "worker-1", [type]);
      if (!job) throw new Error("expected a job");
      await failJob(db, job.id, "worker-1", "boom", { baseDelayMs: 1_000 });
      const [row] = await jobsOf(type);
      delays.push((row?.runAt.getTime() ?? 0) - (row?.updatedAt.getTime() ?? 0));
    }

    expect(delays).toEqual([1_000, 2_000, 4_000]);
  });
});
