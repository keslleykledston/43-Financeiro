CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"contract_id" uuid,
	"customer_id" uuid,
	"body" text NOT NULL,
	"author_id" uuid NOT NULL,
	CONSTRAINT "notes_one_target_chk" CHECK (num_nonnulls("notes"."contract_id", "notes"."customer_id") = 1),
	CONSTRAINT "notes_body_chk" CHECK (char_length(btrim("notes"."body")) between 1 and 2000)
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "legal_name" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "finance_email" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "contract_versions" ADD COLUMN "kind" text DEFAULT 'alteracao' NOT NULL;--> statement-breakpoint
ALTER TABLE "contract_versions" ADD COLUMN "effective_on" date;--> statement-breakpoint
ALTER TABLE "contract_versions" ADD COLUMN "reference" text;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_company_id_contract_id_contracts_company_id_id_fk" FOREIGN KEY ("company_id","contract_id") REFERENCES "public"."contracts"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_company_id_customer_id_customers_company_id_id_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "public"."customers"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notes_contract_idx" ON "notes" USING btree ("company_id","contract_id","created_at");--> statement-breakpoint
CREATE INDEX "notes_customer_idx" ON "notes" USING btree ("company_id","customer_id","created_at");--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_profile_chk" CHECK (char_length("companies"."legal_name") <= 200 and char_length("companies"."finance_email") <= 200 and char_length("companies"."address") <= 300);--> statement-breakpoint
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_kind_chk" CHECK ("contract_versions"."kind" in ('alteracao', 'reajuste', 'valor', 'prorrogacao', 'outros'));--> statement-breakpoint
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_reference_chk" CHECK (char_length("contract_versions"."reference") <= 200);--> statement-breakpoint
CREATE FUNCTION notes_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'comentários são só de acréscimo: não podem ser editados nem apagados' USING ERRCODE = '23514';
END $$;--> statement-breakpoint
CREATE TRIGGER notes_append_only_trg BEFORE UPDATE OR DELETE ON notes FOR EACH ROW EXECUTE FUNCTION notes_append_only();
