ALTER TABLE "agent_runs" ADD COLUMN "trigger_detail" jsonb;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "follow_pull_requests" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "pull_request_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "pull_request_scope" text DEFAULT 'linked' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_pull_request_agent_id_users_id_fk" FOREIGN KEY ("pull_request_agent_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;