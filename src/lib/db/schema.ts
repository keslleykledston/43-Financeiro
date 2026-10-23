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

export const partyKindEnum = pgEnum("party_kind", ["cliente", "fornecedor"]);
export const docTypeEnum = pgEnum("doc_type", ["cpf", "cnpj"]);

// Clientes e fornecedores (ADR-004: tabela única com `kind`). Sempre escopada por company_id.
export const parties = pgTable("parties", {
  ...base,
  companyId: uuid("company_id").notNull().references(() => companies.id),
  kind: partyKindEnum("kind").notNull(),
  legalName: text("legal_name").notNull(),
  tradeName: text("trade_name"),
  docType: docTypeEnum("doc_type").notNull(),
  document: text("document").notNull(), // normalizado, sem pontuação
  archivedAt: timestamp("archived_at", { withTimezone: true }), // exclusão lógica
  createdBy: uuid("created_by").references(() => users.id),
}, (t) => [
  uniqueIndex("parties_company_kind_doc_uq").on(t.companyId, t.kind, t.document).where(sql`${t.archivedAt} is null`),
  index("parties_company_name_idx").on(t.companyId, t.legalName),
  unique("parties_company_id_uq").on(t.companyId, t.id), // alvo da FK composta dos contatos
]);

export const partyContacts = pgTable("party_contacts", {
  ...base,
  companyId: uuid("company_id").notNull().references(() => companies.id),
  partyId: uuid("party_id").notNull(),
  name: text("name").notNull(),
  email: text("email"),
  phone: text("phone"),
  isFinancial: boolean("is_financial").notNull().default(false),
}, (t) => [
  index("party_contacts_party_idx").on(t.companyId, t.partyId),
  // o banco garante que contato e cadastro pertencem à MESMA empresa
  foreignKey({ columns: [t.companyId, t.partyId], foreignColumns: [parties.companyId, parties.id] }),
]);
