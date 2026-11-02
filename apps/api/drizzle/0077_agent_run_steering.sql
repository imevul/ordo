ALTER TABLE "agent_runs" ADD COLUMN "steer_comment_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "steered_comment_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "steerable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_steer_comment_id_comments_id_fk" FOREIGN KEY ("steer_comment_id") REFERENCES "public"."comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_steered_comment_id_comments_id_fk" FOREIGN KEY ("steered_comment_id") REFERENCES "public"."comments"("id") ON DELETE set null ON UPDATE no action;