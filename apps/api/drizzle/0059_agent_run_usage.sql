ALTER TABLE "agent_runs" ADD COLUMN "input_tokens" bigint;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "output_tokens" bigint;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "cache_read_tokens" bigint;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "cache_write_tokens" bigint;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "cost_usd" double precision;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "duration_ms" bigint;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "usage_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "monthly_budget_usd" double precision;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "budget_waived_until" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "agent_runs_usage_idx" ON "agent_runs" USING btree ("workspace_id","usage_at");