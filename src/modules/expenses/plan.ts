import { and, eq, sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { auditLog, partners, profitSettings } from "@/lib/db/schema";
import { isIsoDate } from "@/lib/iso-date";
import { centsFromNumeric, centsFromSignedNumeric, numericFromCents, parseMoneyToCents } from "@/lib/money";
import { Invalid, requirePerm } from "@/modules/identity/service";
import { todayManaus } from "@/modules/messaging/service";
import { pendingForecasts } from "@/modules/payables/planning";
import { addMonths } from "@/modules/payables/schedule";
import { buildForecast, buildVariance, type ContractLite, type PlanResult, type PlanSettings, type VarianceResult } from "./plan-calc";
import { partnerBalances, type Balance } from "./ledger";

/**
 * D4 — plano de retiradas e previsão de lucro. LÊ o que o sistema já sabe (contratos, contas a pagar e previstas, recebimentos, conta-corrente dos sócios);
 * as premissas e a retirada planejada de cada sócio são da diretoria. NÃO lança nada, não paga e não decide a distribuição de lucros (isso é do contador/sócios).
 */
const audit = (x: DB, companyId: string, actorId: string, action: string, detail: Record<string, unknown>) => x.insert(auditLog).values({ companyId, actorId, action, detail });
const uuidOk = (s: string) => /^[0-9a-f-]{36}$/i.test(s ?? "");
type Row = Record<string, unknown>;
const rows = (r: unknown) => r as Row[];

export const DEFAULT_SETTINGS = { delinquencyBps: 300, unplannedBps: 500, reserveMonths: 2, retentionBps: 2000, cashNowCents: null as number | null, cashAsOf: null as string | null };
export type Settings = typeof DEFAULT_SETTINGS;

export async function getProfitSettings(db: DB, actorId: string, companyId: string): Promise<Settings & { isDefault: boolean }> {
  await requirePerm(db, actorId, companyId, "partners.read");
  const [r] = await db.select().from(profitSettings).where(eq(profitSettings.companyId, companyId));
  if (!r) return { ...DEFAULT_SETTINGS, isDefault: true };
  return { delinquencyBps: r.delinquencyBps, unplannedBps: r.unplannedBps, reserveMonths: r.reserveMonths, retentionBps: r.retentionBps, cashNowCents: r.cashNow === null ? null : centsFromSignedNumeric(r.cashNow), cashAsOf: r.cashAsOf, isDefault: false };
}

/** "3", "3,5", "12.25%" → pontos-base (0 a 10000). Zero vale aqui (sem inadimplência/retenção). */
export function parseBps(raw: unknown, label: string): number {
  const s = String(raw ?? "").trim().replace(/%$/, "").trim().replace(",", ".");
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(s)) throw new Invalid(`${label}: informe um percentual de 0 a 100`);
  const b = Math.round(Number(s) * 100);
  if (b < 0 || b > 10000) throw new Invalid(`${label}: informe um percentual de 0 a 100`);
  return b;
}

export type SettingsInput = { delinquency: unknown; unplanned: unknown; reserveMonths: unknown; retention: unknown; cashNow?: string; cashAsOf?: string };
export async function saveProfitSettings(db: DB, actorId: string, companyId: string, i: SettingsInput, today = todayManaus()) {
  await requirePerm(db, actorId, companyId, "partners.manage");
  const delinquencyBps = parseBps(i.delinquency, "Inadimplência"), unplannedBps = parseBps(i.unplanned, "Imprevistos"), retentionBps = parseBps(i.retention, "Retenção");
  const reserveMonths = Number(i.reserveMonths);
  if (!Number.isInteger(reserveMonths) || reserveMonths < 0 || reserveMonths > 24) throw new Invalid("Reserva: de 0 a 24 meses de despesa");
  const cashRaw = String(i.cashNow ?? "").trim();
  let cashNow: string | null = null, cashAsOf: string | null = null;
  if (cashRaw) {
    const neg = cashRaw.startsWith("-");
    const c = parseMoneyToCents(neg ? cashRaw.slice(1) : cashRaw);
    if (c === null) throw new Invalid("Caixa atual inválido");
    cashNow = numericFromCents(c); if (neg) cashNow = `-${cashNow}`;
    cashAsOf = String(i.cashAsOf ?? "").trim() || today;
    if (!isIsoDate(cashAsOf) || cashAsOf > today) throw new Invalid("Data do caixa inválida (não pode ser futura)");
  }
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await x.insert(profitSettings).values({ companyId, delinquencyBps, unplannedBps, reserveMonths, retentionBps, cashNow, cashAsOf, updatedBy: actorId })
      .onConflictDoUpdate({ target: profitSettings.companyId, set: { delinquencyBps, unplannedBps, reserveMonths, retentionBps, cashNow, cashAsOf, updatedBy: actorId, updatedAt: new Date() } });
    await audit(x, companyId, actorId, "plan.settings_saved", { reserveMonths, hasCash: cashNow !== null });
  });
}

