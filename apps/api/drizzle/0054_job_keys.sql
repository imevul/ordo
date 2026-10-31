CREATE TABLE "job_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "job_keys_created_idx" ON "job_keys" USING btree ("created_at");