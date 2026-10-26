CREATE TABLE "auth_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"issuer" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" text NOT NULL,
	"scopes" text DEFAULT 'openid email profile' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"default_role" text DEFAULT 'member' NOT NULL,
	"group_claim" text,
	"group_roles" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_states" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" uuid NOT NULL,
	"nonce" text NOT NULL,
	"code_verifier" text NOT NULL,
	"mode" text DEFAULT 'login' NOT NULL,
	"user_id" uuid,
	"redirect" text,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"email" text,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_providers" ADD CONSTRAINT "auth_providers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_states" ADD CONSTRAINT "auth_states_provider_id_auth_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."auth_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_states" ADD CONSTRAINT "auth_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_provider_id_auth_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."auth_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_providers_workspace_idx" ON "auth_providers" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_identities_subject_idx" ON "user_identities" USING btree ("provider_id","subject");--> statement-breakpoint
CREATE INDEX "user_identities_user_idx" ON "user_identities" USING btree ("user_id");