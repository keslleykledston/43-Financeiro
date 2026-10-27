import { sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";
import { toCsv } from "@/lib/csv";
import { centsFromNumeric } from "@/lib/money";
import { Invalid, requirePerm } from "@/modules/identity/service";
import { todayManaus } from "@/modules/messaging/service";
import { addMonths, isMonth } from "./schedule";

/**
 * Relatório de despesas por categoria, mês e centro de custo. SOMENTE LEITURA; só contas a pagar da empresa ativa (gasto pessoal dos sócios fica na conta-corrente, não aqui).
 *  - base "pago": baixas ativas de contas, no mês da DATA DE PAGAMENTO (o que saiu do caixa).
 *  - base "competencia": contas APROVADAS (pagas ou não), no mês de competência (ou, sem competência, do vencimento), pelo valor da conta.
 * Estornos e contas canceladas/rejeitadas/rascunho/aguardando não entram. No máximo 24 meses.
 */
export type SpendBasis = "pago" | "competencia";
export type SpendLine = { key: string; name: string; group: string | null; byMonth: number[]; totalCents: number };
export type SpendReport = { from: string; to: string; basis: SpendBasis; months: string[]; categories: SpendLine[]; centers: SpendLine[]; totalByMonth: number[]; totalCents: number };
export const MAX_REPORT_MONTHS = 24;

export function reportRange(from?: string, to?: string, today = todayManaus()) {
  const cur = today.slice(0, 7);
  if ((from && !isMonth(from)) || (to && !isMonth(to))) throw new Invalid("Período inválido: use mês e ano (AAAA-MM)");
  const f = from || addMonths(cur, -5), t = to || cur;
  if (f > t) throw new Invalid("O mês inicial não pode ser depois do final");
  const months: string[] = [];
  for (let m = f; m <= t; m = addMonths(m, 1)) { months.push(m); if (months.length > MAX_REPORT_MONTHS) throw new Invalid(`Período de no máximo ${MAX_REPORT_MONTHS} meses`); }
  return { from: f, to: t, months };
}

type Row = Record<string, unknown>;
export async function spendReport(db: DB, actorId: string, companyId: string, i: { from?: string; to?: string; basis?: string }, today = todayManaus()): Promise<SpendReport> {
  await requirePerm(db, actorId, companyId, "payables.read");
  if (i.basis && i.basis !== "pago" && i.basis !== "competencia") throw new Invalid("Base inválida: use pago ou competencia");
  const basis: SpendBasis = i.basis === "competencia" ? "competencia" : "pago";
  const { from, to, months } = reportRange(i.from, i.to, today);
  const start = `${from}-01`, end = `${addMonths(to, 1)}-01`;
  const r = (basis === "pago"
    ? await db.execute(sql`select to_char(pp.paid_at, 'YYYY-MM') m, p.category_id, p.cost_center_id, sum(pp.amount)::text s
        from payable_payments pp join payables p on p.company_id = pp.company_id and p.id = pp.payable_id
        where pp.company_id = ${companyId} and pp.status = 'ativo' and pp.paid_at >= ${start}::date and pp.paid_at < ${end}::date group by 1, 2, 3`)
    : await db.execute(sql`select to_char(coalesce(p.competence, p.due_date), 'YYYY-MM') m, p.category_id, p.cost_center_id, sum(p.amount)::text s
        from payables p where p.company_id = ${companyId} and p.status = 'aprovado' and coalesce(p.competence, p.due_date) >= ${start}::date and coalesce(p.competence, p.due_date) < ${end}::date group by 1, 2, 3`)) as unknown as Row[];
  const [cats, ccs] = await Promise.all([
    db.execute(sql`select id::text, name, grp from expense_categories where company_id = ${companyId}`) as unknown as Promise<Row[]>,
    db.execute(sql`select id::text, name from cost_centers where company_id = ${companyId}`) as unknown as Promise<Row[]>,
  ]);
  const catName = new Map(cats.map((c) => [String(c.id), { name: String(c.name), group: String(c.grp) }]));
  const ccName = new Map(ccs.map((c) => [String(c.id), String(c.name)]));
  const idx = new Map(months.map((m, k) => [m, k]));
  const mk = (n: number) => Array<number>(n).fill(0);
  const cat = new Map<string, SpendLine>(), cen = new Map<string, SpendLine>();
  const totalByMonth = mk(months.length);
  const bump = (map: Map<string, SpendLine>, key: string, name: string, group: string | null, k: number, cents: number) => {
    const l = map.get(key) ?? map.set(key, { key, name, group, byMonth: mk(months.length), totalCents: 0 }).get(key)!;
    l.byMonth[k] += cents; l.totalCents += cents;
  };
  for (const x of r) {
    const k = idx.get(String(x.m)); if (k === undefined) continue;
    let cents: number;
    try { cents = centsFromNumeric(String(x.s)); } catch { throw new Invalid("Valores acima do limite suportado no período: reduza o período"); }
    const cid = x.category_id ? String(x.category_id) : null, zid = x.cost_center_id ? String(x.cost_center_id) : null;
    const c = cid ? catName.get(cid) : undefined;
    bump(cat, cid ?? "-", c?.name ?? "Sem categoria", c?.group ?? null, k, cents);
    bump(cen, zid ?? "-", (zid && ccName.get(zid)) || "Sem centro de custo", null, k, cents);
    totalByMonth[k] += cents;
    if (!Number.isSafeInteger(totalByMonth[k])) throw new Invalid("Valores acima do limite suportado no período: reduza o período");
  }
  const order = (m: Map<string, SpendLine>) => [...m.values()].sort((a, b) => b.totalCents - a.totalCents || a.name.localeCompare(b.name, "pt-BR"));
  return { from, to, basis, months, categories: order(cat), centers: order(cen), totalByMonth, totalCents: totalByMonth.reduce((a, v) => a + v, 0) };
}

export async function exportSpendReport(db: DB, actorId: string, companyId: string, i: { from?: string; to?: string; basis?: string }, today = todayManaus()) {
  await requirePerm(db, actorId, companyId, "payables.export");
  const rep = await spendReport(db, actorId, companyId, i, today);
  const money = (c: number) => (c / 100).toFixed(2).replace(".", ",");
  const head = ["Tipo", "Nome", "Grupo", ...rep.months.map((m) => `${m.slice(5)}/${m.slice(0, 4)}`), "Total"];
  const line = (t: string, l: SpendLine) => [t, l.name, l.group ?? "", ...l.byMonth.map(money), money(l.totalCents)];
  const csv = toCsv([head, ...rep.categories.map((l) => line("Categoria", l)), ...rep.centers.map((l) => line("Centro de custo", l)), ["Total", "", "", ...rep.totalByMonth.map(money), money(rep.totalCents)]]);
  await db.insert(auditLog).values({ companyId, actorId, action: "payable.report_exported", detail: { basis: rep.basis, from: rep.from, to: rep.to } });
  return csv;
}
