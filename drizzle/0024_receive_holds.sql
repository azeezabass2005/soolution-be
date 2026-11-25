ALTER TABLE "transactions" ADD COLUMN "held_amount" numeric;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "held_released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "held_released_by" uuid;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "held_balance" numeric DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_held_balance_non_negative" CHECK ("wallets"."held_balance" >= 0);