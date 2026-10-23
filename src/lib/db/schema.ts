import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, uniqueIndex, index, jsonb, pgEnum, integer, boolean, unique, foreignKey, check, numeric, date } from "drizzle-orm/pg-core";

export const roleEnum = pgEnum("role", ["admin_tecnico", "diretoria", "gerente", "assistente", "contabilidade"]);
export const statusEnum = pgEnum("member_status", ["active", "invited", "removed"]);

const base = {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const users = pgTable("users", {
  ...base,
  email: text("email").notNull(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
}, (t) => [uniqueIndex("users_email_uq").on(sql`lower(${t.email})`)]);

export const companies = pgTable("companies", {
  ...base,
  name: text("name").notNull(),
  cnpj: text("cnpj"), // sem CNPJ real pré-preenchido
  // de onde vêm os CLIENTES desta empresa: "local" (cadastro/CSV aqui) ou "crm" (importados do CRM, somente leitura)
  customerMode: text("customer_mode").notNull().default("local"),
}, (t) => [
  uniqueIndex("companies_cnpj_uq").on(t.cnpj).where(sql`${t.cnpj} is not null`),
  check("companies_customer_mode_chk", sql`${t.customerMode} in ('local', 'crm')`),
]);

export const memberships = pgTable("memberships", {
  ...base,
  userId: uuid("user_id").notNull().references(() => users.id),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  role: roleEnum("role").notNull(),
  status: statusEnum("status").notNull().default("active"),
}, (t) => [uniqueIndex("memberships_user_company_uq").on(t.userId, t.companyId), index("memberships_company_idx").on(t.companyId)]);

export const auditLog = pgTable("audit_log", {
  ...base,
  companyId: uuid("company_id").references(() => companies.id),
  actorId: uuid("actor_id").references(() => users.id),
  action: text("action").notNull(),
  detail: jsonb("detail"),
}, (t) => [index("audit_company_idx").on(t.companyId, t.createdAt)]);

export const invitations = pgTable("invitations", {
  ...base,
  companyId: uuid("company_id").notNull().references(() => companies.id),
  email: text("email").notNull(),
  role: roleEnum("role").notNull(),
  tokenHash: text("token_hash").notNull(), // só o hash; token cru nunca é gravado
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  invitedBy: uuid("invited_by").notNull().references(() => users.id),
}, (t) => [uniqueIndex("invitations_token_uq").on(t.tokenHash), index("invitations_company_idx").on(t.companyId)]);

export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
});

export const docTypeEnum = pgEnum("doc_type", ["cpf", "cnpj"]);

// Desenho original (docs/ARQUITETURA.md): customers, customer_contacts, vendors. Sempre escopados por company_id.
// Colunas idênticas entre customers e vendors (o serviço escolhe a tabela pelo tipo).
const partyColumns = () => ({
  ...base,
  companyId: uuid("company_id").notNull().references(() => companies.id),
  legalName: text("legal_name").notNull(),
  tradeName: text("trade_name"),
  docType: docTypeEnum("doc_type").notNull(),
  document: text("document").notNull(), // normalizado, sem pontuação (CNPJ pode ser alfanumérico)
  archivedAt: timestamp("archived_at", { withTimezone: true }), // exclusão lógica
  // situação comercial: só "ativo" é faturável; suspenso/cancelado continuam clientes (podem ter dívidas antigas a receber)
  status: text("status").notNull().default("ativo"),
  createdBy: uuid("created_by").references(() => users.id),
  // origem do cadastro: manual | csv | crm (CRM é a fonte de verdade de clientes e contratos)
  source: text("source").notNull().default("manual"),
  externalId: text("external_id"),
  externalSyncedAt: timestamp("external_synced_at", { withTimezone: true }),
});

export const customers = pgTable("customers", partyColumns(), (t) => [
  uniqueIndex("customers_company_doc_uq").on(t.companyId, t.document).where(sql`${t.archivedAt} is null`),
  uniqueIndex("customers_company_source_ext_uq").on(t.companyId, t.source, t.externalId).where(sql`${t.externalId} is not null`),
  index("customers_company_name_idx").on(t.companyId, t.legalName),
  unique("customers_company_id_uq").on(t.companyId, t.id), // alvo da FK composta dos contatos
  check("customers_status_chk", sql`${t.status} in ('ativo', 'suspenso', 'cancelado')`),
]);

