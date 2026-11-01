-- An instance that ran 0071 and 0072 before 0070 reached it never applies 0070: drizzle only runs
-- migrations newer than the newest one applied. This creates what it skipped, and does nothing
-- anywhere else.
DO $$
BEGIN
  IF to_regclass('request_forms') IS NULL THEN
    CREATE TABLE "request_form_submissions" (
    	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    	"workspace_id" uuid NOT NULL,
    	"form_id" uuid NOT NULL,
    	"issue_id" uuid NOT NULL,
    	"email" text NOT NULL,
    	"title" text NOT NULL,
    	"locale" text NOT NULL,
    	"done_notified_at" timestamp with time zone,
    	"created_at" timestamp with time zone DEFAULT now() NOT NULL
    );
    CREATE TABLE "request_forms" (
    	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    	"workspace_id" uuid NOT NULL,
    	"team_id" uuid NOT NULL,
    	"token" text NOT NULL,
    	"enabled" boolean DEFAULT false NOT NULL,
    	"title" text DEFAULT '' NOT NULL,
    	"intro" text DEFAULT '' NOT NULL,
    	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
    	"template_id" uuid,
    	"allow_attachments" boolean DEFAULT false NOT NULL,
    	"confirmation_email" boolean DEFAULT true NOT NULL,
    	"done_email" boolean DEFAULT false NOT NULL,
    	"captcha_provider" text,
    	"captcha_site_key" text,
    	"captcha_secret" text,
    	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
    	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    	CONSTRAINT "request_forms_team_id_unique" UNIQUE("team_id"),
    	CONSTRAINT "request_forms_token_unique" UNIQUE("token")
    );
    ALTER TABLE "request_form_submissions" ADD CONSTRAINT "request_form_submissions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;ALTER TABLE "request_form_submissions" ADD CONSTRAINT "request_form_submissions_form_id_request_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."request_forms"("id") ON DELETE cascade ON UPDATE no action;ALTER TABLE "request_form_submissions" ADD CONSTRAINT "request_form_submissions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;ALTER TABLE "request_forms" ADD CONSTRAINT "request_forms_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;ALTER TABLE "request_forms" ADD CONSTRAINT "request_forms_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;ALTER TABLE "request_forms" ADD CONSTRAINT "request_forms_template_id_issue_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."issue_templates"("id") ON DELETE set null ON UPDATE no action;CREATE INDEX "request_form_submissions_form_idx" ON "request_form_submissions" USING btree ("form_id","created_at");CREATE INDEX "request_form_submissions_issue_idx" ON "request_form_submissions" USING btree ("issue_id");CREATE INDEX "request_form_submissions_email_idx" ON "request_form_submissions" USING btree ("workspace_id","email","created_at");
  END IF;
END
$$;
