CREATE TABLE "cost_centers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "cost_centers_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "cost_centers_text_chk" CHECK (char_length("cost_centers"."name") between 2 and 60 and "cost_centers"."code" ~ '^[a-z0-9_]{2,40}$')
);
--> statement-breakpoint
CREATE TABLE "expense_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"grp" text NOT NULL,
	"kind" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort" integer DEFAULT 100 NOT NULL,
	CONSTRAINT "expense_categories_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "expense_categories_kind_chk" CHECK ("expense_categories"."kind" in ('empresa', 'pessoal')),
	CONSTRAINT "expense_categories_text_chk" CHECK (char_length("expense_categories"."name") between 2 and 60 and char_length("expense_categories"."grp") between 2 and 40 and "expense_categories"."code" ~ '^[a-z0-9_]{2,40}$')
);
--> statement-breakpoint
CREATE TABLE "partner_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"partner_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"occurred_on" date NOT NULL,
	"category_id" uuid,
	"description" text NOT NULL,
	"payable_id" uuid,
	"request_key" text,
	"status" text DEFAULT 'ativo' NOT NULL,
	"created_by" uuid NOT NULL,
	"reversed_by" uuid,
	"reversed_at" timestamp with time zone,
	"reverse_reason" text,
	CONSTRAINT "partner_entries_kind_chk" CHECK ("partner_entries"."kind" in ('retirada', 'despesa_paga_pelo_socio', 'devolucao_do_socio', 'reembolso_ao_socio', 'compensacao_lucros')),
	CONSTRAINT "partner_entries_amount_chk" CHECK ("partner_entries"."amount" > 0 and "partner_entries"."amount" <= 99999999999.99),
	CONSTRAINT "partner_entries_status_chk" CHECK ("partner_entries"."status" in ('ativo', 'estornado')),
	CONSTRAINT "partner_entries_reversal_chk" CHECK (("partner_entries"."status" = 'estornado' and "partner_entries"."reversed_by" is not null and "partner_entries"."reversed_at" is not null and char_length(btrim("partner_entries"."reverse_reason")) >= 3) or ("partner_entries"."status" = 'ativo' and "partner_entries"."reversed_by" is null and "partner_entries"."reversed_at" is null and "partner_entries"."reverse_reason" is null)),
	CONSTRAINT "partner_entries_text_chk" CHECK (char_length("partner_entries"."description") between 2 and 200)
);
--> statement-breakpoint
CREATE TABLE "partners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "partners_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "partners_name_chk" CHECK (char_length("partners"."name") between 2 and 80)
);
--> statement-breakpoint
ALTER TABLE "payables" ADD COLUMN "category_id" uuid;--> statement-breakpoint
ALTER TABLE "payables" ADD COLUMN "cost_center_id" uuid;--> statement-breakpoint
ALTER TABLE "payables" ADD COLUMN "competence" date;--> statement-breakpoint
ALTER TABLE "cost_centers" ADD CONSTRAINT "cost_centers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_entries" ADD CONSTRAINT "partner_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_entries" ADD CONSTRAINT "partner_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_entries" ADD CONSTRAINT "partner_entries_reversed_by_users_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_entries" ADD CONSTRAINT "partner_entries_company_id_partner_id_partners_company_id_id_fk" FOREIGN KEY ("company_id","partner_id") REFERENCES "public"."partners"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_entries" ADD CONSTRAINT "partner_entries_company_id_category_id_expense_categories_company_id_id_fk" FOREIGN KEY ("company_id","category_id") REFERENCES "public"."expense_categories"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_entries" ADD CONSTRAINT "partner_entries_company_id_payable_id_payables_company_id_id_fk" FOREIGN KEY ("company_id","payable_id") REFERENCES "public"."payables"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partners" ADD CONSTRAINT "partners_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cost_centers_code_uq" ON "cost_centers" USING btree ("company_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "expense_categories_code_uq" ON "expense_categories" USING btree ("company_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "partner_entries_request_key_uq" ON "partner_entries" USING btree ("company_id","request_key") WHERE "partner_entries"."request_key" is not null;--> statement-breakpoint
CREATE INDEX "partner_entries_partner_idx" ON "partner_entries" USING btree ("company_id","partner_id","occurred_on");--> statement-breakpoint
CREATE UNIQUE INDEX "partners_name_uq" ON "partners" USING btree ("company_id",lower("name"));--> statement-breakpoint
ALTER TABLE "payables" ADD CONSTRAINT "payables_company_id_category_id_expense_categories_company_id_id_fk" FOREIGN KEY ("company_id","category_id") REFERENCES "public"."expense_categories"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payables" ADD CONSTRAINT "payables_company_id_cost_center_id_cost_centers_company_id_id_fk" FOREIGN KEY ("company_id","cost_center_id") REFERENCES "public"."cost_centers"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payables" ADD CONSTRAINT "payables_competence_chk" CHECK ("payables"."competence" is null or extract(day from "payables"."competence") = 1);
--> statement-breakpoint
-- D1: a classificação (categoria, centro, competência) também fica imutável depois do rascunho (mesma regra do restante da conta).
CREATE OR REPLACE FUNCTION payables_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'payable_undeletable'; END IF;
  IF OLD.status IN ('rejeitado', 'cancelado') THEN RAISE EXCEPTION 'payable_immutable'; END IF;
  IF OLD.status <> 'rascunho' AND (NEW.company_id <> OLD.company_id OR NEW.vendor_id <> OLD.vendor_id OR NEW.amount <> OLD.amount OR NEW.due_date <> OLD.due_date
     OR NEW.document_number IS DISTINCT FROM OLD.document_number OR NEW.description <> OLD.description OR NEW.category IS DISTINCT FROM OLD.category OR NEW.created_by <> OLD.created_by
     OR NEW.category_id IS DISTINCT FROM OLD.category_id OR NEW.cost_center_id IS DISTINCT FROM OLD.cost_center_id OR NEW.competence IS DISTINCT FROM OLD.competence) THEN
    RAISE EXCEPTION 'payable_immutable';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'rascunho' AND NEW.status IN ('aguardando_aprovacao', 'cancelado'))
    OR (OLD.status = 'aguardando_aprovacao' AND NEW.status IN ('aprovado', 'rejeitado', 'cancelado'))
    OR (OLD.status = 'aprovado' AND NEW.status = 'cancelado')) THEN
    RAISE EXCEPTION 'payable_bad_transition';
  END IF;
  IF NEW.status = 'cancelado' AND EXISTS (SELECT 1 FROM payable_payments WHERE company_id = OLD.company_id AND payable_id = OLD.id) THEN RAISE EXCEPTION 'payable_has_payments'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
