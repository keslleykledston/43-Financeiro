# Arquitetura — monólito modular K3G Finance

## Topologia
Navegador → Nginx do host (HTTPS `financeiro.devops.k3gsolutions.com.br`) → Next.js server em `127.0.0.1:porta-livre` → PostgreSQL privado Docker. Worker separado usa **a mesma imagem e banco** para tarefas programadas, outbox e integrações. Sem acesso público ao DB e sem conexão direta browser→DB. Objetos/anexos em storage privado com ACL + URL assinada de curta duração; escolher implementação simples com backup.

## Decisões padrão
- Front/back Next.js TypeScript, validação runtime Zod; monorepo NÃO obrigatório.
- ORM: escolher Drizzle ou Prisma pelo caminho mais simples compatível e registrar decisão.
- Sessão/auth: biblioteca mantida e compatível com Next.js selecionado; nunca autenticação feita à mão. Convites, recuperação de acesso, rate limiting, logout, MFA preferencial e sessões revogáveis.
- Sem filas distribuídas externas: `jobs` + `outbox_events` em PostgreSQL; worker usa locking/claim atômico (`FOR UPDATE SKIP LOCKED` ou equivalente seguro), tentativas, lease timeout, jitter/backoff, DLQ e alertas. Efeito externo: idempotency key, reconsulta remota antes de reemitir.
- API REST JSON `/api/v1` + OpenAPI e esquemas. Cookies e CSRF para interface, API keys hashed+scopes+expiry para máquinas. Webhooks assinatura HMAC/mTLS conforme provedor.
- Observabilidade: request_id, correlation_id, logger estruturado sanitizado, métricas simples, health endpoints não sensíveis.

## Pastas sugeridas após scaffold
```
src/app/(auth)/        # login, recuperação, convites
src/app/(app)/         # shell autenticado, dashboard, clientes, contratos...
src/app/api/v1/        # APIs versionadas
src/modules/identity/ # users, companies, memberships, policies
src/modules/crm/      # customers, vendors
src/modules/contracts/
src/modules/billing/   # charges, batches, approvals, scheduling
src/modules/email/     # templates, outbox, delivery
src/modules/banking/  # accounts, imports, reconciliation
src/modules/integrations/ # CoraAdapter, ENFAdapter, EmailAdapter
src/lib/db/           # migrations, transactions
src/lib/security/     # scopes, auth, audit
src/workers/          # jobs
src/components/ui/    # shadcn e design system
help/                 # central de ajuda
```

## Entidades sugeridas e campos mínimos
Todas as tabelas mutáveis: `id uuid`, `created_at`, `updated_at`, `created_by`, quando apropriado `company_id`, índices por tenant+estado+data. UTC para timestamps e timezone `America/Manaus` para calendário operacional (processamento em tz explícita, nunca presumir timezone do server). Armazenar competência como `YYYY-MM-01` data ou `YYYY-MM` validado.

**identidade:** `users`, `companies` (CNPJ unique e protegido), `memberships` (user/company/role/status), `roles`, `permissions`, `role_permissions`, `sessions` (gerenciadas pela lib), `audit_log`.
**cadastro:** `customers` (empresa proprietária + documento/razão social, contato), `customer_contacts` (email financeiro, preferências), `vendors`, `services`.
**contratos:** `contracts` (company/customer/service, monthly_amount numeric, start_at/end_at, status, due_day 1..31, invoice_joint_required, issue_day_override, due_date_policy, competence_rule=previous_month, fiscal_policy_status); `contract_versions` (histórico sem apagar).
**faturamento:** `billing_batches` (company, issue_date, status, approved_by/at), `charges` (company, contract, competence, due_date, scheduled_issue, original_amount, adjustment_amount, total, status, uniqueness), `charge_adjustments`, `approvals` (ator, etapa, razão), `issuance_requests` (provider, operation, external_ref, idem_key, job_status, attempt_count, payload_hash), `fiscal_documents` (numero/status/provider_ref), `payment_slips` (bank account, slip_ref, barcode/PIX payload encrypted/redacted if needed, status).
**emails:** `email_templates` (company, kind, version, subject, sanitized body, status), `email_outbox` (company, charge, template snapshot/version, recipient snapshot, scheduled_for, provider_message_id, state, idempotency_key), `email_events`, `collection_holds`.
**banco:** `bank_accounts` (company/cora external ID masked), `bank_import_batches` (checksum, period, account), `bank_transactions` (account, external_unique_ref or derived hash namespace, posted_at, amount signed numeric, description, source, immutable), `reconciliation_allocations` (bank_transaction ↔ charge/payable, amount), `transfer_pairs` (para intercompany), `payables`.
**infra:** `outbox_events`, `jobs`, `api_keys` (hash only/scopes), `integration_connections` (references to secret store, never plain tokens), `integration_webhook_events` (dedupe, signature verification status), `document_files` (private object URI, checksum, ACL).

## Constraints críticos
- Unique `(company_id, contract_id, competence_month, kind, installment_no)` em `charges`; a importação pode repetir sem duplicar.
- Unique `(provider, account_id, external_transaction_id)` quando id confiável; se ausente, hash contextual e fila de conflitos.
- Unique `(provider, company_id, operation, idempotency_key)` nas emissões.
- Unique `(company_id, charge_id, template_version, kind, scheduled_slot)` para evitar duplicação de email planejado.
- FK cruzadas devem validar mesmo `company_id` nos dois lados, via FK composta ou transação de domínio, e testes multiempresa obrigatórios. Auditoria imutável ou append-only.
- NUNCA expor query global sem escopo da empresa; modo Grupo agrega só registros das empresas autorizadas.
- Valor monetário `numeric(18,2)`, com conferência `sum(allocations) <= abs(transaction.amount)` e saldo restante. Transações e baixas atômicas.
- Jobs de emissão aguardam `approved` e `LIVE_ENABLED`; external service responde `UNKNOWN` → consultar status antes de retry.

## API v1 inicial
`GET /api/v1/me` / `GET /companies` / `GET,POST /customers` / `GET,POST /contracts` / `GET /billing/batches` / `POST /billing/batches/:id/approve` / `GET /charges` / `GET,POST /email/templates` / `POST /bank/imports` / `GET /bank/reconciliation-queue` / `GET /health` (readiness não público com dados). Rotas por empresa: `company_id` verificado server-side. JSON errors padronizados, pagination cursor/limit, safe filtering.

## Padrões de autorização
As permissões devem estar no backend (`requirePermission` / policy middleware) em cada request/action/job. Interface usa permissões apenas para UX. Papel de administrador técnico não ignora company scope nem lê dados financeiros por padrão. Alterações de roles e convites registradas.

## Design de adapters
```
BillingProvider.issueSlip(request, idempotencyKey) -> {status, externalId, dueDate, downloadUrl?}
BillingProvider.lookupSlip(externalId) -> {status, paidAt?}
FiscalProvider.issueServiceInvoice(request, idempotencyKey) -> {status, externalId, documentUrl?}
FiscalProvider.lookupInvoice(externalId) -> {status, documentUrl?}
EmailProvider.send(message, idempotencyKey) -> {status, messageId?}
BankProvider.fetchTransactions(account, cursor) -> {items, nextCursor}
```
O mock implementa mesma interface e é padrão até homologação. `real` depende de feature flags, credenciais protegidas, conta específica e checklist aprovado.

## Falhas e evolução
Codificar módulos separados, sem microsserviços. Versionar schema, jobs e payloads. APIs públicas só após autorização técnica. Migrações preferencialmente backward-compatible, com preview no staging, backup verificável e rollback.
