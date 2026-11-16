CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"is_revoked" boolean DEFAULT false NOT NULL,
	"revoked_at" timestamp with time zone,
	"user_agent" text,
	"ip_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_token_key" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user_tier_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"tier" smallint NOT NULL,
	"reason" text NOT NULL,
	"by_user_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password" text NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"is_verified" boolean DEFAULT false NOT NULL,
	"tier" smallint DEFAULT 0 NOT NULL,
	"identity_status" text DEFAULT 'unverified' NOT NULL,
	"identity_bvn_hash" text,
	"identity_bvn_last4" text,
	"identity_bvn_enc" text,
	"identity_nin_enc" text,
	"identity_nin_hash" text,
	"identity_nin_last4" text,
	"identity_dob" text,
	"identity_id_phone" text,
	"identity_address" text,
	"identity_details_updated_at" timestamp with time zone,
	"identity_verified_name" text,
	"identity_verified_at" timestamp with time zone,
	"identity_method" text,
	"identity_failure_reason" text,
	"is_kyc_done" boolean DEFAULT false NOT NULL,
	"is_kyc_rejected" boolean DEFAULT false NOT NULL,
	"kyc_rejection_reason" text,
	"is_completed" boolean DEFAULT false NOT NULL,
	"role" integer DEFAULT 6483 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"sessions_valid_after" timestamp with time zone,
	"last_login" text,
	"phone_number" text,
	"whatsapp_number" text,
	"country_of_origin" text,
	"country_of_residence" text,
	"purpose" text,
	"type_of_business" text,
	"monthly_volume" text,
	"hear_about_us" text,
	"hear_about_us_other" text,
	"transaction_pin_hash" text,
	"is_transaction_pin_set" boolean DEFAULT false NOT NULL,
	"transaction_pin_attempts" integer DEFAULT 0 NOT NULL,
	"transaction_pin_locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"whatsapp_number" text,
	"country" text NOT NULL,
	"city" text,
	"role" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"description" text,
	"profile_image" text,
	"website" text,
	"is_verified" boolean DEFAULT false NOT NULL,
	"rating" numeric,
	"total_reviews" integer DEFAULT 0 NOT NULL,
	"role_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_available" boolean DEFAULT true NOT NULL,
	"last_active_at" timestamp with time zone,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partners_email_key" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"category" text NOT NULL,
	"user_id" uuid NOT NULL,
	"view_count" integer DEFAULT 0 NOT NULL,
	"like_count" integer DEFAULT 0 NOT NULL,
	"publication_status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid,
	"user_id" uuid,
	"action" text NOT NULL,
	"before_value" jsonb,
	"after_value" jsonb,
	"ip_address" text,
	"user_agent" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"user_id" uuid NOT NULL,
	"transaction_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_key_key" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "payment_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"currency" text NOT NULL,
	"to_currency" text DEFAULT 'NGN' NOT NULL,
	"amount" numeric,
	"title" text,
	"description" text,
	"active" boolean DEFAULT true NOT NULL,
	"usage" text DEFAULT 'reusable' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_links_slug_key" UNIQUE("slug"),
	CONSTRAINT "payment_links_amount_check" CHECK ("payment_links"."amount" is null or "payment_links"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "transaction_details" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"type" text NOT NULL,
	"platform" text,
	"alipay_no" text,
	"alipay_name" text,
	"qr_code_url" text,
	"pay_in_receipt_url" text,
	"pay_out_receipt_url" text,
	"bank_account_details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"from_amount" numeric,
	"institution_type" text,
	"country" text,
	"bank_name" text,
	"account_number" text,
	"account_name" text,
	"momo_network" text,
	"momo_number" text,
	"momo_name" text,
	"yc_collection_id" text,
	"yc_payment_id" text,
	"yc_sequence_id" text,
	"yc_channel_id" text,
	"yc_network_id" text,
	"yc_status" text,
	"yc_raw_payload" jsonb,
	"og_id" text,
	"og_reference" text,
	"og_channel" text,
	"og_network" text,
	"og_bank" text,
	"og_status" text,
	"og_raw_payload" jsonb,
	"fee_amount" numeric DEFAULT 0 NOT NULL,
	"fee_percent" numeric DEFAULT 0 NOT NULL,
	"provider_fee_percent" numeric DEFAULT 0 NOT NULL,
	"markup_percent" numeric DEFAULT 0 NOT NULL,
	"funding_currency" text,
	"funding_amount" numeric,
	"funding_fee" numeric,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transaction_limit_locks" (
	"key" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"receipt_token" text,
	"amount" numeric NOT NULL,
	"currency" text NOT NULL,
	"from_currency" text NOT NULL,
	"detail_type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"initiated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"cancel_reason" text,
	"locked_rate" numeric,
	"usd_value" numeric,
	"locked_rate_from_currency" text,
	"locked_rate_to_currency" text,
	"locked_rate_at" timestamp with time zone,
	"payment_link_id" uuid,
	"payer_name" text,
	"payer_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transactions_reference_key" UNIQUE("reference"),
	CONSTRAINT "transactions_receipt_token_key" UNIQUE("receipt_token"),
	CONSTRAINT "transactions_amount_check" CHECK ("transactions"."amount" > 0),
	CONSTRAINT "transactions_currency_check" CHECK ("transactions"."currency" ~ '^[A-Z]{3,4}$' and "transactions"."from_currency" ~ '^[A-Z]{3,4}$')
);
--> statement-breakpoint
CREATE TABLE "fx_quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"from_currency" text NOT NULL,
	"to_currency" text NOT NULL,
	"from_amount" numeric NOT NULL,
	"to_amount" numeric NOT NULL,
	"rate" numeric NOT NULL,
	"provider_rate" numeric NOT NULL,
	"rate_source" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_quotes_amounts_check" CHECK ("fx_quotes"."from_amount" >= 0 and "fx_quotes"."to_amount" >= 0 and "fx_quotes"."rate" >= 0 and "fx_quotes"."provider_rate" >= 0)
);
--> statement-breakpoint
CREATE TABLE "wallet_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"amount" numeric NOT NULL,
	"reference" text NOT NULL,
	"balance_before" numeric NOT NULL,
	"balance_after" numeric NOT NULL,
	"description" text,
	"paystack_reference" text,
	"paystack_transfer_code" text,
	"recipient_bank_code" text,
	"recipient_bank_name" text,
	"recipient_account_number" text,
	"recipient_account_name" text,
	"paystack_recipient_code" text,
	"failure_reason" text,
	"reversed_transaction_id" uuid,
	"currency" text,
	"counter_currency" text,
	"counter_amount" numeric,
	"rate" numeric,
	"fx_quote_id" uuid,
	"send_ngn_amount" numeric,
	"send_ngn_fee" numeric,
	"send_fee" numeric,
	"provider_account_code" text,
	"transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_transactions_reference_key" UNIQUE("reference"),
	CONSTRAINT "wallet_transactions_amount_check" CHECK ("wallet_transactions"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"currency" text DEFAULT 'NGN' NOT NULL,
	"balance" numeric DEFAULT 0 NOT NULL,
	"ledger_balance" numeric DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"paystack_customer_code" text,
	"paystack_customer_id" bigint,
	"dva_bank_name" text,
	"dva_account_number" text,
	"dva_account_name" text,
	"dva_bank_id" integer,
	"dva_id" bigint,
	"is_dva_provisioned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallets_balance_non_negative" CHECK ("wallets"."balance" >= 0)
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"type" text NOT NULL,
	"currency" text NOT NULL,
	"name" text NOT NULL,
	"owner_user_id" uuid,
	"owner_wallet_id" uuid,
	"balance" numeric DEFAULT 0 NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"description" text,
	"balance_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_code_key" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tx_group_id" text NOT NULL,
	"account_code" text NOT NULL,
	"account_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"amount" numeric NOT NULL,
	"currency" text NOT NULL,
	"reference" text NOT NULL,
	"source" text NOT NULL,
	"description" text NOT NULL,
	"external_ref_provider" text,
	"external_ref_id" text,
	"metadata" jsonb,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"posted_by" uuid,
	"reversed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_entries_amount_check" CHECK ("journal_entries"."amount" > 0),
	CONSTRAINT "journal_entries_direction_check" CHECK ("journal_entries"."direction" in ('debit', 'credit'))
);
--> statement-breakpoint
CREATE TABLE "ledger_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"severity" text NOT NULL,
	"code" text NOT NULL,
	"account_code" text,
	"tx_group_id" text,
	"expected" numeric,
	"actual" numeric,
	"delta" numeric,
	"message" text NOT NULL,
	"metadata" jsonb,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconciliation_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"run_by" uuid,
	"run_mode" text DEFAULT 'on_demand' NOT NULL,
	"wallet_proof" jsonb DEFAULT '{"walletsChecked":0,"mismatches":[]}'::jsonb NOT NULL,
	"account_proof" jsonb DEFAULT '{"accountsChecked":0,"mismatches":[]}'::jsonb NOT NULL,
	"ledger_proof" jsonb DEFAULT '{"txGroupsChecked":0,"unbalancedGroups":[]}'::jsonb NOT NULL,
	"provider_proof" jsonb,
	"in_flight" jsonb DEFAULT '{"paystackTransfers":0,"ycPayments":0,"ycCollections":0}'::jsonb NOT NULL,
	"suspense" jsonb DEFAULT '{"totalUnattributed":0,"count":0}'::jsonb NOT NULL,
	"status" text DEFAULT 'clean' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"event" text,
	"external_id" text,
	"signature" text,
	"signature_valid" boolean DEFAULT false NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"status" text DEFAULT 'received' NOT NULL,
	"error" text,
	"tx_group_id" text,
	"replay_of_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_account_details" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"currency" text NOT NULL,
	"account_number" text NOT NULL,
	"account_name" text NOT NULL,
	"bank_name" text NOT NULL,
	"bank_code" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_account_details_currency_check" CHECK ("bank_account_details"."currency" ~ '^[A-Z]{3,4}$')
);
--> statement-breakpoint
CREATE TABLE "beneficiaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"kind" text NOT NULL,
	"nickname" text,
	"bank_name" text,
	"bank_code" text,
	"account_number" text,
	"account_name" text,
	"momo_network" text,
	"momo_number" text,
	"momo_name" text,
	"alipay_type" text,
	"alipay_no" text,
	"alipay_name" text,
	"qr_code_url" text,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exchange_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_currency" text NOT NULL,
	"to_currency" text NOT NULL,
	"rate" numeric NOT NULL,
	"is_active" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kyc_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"tier" smallint NOT NULL,
	"archive" jsonb,
	"status" text DEFAULT 'draft' NOT NULL,
	"display_name" text,
	"completed_steps" text[] DEFAULT '{}'::text[] NOT NULL,
	"general" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"personal" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ubos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"directors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"questionnaire" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"documents" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rejection_reason" text,
	"submitted_at" timestamp with time zone,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" uuid,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text DEFAULT 'singleton' NOT NULL,
	"rate_markup_percent" numeric DEFAULT 0 NOT NULL,
	"additional_fee_percent" numeric DEFAULT 0 NOT NULL,
	"provider_fee_ogateway_percent" numeric DEFAULT 1.5 NOT NULL,
	"provider_fee_yellowcard_percent" numeric DEFAULT 0 NOT NULL,
	"tier1_daily_limit_usd" numeric NOT NULL,
	"tier2_daily_limit_usd" numeric NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_settings_kind_key" UNIQUE("kind"),
	CONSTRAINT "platform_settings_kind_check" CHECK ("platform_settings"."kind" = 'singleton'),
	CONSTRAINT "platform_settings_markup_check" CHECK ("platform_settings"."rate_markup_percent" between 0 and 50),
	CONSTRAINT "platform_settings_fee_check" CHECK ("platform_settings"."additional_fee_percent" between 0 and 10),
	CONSTRAINT "platform_settings_provider_fee_check" CHECK ("platform_settings"."provider_fee_ogateway_percent" between 0 and 10 and "platform_settings"."provider_fee_yellowcard_percent" between 0 and 10),
	CONSTRAINT "platform_settings_limits_check" CHECK ("platform_settings"."tier1_daily_limit_usd" >= 0 and "platform_settings"."tier2_daily_limit_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"job_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"kind" text,
	"id_hash" text,
	"id_last4" text,
	"bvn_enc" text,
	"nin_enc" text,
	"nin_hash" text,
	"nin_last4" text,
	"smile_job_id" text,
	"result_code" text,
	"result_text" text,
	"actions" jsonb,
	"name_on_id" text,
	"result_source" text,
	"completed_at" timestamp with time zone,
	"last_polled_at" timestamp with time zone,
	"excluded_from_attempts" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_tier_history" ADD CONSTRAINT "user_tier_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_details" ADD CONSTRAINT "transaction_details_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_payment_link_id_payment_links_id_fk" FOREIGN KEY ("payment_link_id") REFERENCES "public"."payment_links"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_quotes" ADD CONSTRAINT "fx_quotes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_fx_quote_id_fx_quotes_id_fk" FOREIGN KEY ("fx_quote_id") REFERENCES "public"."fx_quotes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_owner_wallet_id_wallets_id_fk" FOREIGN KEY ("owner_wallet_id") REFERENCES "public"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_account_details" ADD CONSTRAINT "bank_account_details_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beneficiaries" ADD CONSTRAINT "beneficiaries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kyc_applications" ADD CONSTRAINT "kyc_applications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_idx" ON "refresh_tokens" USING btree ("user_id","is_revoked");--> statement-breakpoint
CREATE INDEX "user_tier_history_user_idx" ON "user_tier_history" USING btree ("user_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "users_tier_idx" ON "users" USING btree ("tier");--> statement-breakpoint
CREATE UNIQUE INDEX "users_identity_bvn_hash_key" ON "users" USING btree ("identity_bvn_hash") WHERE "users"."identity_bvn_hash" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "users_identity_nin_hash_key" ON "users" USING btree ("identity_nin_hash") WHERE "users"."identity_nin_hash" is not null;--> statement-breakpoint
CREATE INDEX "partners_role_status_idx" ON "partners" USING btree ("role","status","is_available");--> statement-breakpoint
CREATE INDEX "partners_location_idx" ON "partners" USING btree ("country","city");--> statement-breakpoint
CREATE INDEX "partners_rating_idx" ON "partners" USING btree ("rating");--> statement-breakpoint
CREATE INDEX "posts_user_idx" ON "posts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "posts_search_idx" ON "posts" USING gin (to_tsvector('english', "title" || ' ' || "content"));--> statement-breakpoint
CREATE INDEX "audit_logs_transaction_idx" ON "audit_logs" USING btree ("transaction_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_user_idx" ON "audit_logs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_action_idx" ON "audit_logs" USING btree ("action","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_created_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idempotency_keys_user_idx" ON "idempotency_keys" USING btree ("user_id","key");--> statement-breakpoint
CREATE INDEX "idempotency_keys_expires_idx" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "payment_links_user_idx" ON "payment_links" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_details_transaction_key" ON "transaction_details" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "transaction_details_yc_sequence_idx" ON "transaction_details" USING btree ("yc_sequence_id");--> statement-breakpoint
CREATE INDEX "transaction_details_yc_collection_idx" ON "transaction_details" USING btree ("yc_collection_id");--> statement-breakpoint
CREATE INDEX "transaction_details_yc_payment_idx" ON "transaction_details" USING btree ("yc_payment_id");--> statement-breakpoint
CREATE INDEX "transaction_details_og_reference_idx" ON "transaction_details" USING btree ("og_reference");--> statement-breakpoint
CREATE INDEX "transaction_details_og_id_idx" ON "transaction_details" USING btree ("og_id");--> statement-breakpoint
CREATE INDEX "transactions_user_status_idx" ON "transactions" USING btree ("user_id","status","detail_type");--> statement-breakpoint
CREATE INDEX "transactions_user_created_idx" ON "transactions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "transactions_status_initiated_idx" ON "transactions" USING btree ("status","initiated_at");--> statement-breakpoint
CREATE INDEX "transactions_detail_type_initiated_idx" ON "transactions" USING btree ("detail_type","initiated_at");--> statement-breakpoint
CREATE INDEX "transactions_currency_created_idx" ON "transactions" USING btree ("currency","created_at");--> statement-breakpoint
CREATE INDEX "transactions_payment_link_idx" ON "transactions" USING btree ("payment_link_id","status");--> statement-breakpoint
CREATE INDEX "fx_quotes_user_idx" ON "fx_quotes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "fx_quotes_created_idx" ON "fx_quotes" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "wallet_transactions_wallet_idx" ON "wallet_transactions" USING btree ("wallet_id","created_at");--> statement-breakpoint
CREATE INDEX "wallet_transactions_user_type_idx" ON "wallet_transactions" USING btree ("user_id","type","created_at");--> statement-breakpoint
CREATE INDEX "wallet_transactions_paystack_reference_idx" ON "wallet_transactions" USING btree ("paystack_reference");--> statement-breakpoint
CREATE INDEX "wallet_transactions_paystack_transfer_idx" ON "wallet_transactions" USING btree ("paystack_transfer_code");--> statement-breakpoint
CREATE INDEX "wallet_transactions_transaction_idx" ON "wallet_transactions" USING btree ("transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_transactions_funding_reference_key" ON "wallet_transactions" USING btree ("paystack_reference") WHERE "wallet_transactions"."type" = 'funding' and "wallet_transactions"."paystack_reference" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_user_currency_key" ON "wallets" USING btree ("user_id","currency");--> statement-breakpoint
CREATE INDEX "wallets_paystack_customer_idx" ON "wallets" USING btree ("paystack_customer_code");--> statement-breakpoint
CREATE INDEX "wallets_dva_account_idx" ON "wallets" USING btree ("dva_account_number");--> statement-breakpoint
CREATE INDEX "wallets_user_created_idx" ON "wallets" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "accounts_type_currency_idx" ON "accounts" USING btree ("type","currency");--> statement-breakpoint
CREATE INDEX "accounts_owner_user_idx" ON "accounts" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "journal_entries_tx_group_idx" ON "journal_entries" USING btree ("tx_group_id");--> statement-breakpoint
CREATE INDEX "journal_entries_account_posted_idx" ON "journal_entries" USING btree ("account_code","posted_at");--> statement-breakpoint
CREATE INDEX "journal_entries_reference_idx" ON "journal_entries" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "journal_entries_source_idx" ON "journal_entries" USING btree ("source");--> statement-breakpoint
CREATE INDEX "journal_entries_posted_idx" ON "journal_entries" USING btree ("posted_at");--> statement-breakpoint
CREATE INDEX "journal_entries_external_ref_idx" ON "journal_entries" USING btree ("external_ref_provider","external_ref_id");--> statement-breakpoint
CREATE INDEX "ledger_alerts_severity_idx" ON "ledger_alerts" USING btree ("severity","created_at");--> statement-breakpoint
CREATE INDEX "ledger_alerts_code_idx" ON "ledger_alerts" USING btree ("code");--> statement-breakpoint
CREATE INDEX "ledger_alerts_account_idx" ON "ledger_alerts" USING btree ("account_code");--> statement-breakpoint
CREATE INDEX "ledger_alerts_unacknowledged_idx" ON "ledger_alerts" USING btree ("created_at") WHERE "ledger_alerts"."acknowledged_at" is null;--> statement-breakpoint
CREATE INDEX "reconciliation_reports_started_idx" ON "reconciliation_reports" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "reconciliation_reports_status_idx" ON "reconciliation_reports" USING btree ("status");--> statement-breakpoint
CREATE INDEX "webhook_events_provider_status_idx" ON "webhook_events" USING btree ("provider","status","received_at");--> statement-breakpoint
CREATE INDEX "webhook_events_event_idx" ON "webhook_events" USING btree ("event");--> statement-breakpoint
CREATE INDEX "webhook_events_external_idx" ON "webhook_events" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX "webhook_events_received_idx" ON "webhook_events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "webhook_events_tx_group_idx" ON "webhook_events" USING btree ("tx_group_id");--> statement-breakpoint
CREATE INDEX "bank_account_details_user_idx" ON "bank_account_details" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "bank_account_details_currency_idx" ON "bank_account_details" USING btree ("currency");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_account_details_company_default_key" ON "bank_account_details" USING btree ("currency") WHERE "bank_account_details"."user_id" is null and "bank_account_details"."is_default";--> statement-breakpoint
CREATE INDEX "beneficiaries_user_currency_idx" ON "beneficiaries" USING btree ("user_id","currency","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "exchange_rates_pair_key" ON "exchange_rates" USING btree ("from_currency","to_currency");--> statement-breakpoint
CREATE UNIQUE INDEX "kyc_applications_user_key" ON "kyc_applications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "kyc_applications_status_idx" ON "kyc_applications" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "kyc_applications_tier_idx" ON "kyc_applications" USING btree ("tier");--> statement-breakpoint
CREATE INDEX "verifications_user_created_idx" ON "verifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "verifications_pending_bvn_key" ON "verifications" USING btree ("user_id") WHERE "verifications"."kind" = 'bvn' and "verifications"."status" = 'pending';