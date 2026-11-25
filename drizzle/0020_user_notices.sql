ALTER TABLE "transactions" ADD COLUMN "notified_status" text;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD COLUMN "notified_status" text;--> statement-breakpoint
-- Everything that already happened counts as told, so nobody gets old news
UPDATE "transactions" SET "notified_status" = "status";--> statement-breakpoint
UPDATE "wallet_transactions" SET "notified_status" = "status";
