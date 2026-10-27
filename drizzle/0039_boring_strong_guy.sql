CREATE TABLE "boleto_cancel_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"charge_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pendente' NOT NULL,
	"requested_by" uuid NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"cancellation_id" uuid,
	CONSTRAINT "boleto_cancel_requests_status_chk" CHECK ("boleto_cancel_requests"."status" in ('pendente', 'aprovado', 'recusado', 'retirado')),
	CONSTRAINT "boleto_cancel_requests_reason_chk" CHECK (char_length("boleto_cancel_requests"."reason") between 3 and 200),
	CONSTRAINT "boleto_cancel_requests_decided_chk" CHECK (("boleto_cancel_requests"."status" = 'pendente') = ("boleto_cancel_requests"."decided_at" is null))
);
--> statement-breakpoint
ALTER TABLE "boleto_cancel_requests" ADD CONSTRAINT "boleto_cancel_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boleto_cancel_requests" ADD CONSTRAINT "boleto_cancel_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boleto_cancel_requests" ADD CONSTRAINT "boleto_cancel_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boleto_cancel_requests" ADD CONSTRAINT "boleto_cancel_requests_company_id_charge_id_charges_company_id_id_fk" FOREIGN KEY ("company_id","charge_id") REFERENCES "public"."charges"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boleto_cancel_requests" ADD CONSTRAINT "boleto_cancel_requests_company_id_cancellation_id_boleto_cancellations_company_id_id_fk" FOREIGN KEY ("company_id","cancellation_id") REFERENCES "public"."boleto_cancellations"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "boleto_cancel_requests_one_pending_uq" ON "boleto_cancel_requests" USING btree ("company_id","charge_id") WHERE "boleto_cancel_requests"."status" = 'pendente';--> statement-breakpoint
CREATE INDEX "boleto_cancel_requests_company_idx" ON "boleto_cancel_requests" USING btree ("company_id","status","created_at");