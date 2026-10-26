ALTER TABLE "cycles" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "cycle_automation" jsonb DEFAULT '{}'::jsonb NOT NULL;