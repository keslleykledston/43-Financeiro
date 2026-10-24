CREATE TABLE "legacy_document_fixes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"name_key" text NOT NULL,
	"customer_name" text NOT NULL,
	"document" text NOT NULL,
	"note" text,
	"fixed_by" uuid NOT NULL,
	CONSTRAINT "legacy_doc_fix_doc_chk" CHECK ("legacy_document_fixes"."document" ~ '^[0-9A-Z]{11,14}$'),
	CONSTRAINT "legacy_doc_fix_len_chk" CHECK (char_length("legacy_document_fixes"."name_key") between 1 and 200 and char_length("legacy_document_fixes"."note") <= 200)
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "display_name" text GENERATED ALWAYS AS (CASE WHEN legal_name ~* '^[0-9]{2}[.]?[0-9]{3}[.]?[0-9]{3}([/]?[0-9]{4}[-]?[0-9]{2})?( (ltda|s/?a|s[.]a[.]?|me|epp|eireli|slu))?[.]?$' AND coalesce(btrim(trade_name), '') <> '' THEN btrim(trade_name) ELSE legal_name END) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "legacy_billing_rows" ADD COLUMN "paid_raw" text;--> statement-breakpoint
ALTER TABLE "legacy_document_fixes" ADD CONSTRAINT "legacy_document_fixes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_document_fixes" ADD CONSTRAINT "legacy_document_fixes_fixed_by_users_id_fk" FOREIGN KEY ("fixed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "legacy_doc_fix_name_uq" ON "legacy_document_fixes" USING btree ("company_id","name_key");--> statement-breakpoint
ALTER TABLE "legacy_billing_rows" ADD CONSTRAINT "legacy_rows_paidraw_chk" CHECK (char_length("legacy_billing_rows"."paid_raw") <= 40);