export async function setPartnerPlan(db: DB, actorId: string, companyId: string, partnerId: string, amount: string) {
  await requirePerm(db, actorId, companyId, "partners.manage");
  if (!uuidOk(partnerId)) throw new Invalid("Sócio não encontrado");
  const raw = String(amount ?? "").trim();
  const c = raw === "" || raw === "0" ? 0 : parseMoneyToCents(raw);
  if (c === null) throw new Invalid("Informe um valor válido (ou 0 para nenhuma retirada planejada)");
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    const r = await x.update(partners).set({ plannedMonthly: numericFromCents(c), updatedAt: new Date() }).where(and(eq(partners.id, partnerId), eq(partners.companyId, companyId))).returning({ id: partners.id });
    if (!r.length) throw new Invalid("Sócio não encontrado");
    await audit(x, companyId, actorId, "plan.partner_saved", { partnerId });
  });
}

export type RealizedMonth = { month: string; receiptsCents: number; paidExpensesCents: number; withdrawalsCents: number };
export type PlanView = {
  today: string; settings: Settings & { isDefault: boolean }; plan: PlanResult; partners: (Balance & { plannedCents: number })[];
  plannedTotalCents: number; realized: RealizedMonth[]; variance: VarianceResult; ytd: { receiptsCents: number; paidExpensesCents: number; withdrawalsCents: number; resultCents: number };
  contracts: { activeCount: number; activeMonthlyCents: number; draftCount: number; draftMonthlyCents: number; suspendedCount: number };
  warnings: string[];
};

