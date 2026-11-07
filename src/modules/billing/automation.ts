import { and, asc, eq, sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { auditLog, billingAutomation, billingBatches, holidays, issuanceSettings } from "@/lib/db/schema";
import { Invalid, requirePerm } from "@/modules/identity/service";
import { addDays } from "@/modules/messaging/dates";
import { localParts } from "@/modules/messaging/window";
import { scheduleQueue } from "@/modules/messaging/service";
import { openBoletoRequests, processIssuance, requestBatchIssuance } from "@/modules/issuance/service";
import { prodEmissionOn } from "@/modules/providers/registry";
import type { Providers } from "@/modules/providers/types";
import { holidaysFor, type HolidayMap } from "./calendar";
import { previewDateFor, runDateFor } from "./run-date";
export { isBusinessDay, previewDateFor, runDateFor } from "./run-date";
import { generateBatchCore } from "./batches";

/**
 * F1 — FATURAMENTO AUTOMÁTICO. Aprovar o lote («Aprovar e agendar») é a única autorização: o agendador
 *  1) gera a PRÉVIA sozinho alguns dias úteis antes de cada data de emissão (1, 8, 15 e 25) — nunca aprova;
 *  2) no dia da emissão (dia útil anterior, se cair em fim de semana ou feriado), a partir das 09:00 de Manaus, solicita e processa os boletos, EM NOME de quem aprovou;
 *  3) terminada a emissão, cria a fila de avisos (o envio do e-mail continua sendo um clique, até a fase do e-mail automático).
 * Mantém TODAS as travas do motor: pausa, limite diário, modo cuidadoso, anti-duplicidade, chave do servidor, e (boleto real) só emite lote aprovado DEPOIS de a empresa ser armada.
 */
export const RUN_FROM_MINUTES = 9 * 60; // 09:00 America/Manaus
export const ISSUE_DAYS = [1, 8, 15, 25] as const;
export const DEFAULT_LEAD_DAYS = 2;

const audit = (x: DB, companyId: string, actorId: string | null, action: string, detail: Record<string, unknown>) => x.insert(auditLog).values({ companyId, actorId, action, detail });
const pad = (n: number) => String(n).padStart(2, "0");

/** Datas de emissão (1, 8, 15, 25) do mês de `today` e do seguinte. */
export function candidateIssueDates(today: string): string[] {
  const [y, m] = today.split("-").map(Number);
  const out: string[] = [];
  const months: [number, number][] = [[y, m], m === 12 ? [y + 1, 1] : [y, m + 1]];
  for (const [yy, mm] of months) for (const d of ISSUE_DAYS) out.push(`${yy}-${pad(mm)}-${pad(d)}`);
  return out;
}
async function holidayMap(x: DB, companyId: string, dates: string[]): Promise<HolidayMap> {
  const own = await x.select({ day: holidays.day, name: holidays.name }).from(holidays).where(eq(holidays.companyId, companyId));
  return holidaysFor(dates, new Map(own.map((h) => [h.day, h.name])));
}

/** A chave segue ligada AGORA? Conferida logo antes de cada passo que emite (solicitar, processar): desligar interrompe a rodada na próxima fronteira. Uma rodada de emissão já em andamento (até 20 boletos) termina — o freio imediato é «Pausar» a emissão, que o motor confere ao reservar cada boleto. */
const stillEnabled = async (x: DB, companyId: string) => ((await x.select({ on: billingAutomation.enabled }).from(billingAutomation).where(eq(billingAutomation.companyId, companyId)))[0]?.on) === true;

export type AutomationState = { enabled: boolean; enabledAt: Date | null; leadDays: number };
export async function getAutomation(db: DB, actorId: string, companyId: string): Promise<AutomationState> {
  await requirePerm(db, actorId, companyId, "billing.read");
  const [r] = await db.select().from(billingAutomation).where(eq(billingAutomation.companyId, companyId));
  return { enabled: r?.enabled ?? false, enabledAt: r?.enabledAt ?? null, leadDays: r?.leadDays ?? DEFAULT_LEAD_DAYS };
}
/** Liga/desliga. Quem liga e quando ficam gravados (é a autorização). Desligar NÃO desfaz nada: lotes já aprovados com «agendar» deixam de ser emitidos pelo agendador (voltam ao modo manual). */
export async function setAutomation(db: DB, actorId: string, companyId: string, on: boolean) {
  await requirePerm(db, actorId, companyId, "issuance.manage");
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    const now = new Date();
    await x.insert(billingAutomation).values({ companyId, enabled: on, enabledBy: on ? actorId : null, enabledAt: on ? now : null })
      .onConflictDoUpdate({ target: billingAutomation.companyId, set: { enabled: on, enabledBy: on ? actorId : null, enabledAt: on ? now : null, updatedAt: now } });
    await audit(x, companyId, actorId, "billing.auto.toggled", { on });
  });
}

