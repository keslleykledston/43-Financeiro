import { and, asc, desc, eq, inArray, lte, ne, sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { auditLog, billingBatches, charges, companies, customerContacts, customers, holidays, messageQueue, messageTemplates, messageTemplateVersions, messagingSettings } from "@/lib/db/schema";
import { centsFromNumeric } from "@/lib/money";
import { formatBRL } from "@/lib/format";
import { Invalid, requirePerm } from "@/modules/identity/service";
import { CHANNELS, DEFAULTS, KINDS, ladder, render, toEmailHtml, validateTemplate, SAMPLE_VARS, type Channel, type Kind, type QueueKind, type Vars } from "./templates";
import { DEFAULT_SETTINGS, WINDOW_REASON, localParts, parseSettings, windowState, type MessagingSettings } from "./window";
import { addDays } from "./dates";
import { resolveProviders } from "@/modules/providers/registry";
import type { Providers, SendResult } from "@/modules/providers/types";

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
      await x.insert(messageTemplateVersions).values({ companyId, templateId: t.id, version: 1, subject: channel === "email" ? d.subject : "", body: d.body, state: "ativa", createdBy: actorId, activatedBy: actorId, activatedAt: new Date() });
      created++;
    }
    await audit(x, companyId, actorId, "messages.templates.defaults", { created });
    return { created };
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
    const existing = await x.select().from(messageQueue).where(and(eq(messageQueue.companyId, companyId), ne(messageQueue.status, "cancelado")));
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
export async function cancelQueueForCharges(x: DB, companyId: string, chargeIds: string[]) {
  if (chargeIds.length === 0) return 0;
  const res = await x.update(messageQueue).set({ status: "cancelado", blockedReason: null, updatedAt: new Date() })
    .where(and(eq(messageQueue.companyId, companyId), inArray(messageQueue.chargeId, chargeIds), inArray(messageQueue.status, ["pendente", "bloqueado"]))).returning({ id: messageQueue.id });
  return res.length;
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
const RECIPIENT_EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
type RunOpts = { respectWindow: boolean; onlyAuto?: boolean; providers?: Providers };
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
  const sentLastHour = Number((await x.execute(sql`select count(*)::int n from message_queue where company_id = ${companyId} and status = 'simulado' and channel <> 'interno' and processed_at > ${new Date(now.getTime() - 3600_000).toISOString()}::timestamptz`))[0].n);
  const budget = Math.max(0, Math.min(st.maxPerRun, st.maxPerHour - sentLastHour));
  if (budget === 0) return { ...out, waiting: "Limite de envios por hora atingido" };

  const [co] = await x.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId));
  const contacts = await x.select().from(customerContacts).where(and(eq(customerContacts.companyId, companyId), eq(customerContacts.isFinancial, true)));
  const due = await x.select({ q: messageQueue, c: charges, customer: customers.legalName, subject: messageTemplateVersions.subject, body: messageTemplateVersions.body })
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
    if (!internal && ((q.channel === "email" && !st.emailEnabled) || (q.channel === "whatsapp" && !st.whatsappEnabled))) { out.skipped++; continue; }
    if (q.scheduledFor < lateLimit) { await block(q.id, `Perdeu a data (mais de ${st.maxLateDays} dia(s) de atraso): revisar manualmente`); continue; }
    const vars: Vars = { cliente: r.customer, empresa: co.name, valor: formatBRL(centsFromNumeric(r.c.amount)), vencimento: br(r.c.dueDate), competencia: `${r.c.competenceMonth.slice(5, 7)}/${r.c.competenceMonth.slice(0, 4)}`, descricao: r.c.description, emissao: br(r.c.issueDate) };
    const subject = internal ? "Revisão humana D+15" : render(r.subject ?? "", vars);
    const body = internal ? `Cobrança de ${vars.cliente} (${vars.valor}, vencida em ${vars.vencimento}) está há 15 dias em atraso. Decidir o próximo passo manualmente.` : render(r.body ?? "", vars);
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

/**
 * "Processa" (SIMULAÇÃO) os itens pendentes com data <= hoje: renderiza, chama o provedor SIMULADO e marca como simulado. Nada é enviado.
 * Manual: ignora a janela de horário, mas respeita pausa, canais e limites.
 */
export async function processQueue(db: DB, actorId: string, companyId: string, today?: string, providers?: Providers) {
  await requirePerm(db, actorId, companyId, "messages.write");
  return db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await lockQueue(x, companyId);
    const r = await runQueue(x, companyId, actorId, today ? new Date(`${today}T12:00:00-04:00`) : new Date(), { respectWindow: false, providers });
    await auditRun(x, companyId, actorId, "messages.queue.processed_simulated", r);
    return r;
  });
}

/** Execução do AGENDADOR para uma empresa: só age se o envio automático estiver ligado e dentro da janela. Sem usuário (ator nulo). */
export async function runScheduled(db: DB, companyId: string, now = new Date(), providers?: Providers) {
  return db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await lockQueue(x, companyId);
    const r = await runQueue(x, companyId, null, now, { respectWindow: true, onlyAuto: true, providers });
    if (r.processed + r.failed + r.blocked + r.cancelled > 0) await auditRun(x, companyId, null, "messages.queue.auto_run", r);
    return r;
  });
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
  const filter = status && ["pendente", "bloqueado", "simulado", "cancelado"].includes(status) ? status : null;
  const rows = await db.select({ q: messageQueue, customer: customers.legalName, amount: charges.amount, dueDate: charges.dueDate }).from(messageQueue)
    .innerJoin(customers, and(eq(customers.id, messageQueue.customerId), eq(customers.companyId, messageQueue.companyId)))
    .innerJoin(charges, and(eq(charges.id, messageQueue.chargeId), eq(charges.companyId, messageQueue.companyId)))
    .where(and(eq(messageQueue.companyId, companyId), filter ? eq(messageQueue.status, filter) : ne(messageQueue.status, "cancelado")))
    .orderBy(asc(messageQueue.scheduledFor), asc(customers.legalName)).limit(300);
  const counts = await db.select({ status: messageQueue.status, n: sql<number>`count(*)::int` }).from(messageQueue).where(eq(messageQueue.companyId, companyId)).groupBy(messageQueue.status);
  return { items: rows.map((r) => ({ ...r.q, customerName: r.customer, amountCents: centsFromNumeric(r.amount), dueDate: r.dueDate, kindLabelKey: r.q.kind as QueueKind })), counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) as Record<string, number> };
}
