import { sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { centsFromNumeric } from "@/lib/money";
import { Forbidden, activeRole, requirePerm } from "@/modules/identity/service";
import { can, type Permission } from "@/modules/identity/permissions";
import { loadScheduledMany } from "@/modules/billing/service";
import { addMonths } from "@/modules/billing/calendar";
import { todayManaus } from "@/modules/messaging/service";
import { addDays } from "@/modules/messaging/dates";
import { listAccounts } from "@/modules/banking/service";
import { receivablesSummary } from "@/modules/receivables/service";
import { payablesSummary } from "@/modules/payables/service";
import { buildAlerts, buildForecast, buildOutflow, horizonEnd, lastMonths, type Alert } from "./calc";

/**
 * E12 — painel executivo com números REAIS e rastreáveis. Cada bloco só aparece se o papel do usuário tem a permissão da fonte.
 * Regras: previsto nunca soma com realizado; vencido não vira "entrada projetada"; transferência entre contas do grupo não é receita;
 * o consolidado do grupo soma empresa por empresa (cada uma com sua própria autorização), nunca por SQL entre empresas.
 */
type Row = Record<string, unknown>;
const rows = (r: unknown) => r as Row[];
const cents = (v: unknown) => centsFromSigned(String(v ?? "0"));
function centsFromSigned(v: string): number { const neg = v.startsWith("-"); const c = centsFromNumeric(neg ? v.slice(1) : v); return neg ? -c : c; }

export type Overview = {
  company: { id: string; name: string }; today: string; month: string;
  receivables: { openCents: number; openCount: number; overdueCents: number; overdueCount: number; over30Cents: number; delinquencyRatio: number } | null;
  billed: { monthCents: number; monthCount: number } | null;
  received: { monthCents: number; monthCount: number } | null;
  series: { month: string; billedCents: number; receivedCents: number }[];
  bank: { accounts: number; balanceCents: number; pendingCredits: number; pendingCents: number; lastTxDate: string | null; internalInCents: number; internalOutCents: number } | null;
  forecast: ReturnType<typeof buildForecast> | null;
  payables: { approvedOpenCents: number; overdueCents: number; overdueCount: number; pendingCents: number; pendingCount: number; dueSoonCount: number; paidMonthCents: number } | null;
  outflow: ReturnType<typeof buildOutflow> | null;
  alerts: Alert[];
  notes: string[];
};

export async function getOverview(db: DB, actorId: string, companyId: string, today = todayManaus()): Promise<Overview> {
  await requirePerm(db, actorId, companyId, "finance.read");
  const role = (await activeRole(db, actorId, companyId))!;
  const ok = (p: Permission) => can(role, p);
  const month = today.slice(0, 7);
  const months = lastMonths(month, 6);
  const [co] = rows(await db.execute(sql`select id, name from companies where id = ${companyId}`));
  const notes: string[] = [];
  const ov: Overview = { company: { id: String(co.id), name: String(co.name) }, today, month, receivables: null, billed: null, received: null, series: months.map((m) => ({ month: m, billedCents: 0, receivedCents: 0 })), bank: null, forecast: null, payables: null, outflow: null, alerts: [], notes };
  const alertIn = { overdueCents: 0, overdueCount: 0, openCents: 0, over30Cents: 0, draftBatches: [] as { id: string; issueDate: string }[], dueSoonCount: 0, pendingCredits: 0, accounts: 0, daysSinceLastTx: null as number | null, blockedMessages: 0, failedIssuance: 0, customersNoContact: 0, customersNoContract: 0, plannedOverdueCount: 0 };

  if (ok("receivables.read")) {
    const s = await receivablesSummary(db, actorId, companyId, today);
    const over30 = s.aging.filter((a) => a.key === "31-60" || a.key === "61+").reduce((t, a) => t + a.cents, 0);
    ov.receivables = { openCents: s.openCents, openCount: s.openCount, overdueCents: s.overdueCents, overdueCount: s.overdueCount, over30Cents: over30, delinquencyRatio: s.openCents > 0 ? s.overdueCents / s.openCents : 0 };
    ov.received = { monthCents: s.receivedMonthCents, monthCount: s.receivedMonthCount };
    Object.assign(alertIn, { overdueCents: s.overdueCents, overdueCount: s.overdueCount, openCents: s.openCents, over30Cents: over30 });
    // faturado = cobranças de lote aprovado por DATA DE EMISSÃO; recebido = pagamentos ativos por data de pagamento (últimos 6 meses)
    const first = `${months[0]}-01`;
    const bill = rows(await db.execute(sql`select to_char(c.issue_date, 'YYYY-MM') m, sum(c.amount)::text s, count(*)::int n from charges c join billing_batches b on b.company_id = c.company_id and b.id = c.batch_id
      where c.company_id = ${companyId} and c.status = 'aprovada' and b.status = 'aprovado' and c.issue_date >= ${first}::date group by 1`));
    const rec = rows(await db.execute(sql`select to_char(paid_at, 'YYYY-MM') m, sum(amount + interest_amount - discount_amount)::text s from payments where company_id = ${companyId} and status = 'ativo' and paid_at >= ${first}::date group by 1`));
    for (const p of ov.series) {
      p.billedCents = cents(bill.find((r) => r.m === p.month)?.s ?? 0);
      p.receivedCents = cents(rec.find((r) => r.m === p.month)?.s ?? 0);
    }
    const cur = bill.find((r) => r.m === month);
    ov.billed = { monthCents: cents(cur?.s ?? 0), monthCount: Number(cur?.n ?? 0) };
    const [soon] = rows(await db.execute(sql`select count(*)::int n from charges c join billing_batches b on b.company_id = c.company_id and b.id = c.batch_id
      where c.company_id = ${companyId} and c.status = 'aprovada' and b.status = 'aprovado' and c.due_date between ${today}::date and ${addDays(today, 3)}::date
        and coalesce((select sum(p.amount) from payments p where p.company_id = c.company_id and p.charge_id = c.id and p.status = 'ativo'), 0) < c.amount`));
    alertIn.dueSoonCount = Number(soon.n);
  } else notes.push("Seu papel não vê contas a receber: faturado, recebido e previsão ficam ocultos.");

  if (ok("bank.read")) {
    const accs = await listAccounts(db, actorId, companyId);
    const [m] = rows(await db.execute(sql`select max(t.posted_at)::text last from bank_transactions t where t.company_id = ${companyId} and t.status = 'ativa'`));
    const [tr] = rows(await db.execute(sql`select coalesce(sum(t.amount) filter (where t.amount > 0), 0)::text i, coalesce(-sum(t.amount) filter (where t.amount < 0), 0)::text o
      from bank_transactions t join bank_transaction_marks k on k.transaction_id = t.id where t.company_id = ${companyId} and t.status = 'ativa' and k.kind = 'transferencia_grupo'`));
    const last = m.last ? String(m.last) : null;
    ov.bank = { accounts: accs.length, balanceCents: accs.reduce((s, a) => s + a.balanceCents, 0), pendingCredits: accs.reduce((s, a) => s + a.pendingCount, 0), pendingCents: accs.reduce((s, a) => s + a.pendingCents, 0), lastTxDate: last, internalInCents: cents(tr.i), internalOutCents: cents(tr.o) };
    Object.assign(alertIn, { accounts: accs.length, pendingCredits: ov.bank.pendingCredits, daysSinceLastTx: last ? Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${last}T00:00:00Z`)) / 86_400_000) : null });
    if (accs.length === 0) notes.push("Nenhuma conta bancária cadastrada: o saldo e a conferência dos recebimentos pelo extrato não estão disponíveis.");
  } else notes.push("Seu papel não vê o extrato bancário: saldo e conciliação ficam ocultos.");

  if (ok("receivables.read") && ok("contracts.read")) {
    const end = horizonEnd(today);
    const open = rows(await db.execute(sql`select c.due_date::text d, (c.amount - coalesce(p.paid, 0))::text o from charges c join billing_batches b on b.company_id = c.company_id and b.id = c.batch_id
      left join (select charge_id, sum(amount) paid from payments where company_id = ${companyId} and status = 'ativo' group by charge_id) p on p.charge_id = c.id
      where c.company_id = ${companyId} and c.status = 'aprovada' and b.status = 'aprovado' and coalesce(p.paid, 0) < c.amount`));
    // previsto pelos contratos: itens agendados SEM cobrança APROVADA (lote aprovado) para o mesmo contrato e competência.
    // Cobrança só em prévia (rascunho) continua "prevista": ainda não é confirmada e não pode sumir da projeção.
    const have = new Set(rows(await db.execute(sql`select c.contract_id::text || '|' || to_char(c.competence_month, 'YYYY-MM') k from charges c join billing_batches b on b.company_id = c.company_id and b.id = c.batch_id
      where c.company_id = ${companyId} and c.status = 'aprovada' and b.status = 'aprovado'`)).map((r) => String(r.k)));
    const planned = new Map<string, { dueDate: string; cents: number }>();
    const floor = `${addMonths(month, -2)}-01`;
    const span: string[] = [];
    for (let m = addMonths(month, -2); m <= addMonths(end.slice(0, 7), 1); m = addMonths(m, 1)) span.push(m);
    const sched = await loadScheduledMany(db, companyId, span); // contratos e feriados lidos uma vez
    for (const m of span) {
      for (const { item } of sched.get(m)!.entries) {
        if (item.review || !item.dueDate) continue;
        const key = `${item.contractId}|${item.competenceMonth}`;
        if (have.has(key) || planned.has(key)) continue;
        if (item.dueDate > end || item.dueDate < floor) continue;
        planned.set(key, { dueDate: item.dueDate, cents: item.amountCents });
      }
    }
    const fc = buildForecast(today, open.map((r) => ({ dueDate: String(r.d), cents: cents(r.o) })), [...planned.values()]);
    ov.forecast = fc; alertIn.plannedOverdueCount = fc.plannedOverdueCount;
    const [{ n }] = rows(await db.execute(sql`select count(*)::int n from contracts where company_id = ${companyId} and status = 'ativo'`)) as { n: number }[];
    if (Number(n) === 0) notes.push("Sem contratos ativos: não há previsão de cobranças futuras por contrato.");
  }
  if (ok("payables.read")) {
    const ps = await payablesSummary(db, actorId, companyId, today);
    ov.payables = ps;
    const items = rows(await db.execute(sql`select p.due_date::text d, p.status, (p.amount - coalesce(pp.paid, 0))::text o from payables p
      left join (select payable_id, sum(amount) paid from payable_payments where company_id = ${companyId} and status = 'ativo' group by payable_id) pp on pp.payable_id = p.id
      where p.company_id = ${companyId} and ((p.status = 'aprovado' and coalesce(pp.paid, 0) < p.amount) or p.status = 'aguardando_aprovacao')`));
    ov.outflow = buildOutflow(today, items.map((r) => ({ dueDate: String(r.d), cents: cents(r.o), approved: r.status === "aprovado" })));
    Object.assign(alertIn, { payablesOverdueCount: ps.overdueCount, payablesOverdueCents: ps.overdueCents, payablesPendingCount: ps.pendingCount, payablesDueSoonCount: ps.dueSoonCount });
  } else notes.push("Seu papel não vê contas a pagar: as saídas não estão consideradas.");

  if (ok("billing.read")) {
    const dr = rows(await db.execute(sql`select id::text, issue_date::text d from billing_batches where company_id = ${companyId} and status = 'rascunho' and issue_date <= ${addDays(today, 3)}::date and issue_date >= ${addDays(today, -30)}::date order by issue_date`));
    alertIn.draftBatches = dr.map((r) => ({ id: String(r.id), issueDate: String(r.d) }));
  }
  if (ok("messages.read")) { const [r] = rows(await db.execute(sql`select count(*)::int n from message_queue where company_id = ${companyId} and status = 'bloqueado'`)); alertIn.blockedMessages = Number(r.n); }
  if (ok("issuance.read")) { const [r] = rows(await db.execute(sql`select count(*)::int n from issuance_requests where company_id = ${companyId} and status = 'falhou'`)); alertIn.failedIssuance = Number(r.n); }
  if (ok("crm.read")) {
    const [a] = rows(await db.execute(sql`select count(*)::int n from customers cu where cu.company_id = ${companyId} and cu.status = 'ativo' and cu.archived_at is null
      and not exists (select 1 from customer_contacts k where k.company_id = cu.company_id and k.customer_id = cu.id and k.is_financial and coalesce(trim(k.email), '') <> '')`));
    const [b] = rows(await db.execute(sql`select count(*)::int n from customers cu where cu.company_id = ${companyId} and cu.status = 'ativo' and cu.archived_at is null
      and not exists (select 1 from contracts c where c.company_id = cu.company_id and c.customer_id = cu.id and c.status = 'ativo')`));
    alertIn.customersNoContact = Number(a.n); alertIn.customersNoContract = Number(b.n);
  }
  ov.alerts = buildAlerts(alertIn, today);
  return ov;
}

export type GroupOverview = {
  companies: Overview[]; skipped: string[];
  total: { payableApprovedCents: number; payableOverdueCents: number; payablePendingCents: number; openCents: number; overdueCents: number; billedMonthCents: number; receivedMonthCents: number; balanceCents: number; pendingCents: number; internalInCents: number; internalOutCents: number; delinquencyRatio: number };
  series: Overview["series"]; weeks: { start: string; end: string; confirmedCents: number; plannedCents: number }[]; overdueCents: number;
  outWeeks: { start: string; end: string; approvedCents: number; pendingCents: number }[];
};

/** Consolidado: cada empresa é consultada com a autorização do usuário NELA; empresas sem acesso são omitidas (e listadas). */
export async function getGroupOverview(db: DB, actorId: string, companyList: { id: string; name: string }[], today = todayManaus()): Promise<GroupOverview> {
  const companies: Overview[] = []; const skipped: string[] = [];
  const results = await Promise.all(companyList.map(async (c) => { try { return { c, o: await getOverview(db, actorId, c.id, today) }; } catch (e) { if (e instanceof Forbidden) return { c, o: null }; throw e; } }));
  for (const r of results) { if (r.o) companies.push(r.o); else skipped.push(r.c.name); }
  const sum = (f: (o: Overview) => number) => companies.reduce((s, o) => s + f(o), 0);
  const month = today.slice(0, 7);
  const series = lastMonths(month, 6).map((m) => ({ month: m, billedCents: sum((o) => o.series.find((p) => p.month === m)?.billedCents ?? 0), receivedCents: sum((o) => o.series.find((p) => p.month === m)?.receivedCents ?? 0) }));
  const wk = companies.find((o) => o.forecast)?.forecast?.weeks ?? [];
  const weeks = wk.map((w, i) => ({ start: w.start, end: w.end, confirmedCents: sum((o) => o.forecast?.weeks[i]?.confirmedCents ?? 0), plannedCents: sum((o) => o.forecast?.weeks[i]?.plannedCents ?? 0) }));
  const ow = companies.find((o) => o.outflow)?.outflow?.weeks ?? [];
  const outWeeks = ow.map((w, i) => ({ start: w.start, end: w.end, approvedCents: sum((o) => o.outflow?.weeks[i]?.approvedCents ?? 0), pendingCents: sum((o) => o.outflow?.weeks[i]?.pendingCents ?? 0) }));
  const open = sum((o) => o.receivables?.openCents ?? 0), overdue = sum((o) => o.receivables?.overdueCents ?? 0);
  return {
    companies, skipped, series, weeks, outWeeks, overdueCents: sum((o) => o.forecast?.overdueCents ?? 0),
    total: { payableApprovedCents: sum((o) => o.payables?.approvedOpenCents ?? 0), payableOverdueCents: sum((o) => o.payables?.overdueCents ?? 0), payablePendingCents: sum((o) => o.payables?.pendingCents ?? 0), openCents: open, overdueCents: overdue, billedMonthCents: sum((o) => o.billed?.monthCents ?? 0), receivedMonthCents: sum((o) => o.received?.monthCents ?? 0), balanceCents: sum((o) => o.bank?.balanceCents ?? 0), pendingCents: sum((o) => o.bank?.pendingCents ?? 0), internalInCents: sum((o) => o.bank?.internalInCents ?? 0), internalOutCents: sum((o) => o.bank?.internalOutCents ?? 0), delinquencyRatio: open > 0 ? overdue / open : 0 },
  };
}

/** Rastreabilidade do "Recebido no mês": os pagamentos que compõem o número (ativos e estornados, com origem). */
export async function listReceipts(db: DB, actorId: string, companyId: string, month: string) {
  await requirePerm(db, actorId, companyId, "receivables.read");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return { month, items: [], totalCents: 0, truncated: false };
  const r = rows(await db.execute(sql`select p.id, p.paid_at::text d, (p.amount + p.interest_amount - p.discount_amount)::text a, p.interest_amount::text ia, p.discount_amount::text da, p.method, p.status, p.charge_id, cu.legal_name
    from payments p join charges c on c.company_id = p.company_id and c.id = p.charge_id join customers cu on cu.company_id = c.company_id and cu.id = c.customer_id
    where p.company_id = ${companyId} and p.paid_at >= ${month + "-01"}::date and p.paid_at < (${month + "-01"}::date + interval '1 month') order by p.paid_at desc, p.created_at desc limit 500`));
  const items = r.map((x) => ({ id: String(x.id), paidAt: String(x.d), amountCents: cents(x.a), interestCents: cents(x.ia), discountCents: cents(x.da), method: String(x.method), status: String(x.status), chargeId: String(x.charge_id), customerName: String(x.legal_name) }));
  const [tot] = rows(await db.execute(sql`select coalesce(sum(amount + interest_amount - discount_amount), 0)::text s, count(*)::int n from payments where company_id = ${companyId} and status = 'ativo' and paid_at >= ${month + "-01"}::date and paid_at < (${month + "-01"}::date + interval '1 month')`));
  return { month, items, totalCents: cents(tot.s), truncated: Number((rows(await db.execute(sql`select count(*)::int n from payments where company_id = ${companyId} and paid_at >= ${month + "-01"}::date and paid_at < (${month + "-01"}::date + interval '1 month')`))[0]).n) > items.length };
}
