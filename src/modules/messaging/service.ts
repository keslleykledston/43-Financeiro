import { and, asc, desc, eq, inArray, lte, ne, sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { auditLog, billingBatches, charges, companies, customerContacts, customers, emailSendLog, holidays, messageQueue, messageTemplates, messageTemplateVersions, messagingSettings } from "@/lib/db/schema";
import { centsFromNumeric } from "@/lib/money";
import { formatBRL } from "@/lib/format";
import { Invalid, requirePerm } from "@/modules/identity/service";
import { CHANNELS, DEFAULTS, KINDS, WA_DEFAULTS, ladder, render, toEmailHtml, validateTemplate, SAMPLE_VARS, type Channel, type Kind, type QueueKind, type Vars } from "./templates";
import { DEFAULT_SETTINGS, WINDOW_REASON, localParts, parseSettings, windowState, type MessagingSettings } from "./window";
import { addDays } from "./dates";
import { resolveProviders } from "@/modules/providers/registry";
import type { Providers, SendResult } from "@/modules/providers/types";
import { activeAuthorization, domainsOf, finishLog, flagOn, liveEmailFor, sentToday, type LiveState } from "@/modules/providers/email-live";
import { isAllowed } from "@/modules/providers/smtp";
import { SIMULATED_LINE, companyBoletoMode, fetchBoletoPdf, prefetchBoletoMail, type BoletoMail, type BoletoMode } from "./boleto-mail";

/**
 * E06 — SIMULAÇÃO. Nenhuma função daqui envia e-mail ou WhatsApp: a fila registra o que SERIA enviado e "processar" só grava o
 * texto renderizado. O envio real é fase própria (E09/E10), com provedores homologados, janelas, limites e autorização.
 */
const audit = (x: DB, companyId: string, actorId: string | null, action: string, detail: Record<string, unknown>) => x.insert(auditLog).values({ companyId, actorId, action, detail });
const lockQueue = (x: DB, companyId: string) => x.execute(sql`select pg_advisory_xact_lock(hashtext(${"messaging-queue:" + companyId}))`);
const isKind = (k: string): k is Kind => (KINDS as readonly string[]).includes(k);
const isChannel = (c: string): c is Channel => (CHANNELS as readonly string[]).includes(c);
const br = (d: string) => d.split("-").reverse().join("/");
export const todayManaus = () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Manaus" });

// ---------- Modelos ----------
export async function listTemplates(db: DB, actorId: string, companyId: string) {
  await requirePerm(db, actorId, companyId, "messages.read");
  const ts = await db.select().from(messageTemplates).where(eq(messageTemplates.companyId, companyId));
  const vs = ts.length ? await db.select().from(messageTemplateVersions).where(and(eq(messageTemplateVersions.companyId, companyId), inArray(messageTemplateVersions.templateId, ts.map((t) => t.id)))).orderBy(desc(messageTemplateVersions.version)) : [];
  return ts.map((t) => {
    const versions = vs.filter((v) => v.templateId === t.id);
    return { ...t, active: versions.find((v) => v.state === "ativa") ?? null, draft: versions.find((v) => v.state === "rascunho") ?? null, versions };
  });
}

/** Cria os modelos padrão que faltarem (já ATIVOS, em nome de quem clicou). Não sobrescreve nada existente. */
export async function ensureDefaultTemplates(db: DB, actorId: string, companyId: string) {
  await requirePerm(db, actorId, companyId, "messages.templates");
  return db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await lockQueue(x, companyId);
    let created = 0;
    for (const kind of KINDS) for (const channel of CHANNELS) {
      const [t] = await x.insert(messageTemplates).values({ companyId, kind, channel }).onConflictDoNothing().returning();
      if (!t) continue;
      const d = DEFAULTS[kind];
      await x.insert(messageTemplateVersions).values({ companyId, templateId: t.id, version: 1, subject: channel === "email" ? d.subject : "", body: channel === "whatsapp" ? WA_DEFAULTS[kind] : d.body, state: "ativa", createdBy: actorId, activatedBy: actorId, activatedAt: new Date() });
      created++;
    }
    await audit(x, companyId, actorId, "messages.templates.defaults", { created });
    return { created };
  });
}

const BOLETO_IN_BODY = /\{\{\s*(linha_digitavel|link_boleto|pix_copia_cola)\s*\}\}/;
/**
 * Garante os modelos de WhatsApp PRÓPRIOS (curtos, sem dados do boleto): cria os que faltam e, onde o modelo ativo ainda usa dados do boleto (texto padrão antigo), publica uma nova versão
 * e arquiva a anterior. Modelo já editado por uma pessoa (sem campos do boleto) NÃO é tocado.
 */
export async function ensureWhatsappDefaults(db: DB, actorId: string, companyId: string) {
  await requirePerm(db, actorId, companyId, "messages.templates");
  return db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await lockQueue(x, companyId);
    let created = 0, upgraded = 0;
    for (const kind of KINDS) {
      let [t] = await x.select().from(messageTemplates).where(and(eq(messageTemplates.companyId, companyId), eq(messageTemplates.kind, kind), eq(messageTemplates.channel, "whatsapp")));
      if (!t) { [t] = await x.insert(messageTemplates).values({ companyId, kind, channel: "whatsapp" }).returning(); }
      const vs = await x.select().from(messageTemplateVersions).where(and(eq(messageTemplateVersions.companyId, companyId), eq(messageTemplateVersions.templateId, t.id))).orderBy(desc(messageTemplateVersions.version));
      const active = vs.find((v) => v.state === "ativa");
      if (active && !BOLETO_IN_BODY.test(active.body)) continue;
      if (active) await x.update(messageTemplateVersions).set({ state: "arquivada", updatedAt: new Date() }).where(eq(messageTemplateVersions.id, active.id));
      await x.insert(messageTemplateVersions).values({ companyId, templateId: t.id, version: (vs[0]?.version ?? 0) + 1, subject: "", body: WA_DEFAULTS[kind], state: "ativa", createdBy: actorId, activatedBy: actorId, activatedAt: new Date() });
      if (active) upgraded++; else created++;
    }
    await audit(x, companyId, actorId, "messages.templates.whatsapp_defaults", { created, upgraded });
    return { created, upgraded };
  });
}

