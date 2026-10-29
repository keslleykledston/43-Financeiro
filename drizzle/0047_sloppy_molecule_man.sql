CREATE TABLE "whatsapp_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"customer_id" uuid,
	"phone" text NOT NULL,
	"decision" text NOT NULL,
	"scope" text DEFAULT 'company' NOT NULL,
	"evidence_source" text NOT NULL,
	"evidence_ref" text NOT NULL,
	"actor_id" uuid NOT NULL,
	CONSTRAINT "whatsapp_consents_phone_chk" CHECK ("whatsapp_consents"."phone" ~ '^55[0-9]{10,11}$'),
	CONSTRAINT "whatsapp_consents_decision_chk" CHECK ("whatsapp_consents"."decision" in ('opt_in', 'opt_out')),
	CONSTRAINT "whatsapp_consents_scope_chk" CHECK ("whatsapp_consents"."scope" in ('company', 'global')),
	CONSTRAINT "whatsapp_consents_source_chk" CHECK ("whatsapp_consents"."evidence_source" in ('verbal', 'escrito', 'formulario', 'cliente_iniciou')),
	CONSTRAINT "whatsapp_consents_ref_chk" CHECK (char_length("whatsapp_consents"."evidence_ref") between 3 and 200)
);
--> statement-breakpoint
ALTER TABLE "whatsapp_consents" ADD CONSTRAINT "whatsapp_consents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_consents" ADD CONSTRAINT "whatsapp_consents_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_consents" ADD CONSTRAINT "whatsapp_consents_company_id_customer_id_customers_company_id_id_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "public"."customers"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "whatsapp_consents_company_phone_idx" ON "whatsapp_consents" USING btree ("company_id","phone","created_at");--> statement-breakpoint
CREATE INDEX "whatsapp_consents_phone_idx" ON "whatsapp_consents" USING btree ("phone","scope","created_at");--> statement-breakpoint
CREATE FUNCTION whatsapp_consents_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'o registro de consentimento é permanente: registre um novo evento em vez de editar ou apagar' USING ERRCODE = '23514';
END $$;--> statement-breakpoint
CREATE TRIGGER whatsapp_consents_guard_trg BEFORE UPDATE OR DELETE ON whatsapp_consents FOR EACH ROW EXECUTE FUNCTION whatsapp_consents_guard();--> statement-breakpoint
CREATE TRIGGER whatsapp_consents_no_truncate_trg BEFORE TRUNCATE ON whatsapp_consents FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate_guard();
