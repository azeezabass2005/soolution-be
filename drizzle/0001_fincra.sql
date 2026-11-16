ALTER TABLE "platform_settings" DROP CONSTRAINT "platform_settings_provider_fee_check";--> statement-breakpoint
ALTER TABLE "transaction_details" ADD COLUMN "provider_reference" text;--> statement-breakpoint
ALTER TABLE "transaction_details" ADD COLUMN "provider_id" text;--> statement-breakpoint
ALTER TABLE "transaction_details" ADD COLUMN "provider_status" text;--> statement-breakpoint
ALTER TABLE "transaction_details" ADD COLUMN "provider_quote_reference" text;--> statement-breakpoint
ALTER TABLE "transaction_details" ADD COLUMN "checkout_url" text;--> statement-breakpoint
ALTER TABLE "transaction_details" ADD COLUMN "provider_payload" jsonb;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "dva_provider" text;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "dva_external_id" text;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "dva_status" text;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "provider_fee_fincra_percent" numeric DEFAULT 1.5 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_details_provider_reference_key" ON "transaction_details" USING btree ("provider_reference") WHERE "transaction_details"."provider_reference" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_dva_external_key" ON "wallets" USING btree ("dva_provider","dva_external_id") WHERE "wallets"."dva_external_id" is not null;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_provider_fee_check" CHECK ("platform_settings"."provider_fee_ogateway_percent" between 0 and 10 and "platform_settings"."provider_fee_yellowcard_percent" between 0 and 10 and "platform_settings"."provider_fee_fincra_percent" between 0 and 10);