-- E32: TRUNCATE não dispara os gatilhos de linha (UPDATE/DELETE) das tabelas só-de-acréscimo; estes gatilhos de instrução fecham essa brecha.
-- Manutenção legítima (raríssima, com ordem do dono e backup): numa transação, ALTER TABLE <t> DISABLE TRIGGER <t>_no_truncate_trg; truncar; ENABLE de novo.
-- Banco de teste (nome terminado em _test) é isento.
CREATE OR REPLACE FUNCTION forbid_truncate_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF right(current_database(), 5) = '_test' THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'TRUNCATE não é permitido na tabela % (registro imutável)', TG_TABLE_NAME USING ERRCODE = '42501';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate_trg BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate_guard();
--> statement-breakpoint
CREATE TRIGGER bank_allocations_no_truncate_trg BEFORE TRUNCATE ON bank_allocations FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate_guard();
--> statement-breakpoint
CREATE TRIGGER bank_transaction_marks_no_truncate_trg BEFORE TRUNCATE ON bank_transaction_marks FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate_guard();
--> statement-breakpoint
CREATE TRIGGER bank_transactions_no_truncate_trg BEFORE TRUNCATE ON bank_transactions FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate_guard();
--> statement-breakpoint
CREATE TRIGGER boleto_cancellations_no_truncate_trg BEFORE TRUNCATE ON boleto_cancellations FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate_guard();
--> statement-breakpoint
CREATE TRIGGER charge_adjustments_no_truncate_trg BEFORE TRUNCATE ON charge_adjustments FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate_guard();
--> statement-breakpoint
CREATE TRIGGER commission_lines_no_truncate_trg BEFORE TRUNCATE ON commission_lines FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate_guard();
--> statement-breakpoint
CREATE TRIGGER commission_statements_no_truncate_trg BEFORE TRUNCATE ON commission_statements FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate_guard();
--> statement-breakpoint
CREATE TRIGGER contract_imports_no_truncate_trg BEFORE TRUNCATE ON contract_imports FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate_guard();
--> statement-breakpoint
CREATE TRIGGER email_live_authorizations_no_truncate_trg BEFORE TRUNCATE ON email_live_authorizations FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate_guard();
--> statement-breakpoint
CREATE TRIGGER email_send_log_no_truncate_trg BEFORE TRUNCATE ON email_send_log FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate_guard();
--> statement-breakpoint
CREATE TRIGGER expense_applications_no_truncate_trg BEFORE TRUNCATE ON expense_applications FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate_guard();
--> statement-breakpoint
CREATE TRIGGER expense_import_rows_no_truncate_trg BEFORE TRUNCATE ON expense_import_rows FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate_guard();
--> statement-breakpoint
CREATE TRIGGER expense_imports_no_truncate_trg BEFORE TRUNCATE ON expense_imports FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate_guard();
--> statement-breakpoint
CREATE TRIGGER legacy_billing_rows_no_truncate_trg BEFORE TRUNCATE ON legacy_billing_rows FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate_guard();
--> statement-breakpoint
CREATE TRIGGER legacy_imports_no_truncate_trg BEFORE TRUNCATE ON legacy_imports FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate_guard();
--> statement-breakpoint
CREATE TRIGGER message_queue_no_truncate_trg BEFORE TRUNCATE ON message_queue FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate_guard();
--> statement-breakpoint
CREATE TRIGGER notes_no_truncate_trg BEFORE TRUNCATE ON notes FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate_guard();
--> statement-breakpoint
CREATE TRIGGER partner_entries_no_truncate_trg BEFORE TRUNCATE ON partner_entries FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate_guard();
--> statement-breakpoint
CREATE TRIGGER payable_payments_no_truncate_trg BEFORE TRUNCATE ON payable_payments FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate_guard();
--> statement-breakpoint
CREATE TRIGGER payables_no_truncate_trg BEFORE TRUNCATE ON payables FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate_guard();
--> statement-breakpoint
CREATE TRIGGER payments_no_truncate_trg BEFORE TRUNCATE ON payments FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate_guard();
--> statement-breakpoint
CREATE TRIGGER boleto_cancel_requests_no_truncate_trg BEFORE TRUNCATE ON boleto_cancel_requests FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate_guard();
