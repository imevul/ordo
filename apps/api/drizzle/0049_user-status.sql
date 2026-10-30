ALTER TABLE "users" ADD COLUMN "status_kind" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "status_emoji" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "status_text" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "status_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "notify_pause" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "notify_pause_until" timestamp with time zone;