import { and, asc, eq, gt, max, sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import type { DbOrTx } from "./queue.ts";
import { canTransition, type RunStatus } from "./run-status.ts";
import { events, runs } from "./schema.ts";

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
// Throws if the status change is not allowed (see run-status.ts), and then writes nothing.
export async function appendEvent(
  db: Db,
  runId: string,
  event: NewEvent,
  options: { status?: RunStatus } = {},
): Promise<number> {
  return db.transaction(async (tx) => {
    const run = await lockRun(tx, runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    return appendToLockedRun(tx, runId, run.status, event, options.status);
  });
}

// Locks the run's row until the transaction ends. A second append (or cancel) for the same
// run waits here, so two of them can never read the same last seq or the same status.
export async function lockRun(tx: DbOrTx, runId: string) {
  const [run] = await tx
    .select({ status: runs.status, cancelRequestedAt: runs.cancelRequestedAt })
    .from(runs)
    .where(eq(runs.id, runId))
    .for("update");
  return run;
}

// The rest of appendEvent, for a caller that already holds the lock from lockRun.
export async function appendToLockedRun(
  tx: DbOrTx,
  runId: string,
  from: RunStatus,
  event: NewEvent,
  to?: RunStatus,
): Promise<number> {
  if (to !== undefined && to !== from && !canTransition(from, to)) {
    throw new Error(`Run ${runId} cannot go from ${from} to ${to}`);
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
    .set({ updatedAt: sql`now()`, ...(to && { status: to }) })
    .where(eq(runs.id, runId));

  return seq;
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
