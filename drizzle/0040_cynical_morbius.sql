CREATE TABLE "contract_adjustment_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"index_code" text NOT NULL,
	"fixed_bps" integer,
	"note" text,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "contract_adjustment_rules_index_chk" CHECK ("contract_adjustment_rules"."index_code" in ('ipca', 'igpm', 'inpc', 'fixo', 'outro')),
	CONSTRAINT "contract_adjustment_rules_fixed_chk" CHECK (("contract_adjustment_rules"."index_code" = 'fixo') = ("contract_adjustment_rules"."fixed_bps" is not null) and ("contract_adjustment_rules"."fixed_bps" is null or "contract_adjustment_rules"."fixed_bps" between 0 and 10000)),
	CONSTRAINT "contract_adjustment_rules_note_chk" CHECK (char_length("contract_adjustment_rules"."note") <= 200)
);
--> statement-breakpoint
CREATE TABLE "contract_alert_snoozes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"due_date" date NOT NULL,
	"until" date,
	"note" text,
	"created_by" uuid NOT NULL,
	CONSTRAINT "contract_alert_snoozes_kind_chk" CHECK ("contract_alert_snoozes"."kind" in ('vigencia_encerrada', 'vigencia_proxima', 'renovacao_proxima', 'reajuste_atrasado', 'reajuste_proximo')),
	CONSTRAINT "contract_alert_snoozes_note_chk" CHECK (char_length("contract_alert_snoozes"."note") <= 200)
);
--> statement-breakpoint
ALTER TABLE "contract_adjustment_rules" ADD CONSTRAINT "contract_adjustment_rules_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_adjustment_rules" ADD CONSTRAINT "contract_adjustment_rules_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_adjustment_rules" ADD CONSTRAINT "contract_adjustment_rules_company_id_contract_id_contracts_company_id_id_fk" FOREIGN KEY ("company_id","contract_id") REFERENCES "public"."contracts"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_alert_snoozes" ADD CONSTRAINT "contract_alert_snoozes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_alert_snoozes" ADD CONSTRAINT "contract_alert_snoozes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_alert_snoozes" ADD CONSTRAINT "contract_alert_snoozes_company_id_contract_id_contracts_company_id_id_fk" FOREIGN KEY ("company_id","contract_id") REFERENCES "public"."contracts"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contract_adjustment_rules_contract_uq" ON "contract_adjustment_rules" USING btree ("contract_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contract_alert_snoozes_uq" ON "contract_alert_snoozes" USING btree ("contract_id","kind","due_date");