export const vendors = pgTable("vendors", partyColumns(), (t) => [
  uniqueIndex("vendors_company_doc_uq").on(t.companyId, t.document).where(sql`${t.archivedAt} is null`),
  uniqueIndex("vendors_company_source_ext_uq").on(t.companyId, t.source, t.externalId).where(sql`${t.externalId} is not null`),
  index("vendors_company_name_idx").on(t.companyId, t.legalName),
  unique("vendors_company_id_uq").on(t.companyId, t.id),
  check("vendors_status_chk", sql`${t.status} in ('ativo', 'suspenso', 'cancelado')`),
]);

const contactColumns = () => ({
  ...base,
  companyId: uuid("company_id").notNull().references(() => companies.id),
  name: text("name").notNull(),
  email: text("email"),
  phone: text("phone"),
  isFinancial: boolean("is_financial").notNull().default(false),
  source: text("source").notNull().default("manual"), // manual | csv | crm
});

export const customerContacts = pgTable("customer_contacts", { ...contactColumns(), partyId: uuid("customer_id").notNull() }, (t) => [
  index("customer_contacts_customer_idx").on(t.companyId, t.partyId),
  // o banco garante que contato e cadastro pertencem à MESMA empresa
  foreignKey({ columns: [t.companyId, t.partyId], foreignColumns: [customers.companyId, customers.id] }),
]);

export const vendorContacts = pgTable("vendor_contacts", { ...contactColumns(), partyId: uuid("vendor_id").notNull() }, (t) => [
  index("vendor_contacts_vendor_idx").on(t.companyId, t.partyId),
  foreignKey({ columns: [t.companyId, t.partyId], foreignColumns: [vendors.companyId, vendors.id] }),
]);

// ---------- Integrações (docs/API_E_INTEGRACOES.md): CRM é a fonte de verdade de clientes e contratos ----------
export const integrationConnections = pgTable("integration_connections", {
  ...base,
  companyId: uuid("company_id").notNull().references(() => companies.id),
  kind: text("kind").notNull(), // "crm"
  enabled: boolean("enabled").notNull().default(false),
  // sem segredos aqui: só referência de empresa/conta no CRM. Credenciais ficam em env/secret store.
  settings: jsonb("settings").notNull().default(sql`'{}'::jsonb`),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
}, (t) => [uniqueIndex("integration_connections_company_kind_uq").on(t.companyId, t.kind)]);

