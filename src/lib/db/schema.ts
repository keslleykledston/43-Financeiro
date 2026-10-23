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
  check("contracts_amount_chk", sql`${t.monthlyAmount} > 0 and ${t.monthlyAmount} <= 99999999999.99`),
  check("contracts_dates_chk", sql`${t.endAt} is null or ${t.endAt} >= ${t.startAt}`),
  check("contracts_fiscal_chk", sql`${t.fiscalPolicyStatus} in ('pendente', 'definida')`),
]);

export const contractVersions = pgTable("contract_versions", {
  ...base,
  companyId: uuid("company_id").notNull().references(() => companies.id),
  contractId: uuid("contract_id").notNull(),
  version: integer("version").notNull(),
  state: text("state").notNull().default("pendente"), // pendente | aprovada | rejeitada | substituida (rascunho reenviado)
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
  check("contract_versions_state_chk", sql`${t.state} in ('pendente', 'aprovada', 'rejeitada', 'substituida')`),
]);

// Feriados municipais/estaduais por empresa (os nacionais vêm do código). Política de feriado: revisão humana (PRD §4).
export const holidays = pgTable("holidays", {
  ...base,
  companyId: uuid("company_id").notNull().references(() => companies.id),
  day: date("day", { mode: "string" }).notNull(),
  name: text("name").notNull(),
}, (t) => [unique("holidays_company_day_uq").on(t.companyId, t.day)]);

// E05 — lotes de cobrança e cobranças (prévia → aprovada). Nenhuma operação externa: só planejamento e aprovação humana.
// Uma cobrança nasce de contrato ativo + competência; os valores são SNAPSHOT do contrato no momento da prévia.
export const billingBatches = pgTable("billing_batches", {
  ...base,
  companyId: uuid("company_id").notNull().references(() => companies.id),
  issueDate: date("issue_date", { mode: "string" }).notNull(),
  status: text("status").notNull().default("rascunho"), // rascunho | aprovado | cancelado
  generatedBy: uuid("generated_by").references(() => users.id), // quem gerou/atualizou a prévia pela última vez
  approvedBy: uuid("approved_by").references(() => users.id),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  reopenReason: text("reopen_reason"),
}, (t) => [
  unique("billing_batches_company_id_uq").on(t.companyId, t.id),
  uniqueIndex("billing_batches_one_per_date_uq").on(t.companyId, t.issueDate).where(sql`${t.status} <> 'cancelado'`),
  check("billing_batches_status_chk", sql`${t.status} in ('rascunho', 'aprovado', 'cancelado')`),
  check("billing_batches_approval_chk", sql`(${t.status} = 'aprovado') = (${t.approvedBy} is not null and ${t.approvedAt} is not null)`),
]);

export const charges = pgTable("charges", {
  ...base,
  companyId: uuid("company_id").notNull().references(() => companies.id),
  batchId: uuid("batch_id").notNull(),
  contractId: uuid("contract_id").notNull(),
  customerId: uuid("customer_id").notNull(),
  competenceMonth: date("competence_month", { mode: "string" }).notNull(), // 1º dia do mês de competência (M)
  dueDate: date("due_date", { mode: "string" }).notNull(),
  issueDate: date("issue_date", { mode: "string" }).notNull(),
  description: text("description").notNull(),
  amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
  jointInvoice: boolean("joint_invoice").notNull().default(false),
  warnings: jsonb("warnings").notNull().default(sql`'[]'::jsonb`),
  status: text("status").notNull().default("previa"), // previa | aprovada | cancelada
}, (t) => [
  foreignKey({ columns: [t.companyId, t.batchId], foreignColumns: [billingBatches.companyId, billingBatches.id] }),
  foreignKey({ columns: [t.companyId, t.contractId], foreignColumns: [contracts.companyId, contracts.id] }),
  foreignKey({ columns: [t.companyId, t.customerId], foreignColumns: [customers.companyId, customers.id] }),
  uniqueIndex("charges_one_per_competence_uq").on(t.companyId, t.contractId, t.competenceMonth).where(sql`${t.status} <> 'cancelada'`),
  index("charges_batch_idx").on(t.companyId, t.batchId),
  unique("charges_company_id_uq").on(t.companyId, t.id),
  check("charges_status_chk", sql`${t.status} in ('previa', 'aprovada', 'cancelada')`),
  check("charges_amount_chk", sql`${t.amount} > 0 and ${t.amount} <= 99999999999.99`),
  check("charges_competence_day_chk", sql`extract(day from ${t.competenceMonth}) = 1`),
]);

// E06 — modelos de mensagem e fila de envios. SIMULAÇÃO: nenhuma mensagem sai do sistema; a fila só registra o que seria enviado.
// Um modelo = (empresa, tipo da régua, canal). O texto vive em versões; só uma versão fica ativa por modelo.
export const messageTemplates = pgTable("message_templates", {
  ...base,
  companyId: uuid("company_id").notNull().references(() => companies.id),
  kind: text("kind").notNull(), // emissao | d_menos_3 | d0 | d_mais_3 | d_mais_7
  channel: text("channel").notNull(), // email | whatsapp
}, (t) => [
  unique("message_templates_company_id_uq").on(t.companyId, t.id),
  uniqueIndex("message_templates_one_uq").on(t.companyId, t.kind, t.channel),
  check("message_templates_kind_chk", sql`${t.kind} in ('emissao', 'd_menos_3', 'd0', 'd_mais_3', 'd_mais_7')`),
  check("message_templates_channel_chk", sql`${t.channel} in ('email', 'whatsapp')`),
]);

