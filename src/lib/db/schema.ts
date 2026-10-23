import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, uniqueIndex, index, jsonb, pgEnum, integer, boolean, unique, foreignKey } from "drizzle-orm/pg-core";

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
}, (t) => [uniqueIndex("companies_cnpj_uq").on(t.cnpj).where(sql`${t.cnpj} is not null`)]);

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
]);

export const vendors = pgTable("vendors", partyColumns(), (t) => [
  uniqueIndex("vendors_company_doc_uq").on(t.companyId, t.document).where(sql`${t.archivedAt} is null`),
  uniqueIndex("vendors_company_source_ext_uq").on(t.companyId, t.source, t.externalId).where(sql`${t.externalId} is not null`),
  index("vendors_company_name_idx").on(t.companyId, t.legalName),
  unique("vendors_company_id_uq").on(t.companyId, t.id),
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