export const integrationSyncRuns = pgTable("integration_sync_runs", {
  ...base,
  companyId: uuid("company_id").notNull().references(() => companies.id),
  kind: text("kind").notNull(),
  status: text("status").notNull(), // preview | applied | failed
  stats: jsonb("stats").notNull().default(sql`'{}'::jsonb`), // só contagens (sem PII)
  error: text("error"),
  confirmedBy: uuid("confirmed_by").references(() => users.id),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (t) => [index("integration_sync_runs_company_idx").on(t.companyId, t.createdAt)]);

export const integrationConflicts = pgTable("integration_conflicts", {
  ...base,
  companyId: uuid("company_id").notNull().references(() => companies.id),
  runId: uuid("run_id").references(() => integrationSyncRuns.id),
  entity: text("entity").notNull(), // customer
  externalId: text("external_id").notNull(),
  reason: text("reason").notNull(), // duplicate_document | document_collision | ambiguous_company
  localId: uuid("local_id"), // cadastro local em conflito
  // payload mínimo para decidir (documento e nome); sem contatos
  payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
  status: text("status").notNull().default("open"), // open | linked | ignored
  resolvedBy: uuid("resolved_by").references(() => users.id),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
}, (t) => [
  index("integration_conflicts_company_idx").on(t.companyId, t.status),
  uniqueIndex("integration_conflicts_open_uq").on(t.companyId, t.entity, t.externalId).where(sql`${t.status} = 'open'`),
]);

// ---------- Contratos (E04): fonte de verdade AQUI (o K3G CRM não tem contratos — ADR-012) ----------
// As colunas guardam os termos VIGENTES (aprovados). Mudanças entram como versão pendente em `contract_versions` e só valem após aprovação.
export const contracts = pgTable("contracts", {
  ...base,
  companyId: uuid("company_id").notNull().references(() => companies.id),
  customerId: uuid("customer_id").notNull(),
  description: text("description").notNull(), // serviço contratado
  monthlyAmount: numeric("monthly_amount", { precision: 18, scale: 2 }).notNull(), // dinheiro: numeric(18,2); a aplicação usa centavos inteiros
  startAt: date("start_at", { mode: "string" }).notNull(),
  endAt: date("end_at", { mode: "string" }),
  status: text("status").notNull().default("rascunho"), // rascunho | ativo | suspenso | encerrado
  dueDay: integer("due_day").notNull(),
  invoiceJointRequired: boolean("invoice_joint_required").notNull().default(false), // exige NF emitida junto do boleto
  issueDayOverride: integer("issue_day_override"),
  dueDatePolicy: text("due_date_policy").notNull().default("contratual"),
  competenceRule: text("competence_rule").notNull().default("previous_month"),
  fiscalPolicyStatus: text("fiscal_policy_status").notNull().default("pendente"), // pendente | definida
  createdBy: uuid("created_by").references(() => users.id),
}, (t) => [
  unique("contracts_company_id_uq").on(t.companyId, t.id),
  foreignKey({ columns: [t.companyId, t.customerId], foreignColumns: [customers.companyId, customers.id] }),
  index("contracts_company_status_idx").on(t.companyId, t.status),
  index("contracts_customer_idx").on(t.companyId, t.customerId),
  check("contracts_status_chk", sql`${t.status} in ('rascunho', 'ativo', 'suspenso', 'encerrado')`),
  check("contracts_due_day_chk", sql`${t.dueDay} between 1 and 31`),
  check("contracts_issue_day_chk", sql`${t.issueDayOverride} is null or ${t.issueDayOverride} between 1 and 28`),
  check("contracts_amount_chk", sql`${t.monthlyAmount} > 0`),
  check("contracts_dates_chk", sql`${t.endAt} is null or ${t.endAt} >= ${t.startAt}`),
  check("contracts_fiscal_chk", sql`${t.fiscalPolicyStatus} in ('pendente', 'definida')`),
]);

export const contractVersions = pgTable("contract_versions", {
  ...base,
  companyId: uuid("company_id").notNull().references(() => companies.id),
  contractId: uuid("contract_id").notNull(),
  version: integer("version").notNull(),
  state: text("state").notNull().default("pendente"), // pendente | aprovada | rejeitada
  terms: jsonb("terms").notNull(), // {description, monthlyAmountCents, startAt, endAt, dueDay, invoiceJointRequired, issueDayOverride}
  reason: text("reason"),
  requestedBy: uuid("requested_by").notNull().references(() => users.id),
  decidedBy: uuid("decided_by").references(() => users.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decisionNote: text("decision_note"),
}, (t) => [
  foreignKey({ columns: [t.companyId, t.contractId], foreignColumns: [contracts.companyId, contracts.id] }),
  unique("contract_versions_uq").on(t.contractId, t.version),
  uniqueIndex("contract_versions_one_pending_uq").on(t.contractId).where(sql`${t.state} = 'pendente'`), // no máximo uma alteração pendente por contrato
  check("contract_versions_state_chk", sql`${t.state} in ('pendente', 'aprovada', 'rejeitada')`),
]);

// Feriados municipais/estaduais por empresa (os nacionais vêm do código). Política de feriado: revisão humana (PRD §4).
export const holidays = pgTable("holidays", {
  ...base,
  companyId: uuid("company_id").notNull().references(() => companies.id),
  day: date("day", { mode: "string" }).notNull(),
  name: text("name").notNull(),
}, (t) => [unique("holidays_company_day_uq").on(t.companyId, t.day)]);