-- Conta-corrente dos sócios: nada se apaga; só "ativo" vira "estornado" (com motivo); lançamento novo só para sócio ativo.
CREATE FUNCTION partner_entries_guard() RETURNS trigger AS $$
DECLARE act boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'partner_entry_undeletable'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'estornado' THEN RAISE EXCEPTION 'partner_entry_immutable'; END IF;
    IF NEW.status <> 'estornado' OR NEW.company_id <> OLD.company_id OR NEW.partner_id <> OLD.partner_id OR NEW.kind <> OLD.kind OR NEW.amount <> OLD.amount
       OR NEW.occurred_on <> OLD.occurred_on OR NEW.category_id IS DISTINCT FROM OLD.category_id OR NEW.description <> OLD.description
       OR NEW.payable_id IS DISTINCT FROM OLD.payable_id OR NEW.request_key IS DISTINCT FROM OLD.request_key OR NEW.created_by <> OLD.created_by THEN
      RAISE EXCEPTION 'partner_entry_immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status <> 'ativo' THEN RAISE EXCEPTION 'partner_entry_insert_not_active'; END IF;
  SELECT active INTO act FROM partners WHERE company_id = NEW.company_id AND id = NEW.partner_id;
  IF act IS DISTINCT FROM true THEN RAISE EXCEPTION 'partner_inactive'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER partner_entries_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON partner_entries FOR EACH ROW EXECUTE FUNCTION partner_entries_guard();
