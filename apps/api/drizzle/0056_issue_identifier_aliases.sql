CREATE TABLE "issue_identifier_aliases" (
	"team_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"issue_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_identifier_aliases_team_id_number_pk" PRIMARY KEY("team_id","number")
);
--> statement-breakpoint
ALTER TABLE "issue_identifier_aliases" ADD CONSTRAINT "issue_identifier_aliases_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_identifier_aliases" ADD CONSTRAINT "issue_identifier_aliases_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_identifier_aliases_issue_idx" ON "issue_identifier_aliases" USING btree ("issue_id");