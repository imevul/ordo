CREATE TABLE "team_key_aliases" (
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"team_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_key_aliases_workspace_id_key_pk" PRIMARY KEY("workspace_id","key")
);
--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "git_automation" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "team_key_aliases" ADD CONSTRAINT "team_key_aliases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_key_aliases" ADD CONSTRAINT "team_key_aliases_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;