export const messageTemplateVersions = pgTable("message_template_versions", {
  ...base,
  companyId: uuid("company_id").notNull().references(() => companies.id),
  templateId: uuid("template_id").notNull(),
  version: integer("version").notNull(),
  subject: text("subject").notNull().default(""), // só e-mail; uma linha, sem quebras
  body: text("body").notNull(), // texto simples com {{campos}} permitidos; nunca HTML
  state: text("state").notNull().default("rascunho"), // rascunho | ativa | arquivada
  createdBy: uuid("created_by").references(() => users.id),
  activatedBy: uuid("activated_by").references(() => users.id),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
}, (t) => [
  foreignKey({ columns: [t.companyId, t.templateId], foreignColumns: [messageTemplates.companyId, messageTemplates.id] }),
  unique("message_template_versions_company_id_uq").on(t.companyId, t.id),
  unique("message_template_versions_ver_uq").on(t.templateId, t.version),
  uniqueIndex("message_template_versions_one_active_uq").on(t.templateId).where(sql`${t.state} = 'ativa'`),
  check("message_template_versions_state_chk", sql`${t.state} in ('rascunho', 'ativa', 'arquivada')`),
  check("message_template_versions_body_chk", sql`char_length(${t.body}) between 1 and 4000 and char_length(${t.subject}) <= 200`),
]);

// Fila: um item por (cobrança aprovada, tipo da régua, canal). O texto é renderizado só ao "processar" (snapshot, sem dados além do necessário).
export const messageQueue = pgTable("message_queue", {
  ...base,
  companyId: uuid("company_id").notNull().references(() => companies.id),
  chargeId: uuid("charge_id").notNull(),
  customerId: uuid("customer_id").notNull(),
  kind: text("kind").notNull(), // emissao | d_menos_3 | d0 | d_mais_3 | d_mais_7 | revisao_d15
  channel: text("channel").notNull(), // email | whatsapp | interno (revisão humana)
  scheduledFor: date("scheduled_for", { mode: "string" }).notNull(),
  status: text("status").notNull().default("pendente"), // pendente | bloqueado | simulado | cancelado
  blockedReason: text("blocked_reason"),
  templateVersionId: uuid("template_version_id"),
  renderedSubject: text("rendered_subject"),
  renderedBody: text("rendered_body"),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  processedBy: uuid("processed_by").references(() => users.id), // null = agendador automático
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"), // código/motivo genérico do provedor, sem dados do cliente
  providerRef: text("provider_ref"), // identificador devolvido pelo provedor (simulado enquanto não houver E10)
}, (t) => [
  foreignKey({ columns: [t.companyId, t.chargeId], foreignColumns: [charges.companyId, charges.id] }).onDelete("cascade"),
  foreignKey({ columns: [t.companyId, t.customerId], foreignColumns: [customers.companyId, customers.id] }),
  foreignKey({ columns: [t.companyId, t.templateVersionId], foreignColumns: [messageTemplateVersions.companyId, messageTemplateVersions.id] }),
  uniqueIndex("message_queue_one_uq").on(t.companyId, t.chargeId, t.kind, t.channel).where(sql`${t.status} <> 'cancelado'`),
  index("message_queue_due_idx").on(t.companyId, t.status, t.scheduledFor),
  check("message_queue_status_chk", sql`${t.status} in ('pendente', 'bloqueado', 'simulado', 'cancelado')`),
  check("message_queue_kind_chk", sql`${t.kind} in ('emissao', 'd_menos_3', 'd0', 'd_mais_3', 'd_mais_7', 'revisao_d15')`),
  check("message_queue_channel_chk", sql`${t.channel} in ('email', 'whatsapp', 'interno')`),
  check("message_queue_internal_chk", sql`(${t.kind} = 'revisao_d15') = (${t.channel} = 'interno')`),
  check("message_queue_blocked_chk", sql`(${t.status} = 'bloqueado') = (${t.blockedReason} is not null)`),
]);

// E09 — configuração de envio por empresa: janela de horário, limites, canais e chave geral (pausa). Padrões conservadores.
export const messagingSettings = pgTable("messaging_settings", {
  ...base,
  companyId: uuid("company_id").notNull().references(() => companies.id),
  paused: boolean("paused").notNull().default(false), // kill switch: nada é processado, nem manual nem automático
  autoDispatch: boolean("auto_dispatch").notNull().default(false), // o agendador só age nas empresas com isto ligado
  emailEnabled: boolean("email_enabled").notNull().default(true),
  whatsappEnabled: boolean("whatsapp_enabled").notNull().default(false), // WhatsApp (WAHA, não oficial) nasce desligado
  windowStart: text("window_start").notNull().default("09:00"),
  windowEnd: text("window_end").notNull().default("18:00"),
  weekdays: integer("weekdays").array().notNull().default(sql`'{1,2,3,4,5}'::integer[]`), // 0=domingo … 6=sábado
  skipHolidays: boolean("skip_holidays").notNull().default(true),
  maxPerRun: integer("max_per_run").notNull().default(50),
  maxPerHour: integer("max_per_hour").notNull().default(30),
  maxLateDays: integer("max_late_days").notNull().default(2), // além disto a mensagem perdeu o sentido: vai para revisão manual
  updatedBy: uuid("updated_by").references(() => users.id),
}, (t) => [
  unique("messaging_settings_company_uq").on(t.companyId),
  check("messaging_settings_window_chk", sql`${t.windowStart} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and ${t.windowEnd} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and ${t.windowStart} < ${t.windowEnd}`),
  check("messaging_settings_limits_chk", sql`${t.maxPerRun} between 1 and 500 and ${t.maxPerHour} between 1 and 2000 and ${t.maxLateDays} between 0 and 30`),
  check("messaging_settings_weekdays_chk", sql`cardinality(${t.weekdays}) between 1 and 7 and ${t.weekdays} <@ array[0,1,2,3,4,5,6]`),
]);
