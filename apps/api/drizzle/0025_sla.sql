ALTER TABLE "issues" ADD COLUMN "sla_breaches_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "sla_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "sla_hours" jsonb DEFAULT '{}'::jsonb NOT NULL;