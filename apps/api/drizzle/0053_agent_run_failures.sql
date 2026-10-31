ALTER TABLE "agent_runs" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "retry_of_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "dismissed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "paused_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "pause_reason" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_retry_of_id_agent_runs_id_fk" FOREIGN KEY ("retry_of_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;