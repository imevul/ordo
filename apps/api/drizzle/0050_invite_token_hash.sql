ALTER TABLE "invites" ADD COLUMN "token_hash" text;--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN "token_encrypted" text;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_token_hash_unique" UNIQUE("token_hash");