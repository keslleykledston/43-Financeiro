CREATE TABLE "contract_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"state" text DEFAULT 'pendente' NOT NULL,
	"terms" jsonb NOT NULL,
	"reason" text,
	"requested_by" uuid NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	CONSTRAINT "contract_versions_uq" UNIQUE("contract_id","version"),
	CONSTRAINT "contract_versions_state_chk" CHECK ("contract_versions"."state" in ('pendente', 'aprovada', 'rejeitada'))
);
--> statement-breakpoint
CREATE TABLE "contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"description" text NOT NULL,
	"monthly_amount" numeric(18, 2) NOT NULL,
	"start_at" date NOT NULL,
	"end_at" date,
	"status" text DEFAULT 'rascunho' NOT NULL,
	"due_day" integer NOT NULL,
	"invoice_joint_required" boolean DEFAULT false NOT NULL,
	"issue_day_override" integer,
	"due_date_policy" text DEFAULT 'contratual' NOT NULL,
	"competence_rule" text DEFAULT 'previous_month' NOT NULL,
	"fiscal_policy_status" text DEFAULT 'pendente' NOT NULL,
	"created_by" uuid,
	CONSTRAINT "contracts_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "contracts_status_chk" CHECK ("contracts"."status" in ('rascunho', 'ativo', 'suspenso', 'encerrado')),
	CONSTRAINT "contracts_due_day_chk" CHECK ("contracts"."due_day" between 1 and 31),
	CONSTRAINT "contracts_issue_day_chk" CHECK ("contracts"."issue_day_override" is null or "contracts"."issue_day_override" between 1 and 28),
	CONSTRAINT "contracts_amount_chk" CHECK ("contracts"."monthly_amount" > 0),
	CONSTRAINT "contracts_dates_chk" CHECK ("contracts"."end_at" is null or "contracts"."end_at" >= "contracts"."start_at"),
	CONSTRAINT "contracts_fiscal_chk" CHECK ("contracts"."fiscal_policy_status" in ('pendente', 'definida'))
);
--> statement-breakpoint
CREATE TABLE "holidays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"day" date NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "holidays_company_day_uq" UNIQUE("company_id","day")
);
--> statement-breakpoint
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_company_id_contract_id_contracts_company_id_id_fk" FOREIGN KEY ("company_id","contract_id") REFERENCES "public"."contracts"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_company_id_customer_id_customers_company_id_id_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "public"."customers"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contract_versions_one_pending_uq" ON "contract_versions" USING btree ("contract_id") WHERE "contract_versions"."state" = 'pendente';--> statement-breakpoint
CREATE INDEX "contracts_company_status_idx" ON "contracts" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "contracts_customer_idx" ON "contracts" USING btree ("company_id","customer_id");