export type CompanyRun = { previews: number; requested: number; processed: number; completed: number; waiting: string[] };
type Deps = { providers?: Providers };

/** Uma rodada para UMA empresa com o faturamento automático ligado. Idempotente: pode rodar a cada minuto. */
export async function runCompany(db: DB, companyId: string, now = new Date(), deps: Deps = {}): Promise<CompanyRun> {
  const out: CompanyRun = { previews: 0, requested: 0, processed: 0, completed: 0, waiting: [] };
  const [au] = await db.select().from(billingAutomation).where(eq(billingAutomation.companyId, companyId));
  if (!au?.enabled) return out;
  const lp = localParts(now), today = lp.date;
  const cands = candidateIssueDates(today);
  const hol = await holidayMap(db, companyId, [...cands, addDays(today, -20), addDays(today, 40)]);

  // 1) PRÉVIA automática (nunca aprova). Não recria lote que alguém cancelou de propósito (qualquer situação conta).
  for (const issue of cands) {
    const run = runDateFor(issue, hol);
    if (previewDateFor(run, au.leadDays, hol) > today || issue < addDays(today, -3)) continue;
    const [exists] = await db.select({ id: billingBatches.id }).from(billingBatches).where(and(eq(billingBatches.companyId, companyId), eq(billingBatches.issueDate, issue))).limit(1);
    if (exists) continue;
    if (!(await stillEnabled(db, companyId))) break;
    try { await generateBatchCore(db, null, companyId, issue); out.previews++; await audit(db, companyId, null, "billing.auto.preview", { issueDate: issue }); }
    catch (e) { if (!(e instanceof Invalid)) throw e; /* «nenhuma cobrança prevista» etc.: segue sem lote */ }
  }

  // 2) EMISSÃO dos lotes aprovados com «agendar»
  const batches = await db.select().from(billingBatches)
    .where(and(eq(billingBatches.companyId, companyId), eq(billingBatches.status, "aprovado"), eq(billingBatches.autoIssue, true), sql`${billingBatches.autoDoneAt} is null`))
    .orderBy(asc(billingBatches.issueDate));
  for (const b of batches) {
    const run = runDateFor(b.issueDate, await holidayMap(db, companyId, [b.issueDate]));
    if (run > today || (run === today && lp.minutes < RUN_FROM_MINUTES)) continue; // ainda não é a hora
    const actor = b.approvedBy!;
    const [st] = await db.select().from(issuanceSettings).where(eq(issuanceSettings.companyId, companyId));
    if (!st || st.paused) { out.waiting.push("Emissão pausada"); continue; }
    const real = st.boletoProvider === "cora_producao";
    if (real) {
      if (!prodEmissionOn()) { out.waiting.push("Emissão em produção desligada no servidor"); continue; }
      // boleto REAL só sai de lote aprovado DEPOIS de a empresa ser armada: a aprovação feita na simulação/testes não vale como autorização de boleto real
      if (!st.liveAuthorizedAt || !b.approvedAt || b.approvedAt < st.liveAuthorizedAt) { out.waiting.push("Lote aprovado antes de ligar os boletos reais: aprove de novo"); continue; }
    }
    if (!(await stillEnabled(db, companyId))) { out.waiting.push("Faturamento automático desligado"); break; }
    if (!b.autoRequestedAt) {
      const r = await requestBatchIssuance(db, actor, companyId, b.id, "boleto");
      out.requested += r.created;
      await db.update(billingBatches).set({ autoRequestedAt: now, updatedAt: now }).where(and(eq(billingBatches.id, b.id), eq(billingBatches.companyId, companyId)));
      await audit(db, companyId, actor, "billing.auto.requested", { batchId: b.id, created: r.created, skippedNoBoleto: r.skippedNoBoleto });
    }
    const open = await openRequests(db, companyId, b.id, now);
    if (open.due > 0 && (await stillEnabled(db, companyId))) {
      const r = await processIssuance(db, actor, companyId, now, deps.providers, { confirmLive: real });
      out.processed += r.issued;
      if (r.waiting) out.waiting.push(r.waiting);
    }
    const after = await openRequests(db, companyId, b.id, now);
    if (after.open === 0 && (await stillEnabled(db, companyId))) {
      await scheduleQueue(db, actor, companyId, today); // a fila de avisos nasce junto da emissão
      await db.update(billingBatches).set({ autoDoneAt: now, updatedAt: now }).where(and(eq(billingBatches.id, b.id), eq(billingBatches.companyId, companyId)));
      await audit(db, companyId, actor, "billing.auto.completed", { batchId: b.id, issueDate: b.issueDate, ...after.by });
      out.completed++;
    }
  }
  return out;
}

