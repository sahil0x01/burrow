import { sql } from "drizzle-orm";
import {
  check,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

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

export const runStatuses = ["running", "succeeded", "failed"] as const;

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
    createdAt: timestampColumn("created_at"),
    updatedAt: timestampColumn("updated_at"),
  },
  (table) => [
    check("runs_status_check", sql`${table.status} in ('running', 'succeeded', 'failed')`),
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
