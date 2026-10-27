CREATE TABLE "sync_changes" (
	"workspace_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"kind" text NOT NULL,
	"entity_id" text NOT NULL,
	"action" text NOT NULL,
	"team_ids" uuid[] DEFAULT '{}' NOT NULL,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_changes_workspace_id_seq_pk" PRIMARY KEY("workspace_id","seq")
);
--> statement-breakpoint
CREATE TABLE "sync_cursors" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint DEFAULT 0 NOT NULL,
	"epoch" integer DEFAULT 1 NOT NULL,
	"min_seq" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sync_changes" ADD CONSTRAINT "sync_changes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sync_changes_created_idx" ON "sync_changes" USING btree ("created_at");