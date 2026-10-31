ALTER TABLE "agent_runs" ADD COLUMN "progress_step" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "progress_percent" integer;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "progress_at" timestamp with time zone;