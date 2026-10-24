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
  // sobe a cada troca de senha / "encerrar todas as sessões": o JWT carrega o valor do login e deixa de valer se divergir
  sessionVersion: integer("session_version").notNull().default(0),
}, (t) => [uniqueIndex("users_email_uq").on(sql`lower(${t.email})`)]);

export const companies = pgTable("companies", {
  ...base,
  name: text("name").notNull(),
  cnpj: text("cnpj"), // sem CNPJ real pré-preenchido
  // de onde vêm os CLIENTES desta empresa: "local" (cadastro/CSV aqui) ou "crm" (importados do CRM, somente leitura)
  customerMode: text("customer_mode").notNull().default("local"),
  // E21 — dados cadastrais da própria empresa (edição pela diretoria; `name` é o nome de exibição)
  legalName: text("legal_name"),
  financeEmail: text("finance_email"),
  address: text("address"),
}, (t) => [
  uniqueIndex("companies_cnpj_uq").on(t.cnpj).where(sql`${t.cnpj} is not null`),
  check("companies_customer_mode_chk", sql`${t.customerMode} in ('local', 'crm')`),
  check("companies_profile_chk", sql`char_length(${t.legalName}) <= 200 and char_length(${t.financeEmail}) <= 200 and char_length(${t.address}) <= 300`),
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

export const customers = pgTable("customers", {
  ...partyColumns(),
  // Nome para MOSTRAR (E25, pedido do dono): quando a razão social é só o número do CNPJ (ex.: "19.534.417 LTDA") e há nome fantasia, mostra o fantasia.
  // A razão social segue intacta em `legal_name` e é a usada em boleto/NFS-e. Coluna gerada: não se grava, só se lê.
  displayName: text("display_name").generatedAlwaysAs(sql`CASE WHEN legal_name ~* '^[0-9]{2}[.]?[0-9]{3}[.]?[0-9]{3}([/]?[0-9]{4}[-]?[0-9]{2})?( (ltda|s/?a|s[.]a[.]?|me|epp|eireli|slu))?[.]?$' AND coalesce(btrim(trade_name), '') <> '' THEN btrim(trade_name) ELSE legal_name END`).notNull(),
}, (t) => [
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
// Lote de importação de contratos (planilha → CSV → prévia → confirmação). Os contratos nascem como rascunho; o lote é aprovado/rejeitado de uma vez.
export const contractImports = pgTable("contract_imports", {
  ...base,
  companyId: uuid("company_id").notNull().references(() => companies.id),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  summary: jsonb("summary").notNull().default(sql`'{}'::jsonb`), // só contagens
}, (t) => [unique("contract_imports_company_id_uq").on(t.companyId, t.id)]);

export const contracts = pgTable("contracts", {
  ...base,
  companyId: uuid("company_id").notNull().references(() => companies.id),
  customerId: uuid("customer_id").notNull(),
  importId: uuid("import_id"), // lote de importação que originou o contrato
  commissionPartner: text("commission_partner"), // parceiro que recebe comissão sobre este contrato (ex.: Medina)
  commissionBps: integer("commission_bps"), // percentual da comissão em pontos-base (3000 = 30%) sobre o valor mensal do contrato; nulo = parceiro marcado, percentual ainda não definido (E18)
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
  foreignKey({ columns: [t.companyId, t.importId], foreignColumns: [contractImports.companyId, contractImports.id] }),
  check("contracts_commission_chk", sql`${t.commissionPartner} is null or char_length(${t.commissionPartner}) between 2 and 60`),
  check("contracts_commission_bps_chk", sql`${t.commissionBps} is null or (${t.commissionBps} between 1 and 10000 and ${t.commissionPartner} is not null)`),
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
  // E21 — aditivo: tipo, data em que passa a valer e referência do documento assinado
  kind: text("kind").notNull().default("alteracao"),
  effectiveOn: date("effective_on", { mode: "string" }),
  reference: text("reference"),
  requestedBy: uuid("requested_by").notNull().references(() => users.id),
  decidedBy: uuid("decided_by").references(() => users.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decisionNote: text("decision_note"),
}, (t) => [
  foreignKey({ columns: [t.companyId, t.contractId], foreignColumns: [contracts.companyId, contracts.id] }),
  unique("contract_versions_uq").on(t.contractId, t.version),
  uniqueIndex("contract_versions_one_pending_uq").on(t.contractId).where(sql`${t.state} = 'pendente'`), // no máximo uma alteração pendente por contrato
  check("contract_versions_state_chk", sql`${t.state} in ('pendente', 'aprovada', 'rejeitada', 'substituida')`),
  check("contract_versions_kind_chk", sql`${t.kind} in ('alteracao', 'reajuste', 'valor', 'prorrogacao', 'outros')`),
  check("contract_versions_reference_chk", sql`char_length(${t.reference}) <= 200`),
]);

// E21 — comentários (só de acréscimo; o banco recusa editar e apagar). Pertencem a um contrato OU a um cliente.
export const notes = pgTable("notes", {
  ...base,
  companyId: uuid("company_id").notNull().references(() => companies.id),
  contractId: uuid("contract_id"),
  customerId: uuid("customer_id"),
  body: text("body").notNull(),
  authorId: uuid("author_id").notNull().references(() => users.id),
}, (t) => [
  foreignKey({ columns: [t.companyId, t.contractId], foreignColumns: [contracts.companyId, contracts.id] }),
  foreignKey({ columns: [t.companyId, t.customerId], foreignColumns: [customers.companyId, customers.id] }),
  index("notes_contract_idx").on(t.companyId, t.contractId, t.createdAt),
  index("notes_customer_idx").on(t.companyId, t.customerId, t.createdAt),
  check("notes_one_target_chk", sql`num_nonnulls(${t.contractId}, ${t.customerId}) = 1`),
  check("notes_body_chk", sql`char_length(btrim(${t.body})) between 1 and 2000`),
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
  amount: numeric("amount", { precision: 18, scale: 2 }).notNull(), // valor da cobrança = base + ajustes
  baseAmount: numeric("base_amount", { precision: 18, scale: 2 }).notNull(), // valor fixo do contrato no momento da prévia
  adjustmentAmount: numeric("adjustment_amount", { precision: 18, scale: 2 }).notNull().default("0"), // excedente/acréscimo (+) e desconto (−) da competência
  adjustmentDetail: jsonb("adjustment_detail").notNull().default(sql`'[]'::jsonb`), // SNAPSHOT dos itens (tipo, descrição, valor) que compõem o ajuste: o aprovador aprova exatamente isto
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
  check("charges_composition_chk", sql`${t.amount} = ${t.baseAmount} + ${t.adjustmentAmount}`),
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
  status: text("status").notNull().default("pendente"), // pendente | enviando | enviado (E-mail REAL, E23) | bloqueado | simulado | cancelado
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
  check("message_queue_status_chk", sql`${t.status} in ('pendente', 'enviando', 'enviado', 'bloqueado', 'simulado', 'cancelado')`),
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

// E07 — contas a receber. A cobrança aprovada (charges) é o título; o que foi pago é a soma dos pagamentos ATIVOS.
// Nada é apagado nem sobrescrito: pagamento errado é ESTORNADO (com motivo) e o saldo é sempre recalculado.
// O total pago nunca passa do valor da cobrança (trigger no banco, além da validação no serviço).
export const payments = pgTable("payments", {
  ...base,
  companyId: uuid("company_id").notNull().references(() => companies.id),
  chargeId: uuid("charge_id").notNull(),
  amount: numeric("amount", { precision: 18, scale: 2 }).notNull(), // PRINCIPAL quitado (é o que abate o saldo da cobrança)
  interestAmount: numeric("interest_amount", { precision: 18, scale: 2 }).notNull().default("0"), // juros/multa recebidos além do principal
  discountAmount: numeric("discount_amount", { precision: 18, scale: 2 }).notNull().default("0"), // desconto/abatimento/retenção concedido (principal quitado sem entrar dinheiro)
  paidAt: date("paid_at", { mode: "string" }).notNull(),
  method: text("method").notNull(), // pix | boleto | transferencia | dinheiro | outro
  note: text("note"),
  requestKey: text("request_key"), // idempotência do formulário: duplo clique não registra duas vezes
  status: text("status").notNull().default("ativo"), // ativo | estornado
  registeredBy: uuid("registered_by").notNull().references(() => users.id),
  reversedBy: uuid("reversed_by").references(() => users.id),
  reversedAt: timestamp("reversed_at", { withTimezone: true }),
  reverseReason: text("reverse_reason"),
}, (t) => [
  foreignKey({ columns: [t.companyId, t.chargeId], foreignColumns: [charges.companyId, charges.id] }),
  unique("payments_company_id_uq").on(t.companyId, t.id),
  uniqueIndex("payments_request_key_uq").on(t.companyId, t.requestKey).where(sql`${t.requestKey} is not null`),
  index("payments_charge_idx").on(t.companyId, t.chargeId),
  check("payments_amount_chk", sql`${t.amount} > 0 and ${t.amount} <= 99999999999.99`),
  check("payments_extras_chk", sql`${t.interestAmount} >= 0 and ${t.interestAmount} <= 99999999999.99 and ${t.discountAmount} >= 0 and ${t.discountAmount} < ${t.amount} + ${t.interestAmount}`), // dinheiro recebido (principal + juros − desconto) é sempre > 0
  check("payments_method_chk", sql`${t.method} in ('pix', 'boleto', 'transferencia', 'dinheiro', 'outro', 'extrato')`),
  check("payments_status_chk", sql`${t.status} in ('ativo', 'estornado')`),
  check("payments_reversal_chk", sql`(${t.status} = 'estornado' and ${t.reversedBy} is not null and ${t.reversedAt} is not null and ${t.reverseReason} is not null) or (${t.status} = 'ativo' and ${t.reversedBy} is null and ${t.reversedAt} is null and ${t.reverseReason} is null)`),
  check("payments_note_chk", sql`${t.note} is null or char_length(${t.note}) <= 200`),
]);

// E08 — conciliação bancária. O extrato é a VERDADE do banco: transações importadas são imutáveis (só podem ser desfeitas com a importação).
// Nunca guardamos número completo de conta (só rótulo e final de 4 dígitos). Vincular crédito a cobrança cria um pagamento (E07) e é desfazível.
const moneySigned = (name: string) => numeric(name, { precision: 18, scale: 2 });

export const bankAccounts = pgTable("bank_accounts", {
  ...base,
  companyId: uuid("company_id").notNull().references(() => companies.id),
  name: text("name").notNull(),
  bank: text("bank").notNull(), // rótulo livre: Cora, Caixa, Santander…
  last4: text("last4"), // final da conta, só para conferir que o arquivo é da conta certa
  openingBalance: moneySigned("opening_balance").notNull().default("0"),
  openingDate: date("opening_date", { mode: "string" }).notNull(),
  active: boolean("active").notNull().default(true),
  createdBy: uuid("created_by").references(() => users.id),
}, (t) => [
  unique("bank_accounts_company_id_uq").on(t.companyId, t.id),
  unique("bank_accounts_company_name_uq").on(t.companyId, t.name),
  check("bank_accounts_last4_chk", sql`${t.last4} is null or ${t.last4} ~ '^[0-9]{4}$'`),
  check("bank_accounts_opening_chk", sql`abs(${t.openingBalance}) <= 99999999999.99`),
]);

export const bankImportBatches = pgTable("bank_import_batches", {
  ...base,
  companyId: uuid("company_id").notNull().references(() => companies.id),
  accountId: uuid("account_id").notNull(),
  format: text("format").notNull(), // ofx | csv
  fileName: text("file_name").notNull(),
  checksum: text("checksum").notNull(), // sha256 do arquivo: o mesmo arquivo não entra duas vezes
  status: text("status").notNull().default("previa"), // previa | aplicado | desfeito | cancelado
  rowCount: integer("row_count").notNull().default(0),
  newCount: integer("new_count").notNull().default(0),
  dupCount: integer("dup_count").notNull().default(0),
  periodStart: date("period_start", { mode: "string" }),
  periodEnd: date("period_end", { mode: "string" }),
  ledgerBalance: moneySigned("ledger_balance"), // saldo informado pelo banco no arquivo (OFX), para conferência
  ledgerDate: date("ledger_date", { mode: "string" }),
  importedBy: uuid("imported_by").notNull().references(() => users.id),
  appliedBy: uuid("applied_by").references(() => users.id),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
  undoneBy: uuid("undone_by").references(() => users.id),
  undoneAt: timestamp("undone_at", { withTimezone: true }),
  undoReason: text("undo_reason"),
}, (t) => [
  foreignKey({ columns: [t.companyId, t.accountId], foreignColumns: [bankAccounts.companyId, bankAccounts.id] }),
  unique("bank_import_batches_company_id_uq").on(t.companyId, t.id),
  uniqueIndex("bank_import_batches_checksum_uq").on(t.companyId, t.accountId, t.checksum).where(sql`${t.status} in ('previa', 'aplicado')`),
  check("bank_import_batches_status_chk", sql`${t.status} in ('previa', 'aplicado', 'desfeito', 'cancelado')`),
  check("bank_import_batches_format_chk", sql`${t.format} in ('ofx', 'csv')`),
]);

// Linhas da PRÉVIA (antes de confirmar). Não contam em saldo nem em dedup.
export const bankImportRows = pgTable("bank_import_rows", {
  ...base,
  companyId: uuid("company_id").notNull().references(() => companies.id),
  batchId: uuid("batch_id").notNull(),
  lineNo: integer("line_no").notNull(),
  postedAt: date("posted_at", { mode: "string" }).notNull(),
  amount: moneySigned("amount").notNull(),
  description: text("description").notNull(),
  externalRef: text("external_ref"),
  refKey: text("ref_key").notNull(),
  duplicate: boolean("duplicate").notNull().default(false),
}, (t) => [
  foreignKey({ columns: [t.companyId, t.batchId], foreignColumns: [bankImportBatches.companyId, bankImportBatches.id] }).onDelete("cascade"),
  unique("bank_import_rows_batch_key_uq").on(t.batchId, t.refKey),
]);

export const bankTransactions = pgTable("bank_transactions", {
  ...base,
  companyId: uuid("company_id").notNull().references(() => companies.id),
  accountId: uuid("account_id").notNull(),
  batchId: uuid("batch_id").notNull(),
  postedAt: date("posted_at", { mode: "string" }).notNull(),
  amount: moneySigned("amount").notNull(), // crédito positivo, débito negativo
  description: text("description").notNull(),
  externalRef: text("external_ref"),
  refKey: text("ref_key").notNull(), // identificador do FITID ou hash+ocorrência: base do dedup
  status: text("status").notNull().default("ativa"), // ativa | desfeita
}, (t) => [
  foreignKey({ columns: [t.companyId, t.accountId], foreignColumns: [bankAccounts.companyId, bankAccounts.id] }),
  foreignKey({ columns: [t.companyId, t.batchId], foreignColumns: [bankImportBatches.companyId, bankImportBatches.id] }),
  unique("bank_transactions_company_id_uq").on(t.companyId, t.id),
  uniqueIndex("bank_transactions_ref_uq").on(t.companyId, t.accountId, t.refKey).where(sql`${t.status} = 'ativa'`),
  index("bank_transactions_account_idx").on(t.companyId, t.accountId, t.postedAt),
  check("bank_transactions_amount_chk", sql`${t.amount} <> 0 and abs(${t.amount}) <= 99999999999.99`),
  check("bank_transactions_status_chk", sql`${t.status} in ('ativa', 'desfeita')`),
]);

// Vínculo crédito ↔ cobrança (um crédito pode quitar várias cobranças e uma cobrança pode receber vários créditos).
export const bankAllocations = pgTable("bank_allocations", {
  ...base,
  companyId: uuid("company_id").notNull().references(() => companies.id),
  transactionId: uuid("transaction_id").notNull(),
  chargeId: uuid("charge_id").notNull(),
  paymentId: uuid("payment_id").notNull(), // o pagamento (E07) criado por este vínculo
  amount: moneySigned("amount").notNull(),
  requestKey: text("request_key"),
  status: text("status").notNull().default("ativa"), // ativa | desfeita
  createdBy: uuid("created_by").notNull().references(() => users.id),
  undoneBy: uuid("undone_by").references(() => users.id),
  undoneAt: timestamp("undone_at", { withTimezone: true }),
  undoReason: text("undo_reason"),
}, (t) => [
  foreignKey({ columns: [t.companyId, t.transactionId], foreignColumns: [bankTransactions.companyId, bankTransactions.id] }),
  foreignKey({ columns: [t.companyId, t.chargeId], foreignColumns: [charges.companyId, charges.id] }),
  foreignKey({ columns: [t.companyId, t.paymentId], foreignColumns: [payments.companyId, payments.id] }),
  unique("bank_allocations_company_id_uq").on(t.companyId, t.id),
  unique("bank_allocations_payment_uq").on(t.paymentId),
  uniqueIndex("bank_allocations_request_key_uq").on(t.companyId, t.requestKey).where(sql`${t.requestKey} is not null`),
  index("bank_allocations_tx_idx").on(t.companyId, t.transactionId),
  check("bank_allocations_amount_chk", sql`${t.amount} > 0 and ${t.amount} <= 99999999999.99`),
  check("bank_allocations_status_chk", sql`${t.status} in ('ativa', 'desfeita')`),
  check("bank_allocations_undo_chk", sql`(${t.status} = 'desfeita' and ${t.undoneBy} is not null and ${t.undoneAt} is not null and ${t.undoReason} is not null) or (${t.status} = 'ativa' and ${t.undoneBy} is null and ${t.undoneAt} is null and ${t.undoReason} is null)`),
]);

// Classificação sem cobrança: tarifa, transferência entre contas do grupo, outro. Impede vincular a cobrança enquanto existir.
export const bankTransactionMarks = pgTable("bank_transaction_marks", {
  ...base,
  companyId: uuid("company_id").notNull().references(() => companies.id),
  transactionId: uuid("transaction_id").notNull(),
  kind: text("kind").notNull(), // tarifa | transferencia_grupo | outro
  note: text("note"),
  createdBy: uuid("created_by").notNull().references(() => users.id),
}, (t) => [
  foreignKey({ columns: [t.companyId, t.transactionId], foreignColumns: [bankTransactions.companyId, bankTransactions.id] }),
  unique("bank_transaction_marks_tx_uq").on(t.transactionId),
  check("bank_transaction_marks_kind_chk", sql`${t.kind} in ('tarifa', 'transferencia_grupo', 'outro')`),
  check("bank_transaction_marks_note_chk", sql`${t.note} is null or char_length(${t.note}) <= 200`),
]);

// E10 (motor, SIMULADO) — solicitações de emissão de boleto/NFS-e. O banco só aceita modo "simulado": habilitar emissão real exige uma MIGRAÇÃO
// própria (que também troca a FK message_queue→charges para RESTRICT e adota claim→enviar→registrar nas mensagens), depois de homologação,
// credenciais e autorização explícita. Ver docs/E10_GOLIVE.md.
export const issuanceSettings = pgTable("issuance_settings", {
  ...base,
  companyId: uuid("company_id").notNull().references(() => companies.id),
  paused: boolean("paused").notNull().default(true), // nasce PAUSADO (kill switch)
  dailyLimit: integer("daily_limit").notNull().default(20),
  updatedBy: uuid("updated_by").references(() => users.id),
}, (t) => [
  unique("issuance_settings_company_uq").on(t.companyId),
  check("issuance_settings_limit_chk", sql`${t.dailyLimit} between 1 and 500`),
]);

export const issuanceRequests = pgTable("issuance_requests", {
  ...base,
  companyId: uuid("company_id").notNull().references(() => companies.id),
  chargeId: uuid("charge_id").notNull(),
  kind: text("kind").notNull(), // boleto | nfse
  mode: text("mode").notNull().default("simulado"), // única opção aceita pelo banco nesta fase
  idempotencyKey: text("idempotency_key").notNull(), // fixa por (empresa, cobrança, tipo): reenviar nunca emite 2 vezes no provedor
  status: text("status").notNull().default("pendente"), // pendente | enviando | processando | emitido | desconhecido | falhou | cancelado
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  externalRef: text("external_ref"),
  externalStatus: text("external_status"),
  lastError: text("last_error"), // código genérico, sem dados do cliente
  requestedBy: uuid("requested_by").notNull().references(() => users.id),
}, (t) => [
  foreignKey({ columns: [t.companyId, t.chargeId], foreignColumns: [charges.companyId, charges.id] }).onDelete("cascade"), // só na simulação; no modo real vira RESTRICT (gate)
  unique("issuance_requests_company_id_uq").on(t.companyId, t.id),
  uniqueIndex("issuance_requests_one_uq").on(t.companyId, t.chargeId, t.kind).where(sql`${t.status} <> 'cancelado'`),
  uniqueIndex("issuance_requests_idem_uq").on(t.companyId, t.idempotencyKey).where(sql`${t.status} <> 'cancelado'`),
  index("issuance_requests_due_idx").on(t.companyId, t.status, t.nextAttemptAt),
  check("issuance_requests_mode_chk", sql`${t.mode} = 'simulado'`),
  check("issuance_requests_kind_chk", sql`${t.kind} in ('boleto', 'nfse')`),
  check("issuance_requests_status_chk", sql`${t.status} in ('pendente', 'enviando', 'processando', 'emitido', 'desconhecido', 'falhou', 'cancelado')`),
  check("issuance_requests_attempts_chk", sql`${t.attempts} between 0 and 20`),
  check("issuance_requests_done_chk", sql`${t.status} not in ('emitido', 'processando') or ${t.externalRef} is not null`),
]);

// E11 — contas a pagar. A aplicação NUNCA executa pagamento: ela organiza, aprova (com alçada) e REGISTRA o que foi pago à mão no Cora.
// Fluxo: rascunho → aguardando_aprovacao → aprovado | rejeitado | cancelado. "Paga" é derivado (soma das baixas ativas), como nas contas a receber.
export const payables = pgTable("payables", {
  ...base,
  companyId: uuid("company_id").notNull().references(() => companies.id),
  vendorId: uuid("vendor_id").notNull(),
  description: text("description").notNull(),
  documentNumber: text("document_number"), // nº da nota/boleto/fatura do fornecedor: base da detecção de duplicidade
  amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
  dueDate: date("due_date", { mode: "string" }).notNull(),
  category: text("category"),
  status: text("status").notNull().default("rascunho"),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  decidedBy: uuid("decided_by").references(() => users.id), // aprovou ou rejeitou
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decisionNote: text("decision_note"),
  cancelledBy: uuid("cancelled_by").references(() => users.id),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  cancelReason: text("cancel_reason"),
}, (t) => [
  foreignKey({ columns: [t.companyId, t.vendorId], foreignColumns: [vendors.companyId, vendors.id] }),
  unique("payables_company_id_uq").on(t.companyId, t.id),
  uniqueIndex("payables_doc_uq").on(t.companyId, t.vendorId, sql`lower(${t.documentNumber})`).where(sql`${t.documentNumber} is not null and ${t.status} not in ('cancelado', 'rejeitado')`),
  index("payables_due_idx").on(t.companyId, t.status, t.dueDate),
  check("payables_status_chk", sql`${t.status} in ('rascunho', 'aguardando_aprovacao', 'aprovado', 'rejeitado', 'cancelado')`),
  check("payables_amount_chk", sql`${t.amount} > 0 and ${t.amount} <= 99999999999.99`),
  check("payables_text_chk", sql`char_length(${t.description}) between 2 and 200 and (${t.documentNumber} is null or char_length(${t.documentNumber}) between 1 and 40) and (${t.category} is null or char_length(${t.category}) <= 40)`),
  check("payables_decision_chk", sql`case when ${t.status} in ('aprovado', 'rejeitado') then ${t.decidedBy} is not null and ${t.decidedAt} is not null when ${t.status} in ('rascunho', 'aguardando_aprovacao') then ${t.decidedBy} is null else true end`),
  check("payables_reject_chk", sql`${t.status} <> 'rejeitado' or ${t.decisionNote} is not null`),
  check("payables_cancel_chk", sql`(${t.status} = 'cancelado') = (${t.cancelledBy} is not null and ${t.cancelledAt} is not null and ${t.cancelReason} is not null)`),
]);

export const payablePayments = pgTable("payable_payments", {
  ...base,
  companyId: uuid("company_id").notNull().references(() => companies.id),
  payableId: uuid("payable_id").notNull(),
  amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
  paidAt: date("paid_at", { mode: "string" }).notNull(),
  method: text("method").notNull(), // pix | boleto | ted | transferencia | outro
  reference: text("reference"), // protocolo/comprovante informado por quem executou no banco
  note: text("note"),
  requestKey: text("request_key"),
  status: text("status").notNull().default("ativo"), // ativo | estornado
  registeredBy: uuid("registered_by").notNull().references(() => users.id),
  reversedBy: uuid("reversed_by").references(() => users.id),
  reversedAt: timestamp("reversed_at", { withTimezone: true }),
  reverseReason: text("reverse_reason"),
}, (t) => [
  foreignKey({ columns: [t.companyId, t.payableId], foreignColumns: [payables.companyId, payables.id] }),
  unique("payable_payments_company_id_uq").on(t.companyId, t.id),
  uniqueIndex("payable_payments_request_key_uq").on(t.companyId, t.requestKey).where(sql`${t.requestKey} is not null`),
  index("payable_payments_payable_idx").on(t.companyId, t.payableId),
  check("payable_payments_amount_chk", sql`${t.amount} > 0 and ${t.amount} <= 99999999999.99`),
  check("payable_payments_method_chk", sql`${t.method} in ('pix', 'boleto', 'ted', 'transferencia', 'outro')`),
  check("payable_payments_status_chk", sql`${t.status} in ('ativo', 'estornado')`),
  check("payable_payments_reversal_chk", sql`(${t.status} = 'estornado' and ${t.reversedBy} is not null and ${t.reversedAt} is not null and ${t.reverseReason} is not null) or (${t.status} = 'ativo' and ${t.reversedBy} is null and ${t.reversedAt} is null and ${t.reverseReason} is null)`),
  check("payable_payments_text_chk", sql`(${t.reference} is null or char_length(${t.reference}) <= 60) and (${t.note} is null or char_length(${t.note}) <= 200)`),
]);

// Alçada e segregação por empresa. Padrão conservador: gerente aprova até R$ 5.000,00; ninguém aprova o que criou.
export const payablesSettings = pgTable("payables_settings", {
  ...base,
  companyId: uuid("company_id").notNull().references(() => companies.id),
  managerLimit: numeric("manager_limit", { precision: 18, scale: 2 }).notNull().default("5000.00"),
  directorSelfApproval: boolean("director_self_approval").notNull().default(false),
  updatedBy: uuid("updated_by").references(() => users.id),
}, (t) => [
  unique("payables_settings_company_uq").on(t.companyId),
  check("payables_settings_limit_chk", sql`${t.managerLimit} >= 0 and ${t.managerLimit} <= 99999999999.99`),
]);

// Ajustes da cobrança por competência (ex.: EXCEDENTE da K3G Call, calculado em outro sistema e lançado à mão). Entram no valor da cobrança na prévia do lote.
// Depois que a cobrança da competência está em lote APROVADO, os ajustes ficam travados (trigger): para mudar, reabrir o lote.
export const chargeAdjustments = pgTable("charge_adjustments", {
  ...base,
  companyId: uuid("company_id").notNull().references(() => companies.id),
  contractId: uuid("contract_id").notNull(),
  competenceMonth: date("competence_month", { mode: "string" }).notNull(), // 1º dia do mês de competência
  kind: text("kind").notNull(), // excedente | acrescimo | desconto
  description: text("description").notNull(),
  amount: numeric("amount", { precision: 18, scale: 2 }).notNull(), // sempre positivo; o sinal vem do tipo
  createdBy: uuid("created_by").notNull().references(() => users.id),
  removedBy: uuid("removed_by").references(() => users.id), // remover NÃO apaga: o ajuste fica no histórico, fora do cálculo
  removedAt: timestamp("removed_at", { withTimezone: true }),
}, (t) => [
  foreignKey({ columns: [t.companyId, t.contractId], foreignColumns: [contracts.companyId, contracts.id] }),
  check("charge_adjustments_removed_chk", sql`(${t.removedBy} is null) = (${t.removedAt} is null)`),
  index("charge_adjustments_idx").on(t.companyId, t.contractId, t.competenceMonth),
  check("charge_adjustments_kind_chk", sql`${t.kind} in ('excedente', 'acrescimo', 'desconto')`),
  check("charge_adjustments_amount_chk", sql`${t.amount} > 0 and ${t.amount} <= 99999999999.99`),
  check("charge_adjustments_text_chk", sql`char_length(${t.description}) between 2 and 120`),
  check("charge_adjustments_day_chk", sql`extract(day from ${t.competenceMonth}) = 1`),
]);

// E18 — comissões de parceiros (ex.: Medina). Regra do dono: no dia 16 paga-se o percentual do contrato sobre o valor mensal dos contratos marcados
// cujas cobranças foram RECEBIDAS (quitadas) no mês anterior. O fechamento congela o cálculo (linhas imutáveis); a mudança de percentual só vale para os próximos.
export const commissionStatements = pgTable("commission_statements", {
  ...base,
  companyId: uuid("company_id").notNull().references(() => companies.id),
  partner: text("partner").notNull(),
  month: date("month", { mode: "string" }).notNull(), // 1º dia do mês em que as cobranças foram recebidas; o pagamento é no dia 16 do mês seguinte
  status: text("status").notNull().default("fechado"), // fechado | pago | cancelado
  totalAmount: numeric("total_amount", { precision: 18, scale: 2 }).notNull(),
  lineCount: integer("line_count").notNull(),
  closedBy: uuid("closed_by").notNull().references(() => users.id),
  paidOn: date("paid_on", { mode: "string" }),
  paidBy: uuid("paid_by").references(() => users.id),
  paidNote: text("paid_note"),
  cancelledBy: uuid("cancelled_by").references(() => users.id),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  cancelReason: text("cancel_reason"),
}, (t) => [
  unique("commission_statements_company_id_uq").on(t.companyId, t.id),
  uniqueIndex("commission_statements_one_uq").on(t.companyId, t.partner, t.month).where(sql`${t.status} <> 'cancelado'`),
  check("commission_statements_status_chk", sql`${t.status} in ('fechado', 'pago', 'cancelado')`),
  check("commission_statements_month_chk", sql`extract(day from ${t.month}) = 1`),
  check("commission_statements_partner_chk", sql`char_length(${t.partner}) between 2 and 60`),
  check("commission_statements_total_chk", sql`${t.totalAmount} > 0 and ${t.totalAmount} <= 99999999999.99 and ${t.lineCount} > 0`),
  check("commission_statements_paid_chk", sql`(${t.status} = 'pago') = (${t.paidOn} is not null and ${t.paidBy} is not null)`),
  check("commission_statements_cancel_chk", sql`(${t.status} = 'cancelado') = (${t.cancelledBy} is not null and ${t.cancelledAt} is not null and ${t.cancelReason} is not null)`),
  check("commission_statements_note_chk", sql`${t.paidNote} is null or char_length(${t.paidNote}) <= 200`),
]);

export const commissionLines = pgTable("commission_lines", {
  ...base,
  companyId: uuid("company_id").notNull().references(() => companies.id),
  statementId: uuid("statement_id").notNull(),
  chargeId: uuid("charge_id").notNull(),
  contractId: uuid("contract_id").notNull(),
  customerId: uuid("customer_id").notNull(),
  customerName: text("customer_name").notNull(), // SNAPSHOT do nome no fechamento
  competenceMonth: date("competence_month", { mode: "string" }).notNull(),
  receivedOn: date("received_on", { mode: "string" }).notNull(), // data da baixa que quitou a cobrança
  baseAmount: numeric("base_amount", { precision: 18, scale: 2 }).notNull(), // valor mensal do contrato na cobrança (sem excedente/ajustes)
  bps: integer("bps").notNull(),
  commissionAmount: numeric("commission_amount", { precision: 18, scale: 2 }).notNull(),
  voidedAt: timestamp("voided_at", { withTimezone: true }), // preenchido quando o fechamento é cancelado: a cobrança volta a poder entrar em outro
}, (t) => [
  foreignKey({ columns: [t.companyId, t.statementId], foreignColumns: [commissionStatements.companyId, commissionStatements.id] }),
  foreignKey({ columns: [t.companyId, t.chargeId], foreignColumns: [charges.companyId, charges.id] }),
  foreignKey({ columns: [t.companyId, t.contractId], foreignColumns: [contracts.companyId, contracts.id] }),
  uniqueIndex("commission_lines_charge_uq").on(t.companyId, t.chargeId).where(sql`${t.voidedAt} is null`), // uma cobrança entra em no máximo um fechamento válido
  index("commission_lines_statement_idx").on(t.companyId, t.statementId),
  check("commission_lines_bps_chk", sql`${t.bps} between 1 and 10000`),
  check("commission_lines_base_chk", sql`${t.baseAmount} > 0 and ${t.baseAmount} <= 99999999999.99`),
  check("commission_lines_calc_chk", sql`${t.commissionAmount} = round(${t.baseAmount} * ${t.bps} / 10000.0, 2)`),
  check("commission_lines_day_chk", sql`extract(day from ${t.competenceMonth}) = 1`),
]);

// E19 — credenciais de provedores (hoje só a Cora, apenas boletos). Os segredos ficam CIFRADOS (AES-256-GCM, ver src/lib/security/secretbox.ts) e a tela
// nunca os mostra de volta: só impressão digital e validade do certificado. Guardar credenciais NÃO liga nada: a emissão real segue bloqueada (E10b).
export const providerCredentials = pgTable("provider_credentials", {
  ...base,
  companyId: uuid("company_id").notNull().references(() => companies.id),
  provider: text("provider").notNull(), // cora
  environment: text("environment").notNull(), // homologacao | producao
  label: text("label"), // apelido da conta (não é segredo)
  clientIdEnc: text("client_id_enc").notNull(),
  certEnc: text("cert_enc").notNull(),
  keyEnc: text("key_enc").notNull(),
  certFingerprint: text("cert_fingerprint").notNull(), // SHA-256 do certificado (público)
  certNotAfter: date("cert_not_after", { mode: "string" }).notNull(),
  updatedBy: uuid("updated_by").notNull().references(() => users.id),
}, (t) => [
  uniqueIndex("provider_credentials_one_uq").on(t.companyId, t.provider, t.environment),
  check("provider_credentials_provider_chk", sql`${t.provider} in ('cora')`),
  check("provider_credentials_env_chk", sql`${t.environment} in ('homologacao', 'producao')`),
  check("provider_credentials_label_chk", sql`${t.label} is null or char_length(${t.label}) between 2 and 60`),
  check("provider_credentials_fp_chk", sql`${t.certFingerprint} ~ '^[0-9a-f]{64}$'`),
  check("provider_credentials_sealed_chk", sql`${t.clientIdEnc} like 'v1.%' and ${t.certEnc} like 'v1.%' and ${t.keyEnc} like 'v1.%'`), // nunca texto puro
]);

// E20 — cancelamento de boleto (autorizado pelo dono em 2026-10-24; ADR-017). SOMENTE diretoria. Registro IMUTÁVEL: quem, quando, por quê, qual boleto e o resultado.
// Mesmo padrão do motor de emissão: reservar (enviando) → chamar o provedor fora de transação → registrar. Resposta perdida = `desconhecido` (reconsulta antes de repetir).
export const boletoCancellations = pgTable("boleto_cancellations", {
  ...base,
  companyId: uuid("company_id").notNull().references(() => companies.id),
  chargeId: uuid("charge_id").notNull(),
  requestId: uuid("request_id").notNull(), // solicitação de emissão do boleto que está sendo cancelado
  externalRef: text("external_ref").notNull(), // referência do boleto no provedor
  mode: text("mode").notNull().default("simulado"), // única opção aceita pelo banco nesta fase
  reason: text("reason").notNull(),
  status: text("status").notNull().default("enviando"), // enviando | cancelado | desconhecido | falhou
  attempts: integer("attempts").notNull().default(1),
  lastError: text("last_error"), // código genérico, sem dados do cliente
  requestedBy: uuid("requested_by").notNull().references(() => users.id),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
}, (t) => [
  foreignKey({ columns: [t.companyId, t.chargeId], foreignColumns: [charges.companyId, charges.id] }),
  foreignKey({ columns: [t.companyId, t.requestId], foreignColumns: [issuanceRequests.companyId, issuanceRequests.id] }),
  unique("boleto_cancellations_company_id_uq").on(t.companyId, t.id),
  uniqueIndex("boleto_cancellations_one_active_uq").on(t.companyId, t.requestId).where(sql`${t.status} in ('enviando', 'cancelado', 'desconhecido')`),
  index("boleto_cancellations_charge_idx").on(t.companyId, t.chargeId),
  check("boleto_cancellations_mode_chk", sql`${t.mode} = 'simulado'`),
  check("boleto_cancellations_status_chk", sql`${t.status} in ('enviando', 'cancelado', 'desconhecido', 'falhou')`),
  check("boleto_cancellations_reason_chk", sql`char_length(${t.reason}) between 3 and 200`),
  check("boleto_cancellations_attempts_chk", sql`${t.attempts} between 1 and 20`),
  check("boleto_cancellations_resolved_chk", sql`(${t.status} in ('cancelado', 'falhou')) = (${t.resolvedAt} is not null)`),
]);

// E22 — conta de e-mail (SMTP) por empresa. Usuário e senha CIFRADOS (mesmo cofre da Cora) e escrita apenas; host/porta/remetente não são segredo.
// Guardar NÃO liga o envio: EMAIL_EXTERNAL_ENABLED segue desligada e não existe adaptador real (E10b).
export const emailAccounts = pgTable("email_accounts", {
  ...base,
  companyId: uuid("company_id").notNull().references(() => companies.id),
  host: text("host").notNull(),
  port: integer("port").notNull(),
  security: text("security").notNull(), // ssl (porta 465) | starttls
  fromEmail: text("from_email").notNull(),
  fromName: text("from_name"),
  replyTo: text("reply_to"),
  userEnc: text("user_enc").notNull(),
  passEnc: text("pass_enc").notNull(),
  updatedBy: uuid("updated_by").notNull().references(() => users.id),
}, (t) => [
  uniqueIndex("email_accounts_company_uq").on(t.companyId),
  check("email_accounts_port_chk", sql`${t.port} in (25, 465, 587, 2525)`),
  check("email_accounts_security_chk", sql`${t.security} in ('ssl', 'starttls') and (${t.security} = 'ssl') = (${t.port} = 465)`),
  check("email_accounts_text_chk", sql`char_length(${t.host}) <= 253 and char_length(${t.fromEmail}) <= 200 and char_length(${t.fromName}) <= 80 and char_length(${t.replyTo}) <= 200`),
  check("email_accounts_sealed_chk", sql`${t.userEnc} like 'v1.%' and ${t.passEnc} like 'v1.%'`), // nunca texto puro
]);

// E22 — dados da contabilidade (contador/escritório) e dados fiscais da empresa para a NFS-e. Não são segredos. Edição só pela diretoria (company.manage).
export const companyFiscal = pgTable("company_fiscal", {
  ...base,
  companyId: uuid("company_id").notNull().references(() => companies.id),
  accountantName: text("accountant_name"),
  accountantDocument: text("accountant_document"), // CPF ou CNPJ, só dígitos/letras
  accountantCrc: text("accountant_crc"),
  accountantContact: text("accountant_contact"),
  accountantEmail: text("accountant_email"),
  accountantPhone: text("accountant_phone"),
  accountantNotes: text("accountant_notes"),
  taxRegime: text("tax_regime"), // mei | simples | presumido | real
  municipalRegistration: text("municipal_registration"),
  cnae: text("cnae"), // 7 dígitos
  serviceCode: text("service_code"), // item da LC 116 (ex.: 1.07)
  issRateBps: integer("iss_rate_bps"), // alíquota do ISS em pontos-base (200 = 2%)
  issWithheld: boolean("iss_withheld").notNull().default(false),
  cityName: text("city_name"),
  cityIbge: text("city_ibge"), // 7 dígitos
  uf: text("uf"),
  cep: text("cep"), // 8 dígitos
  street: text("street"),
  streetNumber: text("street_number"),
  complement: text("complement"),
  district: text("district"),
  phone: text("phone"),
  updatedBy: uuid("updated_by").references(() => users.id),
}, (t) => [
  uniqueIndex("company_fiscal_company_uq").on(t.companyId),
  check("company_fiscal_regime_chk", sql`${t.taxRegime} is null or ${t.taxRegime} in ('mei', 'simples', 'presumido', 'real')`),
  check("company_fiscal_iss_chk", sql`${t.issRateBps} is null or ${t.issRateBps} between 0 and 500`),
  check("company_fiscal_formats_chk", sql`(${t.cnae} is null or ${t.cnae} ~ '^[0-9]{7}$') and (${t.cityIbge} is null or ${t.cityIbge} ~ '^[0-9]{7}$') and (${t.cep} is null or ${t.cep} ~ '^[0-9]{8}$') and (${t.uf} is null or ${t.uf} ~ '^[A-Z]{2}$')`),
  check("company_fiscal_len_chk", sql`char_length(${t.accountantName}) <= 160 and char_length(${t.accountantDocument}) <= 20 and char_length(${t.accountantCrc}) <= 30 and char_length(${t.accountantContact}) <= 120 and char_length(${t.accountantEmail}) <= 200 and char_length(${t.accountantPhone}) <= 30 and char_length(${t.accountantNotes}) <= 500 and char_length(${t.municipalRegistration}) <= 30 and char_length(${t.serviceCode}) <= 10 and char_length(${t.cityName}) <= 80 and char_length(${t.street}) <= 160 and char_length(${t.streetNumber}) <= 20 and char_length(${t.complement}) <= 80 and char_length(${t.district}) <= 80 and char_length(${t.phone}) <= 30`),
]);

// E23 — envio REAL de e-mail (canário). Dupla chave: chave do servidor EMAIL_EXTERNAL_ENABLED + autorização registrada aqui pela diretoria
// (referência da autorização escrita, destinatários permitidos, limite diário). Histórico imutável: revogar é a única alteração permitida (trigger).
export const emailLiveAuthorizations = pgTable("email_live_authorizations", {
  ...base,
  companyId: uuid("company_id").notNull().references(() => companies.id),
  reference: text("reference").notNull(), // onde está a autorização escrita (e-mail, ata, documento)
  allowed: text("allowed").array().notNull(), // endereços exatos ou "@dominio" (só o domínio exato, sem subdomínios)
  dailyLimit: integer("daily_limit").notNull(),
  active: boolean("active").notNull().default(true),
  authorizedBy: uuid("authorized_by").notNull().references(() => users.id),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedBy: uuid("revoked_by").references(() => users.id),
}, (t) => [
  uniqueIndex("email_live_auth_active_uq").on(t.companyId).where(sql`${t.active}`),
  check("email_live_auth_ref_chk", sql`char_length(${t.reference}) between 5 and 200`),
  check("email_live_auth_allowed_chk", sql`cardinality(${t.allowed}) between 1 and 20`),
  check("email_live_auth_limit_chk", sql`${t.dailyLimit} between 1 and 200`),
  check("email_live_auth_revoked_chk", sql`${t.active} = (${t.revokedAt} is null)`),
]);

// Registro de cada tentativa de envio real (fila ou teste). Só os DOMÍNIOS dos destinatários (nunca os endereços). Append-only: só sai de "enviando" uma vez.
export const emailSendLog = pgTable("email_send_log", {
  ...base,
  companyId: uuid("company_id").notNull().references(() => companies.id),
  kind: text("kind").notNull(), // fila | teste
  queueId: uuid("queue_id"), // sem FK de propósito: o registro não pode sumir junto com a fila
  recipientDomains: text("recipient_domains").notNull(),
  recipients: integer("recipients").notNull(),
  status: text("status").notNull().default("enviando"), // enviando | enviado | falhou | desconhecido
  providerRef: text("provider_ref"),
  error: text("error"),
  actorId: uuid("actor_id").references(() => users.id), // nulo = agendador
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (t) => [
  index("email_send_log_company_idx").on(t.companyId, t.createdAt),
  check("email_send_log_kind_chk", sql`${t.kind} in ('fila', 'teste')`),
  check("email_send_log_status_chk", sql`${t.status} in ('enviando', 'enviado', 'falhou', 'desconhecido')`),
  check("email_send_log_finished_chk", sql`(${t.status} = 'enviando') = (${t.finishedAt} is null)`),
]);

// H1 — histórico a partir da planilha de boletos (docs/HISTORICO_E_CAIXA.md). STAGING imutável: cada linha da planilha como veio, por empresa. NÃO é cobrança nem
// contrato: nada aqui alimenta lotes, régua, emissão, contas a receber ou painel. Serve ao relatório de divergências e (H2/H3, com autorização própria) à carga histórica.
export const legacyImports = pgTable("legacy_imports", {
  ...base,
  companyId: uuid("company_id").notNull().references(() => companies.id),
  fileSha256: text("file_sha256").notNull(), // identifica o arquivo: reimportar o mesmo arquivo não duplica
  fileLabel: text("file_label").notNull(),
  year: integer("year").notNull(),
  rowCount: integer("row_count").notNull(),
  createdBy: uuid("created_by").notNull().references(() => users.id),
}, (t) => [
  uniqueIndex("legacy_imports_file_uq").on(t.companyId, t.fileSha256),
  unique("legacy_imports_company_id_uq").on(t.companyId, t.id),
  check("legacy_imports_sha_chk", sql`${t.fileSha256} ~ '^[0-9a-f]{64}$'`),
  check("legacy_imports_year_chk", sql`${t.year} between 2000 and 2100`),
]);

export const legacyBillingRows = pgTable("legacy_billing_rows", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  companyId: uuid("company_id").notNull(),
  importId: uuid("import_id").notNull(),
  sheet: text("sheet").notNull(), // nome da aba
  rowNumber: integer("row_number").notNull(), // linha na aba (1 = primeira)
  month: text("month").notNull(), // YYYY-MM da aba = mês do VENCIMENTO
  customerName: text("customer_name").notNull(),
  documentRaw: text("document_raw").notNull(),
  document: text("document"), // normalizado e validado; nulo se faltando/inválido
  customerId: uuid("customer_id"), // cliente da empresa com este documento, quando já existe (informativo)
  block: text("block").notNull(), // solutions (valor bruto) | call (plano + excedente): decide como o valor da cobrança é calculado
  amount: numeric("amount", { precision: 18, scale: 2 }).notNull(), // valor da cobrança pela regra do bloco (guardado, para o relatório não recalcular)
  service: text("service"),
  observation: text("observation"),
  grossAmount: numeric("gross_amount", { precision: 18, scale: 2 }), // VALOR BRUTO (Solutions)
  planAmount: numeric("plan_amount", { precision: 18, scale: 2 }), // Plano (Call)
  excessAmount: numeric("excess_amount", { precision: 18, scale: 2 }), // Excedente (Call)
  netAmount: numeric("net_amount", { precision: 18, scale: 2 }), // LÍQUIDO (o que entrou, com juros/descontos)
  dueOn: date("due_on", { mode: "string" }),
  paidOn: date("paid_on", { mode: "string" }),
  paidRaw: text("paid_raw"), // texto da célula de pagamento quando não é data (ex.: dois pagamentos "24/03;14/04")
}, (t) => [
  foreignKey({ columns: [t.companyId, t.importId], foreignColumns: [legacyImports.companyId, legacyImports.id] }).onDelete("cascade"),
  foreignKey({ columns: [t.companyId, t.customerId], foreignColumns: [customers.companyId, customers.id] }),
  uniqueIndex("legacy_rows_pos_uq").on(t.importId, t.sheet, t.rowNumber),
  index("legacy_rows_company_month_idx").on(t.companyId, t.month),
  check("legacy_rows_month_chk", sql`${t.month} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
  check("legacy_rows_paidraw_chk", sql`char_length(${t.paidRaw}) <= 40`),
  check("legacy_rows_block_chk", sql`${t.block} in ('solutions', 'call') and ${t.amount} >= 0`),
  check("legacy_rows_amounts_chk", sql`coalesce(${t.grossAmount}, 0) >= 0 and coalesce(${t.planAmount}, 0) >= 0 and coalesce(${t.excessAmount}, 0) >= 0 and coalesce(${t.netAmount}, 0) >= 0`),
]);

// H1 — correções de CNPJ/CPF pedidas pela diretoria/gerência sobre o histórico (ex.: "…-60" digitado errado na planilha). O staging NÃO muda: a correção vale por NOME do
// cliente na análise e nos próximos passos (H2/H3). Não altera cadastro de cliente. Cada correção é auditada (sem nome nem documento).
export const legacyDocumentFixes = pgTable("legacy_document_fixes", {
  ...base,
  companyId: uuid("company_id").notNull().references(() => companies.id),
  nameKey: text("name_key").notNull(), // nome do cliente normalizado (maiúsculas, sem acento, espaços únicos)
  customerName: text("customer_name").notNull(), // como aparece na planilha (para mostrar)
  document: text("document").notNull(), // CPF/CNPJ validado, só dígitos/letras
  note: text("note"),
  fixedBy: uuid("fixed_by").notNull().references(() => users.id),
}, (t) => [
  uniqueIndex("legacy_doc_fix_name_uq").on(t.companyId, t.nameKey),
  check("legacy_doc_fix_doc_chk", sql`${t.document} ~ '^[0-9A-Z]{11,14}$'`),
  check("legacy_doc_fix_len_chk", sql`char_length(${t.nameKey}) between 1 and 200 and char_length(${t.note}) <= 200`),
]);

