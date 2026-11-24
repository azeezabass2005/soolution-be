CREATE TABLE "payout_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"user_id" uuid NOT NULL,
	"transaction_id" uuid,
	"wallet_transaction_id" uuid,
	"reference" text NOT NULL,
	"amount_ngn" numeric NOT NULL,
	"amount" numeric NOT NULL,
	"currency" text NOT NULL,
	"recipient" text,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "approval_exempt" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "approval_threshold_ngn" numeric;--> statement-breakpoint
ALTER TABLE "payout_holds" ADD CONSTRAINT "payout_holds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payout_holds_status_idx" ON "payout_holds" USING btree ("status","created_at");