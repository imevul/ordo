ALTER TABLE "invites" DROP CONSTRAINT "invites_token_unique";--> statement-breakpoint
ALTER TABLE "invites" ALTER COLUMN "token_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "invites" DROP COLUMN "token";