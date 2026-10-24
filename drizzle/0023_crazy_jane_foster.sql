CREATE TABLE "provider_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"environment" text NOT NULL,
	"label" text,
	"client_id_enc" text NOT NULL,
	"cert_enc" text NOT NULL,
	"key_enc" text NOT NULL,
	"cert_fingerprint" text NOT NULL,
	"cert_not_after" date NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "provider_credentials_provider_chk" CHECK ("provider_credentials"."provider" in ('cora')),
	CONSTRAINT "provider_credentials_env_chk" CHECK ("provider_credentials"."environment" in ('homologacao', 'producao')),
	CONSTRAINT "provider_credentials_label_chk" CHECK ("provider_credentials"."label" is null or char_length("provider_credentials"."label") between 2 and 60),
	CONSTRAINT "provider_credentials_fp_chk" CHECK ("provider_credentials"."cert_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "provider_credentials_sealed_chk" CHECK ("provider_credentials"."client_id_enc" like 'v1.%' and "provider_credentials"."cert_enc" like 'v1.%' and "provider_credentials"."key_enc" like 'v1.%')
);
--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_credentials_one_uq" ON "provider_credentials" USING btree ("company_id","provider","environment");