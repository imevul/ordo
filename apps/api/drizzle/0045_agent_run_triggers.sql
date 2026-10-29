ALTER TABLE "agent_runs" ADD COLUMN "trigger" text DEFAULT 'assigned' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "trigger_comment_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_trigger_comment_id_comments_id_fk" FOREIGN KEY ("trigger_comment_id") REFERENCES "public"."comments"("id") ON DELETE set null ON UPDATE no action;