CREATE TABLE "company_certificates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"purpose" text DEFAULT 'nfse' NOT NULL,
	"status" text DEFAULT 'ativo' NOT NULL,
	"subject" text NOT NULL,
	"holder_cnpj" text NOT NULL,
	"issuer" text NOT NULL,
	"serial" text NOT NULL,
	"not_before" date NOT NULL,
	"not_after" date NOT NULL,
	"fingerprint" text NOT NULL,
	"cert_enc" text,
	"key_enc" text,
	"chain_enc" text,
	"created_by" uuid NOT NULL,
	"closed_by" uuid,
	"closed_at" timestamp with time zone,
	CONSTRAINT "company_certificates_purpose_chk" CHECK ("company_certificates"."purpose" in ('nfse')),
	CONSTRAINT "company_certificates_status_chk" CHECK ("company_certificates"."status" in ('ativo', 'substituido', 'removido')),
	CONSTRAINT "company_certificates_cnpj_chk" CHECK ("company_certificates"."holder_cnpj" ~ '^[0-9]{14}$'),
	CONSTRAINT "company_certificates_fp_chk" CHECK ("company_certificates"."fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "company_certificates_sealed_chk" CHECK (("company_certificates"."status" = 'ativo' and "company_certificates"."cert_enc" is not null and "company_certificates"."key_enc" is not null and "company_certificates"."cert_enc" like 'v1.%' and "company_certificates"."key_enc" like 'v1.%' and ("company_certificates"."chain_enc" is null or "company_certificates"."chain_enc" like 'v1.%')) or ("company_certificates"."status" <> 'ativo' and "company_certificates"."cert_enc" is null and "company_certificates"."key_enc" is null and "company_certificates"."chain_enc" is null))
);
--> statement-breakpoint
ALTER TABLE "company_certificates" ADD CONSTRAINT "company_certificates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_certificates" ADD CONSTRAINT "company_certificates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_certificates" ADD CONSTRAINT "company_certificates_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_certificates_active_uq" ON "company_certificates" USING btree ("company_id","purpose") WHERE "company_certificates"."status" = 'ativo';