/** Grava o texto como RASCUNHO (substitui o rascunho aberto, se houver). Só vale para clientes depois de ativar. */
export async function saveDraft(db: DB, actorId: string, companyId: string, kindIn: string, channelIn: string, subject: string, body: string) {
  await requirePerm(db, actorId, companyId, "messages.templates");
  if (!isKind(kindIn) || !isChannel(channelIn)) throw new Invalid("Modelo inválido");
  const v = validateTemplate(channelIn, subject, body);
  if (!v.ok) throw new Invalid(v.error);
  return db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await lockQueue(x, companyId);
    await x.insert(messageTemplates).values({ companyId, kind: kindIn, channel: channelIn }).onConflictDoNothing();
    const [t] = await x.select().from(messageTemplates).where(and(eq(messageTemplates.companyId, companyId), eq(messageTemplates.kind, kindIn), eq(messageTemplates.channel, channelIn))).for("update");
    const [draft] = await x.select().from(messageTemplateVersions).where(and(eq(messageTemplateVersions.companyId, companyId), eq(messageTemplateVersions.templateId, t.id), eq(messageTemplateVersions.state, "rascunho")));
    const now = new Date();
    if (draft) {
      await x.update(messageTemplateVersions).set({ subject: channelIn === "email" ? subject.trim() : "", body, createdBy: actorId, updatedAt: now }).where(eq(messageTemplateVersions.id, draft.id));
      await audit(x, companyId, actorId, "messages.template.draft_saved", { templateId: t.id, version: draft.version });
      return { versionId: draft.id, version: draft.version };
    }
    const [{ max }] = await x.select({ max: sql<number>`coalesce(max(${messageTemplateVersions.version}), 0)::int` }).from(messageTemplateVersions).where(eq(messageTemplateVersions.templateId, t.id));
    const [nv] = await x.insert(messageTemplateVersions).values({ companyId, templateId: t.id, version: max + 1, subject: channelIn === "email" ? subject.trim() : "", body, state: "rascunho", createdBy: actorId }).returning();
    await audit(x, companyId, actorId, "messages.template.draft_saved", { templateId: t.id, version: nv.version });
    return { versionId: nv.id, version: nv.version };
  });
}

/** Ativa uma versão (a ativa anterior vira arquivada). Revalida o texto: nada inválido entra em uso. */
export async function activateVersion(db: DB, actorId: string, companyId: string, versionId: string) {
  await requirePerm(db, actorId, companyId, "messages.templates");
  if (!/^[0-9a-f-]{36}$/i.test(versionId)) throw new Invalid("Versão não encontrada");
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await lockQueue(x, companyId);
    const [v] = await x.select().from(messageTemplateVersions).where(and(eq(messageTemplateVersions.id, versionId), eq(messageTemplateVersions.companyId, companyId))).for("update");
    if (!v) throw new Invalid("Versão não encontrada");
    if (v.state === "ativa") throw new Invalid("Esta versão já está ativa");
    const [t] = await x.select().from(messageTemplates).where(and(eq(messageTemplates.id, v.templateId), eq(messageTemplates.companyId, companyId))).for("update");
    const ok = validateTemplate(t.channel as Channel, v.subject, v.body);
    if (!ok.ok) throw new Invalid(ok.error);
    const now = new Date();
    await x.update(messageTemplateVersions).set({ state: "arquivada", updatedAt: now }).where(and(eq(messageTemplateVersions.templateId, t.id), eq(messageTemplateVersions.state, "ativa")));
    await x.update(messageTemplateVersions).set({ state: "ativa", activatedBy: actorId, activatedAt: now, updatedAt: now }).where(eq(messageTemplateVersions.id, v.id));
    await audit(x, companyId, actorId, "messages.template.activated", { templateId: t.id, version: v.version });
  });
}

export const previewText = (subject: string, body: string, vars: Vars = SAMPLE_VARS) => ({ subject: render(subject, vars), body: render(body, vars) });

// ---------- Fila ----------
const REASON_EMAIL = "Sem contato financeiro com e-mail", REASON_WA = "Sem contato financeiro com telefone";

/**
 * Programa a régua das cobranças APROVADAS. Idempotente (índice único por cobrança+tipo+canal). Não agenda datas já passadas.
 * Sem modelo ativo → não programa (conta em `semModelo`). Sem contato financeiro → item "bloqueado" com motivo.
 * Também cancela itens abertos de cobranças que deixaram de estar aprovadas.
 */
