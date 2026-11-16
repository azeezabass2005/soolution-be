ALTER TABLE "wallet_transactions" ADD COLUMN "fee" numeric;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "pricing" jsonb;