/** Situação das solicitações de boleto do lote: abertas (a emitir/reconsultar) e as já devidas agora. */
async function openRequests(x: DB, companyId: string, batchId: string, now: Date) {
  const rows = (await x.execute(sql`select r.status, r.next_attempt_at <= ${now.toISOString()}::timestamptz as due, count(*)::int n
    from issuance_requests r join charges c on c.company_id = r.company_id and c.id = r.charge_id
    where r.company_id = ${companyId} and c.batch_id = ${batchId} and r.kind = 'boleto' and r.status <> 'cancelado' group by 1, 2`)) as unknown as { status: string; due: boolean; n: number }[];
  const by: Record<string, number> = {};
  let open = 0, due = 0;
  for (const r of rows) {
    by[r.status] = (by[r.status] ?? 0) + r.n;
    if (["pendente", "enviando", "desconhecido"].includes(r.status)) { open += r.n; if (r.due) due += r.n; }
  }
  return { open, due, by };
}

/** Ciclo do agendador: todas as empresas com o faturamento automático ligado; erro em uma não impede as outras. Log só com contagens. */
export async function tickBilling(db: DB, now = new Date(), deps: Deps = {}) {
  const cs = await db.select({ id: billingAutomation.companyId }).from(billingAutomation).where(eq(billingAutomation.enabled, true));
  const res: { companyId: string; run?: CompanyRun; error?: string }[] = [];
  for (const c of cs) {
    try { res.push({ companyId: c.id, run: await runCompany(db, c.id, now, deps) }); } catch (e) { res.push({ companyId: c.id, error: (e as Error).name }); }
  }
  return res;
}

/** O que a tela mostra: próximas datas, com a prévia/lote de cada uma e o andamento da emissão. Só leitura. */
export async function upcoming(db: DB, actorId: string, companyId: string, now = new Date()): Promise<{ issueDate: string; runDate: string; previewFrom: string; batchId: string | null; status: string | null; autoIssue: boolean; done: boolean; late: boolean }[]> {
  await requirePerm(db, actorId, companyId, "billing.read");
  const [au] = await db.select().from(billingAutomation).where(eq(billingAutomation.companyId, companyId));
  const lead = au?.leadDays ?? DEFAULT_LEAD_DAYS, today = localParts(now).date;
  const cands = candidateIssueDates(today).filter((d) => d >= addDays(today, -3));
  const hol = await holidayMap(db, companyId, [...cands, addDays(today, 40)]);
  const bs = await db.select().from(billingBatches).where(eq(billingBatches.companyId, companyId));
  return cands.map((issueDate) => {
    const run = runDateFor(issueDate, hol), b = bs.find((x) => x.issueDate === issueDate && x.status !== "cancelado");
    return { issueDate, runDate: run, previewFrom: previewDateFor(run, lead, hol), batchId: b?.id ?? null, status: b?.status ?? null, autoIssue: b?.autoIssue ?? false, done: !!b?.autoDoneAt, late: !!b && b.status === "rascunho" && run <= today };
  }).slice(0, 4);
}

/** Andamento de UM lote agendado, para a página do lote. Só leitura. */
export async function batchProgress(db: DB, actorId: string, companyId: string, batchId: string, now = new Date()) {
  await requirePerm(db, actorId, companyId, "billing.read");
  const [b] = await db.select().from(billingBatches).where(and(eq(billingBatches.id, batchId), eq(billingBatches.companyId, companyId)));
  if (!b) return null;
  const hol = await holidayMap(db, companyId, [b.issueDate]);
  const run = runDateFor(b.issueDate, hol);
  const req = await openRequests(db, companyId, batchId, now);
  const [{ n: pendingMail }] = (await db.execute(sql`select count(*)::int n from message_queue q join charges c on c.company_id = q.company_id and c.id = q.charge_id
    where q.company_id = ${companyId} and c.batch_id = ${batchId} and q.kind = 'emissao' and q.channel = 'email' and q.status = 'pendente'`)) as unknown as { n: number }[];
  const [{ n: sentMail }] = (await db.execute(sql`select count(*)::int n from message_queue q join charges c on c.company_id = q.company_id and c.id = q.charge_id
    where q.company_id = ${companyId} and c.batch_id = ${batchId} and q.kind = 'emissao' and q.channel = 'email' and q.status in ('enviado', 'simulado')`)) as unknown as { n: number }[];
  return { runDate: run, autoIssue: b.autoIssue, done: !!b.autoDoneAt, requests: req.by, open: req.open, pendingMail: Number(pendingMail), sentMail: Number(sentMail) };
}

/** Dia da emissão de fato de uma data de lote, com os MESMOS feriados do agendador (nacionais + da empresa). Para a tela. */
export async function runDateOf(db: DB, actorId: string, companyId: string, issueDate: string): Promise<string> {
  await requirePerm(db, actorId, companyId, "billing.read");
  return runDateFor(issueDate, await holidayMap(db, companyId, [issueDate]));
}