export async function scheduleQueue(db: DB, actorId: string, companyId: string, today = todayManaus()) {
  await requirePerm(db, actorId, companyId, "messages.write");
  return db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await lockQueue(x, companyId);
    const cancelled = await cancelOrphans(x, companyId);
    const rows = await x.select({ c: charges }).from(charges).innerJoin(billingBatches, and(eq(billingBatches.id, charges.batchId), eq(billingBatches.companyId, charges.companyId)))
      .where(and(eq(charges.companyId, companyId), eq(charges.status, "aprovada"), eq(billingBatches.status, "aprovado"),
        sql`coalesce((select sum(p.amount) from payments p where p.company_id = ${charges.companyId} and p.charge_id = ${charges.id} and p.status = 'ativo'), 0) < ${charges.amount}`)); // quitada não recebe régua
    const active = await x.select({ t: messageTemplates, v: messageTemplateVersions }).from(messageTemplateVersions)
      .innerJoin(messageTemplates, and(eq(messageTemplates.id, messageTemplateVersions.templateId), eq(messageTemplates.companyId, messageTemplateVersions.companyId)))
      .where(and(eq(messageTemplateVersions.companyId, companyId), eq(messageTemplateVersions.state, "ativa")));
    const tpl = new Map(active.map((a) => [`${a.t.kind}|${a.t.channel}`, a.v.id]));
    const contacts = await x.select().from(customerContacts).where(and(eq(customerContacts.companyId, companyId), eq(customerContacts.isFinancial, true)));
    const hasEmail = new Set(contacts.filter((c) => c.email?.trim()).map((c) => c.partyId));
    const hasPhone = new Set(contacts.filter((c) => c.phone?.trim()).map((c) => c.partyId));
    let created = 0, blocked = 0, semModelo = 0, passado = 0, unblocked = 0;
    const existing = (await x.select().from(messageQueue).where(and(eq(messageQueue.companyId, companyId), ne(messageQueue.status, "cancelado")))).sort((a, b) => a.generation - b.generation); // a geração mais nova vence no mapa
    const have = new Map(existing.map((q) => [`${q.chargeId}|${q.kind}|${q.channel}`, q]));
    for (const { c } of rows) {
      for (const step of ladder(c)) {
        const channels: (Channel | "interno")[] = step.kind === "revisao_d15" ? ["interno"] : [...CHANNELS];
        for (const channel of channels) {
          const key = `${c.id}|${step.kind}|${channel}`; const cur = have.get(key);
          const reason = channel === "email" && !hasEmail.has(c.customerId) ? REASON_EMAIL : channel === "whatsapp" && !hasPhone.has(c.customerId) ? REASON_WA : null;
          if (cur) { // reavalia só o bloqueio de itens ainda abertos
            if (cur.status === "bloqueado" && !reason && (cur.blockedReason === REASON_EMAIL || cur.blockedReason === REASON_WA)) { await x.update(messageQueue).set({ status: "pendente", blockedReason: null, updatedAt: new Date() }).where(eq(messageQueue.id, cur.id)); unblocked++; }
            else if (cur.status === "pendente" && reason) { await x.update(messageQueue).set({ status: "bloqueado", blockedReason: reason, updatedAt: new Date() }).where(eq(messageQueue.id, cur.id)); blocked++; }
            continue;
          }
          if (step.date < today) { passado++; continue; }
          const tv = channel === "interno" ? null : tpl.get(`${step.kind}|${channel}`) ?? null;
          if (channel !== "interno" && !tv) { semModelo++; continue; }
          await x.insert(messageQueue).values({ companyId, chargeId: c.id, customerId: c.customerId, kind: step.kind, channel, scheduledFor: step.date, status: reason ? "bloqueado" : "pendente", blockedReason: reason, templateVersionId: tv });
          created++; if (reason) blocked++;
        }
      }
    }
    await audit(x, companyId, actorId, "messages.queue.scheduled", { charges: rows.length, created, blocked, unblocked, semModelo, passado, cancelled });
    return { charges: rows.length, created, blocked, unblocked, semModelo, passado, cancelled };
  });
}

/** Itens abertos de cobranças que não estão mais aprovadas (lote reaberto/cancelado, cobrança cancelada). */
async function cancelOrphans(x: DB, companyId: string) {
  const res = await x.execute(sql`
    update message_queue q set status = 'cancelado', blocked_reason = null, updated_at = now()
    where q.company_id = ${companyId} and q.status in ('pendente', 'bloqueado')
      and not exists (select 1 from charges c join billing_batches b on b.company_id = c.company_id and b.id = c.batch_id
        where c.company_id = q.company_id and c.id = q.charge_id and c.status = 'aprovada' and b.status = 'aprovado'
          and coalesce((select sum(p.amount) from payments p where p.company_id = c.company_id and p.charge_id = c.id and p.status = 'ativo'), 0) < c.amount)`);
  return res.count as number;
}

