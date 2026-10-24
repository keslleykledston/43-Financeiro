CREATE TABLE "company_fiscal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"accountant_name" text,
	"accountant_document" text,
	"accountant_crc" text,
	"accountant_contact" text,
	"accountant_email" text,
	"accountant_phone" text,
	"accountant_notes" text,
	"tax_regime" text,
	"municipal_registration" text,
	"cnae" text,
	"service_code" text,
	"iss_rate_bps" integer,
	"iss_withheld" boolean DEFAULT false NOT NULL,
	"city_name" text,
	"city_ibge" text,
	"uf" text,
	"cep" text,
	"street" text,
	"street_number" text,
	"complement" text,
	"district" text,
	"phone" text,
	"updated_by" uuid,
	CONSTRAINT "company_fiscal_regime_chk" CHECK ("company_fiscal"."tax_regime" is null or "company_fiscal"."tax_regime" in ('mei', 'simples', 'presumido', 'real')),
	CONSTRAINT "company_fiscal_iss_chk" CHECK ("company_fiscal"."iss_rate_bps" is null or "company_fiscal"."iss_rate_bps" between 0 and 500),
	CONSTRAINT "company_fiscal_formats_chk" CHECK (("company_fiscal"."cnae" is null or "company_fiscal"."cnae" ~ '^[0-9]{7}$') and ("company_fiscal"."city_ibge" is null or "company_fiscal"."city_ibge" ~ '^[0-9]{7}$') and ("company_fiscal"."cep" is null or "company_fiscal"."cep" ~ '^[0-9]{8}$') and ("company_fiscal"."uf" is null or "company_fiscal"."uf" ~ '^[A-Z]{2}$')),
	CONSTRAINT "company_fiscal_len_chk" CHECK (char_length("company_fiscal"."accountant_name") <= 160 and char_length("company_fiscal"."accountant_document") <= 20 and char_length("company_fiscal"."accountant_crc") <= 30 and char_length("company_fiscal"."accountant_contact") <= 120 and char_length("company_fiscal"."accountant_email") <= 200 and char_length("company_fiscal"."accountant_phone") <= 30 and char_length("company_fiscal"."accountant_notes") <= 500 and char_length("company_fiscal"."municipal_registration") <= 30 and char_length("company_fiscal"."service_code") <= 10 and char_length("company_fiscal"."city_name") <= 80 and char_length("company_fiscal"."street") <= 160 and char_length("company_fiscal"."street_number") <= 20 and char_length("company_fiscal"."complement") <= 80 and char_length("company_fiscal"."district") <= 80 and char_length("company_fiscal"."phone") <= 30)
);
--> statement-breakpoint
CREATE TABLE "email_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"host" text NOT NULL,
	"port" integer NOT NULL,
	"security" text NOT NULL,
	"from_email" text NOT NULL,
	"from_name" text,
	"reply_to" text,
	"user_enc" text NOT NULL,
	"pass_enc" text NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "email_accounts_port_chk" CHECK ("email_accounts"."port" in (25, 465, 587, 2525)),
	CONSTRAINT "email_accounts_security_chk" CHECK ("email_accounts"."security" in ('ssl', 'starttls') and ("email_accounts"."security" = 'ssl') = ("email_accounts"."port" = 465)),
	CONSTRAINT "email_accounts_text_chk" CHECK (char_length("email_accounts"."host") <= 253 and char_length("email_accounts"."from_email") <= 200 and char_length("email_accounts"."from_name") <= 80 and char_length("email_accounts"."reply_to") <= 200),
	CONSTRAINT "email_accounts_sealed_chk" CHECK ("email_accounts"."user_enc" like 'v1.%' and "email_accounts"."pass_enc" like 'v1.%')
);
--> statement-breakpoint
ALTER TABLE "company_fiscal" ADD CONSTRAINT "company_fiscal_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_fiscal" ADD CONSTRAINT "company_fiscal_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_accounts" ADD CONSTRAINT "email_accounts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_accounts" ADD CONSTRAINT "email_accounts_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_fiscal_company_uq" ON "company_fiscal" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_accounts_company_uq" ON "email_accounts" USING btree ("company_id");