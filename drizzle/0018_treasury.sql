CREATE TABLE "treasury_expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"amount_ngn" numeric NOT NULL,
	"category" text NOT NULL,
	"note" text,
	"occurred_on" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "treasury_expenses_day_idx" ON "treasury_expenses" USING btree ("occurred_on");