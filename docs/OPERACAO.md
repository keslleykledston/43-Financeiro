# Operação e manutenção

## Runbook mínimo
- `/health/live` simples sem conexão DB; `/health/ready` interno com DB e worker checks, sem revelar credenciais ou configs.
- Monitorar status/versão app, espaço livre, backups, filas pendentes, erros de integrações, tempo desde última conciliação, falhas de envio.
- Alerta sem expor dados pessoais: “falhas de emissão > N”, “backup atrasado”, “jobs travados”, “DB indisponível”, “documento fiscal pendente”.
- Logs com requestId/traceId, tenant masked ou uuid, status, duração, sem tokens, CPF/CNPJ completos, payload bancário, e-mail completo, anexos ou senhas.
- Manter CHANGELOG, migrações, owner do deploy, recovery point/recovery time desejados a serem definidos.

## Rotinas
- Diária: ver jobs pendentes/falhados e saúde da última conciliação, executar backup automatizado.
- Semanal: confirmar sucesso de backup/teste automatizado; revisar atualização de dependências e avisos de segurança.
- Mensal: fazer restore teste em ambiente isolado, revisar permissões, fechamento gerencial e diffs de dinheiro.

## Procedimento incidente
1. Suspender ação externa com flags (não desligar a interface sem necessidade).
2. Isolar falha com requestId e estado dos jobs.
3. Preservar logs e auditoria; nunca limpar registros de movimento financeiro.
4. Restaurar serviço de forma reprodutível; aplicar correção revisada.
5. Registrar postmortem/ADR para evitar recorrência.

## Rollback de migrações (Drizzle não gera "down")
Regra: antes de `pnpm db:migrate` em produção, `scripts/backup.sh`. A reversão é **restaurar o backup** (`docs/DEPLOY.md`, `scripts/restore-test.sh` valida o formato) ou aplicar o SQL inverso abaixo se nada foi gravado nas estruturas novas. Primeiro subir de volta a imagem anterior do `web` (compatível com o esquema antigo), depois reverter o banco.

| Migração | O que faz | Reversão manual (só se as tabelas/colunas novas estiverem vazias ou descartáveis) |
|---|---|---|
| 0010 | cria `contracts`, `contract_versions`, `holidays` | `DROP TABLE contract_versions; DROP TABLE contracts; DROP TABLE holidays;` (nessa ordem; perde contratos/feriados cadastrados) |
| 0011 | CHECK de valor máximo em `contracts`; estado `substituida` em `contract_versions` | `ALTER TABLE contracts DROP CONSTRAINT contracts_amount_chk; ALTER TABLE contracts ADD CONSTRAINT contracts_amount_chk CHECK (monthly_amount > 0);` e, se não houver versão `substituida`, recriar `contract_versions_state_chk` com 3 estados. Com versões `substituida` existentes, restaurar o backup. |
| 0012 | cria `billing_batches` e `charges` (E05) | `DROP TABLE charges; DROP TABLE billing_batches;` (nessa ordem; perde lotes/cobranças — só antes de qualquer emissão real; depois, restaurar backup) |
| 0013 | cria `message_templates`, `message_template_versions`, `message_queue` e `charges_company_id_uq` (E06) | `DROP TABLE message_queue; DROP TABLE message_template_versions; DROP TABLE message_templates; ALTER TABLE charges DROP CONSTRAINT charges_company_id_uq;` (nessa ordem; perde modelos editados e a fila simulada — só antes de qualquer envio real; depois, restaurar backup) |
| 0014 | cria `messaging_settings` e colunas `attempts`, `last_error`, `provider_ref` em `message_queue` (E09) | `ALTER TABLE message_queue DROP COLUMN provider_ref, DROP COLUMN last_error, DROP COLUMN attempts; DROP TABLE messaging_settings;` (perde janelas/limites configurados e o contador de tentativas; reaplicar a migração recria os padrões) |
| 0015 | cria `payments` + triggers `payments_guard` e `charges_payments_guard` (E07) | `DROP TRIGGER charges_payments_guard_trg ON charges; DROP FUNCTION charges_payments_guard(); DROP TRIGGER payments_guard_trg ON payments; DROP FUNCTION payments_guard(); DROP TABLE payments;` (o trigger de `payments` bloqueia DELETE: derrube-o antes; perde os pagamentos registrados — nunca antes de exportar/backup; com pagamentos reais, restaurar backup em vez de apagar) |
| 0016 | cria `bank_accounts`, `bank_import_batches`, `bank_import_rows`, `bank_transactions`, `bank_allocations`, `bank_transaction_marks` + triggers de imutabilidade; amplia `payments_method_chk` com `extrato` (E08) | `DROP TABLE bank_transaction_marks, bank_allocations, bank_transactions, bank_import_rows, bank_import_batches, bank_accounts CASCADE; DROP FUNCTION bank_marks_guard(), bank_allocations_guard(), bank_transactions_guard();` recriar `payments_guard()` com o corpo da migração 0015 e `payments_method_chk` sem `extrato` (só se não houver pagamento com método `extrato`; os triggers bloqueiam DELETE: derrube-os antes). Com vínculos reais, restaurar backup em vez de apagar |
| 0017 | cria `issuance_settings` e `issuance_requests` (E10, motor simulado; CHECK `mode = 'simulado'`) | `DROP TABLE issuance_requests; DROP TABLE issuance_settings;` (só simulação: sem efeito fora do sistema). Quando existir emissão REAL, apagar deixa de ser opção: restaurar backup) |
| 0018 | cria `payables`, `payable_payments`, `payables_settings` + triggers `payables_guard` e `payable_payments_guard` (E11) | `DROP TRIGGER payable_payments_guard_trg ON payable_payments; DROP TRIGGER payables_guard_trg ON payables; DROP FUNCTION payable_payments_guard(); DROP FUNCTION payables_guard(); DROP TABLE payable_payments, payables_settings, payables;` (os triggers bloqueiam DELETE: derrube-os antes; perde os lançamentos de contas a pagar — nunca antes de exportar/backup; com baixas reais, restaurar backup em vez de apagar) |

Cada nova migração deve acrescentar sua linha nesta tabela no mesmo commit.
