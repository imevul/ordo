ALTER TABLE "auth_providers" ALTER COLUMN "issuer" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_providers" ALTER COLUMN "client_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_providers" ALTER COLUMN "client_secret" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_states" ALTER COLUMN "nonce" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_states" ALTER COLUMN "code_verifier" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_providers" ADD COLUMN "protocol" text DEFAULT 'oidc' NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_providers" ADD COLUMN "saml" jsonb;--> statement-breakpoint
ALTER TABLE "auth_providers" ADD COLUMN "trust_email" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_states" ADD COLUMN "request_id" text;--> statement-breakpoint
ALTER TABLE "auth_states" ADD COLUMN "claims" jsonb;