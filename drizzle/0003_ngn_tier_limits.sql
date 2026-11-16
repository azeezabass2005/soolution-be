ALTER TABLE "platform_settings" DROP CONSTRAINT "platform_settings_limits_check";--> statement-breakpoint
ALTER TABLE "platform_settings" ALTER COLUMN "tier1_daily_limit_usd" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ALTER COLUMN "tier2_daily_limit_usd" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "ngn_value" numeric;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "tier1_daily_limit_ngn" numeric DEFAULT 5000000 NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "tier2_daily_limit_ngn" numeric DEFAULT 150000000 NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_limits_check" CHECK ("platform_settings"."tier1_daily_limit_ngn" >= 0 and "platform_settings"."tier2_daily_limit_ngn" >= 0);