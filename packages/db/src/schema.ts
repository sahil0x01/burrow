import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { runStatuses } from "./run-status.ts";

// UUIDv7 starts with a timestamp, so ids sort by creation time.
const id = () =>
  uuid("id")
    .primaryKey()
    .default(sql`uuidv7()`);
const timestampColumn = (name: string) =>
  timestamp(name, { withTimezone: true }).notNull().defaultNow();

// Repos the backend may work on. Runs point at one by id, so the API never accepts a
// folder path from a client. For now a repo is a folder on this machine; M5 adds GitHub.
export const repos = pgTable("repos", {
  id: id(),
  name: text("name").notNull().unique(),
  path: text("path").notNull(),
  createdAt: timestampColumn("created_at"),
});

// One row per run. `status` is a quick summary for listing runs; the events are the full story.
export const runs = pgTable(
  "runs",
  {
    id: id(),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id),
    task: text("task").notNull(),
    status: text("status", { enum: runStatuses }).notNull(),
    // Set by POST /runs/:id/cancel. A worker running this run checks it between agent steps.
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    createdAt: timestampColumn("created_at"),
    updatedAt: timestampColumn("updated_at"),
  },
  (table) => [
    check(
      "runs_status_check",
      // Built from runStatuses, so the list in code and the check in the database agree.
      sql`${table.status} in (${sql.raw(runStatuses.map((status) => `'${status}'`).join(", "))})`,
    ),
  ],
);

// Append-only log of everything that happened in a run, numbered 1, 2, 3, … per run.
// Rows are only ever inserted, never updated.
export const events = pgTable(
  "events",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    // Bumped when the shape of `data` for a type changes, so old events stay readable.
    version: smallint("version").notNull().default(1),
    data: jsonb("data").notNull(),
    createdAt: timestampColumn("created_at"),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.seq] }),
    check("events_seq_positive", sql`${table.seq} > 0`),
  ],
);

export const jobStatuses = ["queued", "running", "succeeded", "failed"] as const;

// Our queue. A job is a piece of work for a worker (for now: "execute run X"). Workers claim
// queued jobs with SELECT … FOR UPDATE SKIP LOCKED, so two workers never take the same one.
// Kept apart from `runs`: runs are what users see, jobs are how the work gets delivered.
export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    type: text("type").notNull(),
    // At most one job per key, e.g. "run:<run id>". Enqueueing the same key twice does
    // nothing the second time, so a retried request cannot start the same work twice.
    key: text("key").notNull().unique(),
    payload: jsonb("payload").notNull(),
    status: text("status", { enum: jobStatuses }).notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    // Not picked up before this time. A failed attempt pushes it later (backoff).
    runAt: timestampColumn("run_at"),
    // Which worker holds the job and since when; set only while it is running.
    lockedBy: text("locked_by"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestampColumn("created_at"),
    updatedAt: timestampColumn("updated_at"),
  },
  (table) => [
    check(
      "jobs_status_check",
      sql`${table.status} in ('queued', 'running', 'succeeded', 'failed')`,
    ),
    check("jobs_attempts_check", sql`${table.attempts} between 0 and ${table.maxAttempts}`),
    check("jobs_max_attempts_positive", sql`${table.maxAttempts} > 0`),
    // A running job always has an owner, and only a running job has one.
    check(
      "jobs_lock_check",
      sql`(${table.status} = 'running') = (${table.lockedBy} is not null and ${table.lockedAt} is not null)`,
    ),
    // Workers only ever look for queued jobs that are due, so index just those rows.
    index("jobs_due_idx")
      .on(table.runAt)
      .where(sql`${table.status} = 'queued'`),
  ],
);
