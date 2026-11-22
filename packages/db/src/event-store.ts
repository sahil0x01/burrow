import { and, asc, eq, gt, max, sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import { events, runs, type runStatuses } from "./schema.ts";

export type RunStatus = (typeof runStatuses)[number];

export type NewEvent = {
  type: string;
  data: unknown;
  version?: number;
};

export type StoredEvent = {
  seq: number;
  type: string;
  version: number;
  data: unknown;
  createdAt: Date;
};

// Appends one event with the next seq for its run (1, 2, 3, … with no gaps), and in the
// same transaction can change the run's status, so the two never disagree. Returns the seq.
export async function appendEvent(
  db: Db,
  runId: string,
  event: NewEvent,
  options: { status?: RunStatus } = {},
): Promise<number> {
  return db.transaction(async (tx) => {
    // Lock the run's row. A second append for the same run waits here until this
    // transaction ends, so two appends can never read the same last seq.
    const locked = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.id, runId))
      .for("update");
    if (locked.length === 0) {
      throw new Error(`Run not found: ${runId}`);
    }

    const [last] = await tx
      .select({ seq: max(events.seq) })
      .from(events)
      .where(eq(events.runId, runId));
    const seq = (last?.seq ?? 0) + 1;

    await tx.insert(events).values({
      runId,
      seq,
      type: event.type,
      version: event.version ?? 1,
      data: event.data,
    });
    await tx
      .update(runs)
      .set({ updatedAt: sql`now()`, ...(options.status && { status: options.status }) })
      .where(eq(runs.id, runId));

    return seq;
  });
}

// Every event of a run with seq greater than `afterSeq`, oldest first.
// `afterSeq = 0` gives the whole log; an SSE client resuming passes its Last-Event-ID.
export async function listEventsAfter(
  db: Db,
  runId: string,
  afterSeq: number,
): Promise<StoredEvent[]> {
  return db
    .select({
      seq: events.seq,
      type: events.type,
      version: events.version,
      data: events.data,
      createdAt: events.createdAt,
    })
    .from(events)
    .where(and(eq(events.runId, runId), gt(events.seq, afterSeq)))
    .orderBy(asc(events.seq));
}
