import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, uniqueIndex, index, jsonb, pgEnum } from "drizzle-orm/pg-core";

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
