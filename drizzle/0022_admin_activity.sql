CREATE TABLE "admin_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_id" uuid NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"action" text,
	"status" integer NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_activity" ADD CONSTRAINT "admin_activity_admin_id_users_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_activity_admin_idx" ON "admin_activity" USING btree ("admin_id","created_at");--> statement-breakpoint
CREATE INDEX "admin_activity_created_idx" ON "admin_activity" USING btree ("created_at");