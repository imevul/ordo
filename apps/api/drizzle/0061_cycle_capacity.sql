CREATE TABLE "cycle_capacities" (
	"cycle_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"capacity" integer NOT NULL,
	CONSTRAINT "cycle_capacities_cycle_id_user_id_pk" PRIMARY KEY("cycle_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "team_members" ADD COLUMN "capacity" integer;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "default_capacity" integer;--> statement-breakpoint
ALTER TABLE "cycle_capacities" ADD CONSTRAINT "cycle_capacities_cycle_id_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."cycles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_capacities" ADD CONSTRAINT "cycle_capacities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;