export async function buildPlan(db: DB, actorId: string, companyId: string, today = todayManaus(), horizon = 12): Promise<PlanView> {
  await requirePerm(db, actorId, companyId, "partners.read");
  const settings = await getProfitSettings(db, actorId, companyId);
  const first = today.slice(0, 7), last = addMonths(first, horizon - 1);
  const back = addMonths(first, -5);
  const [cons, bal, planned, realized, known, dueRows] = await Promise.all([
    db.execute(sql`select monthly_amount::text amt, start_at::text start_at, end_at::text end_at, status, commission_bps from contracts where company_id = ${companyId}`),
    partnerBalances(db, actorId, companyId, today),
    db.select({ id: partners.id, p: partners.plannedMonthly, active: partners.active }).from(partners).where(eq(partners.companyId, companyId)),
    db.execute(sql`with m as (select to_char(d, 'YYYY-MM') as month from generate_series(date_trunc('month', ${today}::date) - interval '5 months', date_trunc('month', ${today}::date), interval '1 month') d)
      select m.month,
        coalesce((select sum(p.amount + p.interest_amount - p.discount_amount) from payments p where p.company_id = ${companyId} and p.status = 'ativo' and to_char(p.paid_at, 'YYYY-MM') = m.month), 0)::text receipts,
        coalesce((select sum(pp.amount) from payable_payments pp where pp.company_id = ${companyId} and pp.status = 'ativo' and to_char(pp.paid_at, 'YYYY-MM') = m.month), 0)::text paid,
        coalesce((select sum(e.amount) from partner_entries e where e.company_id = ${companyId} and e.status = 'ativo' and e.kind = 'retirada' and to_char(e.occurred_on, 'YYYY-MM') = m.month), 0)::text withdrawals
      from m order by m.month`),
    db.execute(sql`select to_char(due_date, 'YYYY-MM') as month, coalesce(sum(amount), 0)::text s from payables where company_id = ${companyId} and status not in ('cancelado', 'rejeitado') and due_date >= ${first + "-01"}::date and due_date < (${last + "-01"}::date + interval '1 month') group by 1`),
    db.execute(sql`select to_char(due_date, 'YYYY-MM') as month, coalesce(sum(amount), 0)::text s from payables where company_id = ${companyId} and status not in ('cancelado', 'rejeitado', 'rascunho') and due_date >= ${back + "-01"}::date and due_date < (${first + "-01"}::date + interval '1 month') group by 1`),
  ]);
  const contracts: ContractLite[] = rows(cons).map((c) => ({ monthlyCents: centsFromNumeric(String(c.amt)), startAt: String(c.start_at), status: String(c.status), commissionBps: c.commission_bps === null ? null : Number(c.commission_bps) }));
  const knownMap: Record<string, number> = {};
  for (const k of rows(known)) knownMap[String(k.month)] = centsFromNumeric(String(k.s));
  const fcs = await Promise.all(Array.from({ length: horizon }, (_, k) => { const m = addMonths(first, k); return pendingForecasts(db, companyId, m).then((fc) => [m, fc.reduce((a, f) => a + f.amountCents, 0)] as const); }));
  for (const [m, v] of fcs) knownMap[m] = (knownMap[m] ?? 0) + v;
  const expiredActive = rows(cons).filter((c) => c.status === "ativo" && c.end_at !== null && String(c.end_at) < today).length;
  const plannedBy = new Map(planned.map((p) => [p.id, centsFromNumeric(p.p)]));
  const activePlanned = planned.filter((p) => p.active).reduce((a, p) => a + centsFromNumeric(p.p), 0);
  const s: PlanSettings = { delinquencyBps: settings.delinquencyBps, unplannedBps: settings.unplannedBps, reserveMonths: settings.reserveMonths, retentionBps: settings.retentionBps, cashNowCents: settings.cashNowCents };
  const plan = buildForecast({ firstMonth: first, months: horizon, settings: s, contracts, knownExpensesCents: knownMap, plannedWithdrawalCents: activePlanned });
  const real: RealizedMonth[] = rows(realized).map((r) => ({ month: String(r.month), receiptsCents: centsFromNumeric(String(r.receipts)), paidExpensesCents: centsFromNumeric(String(r.paid)), withdrawalsCents: centsFromNumeric(String(r.withdrawals)) }));
  const dueByMonth: Record<string, number> = {};
  for (const d of rows(dueRows)) dueByMonth[String(d.month)] = centsFromNumeric(String(d.s));
  const variance = buildVariance({ months: real.map((r) => r.month), currentMonth: first, delinquencyBps: settings.delinquencyBps, contracts, dueByMonth,
    paidByMonth: Object.fromEntries(real.map((r) => [r.month, r.paidExpensesCents])), receivedByMonth: Object.fromEntries(real.map((r) => [r.month, r.receiptsCents])),
    withdrawnByMonth: Object.fromEntries(real.map((r) => [r.month, r.withdrawalsCents])), plannedWithdrawalCents: activePlanned });
  const y = today.slice(0, 4);
  const [ytdRow] = rows(await db.execute(sql`select
      coalesce((select sum(p.amount + p.interest_amount - p.discount_amount) from payments p where p.company_id = ${companyId} and p.status = 'ativo' and p.paid_at >= ${y + "-01-01"}::date and p.paid_at <= ${today}::date), 0)::text r,
      coalesce((select sum(pp.amount) from payable_payments pp where pp.company_id = ${companyId} and pp.status = 'ativo' and pp.paid_at >= ${y + "-01-01"}::date and pp.paid_at <= ${today}::date), 0)::text e,
      coalesce((select sum(e.amount) from partner_entries e where e.company_id = ${companyId} and e.status = 'ativo' and e.kind = 'retirada' and e.occurred_on >= ${y + "-01-01"}::date and e.occurred_on <= ${today}::date), 0)::text w`));
  const ytd = { receiptsCents: centsFromNumeric(String(ytdRow.r)), paidExpensesCents: centsFromNumeric(String(ytdRow.e)), withdrawalsCents: centsFromNumeric(String(ytdRow.w)), resultCents: 0 };
  ytd.resultCents = ytd.receiptsCents - ytd.paidExpensesCents;
  const by = (st: string) => contracts.filter((c) => c.status === st);
  const sum = (cs: ContractLite[]) => cs.reduce((a, c) => a + c.monthlyCents, 0);
  const cinfo = { activeCount: by("ativo").length, activeMonthlyCents: sum(by("ativo")), draftCount: by("rascunho").length, draftMonthlyCents: sum(by("rascunho")), suspendedCount: by("suspenso").length };
  const warnings: string[] = [];
  if (expiredActive > 0) warnings.push(`${expiredActive} contrato(s) ativo(s) já passaram da data de término e foram tratados como renovados (renovação automática). Se algum não renova, encerre-o.`);
  if (cinfo.activeCount === 0) warnings.push("Nenhum contrato ativo: a receita prevista é zero. Aprove os contratos em rascunho para a previsão refletir a carteira.");
  if (cinfo.draftCount > 0) warnings.push(`${cinfo.draftCount} contrato(s) em rascunho (${(cinfo.draftMonthlyCents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}/mês) não entram na previsão até serem aprovados.`);
  if (activePlanned > plan.suggestedMonthlyCents) warnings.push("A retirada planejada passa do limite sugerido.");
  if (plan.firstNegativeCash.base) warnings.push(`No cenário base o caixa fica negativo em ${plan.firstNegativeCash.base.slice(5)}/${plan.firstNegativeCash.base.slice(0, 4)}.`);
  else if (plan.firstNegativeCash.pessimistic) warnings.push(`No cenário pessimista o caixa fica negativo em ${plan.firstNegativeCash.pessimistic.slice(5)}/${plan.firstNegativeCash.pessimistic.slice(0, 4)}.`);
  if (settings.cashNowCents === null) warnings.push("Informe o caixa atual para ver a projeção de caixa e a reposição da reserva.");
  return { today, settings, plan, partners: bal.map((b) => ({ ...b, plannedCents: plannedBy.get(b.partnerId) ?? 0 })), plannedTotalCents: activePlanned, realized: real, variance, ytd, contracts: cinfo, warnings };
}
