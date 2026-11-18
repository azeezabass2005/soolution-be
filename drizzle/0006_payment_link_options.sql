ALTER TABLE "payment_links" ADD COLUMN "redirect_url" text;--> statement-breakpoint
ALTER TABLE "payment_links" ADD COLUMN "collect_fields" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "payer_phone" text;