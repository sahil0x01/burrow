ALTER TABLE "runs" DROP CONSTRAINT "runs_status_check";--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "cancel_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_status_check" CHECK ("runs"."status" in ('queued', 'running', 'succeeded', 'failed', 'cancelled'));