/** Usado por reabrir/cancelar lote e (E07) pagamento: cancela itens abertos das cobranças dadas. Dentro da transação do chamador. */
export async function cancelQueueForCharges(x: DB, companyId: string, chargeIds: string[], o: { keepWhatsapp?: boolean } = {}) {
  if (chargeIds.length === 0) return 0;
  // W3: a fila de WhatsApp a cliente também para quando a cobrança deixa de valer (paga, lote reaberto/cancelado): «na fila» vira «suprimido» (e o envio revalida de qualquer jeito).
  // Cancelar só o BOLETO (`keepWhatsapp`) NÃO suprime: a cobrança segue devida e o texto do WhatsApp não depende do boleto.
  if (!o.keepWhatsapp) await x.execute(sql`update whatsapp_outbox set status = 'suprimido', reason = 'cobranca_alterada', finished_at = now(), updated_at = now()
    where company_id = ${companyId} and status = 'na_fila' and charge_id in (${sql.join(chargeIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
  const res = await x.update(messageQueue).set({ status: "cancelado", blockedReason: null, updatedAt: new Date() })
    .where(and(eq(messageQueue.companyId, companyId), inArray(messageQueue.chargeId, chargeIds), inArray(messageQueue.status, ["pendente", "bloqueado"]))).returning({ id: messageQueue.id });
  return res.length;
}

/**
 * Boleto cancelado com a cobrança ainda aprovada e em aberto: o e-mail de EMISSÃO já enviado levava o boleto antigo. Mensagem enviada é imutável, então entra uma NOVA
 * mensagem de emissão (`generation` + 1, hoje) que espera o boleto novo (a reemissão ganha chave `:gN`). Só se a última emissão do e-mail já foi enviada (ou está sendo enviada: o SMTP roda fora da transação e pode terminar depois do cancelamento): não duplica
 * enquanto a nova não saiu. O histórico do envio anterior fica na própria fila e em `email_send_log`. A régua (D-3 etc.) foi cancelada junto: "Programar régua" recria as datas futuras.
 * Dentro da transação do chamador.
 */
export async function reopenEmissionAfterCancel(x: DB, companyId: string, chargeId: string, today = todayManaus()) {
  const res = await x.execute(sql`
    insert into message_queue (company_id, charge_id, customer_id, kind, channel, scheduled_for, status, template_version_id, generation)
    select q.company_id, q.charge_id, q.customer_id, 'emissao', 'email', ${today}::date, 'pendente', q.template_version_id, q.generation + 1
    from message_queue q
    where q.company_id = ${companyId} and q.charge_id = ${chargeId} and q.kind = 'emissao' and q.channel = 'email' and q.status in ('enviado', 'enviando') -- 'enviando': o SMTP pode concluir depois do cancelamento, com o boleto antigo
      and q.generation = (select max(m.generation) from message_queue m where m.company_id = q.company_id and m.charge_id = q.charge_id and m.kind = 'emissao' and m.channel = 'email' and m.status <> 'cancelado')
      and exists (select 1 from charges c join billing_batches b on b.company_id = c.company_id and b.id = c.batch_id
        where c.company_id = q.company_id and c.id = q.charge_id and c.status = 'aprovada' and b.status = 'aprovado'
          and coalesce((select sum(p.amount) from payments p where p.company_id = c.company_id and p.charge_id = c.id and p.status = 'ativo'), 0) < c.amount)`);
  return res.count as number;
}

// ---------- Configuração de envio (janela, limites, canais, pausa) ----------
export async function getSettings(db: DB, actorId: string, companyId: string): Promise<MessagingSettings> {
  await requirePerm(db, actorId, companyId, "messages.read");
  return loadSettings(db, companyId);
}
async function loadSettings(x: DB, companyId: string): Promise<MessagingSettings> {
  const [r] = await x.select().from(messagingSettings).where(eq(messagingSettings.companyId, companyId));
  if (!r) return { ...DEFAULT_SETTINGS };
  return { paused: r.paused, autoDispatch: r.autoDispatch, emailEnabled: r.emailEnabled, whatsappEnabled: r.whatsappEnabled, windowStart: r.windowStart, windowEnd: r.windowEnd, weekdays: r.weekdays, skipHolidays: r.skipHolidays, maxPerRun: r.maxPerRun, maxPerHour: r.maxPerHour, maxLateDays: r.maxLateDays };
}
export async function saveSettings(db: DB, actorId: string, companyId: string, raw: Partial<Record<keyof MessagingSettings, unknown>>) {
  await requirePerm(db, actorId, companyId, "messages.templates");
  const v = parseSettings(raw);
  if (!v.ok) throw new Invalid(v.error);
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await lockQueue(x, companyId);
    await x.insert(messagingSettings).values({ companyId, ...v.value, updatedBy: actorId })
      .onConflictDoUpdate({ target: messagingSettings.companyId, set: { ...v.value, updatedBy: actorId, updatedAt: new Date() } });
    await audit(x, companyId, actorId, "messages.settings.saved", { ...v.value });
  });
}

const MAX_ATTEMPTS = 3;
type DueRow = { q: typeof messageQueue.$inferSelect; c: typeof charges.$inferSelect; customer: string; subject: string | null; body: string | null };
/** Texto da mensagem (assunto/corpo) a partir do modelo ativo. Único lugar que monta o texto, para o simulado e o real nunca divergirem. */
function buildMessage(r: DueRow, companyName: string, internal: boolean, bm?: BoletoMail) {
  const vars: Vars = { linha_digitavel: bm?.state === "ok" ? (bm.digitable ?? "") : SIMULATED_LINE, link_boleto: bm?.state === "ok" ? (bm.pdfUrl ?? "") : "", pix_copia_cola: bm?.state === "ok" ? (bm.pixEmv ?? "") : "", cliente: r.customer, empresa: companyName, valor: formatBRL(centsFromNumeric(r.c.amount)), vencimento: br(r.c.dueDate), competencia: `${r.c.competenceMonth.slice(5, 7)}/${r.c.competenceMonth.slice(0, 4)}`, descricao: r.c.description, emissao: br(r.c.issueDate) };
  const subject = internal ? "Revisão humana D+15" : render(r.subject ?? "", vars);
  const body = internal ? `Cobrança de ${vars.cliente} (${vars.valor}, vencida em ${vars.vencimento}) está há 15 dias em atraso. Decidir o próximo passo manualmente.` : render(r.body ?? "", vars);
  return { subject, body };
}
const RECIPIENT_EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
type RunOpts = { respectWindow: boolean; onlyAuto?: boolean; providers?: Providers; /** E33: boletos consultados ANTES da transação (rede fora do banco) e provedor de boleto da empresa */ boletos?: Map<string, BoletoMail>; boletoMode?: BoletoMode; /** E23: o e-mail desta empresa é tratado pelo caminho REAL (ou está bloqueado): o simulado não o toca */ skipEmail?: boolean };
export type RunResult = { processed: number; cancelled: number; failed: number; blocked: number; skipped: number; waiting?: string };

/**
 * Núcleo do processamento da fila. Com `respectWindow` só age dentro da janela configurada (agendador); o botão manual ignora a janela,
 * mas respeita pausa, canais ligados e limites. Provedores são SIMULADOS (E09); a chamada ao provedor fica dentro da transação por ser mock:
 * o E10 deve trocar por "reservar → enviar → registrar" para não manter transação aberta durante I/O externo.
 */
async function runQueue(x: DB, companyId: string, actorId: string | null, now: Date, o: RunOpts): Promise<RunResult> {
  const out: RunResult = { processed: 0, cancelled: 0, failed: 0, blocked: 0, skipped: 0 };
  const st = await loadSettings(x, companyId);
  if (st.paused) return { ...out, waiting: "Envio pausado" };
  if (o.onlyAuto && !st.autoDispatch) return { ...out, waiting: "Envio automático desligado" };
  if (o.respectWindow) {
    const hol = await x.select().from(holidays).where(eq(holidays.companyId, companyId));
    const w = windowState(now, st, new Map(hol.map((h) => [h.day, h.name])));
    if (!w.open) return { ...out, waiting: WINDOW_REASON[w.reason] };
  }
  const providers = resolveProviders(o.providers);
  const today = localParts(now).date;
  out.cancelled = await cancelOrphans(x, companyId);
  const sentLastHour = Number((await x.execute(sql`select count(*)::int n from message_queue where company_id = ${companyId} and status in ('simulado', 'enviando', 'enviado') and channel <> 'interno' and processed_at > ${new Date(now.getTime() - 3600_000).toISOString()}::timestamptz`))[0].n);
  const budget = Math.max(0, Math.min(st.maxPerRun, st.maxPerHour - sentLastHour));
  if (budget === 0) return { ...out, waiting: "Limite de envios por hora atingido" };

  const [co] = await x.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId));
  const contacts = await x.select().from(customerContacts).where(and(eq(customerContacts.companyId, companyId), eq(customerContacts.isFinancial, true)));
  const due = await x.select({ q: messageQueue, c: charges, customer: customers.displayName, subject: messageTemplateVersions.subject, body: messageTemplateVersions.body })
    .from(messageQueue)
    .innerJoin(charges, and(eq(charges.id, messageQueue.chargeId), eq(charges.companyId, messageQueue.companyId)))
    .innerJoin(customers, and(eq(customers.id, messageQueue.customerId), eq(customers.companyId, messageQueue.companyId)))
    .leftJoin(messageTemplateVersions, and(eq(messageTemplateVersions.id, messageQueue.templateVersionId), eq(messageTemplateVersions.companyId, messageQueue.companyId)))
    .where(and(eq(messageQueue.companyId, companyId), eq(messageQueue.status, "pendente"), lte(messageQueue.scheduledFor, today)))
    .orderBy(asc(messageQueue.scheduledFor), asc(messageQueue.createdAt)).limit(500)
    .for("update", { of: messageQueue }); // reabrir lote (outro lock) cancela estas linhas: espera, e o update abaixo só vale se ainda estiver pendente
  const lateLimit = addDays(today, -st.maxLateDays);
  let used = 0;
  const block = async (id: string, reason: string) => { await x.update(messageQueue).set({ status: "bloqueado", blockedReason: reason, updatedAt: now }).where(and(eq(messageQueue.id, id), eq(messageQueue.status, "pendente"))); out.blocked++; };

  for (const r of due) {
    if (used >= budget) { out.waiting = "Limite de envios atingido nesta execução"; break; }
    const q = r.q, internal = q.channel === "interno";
    if (o.skipEmail && q.channel === "email") continue; // E23: não consome (nem simula) e-mail que pertence ao caminho real
    if (!internal && ((q.channel === "email" && !st.emailEnabled) || (q.channel === "whatsapp" && !st.whatsappEnabled))) { out.skipped++; continue; }
    if (q.scheduledFor < lateLimit) { await block(q.id, `Perdeu a data (mais de ${st.maxLateDays} dia(s) de atraso): revisar manualmente`); continue; }
    // E33: empresa com provedor de boleto REAL só envia cobrança/lembrete quando o boleto existe (emitido e em aberto); senão a mensagem espera (nada é enviado sem o boleto)
    const bm = o.boletos?.get(q.chargeId);
    if (!internal && o.boletoMode && o.boletoMode !== "simulado" && bm?.state !== "ok") { out.skipped++; out.waiting ??= "Aguardando o boleto emitido (provedor real)"; continue; }
    const { subject, body } = buildMessage(r, co.name, internal, bm);
    let providerRef: string | null = null;
    if (!internal) {
      const mine = contacts.filter((c) => c.partyId === q.customerId);
      const key = `msg-${q.id}`; // um item = uma mensagem: reenvio da mesma chave não duplica no provedor
      let res: SendResult;
      if (q.channel === "email") {
        const to = [...new Set(mine.map((c) => c.email?.trim().toLowerCase() ?? "").filter((e) => RECIPIENT_EMAIL.test(e)))].slice(0, 3);
        if (to.length === 0) { await block(q.id, REASON_EMAIL); continue; }
        res = await providers.email.send({ to, subject, text: body, html: toEmailHtml(body), idempotencyKey: key });
      } else {
        const to = mine.map((c) => (c.phone ?? "").replace(/\D/g, "")).find((p) => p.length >= 10 && p.length <= 15);
        if (!to) { await block(q.id, REASON_WA); continue; }
        res = await providers.whatsapp.send({ to, text: body, idempotencyKey: key });
      }
      used++;
      if (!res.ok) {
        const attempts = q.attempts + 1; out.failed++;
        const give = !res.retryable || attempts >= MAX_ATTEMPTS;
        await x.update(messageQueue).set({ attempts, lastError: res.error.slice(0, 120), ...(give ? { status: "bloqueado", blockedReason: `Falha no envio (${res.error.slice(0, 60)}): revisar manualmente` } : {}), updatedAt: now })
          .where(and(eq(messageQueue.id, q.id), eq(messageQueue.status, "pendente")));
        continue;
      }
      providerRef = res.providerRef;
    }
    const won = await x.update(messageQueue).set({ status: "simulado", renderedSubject: subject, renderedBody: body, providerRef, attempts: q.attempts + (internal ? 0 : 1), lastError: null, processedAt: now, processedBy: actorId, updatedAt: now })
      .where(and(eq(messageQueue.id, q.id), eq(messageQueue.status, "pendente"))).returning({ id: messageQueue.id });
    out.processed += won.length;
  }
  return out;
}

const auditRun = (x: DB, companyId: string, actorId: string | null, action: string, r: RunResult) =>
  audit(x, companyId, actorId, action, { processed: r.processed, cancelled: r.cancelled, failed: r.failed, blocked: r.blocked, skipped: r.skipped, waiting: r.waiting ?? null });

type LiveDeps = { env?: Record<string, string | undefined>; smtp?: import("@/modules/providers/smtp").SmtpDeps; afterReserve?: () => Promise<void> };
const OFF: LiveState = { state: "off" };
const EMPTY: RunResult = { processed: 0, cancelled: 0, failed: 0, blocked: 0, skipped: 0 };
const merge = (a: RunResult, b: RunResult): RunResult => ({ processed: a.processed + b.processed, cancelled: a.cancelled + b.cancelled, failed: a.failed + b.failed, blocked: a.blocked + b.blocked, skipped: a.skipped + b.skipped, waiting: a.waiting ?? b.waiting });
/** Provedores/ambiente injetados só valem sob o executor de testes. */
const resolveLive = (db: DB, companyId: string, d?: LiveDeps) => (process.env.VITEST === "true" && d ? liveEmailFor(db, companyId, d.env ?? process.env, d.smtp) : liveEmailFor(db, companyId));

/**
 * Executa a fila de UMA empresa. SIMULADO por padrão (provedores de mock). Quando a empresa tem o e-mail REAL liberado (chave do servidor + autorização
 * registrada + conta legível; ver providers/email-live.ts), os itens de e-mail vão pelo caminho real (`runEmailLive`); WhatsApp e revisão interna continuam
 * simulados. Se o real está liberado mas bloqueado agora (ex.: cofre indisponível neste processo), os e-mails ficam NA FILA: nem enviados nem "simulados".
 */
async function dispatch(db: DB, companyId: string, actorId: string | null, now: Date, o0: RunOpts, live: LiveState, auditAction: string | null, hooks: { afterReserve?: () => Promise<void> } = {}): Promise<RunResult> {
  // E33: boletos dos itens que vencem a fila agora, consultados FORA de transação (só empresas com provedor de boleto real)
  const boletoMode = await companyBoletoMode(db, companyId);
  let boletos: Map<string, BoletoMail> | undefined;
  if (boletoMode !== "simulado") {
    const ids = (await db.execute(sql`select distinct charge_id::text as id from message_queue where company_id = ${companyId} and status = 'pendente' and channel in ('email', 'whatsapp') and scheduled_for <= ${localParts(now).date} limit 200`)) as unknown as { id: string }[];
    boletos = await prefetchBoletoMail(db, companyId, ids.map((r) => r.id));
  }
  const o: RunOpts = { ...o0, boletos, boletoMode };
  const sim = await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await lockQueue(x, companyId);
    const r = await runQueue(x, companyId, actorId, now, { ...o, skipEmail: live.state !== "off" });
    if (auditAction && (actorId !== null || r.processed + r.failed + r.blocked + r.cancelled > 0)) await auditRun(x, companyId, actorId, auditAction, r);
    return r;
  });
  if (live.state === "blocked") return { ...sim, waiting: sim.waiting ?? `E-mail real bloqueado: ${live.reason}` };
  if (live.state !== "ready") return sim;
  return merge(sim, await runEmailLive(db, companyId, actorId, now, o, live, process.env.VITEST === "true" ? hooks : {}));
}

/**
 * Caminho REAL do e-mail (E23): RESERVAR (transação curta: pendente → enviando + registro) → ENVIAR fora de transação → REGISTRAR (enviado / de volta à fila /
 * bloqueado). Nunca reenvia sozinho um resultado desconhecido (queda depois de entregar o conteúdo): vai para revisão humana. Respeita pausa, canal, janela,
 * limites por execução/hora, limite diário da autorização e a lista de destinatários autorizados (também reconferida no adaptador).
 */
export async function runEmailLive(db: DB, companyId: string, actorId: string | null, now: Date, o: { respectWindow: boolean; onlyAuto?: boolean; boletos?: Map<string, BoletoMail>; boletoMode?: BoletoMode }, live: Extract<LiveState, { state: "ready" }>, hooks: { afterReserve?: () => Promise<void> } = {}): Promise<RunResult> {
  const out: RunResult = { ...EMPTY };
  type Job = { id: string; logId: string; to: string[]; subject: string; body: string; attempts: number; boleto?: BoletoMail; dueDate: string; chargeId: string };
  const jobs: Job[] = [];
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await lockQueue(x, companyId);
    await x.execute(sql`select pg_advisory_xact_lock(hashtext(${"email-live:" + companyId}))`);
    const st = await loadSettings(x, companyId);
    if (st.paused) { out.waiting = "Envio pausado"; return; }
    if (!st.emailEnabled) { out.waiting = "E-mail desligado nas configurações de envio"; return; }
    if (o.onlyAuto && !st.autoDispatch) { out.waiting = "Envio automático desligado"; return; }
    if (o.respectWindow) {
      const hol = await x.select().from(holidays).where(eq(holidays.companyId, companyId));
      const w = windowState(now, st, new Map(hol.map((h) => [h.day, h.name])));
      if (!w.open) { out.waiting = WINDOW_REASON[w.reason]; return; }
    }
    const stuckBefore = new Date(Date.now() - 10 * 60_000); // relógio real: updated_at/created_at do registro são sempre de agora
    await x.execute(sql`update message_queue set status = 'bloqueado', blocked_reason = 'Resultado desconhecido (o processo caiu durante o envio): confira nos enviados antes de reenviar', updated_at = now()
      where company_id = ${companyId} and channel = 'email' and status = 'enviando' and updated_at < ${stuckBefore.toISOString()}::timestamptz`);
    await x.execute(sql`update email_send_log set status = 'desconhecido', error = 'processo_interrompido', finished_at = now(), updated_at = now()
      where company_id = ${companyId} and status = 'enviando' and created_at < ${stuckBefore.toISOString()}::timestamptz`);
    out.cancelled = await cancelOrphans(x, companyId);
    const sentLastHour = Number((await x.execute(sql`select count(*)::int n from message_queue where company_id = ${companyId} and status in ('simulado', 'enviando', 'enviado') and channel <> 'interno' and processed_at > ${new Date(now.getTime() - 3600_000).toISOString()}::timestamptz`))[0].n);
    const budget = Math.max(0, Math.min(st.maxPerRun, st.maxPerHour - sentLastHour, live.dailyLimit - (await sentToday(x, companyId))));
    if (budget === 0) { out.waiting = "Limite de envios (por hora ou diário) atingido"; return; }
    const today = localParts(now).date, lateLimit = addDays(today, -st.maxLateDays);
    const [co] = await x.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId));
    const contacts = await x.select().from(customerContacts).where(and(eq(customerContacts.companyId, companyId), eq(customerContacts.isFinancial, true)));
    const due = await x.select({ q: messageQueue, c: charges, customer: customers.displayName, subject: messageTemplateVersions.subject, body: messageTemplateVersions.body })
      .from(messageQueue)
      .innerJoin(charges, and(eq(charges.id, messageQueue.chargeId), eq(charges.companyId, messageQueue.companyId)))
      .innerJoin(customers, and(eq(customers.id, messageQueue.customerId), eq(customers.companyId, messageQueue.companyId)))
      .leftJoin(messageTemplateVersions, and(eq(messageTemplateVersions.id, messageQueue.templateVersionId), eq(messageTemplateVersions.companyId, messageQueue.companyId)))
      .where(and(eq(messageQueue.companyId, companyId), eq(messageQueue.status, "pendente"), eq(messageQueue.channel, "email"), lte(messageQueue.scheduledFor, today)))
      .orderBy(asc(messageQueue.scheduledFor), asc(messageQueue.createdAt)).limit(500).for("update", { of: messageQueue });
    const block = async (id: string, reason: string) => { await x.update(messageQueue).set({ status: "bloqueado", blockedReason: reason, updatedAt: now }).where(and(eq(messageQueue.id, id), eq(messageQueue.status, "pendente"))); out.blocked++; };
    for (const r of due) {
      if (jobs.length >= budget) { out.waiting = "Limite de envios atingido nesta execução"; break; }
      const q = r.q;
      if (q.scheduledFor < lateLimit) { await block(q.id, `Perdeu a data (mais de ${st.maxLateDays} dia(s) de atraso): revisar manualmente`); continue; }
      const mine = contacts.filter((c) => c.partyId === q.customerId);
      const valid = [...new Set(mine.map((c) => c.email?.trim().toLowerCase() ?? "").filter((e) => RECIPIENT_EMAIL.test(e)))].slice(0, 3);
      if (valid.length === 0) { await block(q.id, REASON_EMAIL); continue; }
      const to = valid.filter((a) => isAllowed(a, live.allowed));
      if (to.length === 0) { await block(q.id, "Destinatário fora da lista autorizada do envio real (canário): fica sem enviar até a lista ser ampliada"); continue; }
      // E33: e-mail REAL com boleto: precisa do boleto emitido e em aberto (espera, sem bloquear); modelo que usa o boleto com provedor SIMULADO é bloqueado (nunca mandar boleto de mentira a cliente de verdade)
      const bm = o.boletos?.get(q.chargeId);
      if (o.boletoMode && o.boletoMode !== "simulado" && bm?.state !== "ok") { out.waiting ??= "Aguardando o boleto emitido (provedor real)"; continue; }
      if ((!o.boletoMode || o.boletoMode === "simulado") && /\{\{\s*(linha_digitavel|link_boleto)\s*\}\}/.test(`${r.subject ?? ""}\n${r.body ?? ""}`)) { await block(q.id, "O modelo usa o boleto, mas o boleto desta empresa é simulado: e-mail real não vai com boleto de mentira"); continue; }
      const { subject, body } = buildMessage(r, co.name, false, bm);
      const won = await x.update(messageQueue).set({ status: "enviando", renderedSubject: subject, renderedBody: body, attempts: q.attempts + 1, lastError: null, processedAt: now, processedBy: actorId, updatedAt: now })
        .where(and(eq(messageQueue.id, q.id), eq(messageQueue.status, "pendente"))).returning({ id: messageQueue.id });
      if (won.length === 0) continue;
      const [log] = await x.insert(emailSendLog).values({ companyId, kind: "fila", queueId: q.id, recipientDomains: domainsOf(to), recipients: to.length, actorId }).returning({ id: emailSendLog.id });
      jobs.push({ id: q.id, logId: log.id, to, subject, body, attempts: q.attempts + 1, boleto: bm?.state === "ok" ? bm : undefined, dueDate: r.c.dueDate, chargeId: q.chargeId });
    }
  });
  if (process.env.VITEST === "true") await hooks.afterReserve?.(); // só testes: simula a revogação entre reservar e enviar
  for (const j of jobs) { // FORA de transação: nenhuma conexão do banco fica aberta durante a rede
    // Revogou (ou desligou a chave) depois de reservar? Reconfere ANTES de entregar cada mensagem ao SMTP: o item volta à fila sem enviar.
    const stillAuthorized = flagOn(live.env) && (await activeAuthorization(db, companyId))?.id === live.authorizationId;
    if (!stillAuthorized) {
      await db.transaction(async (tx) => {
        const x = tx as unknown as DB;
        await finishLog(x, j.logId, { status: "falhou", error: "autorizacao_revogada" });
        await x.update(messageQueue).set({ status: "pendente", attempts: j.attempts - 1, lastError: "autorizacao_revogada", updatedAt: new Date() }).where(and(eq(messageQueue.id, j.id), eq(messageQueue.status, "enviando")));
      });
      out.waiting = "Autorização de envio real revogada: nada foi enviado";
      continue;
    }
    // E33: o PDF do boleto segue em anexo (baixado aqui, FORA de transação; se não vier, tenta de novo na próxima rodada em vez de mandar e-mail sem o boleto)
    let attachments: import("@/modules/providers/types").EmailAttachment[] | undefined; let pdfFail = false;
    // E33: reconsulta o boleto IMEDIATAMENTE antes de entregar ao SMTP (pode ter sido pago/cancelado/alterado depois da consulta da rodada): mudou = volta à fila sem enviar
    if (j.boleto) {
      const fresh = (await prefetchBoletoMail(db, companyId, [j.chargeId]).catch(() => new Map<string, BoletoMail>())).get(j.chargeId);
      if (fresh?.state !== "ok" || fresh.digitable !== j.boleto.digitable) {
        await db.transaction(async (tx) => {
          const x = tx as unknown as DB;
          await finishLog(x, j.logId, { status: "falhou", error: "boleto_mudou" });
          await x.update(messageQueue).set({ status: "pendente", attempts: j.attempts - 1, lastError: "boleto_mudou", updatedAt: new Date() }).where(and(eq(messageQueue.id, j.id), eq(messageQueue.status, "enviando")));
        });
        out.waiting = "O boleto mudou antes do envio: nada foi enviado";
        continue;
      }
    }
    if (j.boleto?.pdfUrl) { try { attachments = [{ filename: `boleto-${j.dueDate}.pdf`, contentType: "application/pdf", content: await fetchBoletoPdf(j.boleto.pdfUrl) }]; } catch { pdfFail = true; } }
    const res: SendResult = pdfFail ? { ok: false, retryable: true, error: "pdf_indisponivel" } : await live.provider.send({ to: j.to, subject: j.subject, text: j.body, html: toEmailHtml(j.body), idempotencyKey: `msg-${j.id}`, ...(attachments ? { attachments } : {}) }).catch(() => ({ ok: false as const, retryable: false, unknown: true, error: "resultado_desconhecido" }));
    await db.transaction(async (tx) => {
      const x = tx as unknown as DB;
      await finishLog(x, j.logId, res.ok ? { status: "enviado", providerRef: res.providerRef } : { status: res.unknown ? "desconhecido" : "falhou", error: res.error });
      if (res.ok) {
        await x.update(messageQueue).set({ status: "enviado", providerRef: res.providerRef, lastError: null, processedAt: now, updatedAt: new Date() }).where(and(eq(messageQueue.id, j.id), eq(messageQueue.status, "enviando")));
        out.processed++;
        return;
      }
      out.failed++;
      const give = !!res.unknown || !res.retryable || j.attempts >= MAX_ATTEMPTS;
      const reason = res.unknown ? "Resultado desconhecido: o e-mail PODE ter sido enviado. Confira nos enviados antes de reenviar" : `Falha no envio (${res.error.slice(0, 60)}): revisar manualmente`;
      await x.update(messageQueue).set({ lastError: res.error.slice(0, 120), updatedAt: new Date(), ...(give ? { status: "bloqueado", blockedReason: reason } : { status: "pendente" }) }).where(and(eq(messageQueue.id, j.id), eq(messageQueue.status, "enviando")));
      if (give) out.blocked++;
    });
  }
  if (jobs.length > 0 || out.blocked > 0 || out.cancelled > 0) await audit(db, companyId, actorId, "messages.email.live_run", { sent: out.processed, failed: out.failed, blocked: out.blocked, cancelled: out.cancelled, waiting: out.waiting ?? null });
  return out;
}

/**
 * Processa os itens pendentes com data <= hoje: SIMULADO (nada sai) ou, se o e-mail real da empresa está liberado, e-mail REAL só para a lista autorizada.
 * Manual: ignora a janela de horário, mas respeita pausa, canais e limites.
 */
export async function processQueue(db: DB, actorId: string, companyId: string, today?: string, providers?: Providers, liveDeps?: LiveDeps) {
  await requirePerm(db, actorId, companyId, "messages.write");
  const live = providers ? OFF : await resolveLive(db, companyId, liveDeps); // provedores injetados (testes) = só simulado
  return dispatch(db, companyId, actorId, today ? new Date(`${today}T12:00:00-04:00`) : new Date(), { respectWindow: false, providers }, live, "messages.queue.processed_simulated", { afterReserve: liveDeps?.afterReserve });
}

/** Execução do AGENDADOR para uma empresa: só age se o envio automático estiver ligado e dentro da janela. Sem usuário (ator nulo). E-mail REAL nunca é enviado por aqui (só manual, pelo botão). */
export async function runScheduled(db: DB, companyId: string, now = new Date(), providers?: Providers, liveDeps?: LiveDeps) {
  let live = providers ? OFF : await resolveLive(db, companyId, liveDeps);
  // Canário: o e-mail REAL nunca sai sozinho. O agendador só pode simular; com o real liberado ele NÃO toca nos e-mails (ficam na fila para o botão Processar fila).
  if (live.state === "ready") live = { state: "blocked", reason: "o envio real do canário é só pelo botão Processar fila (o agendador não envia e-mail real)" };
  return dispatch(db, companyId, null, now, { respectWindow: true, onlyAuto: true, providers }, live, "messages.queue.auto_run");
}

/** Um ciclo do agendador: todas as empresas com envio automático ligado. Erro em uma empresa não impede as outras. */
export async function tickAll(db: DB, now = new Date(), providers?: Providers) {
  const rows = await db.select({ id: messagingSettings.companyId }).from(messagingSettings).where(and(eq(messagingSettings.autoDispatch, true), eq(messagingSettings.paused, false)));
  const results: { companyId: string; result?: RunResult; error?: string }[] = [];
  for (const { id } of rows) {
    try { results.push({ companyId: id, result: await runScheduled(db, id, now, providers) }); } catch (e) { results.push({ companyId: id, error: (e as Error).name }); }
  }
  return results;
}

export async function listQueue(db: DB, actorId: string, companyId: string, status?: string) {
  await requirePerm(db, actorId, companyId, "messages.read");
  const filter = status && ["pendente", "enviando", "enviado", "bloqueado", "simulado", "cancelado"].includes(status) ? status : null;
  const rows = await db.select({ q: messageQueue, customer: customers.displayName, amount: charges.amount, dueDate: charges.dueDate }).from(messageQueue)
    .innerJoin(customers, and(eq(customers.id, messageQueue.customerId), eq(customers.companyId, messageQueue.companyId)))
    .innerJoin(charges, and(eq(charges.id, messageQueue.chargeId), eq(charges.companyId, messageQueue.companyId)))
    .where(and(eq(messageQueue.companyId, companyId), filter ? eq(messageQueue.status, filter) : ne(messageQueue.status, "cancelado")))
    .orderBy(asc(messageQueue.scheduledFor), asc(customers.displayName)).limit(300);
  const counts = await db.select({ status: messageQueue.status, n: sql<number>`count(*)::int` }).from(messageQueue).where(eq(messageQueue.companyId, companyId)).groupBy(messageQueue.status);
  return { items: rows.map((r) => ({ ...r.q, customerName: r.customer, amountCents: centsFromNumeric(r.amount), dueDate: r.dueDate, kindLabelKey: r.q.kind as QueueKind })), counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) as Record<string, number> };
}
