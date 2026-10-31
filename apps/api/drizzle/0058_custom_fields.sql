CREATE TABLE "custom_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"team_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"type" text NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"position" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_field_values" (
	"issue_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"text_value" text,
	"option_ids" text[],
	"number_value" double precision,
	"date_value" date,
	"user_id" uuid,
	CONSTRAINT "issue_field_values_issue_id_field_id_pk" PRIMARY KEY("issue_id","field_id")
);
--> statement-breakpoint
ALTER TABLE "custom_fields" ADD CONSTRAINT "custom_fields_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_fields" ADD CONSTRAINT "custom_fields_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_field_values" ADD CONSTRAINT "issue_field_values_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_field_values" ADD CONSTRAINT "issue_field_values_field_id_custom_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."custom_fields"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_field_values" ADD CONSTRAINT "issue_field_values_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "custom_fields_workspace_idx" ON "custom_fields" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "issue_field_values_field_idx" ON "issue_field_values" USING btree ("field_id");