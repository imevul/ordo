ALTER TABLE "agent_runs" ADD COLUMN "plan" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "plan_approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "plan_approved_by_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "require_plan_approval" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "plan_approval" boolean;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_plan_approved_by_id_users_id_fk" FOREIGN KEY ("plan_approved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;