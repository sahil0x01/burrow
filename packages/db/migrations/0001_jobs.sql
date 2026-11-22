CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"type" text NOT NULL,
	"key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_by" text,
	"locked_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_key_unique" UNIQUE("key"),
	CONSTRAINT "jobs_status_check" CHECK ("jobs"."status" in ('queued', 'running', 'succeeded', 'failed')),
	CONSTRAINT "jobs_attempts_check" CHECK ("jobs"."attempts" between 0 and "jobs"."max_attempts"),
	CONSTRAINT "jobs_max_attempts_positive" CHECK ("jobs"."max_attempts" > 0),
	CONSTRAINT "jobs_lock_check" CHECK (("jobs"."status" = 'running') = ("jobs"."locked_by" is not null and "jobs"."locked_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "runs_status_check";--> statement-breakpoint
CREATE INDEX "jobs_due_idx" ON "jobs" USING btree ("run_at") WHERE "jobs"."status" = 'queued';--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_status_check" CHECK ("runs"."status" in ('queued', 'running', 'succeeded', 'failed'));