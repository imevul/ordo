ALTER TABLE "agent_runs" ADD COLUMN "ignore_blockers" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "wait_for_blockers" boolean DEFAULT true NOT NULL;