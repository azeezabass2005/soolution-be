ALTER TABLE "users" ADD COLUMN "freeze" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "freeze_reason" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "daily_limit_override_ngn" numeric;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "operations" jsonb;--> statement-breakpoint
-- Accounts made before email verification was required count as verified
UPDATE "users" SET "is_verified" = true WHERE "is_verified" = false;
