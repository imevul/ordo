ALTER TABLE "projects" ADD COLUMN "default_assignee_mode" text DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "default_assignee_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_default_assignee_id_users_id_fk" FOREIGN KEY ("default_assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;