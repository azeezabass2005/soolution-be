ALTER TABLE "users" ADD COLUMN "disabled_currencies" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "transaction_details" ADD COLUMN "provider_rate" numeric;