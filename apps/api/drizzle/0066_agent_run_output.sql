CREATE TABLE "agent_run_output" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_run_output" ADD CONSTRAINT "agent_run_output_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_run_output_updated_idx" ON "agent_run_output" USING btree ("updated_at");