CREATE TABLE "fx_conversions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"source_currency" text NOT NULL,
	"destination_currency" text NOT NULL,
	"source_amount" numeric NOT NULL,
	"booked_ngn" numeric NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"customer_reference" text,
	"quote_reference" text,
	"provider_reference" text,
	"amount_received" numeric,
	"rate" numeric,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fx_conversions" ADD CONSTRAINT "fx_conversions_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fx_conversions_transaction_key" ON "fx_conversions" USING btree ("transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fx_conversions_provider_reference_key" ON "fx_conversions" USING btree ("provider_reference");--> statement-breakpoint
CREATE INDEX "fx_conversions_due_idx" ON "fx_conversions" USING btree ("status","next_attempt_at");