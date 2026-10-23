import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "@/lib/db";
import { auditLog, contracts, customers, holidays } from "@/lib/db/schema";
import { centsFromNumeric } from "@/lib/money";
import { Invalid, requirePerm } from "@/modules/identity/service";
import { isContractBillable } from "@/modules/contracts/service";
import { addMonths, billingSchedule, daysInMonth, holidaysFor, nationalHolidays, parseMonth, type HolidayMap, type Warning } from "./calendar";

export type CalendarItem = {
  contractId: string; customerId: string; customerName: string; description: string; amountCents: number; jointInvoice: boolean;
  competenceMonth: string; dueDate?: string; issueDate?: string; batch?: 25 | 1 | 8 | 15 | null; review: boolean; reason?: string; warnings: Warning[];
};
export type CalendarDay = { date: string; issue: CalendarItem[]; due: CalendarItem[]; holiday?: string };
export type BatchTotal = { batch: 25 | 1 | 8 | 15 | null; count: number; cents: number };

async function extraHolidays(db: DB, companyId: string, years: number[]): Promise<HolidayMap> {
  const lo = `${Math.min(...years)}-01-01`, hi = `${Math.max(...years)}-12-31`;
  const rows = await db.select().from(holidays).where(and(eq(holidays.companyId, companyId), gte(holidays.day, lo), lte(holidays.day, hi)));
  return new Map(rows.map((r) => [r.day, r.name]));
}

/**
 * Itens agendados que tocam o mês `month` (emissão OU vencimento nele), só de contratos faturáveis
 * (contrato ativo + cliente ativo + vigência cobrindo a competência). Fonte única do calendário e dos lotes (E05).
 * Sem checagem de permissão: quem chama autoriza.
 */
export async function loadScheduled(db: DB, companyId: string, month: string) {
  parseMonth(month);
  const rows = await db.select({ c: contracts, cu: customers }).from(contracts)
    .innerJoin(customers, and(eq(customers.id, contracts.customerId), eq(customers.companyId, contracts.companyId)))
    .where(and(eq(contracts.companyId, companyId), eq(contracts.status, "ativo")));
  const years = [...new Set([+month.slice(0, 4) - 1, +month.slice(0, 4), +month.slice(0, 4) + 1])];
  const extra = await extraHolidays(db, companyId, years);
  const hol = holidaysFor([`${month}-01`], extra);
  for (const y of years) for (const [k, v] of nationalHolidays(y)) hol.set(k, v);
  const entries: { item: CalendarItem; dueMonth: string }[] = [];
  for (const { c, cu } of rows) {
    // eventos do mês podem vir de dois vencimentos: o deste mês (emitido no 1/8/15 ou, p/ 1–12, no 25 anterior) e o do mês seguinte (emitido no dia 25 deste mês)
    for (const dueMonth of [month, addMonths(month, 1)]) {
      const competence = addMonths(dueMonth, -1);
      if (!isContractBillable(c, cu, competence)) continue;
      const r = billingSchedule({ competenceMonth: competence, dueDay: c.dueDay, jointInvoice: c.invoiceJointRequired, issueDayOverride: c.issueDayOverride }, extra);
      entries.push({ dueMonth, item: { contractId: c.id, customerId: cu.id, customerName: cu.legalName, description: c.description, amountCents: centsFromNumeric(c.monthlyAmount), jointInvoice: c.invoiceJointRequired,
        competenceMonth: competence, dueDate: r.dueDate, issueDate: r.issueDate, batch: r.batch, review: r.review, reason: r.reason, warnings: r.warnings } });
    }
  }
  return { entries, hol };
}

/**
 * Calendário do mês `month` (YYYY-MM): quando EMITIR boletos/NFs e quando VENCEM, só para contratos faturáveis.
 * Nenhuma emissão externa acontece aqui: é previsão.
 */
export async function getBillingCalendar(db: DB, actorId: string, companyId: string, month: string) {
  await requirePerm(db, actorId, companyId, "contracts.read");
  const { entries, hol } = await loadScheduled(db, companyId, month);
  const days = new Map<string, CalendarDay>();
  const day = (d: string) => days.get(d) ?? (days.set(d, { date: d, issue: [], due: [], holiday: hol.get(d) }), days.get(d)!);
  const review: CalendarItem[] = []; const batchMap = new Map<number | null, BatchTotal>();
  const inMonth = (d?: string) => !!d && d.slice(0, 7) === month;

  for (const { item, dueMonth } of entries) {
    if (!item.issueDate || !item.dueDate) { if (dueMonth === month) review.push(item); continue; } // dia 31 / mês curto: sem data, vai para "precisa de revisão"
    if (inMonth(item.issueDate)) {
      day(item.issueDate).issue.push(item);
      const t = batchMap.get(item.batch ?? null) ?? { batch: item.batch ?? null, count: 0, cents: 0 }; t.count++; t.cents += item.amountCents; batchMap.set(item.batch ?? null, t);
      if (item.review) review.push(item);
    }
    if (inMonth(item.dueDate)) day(item.dueDate).due.push(item);
  }
  // feriados do mês aparecem no calendário mesmo sem eventos
  for (let d = 1; d <= daysInMonth(month); d++) { const iso = `${month}-${String(d).padStart(2, "0")}`; if (hol.has(iso)) day(iso); }
  const ordered = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  const order = [25, 1, 8, 15, null];
  return {
    month, days: ordered, review,
    batches: order.map((b) => batchMap.get(b) ?? { batch: b as BatchTotal["batch"], count: 0, cents: 0 }).filter((b) => b.count > 0),
    totals: { issueCount: ordered.reduce((s, d) => s + d.issue.length, 0), issueCents: ordered.reduce((s, d) => s + d.issue.reduce((a, i) => a + i.amountCents, 0), 0), dueCount: ordered.reduce((s, d) => s + d.due.length, 0), dueCents: ordered.reduce((s, d) => s + d.due.reduce((a, i) => a + i.amountCents, 0), 0) },
  };
}

// ---------- feriados por empresa ----------
export async function listHolidays(db: DB, actorId: string, companyId: string, year: number) {
  await requirePerm(db, actorId, companyId, "contracts.read");
  const own = await db.select().from(holidays).where(and(eq(holidays.companyId, companyId), sql`extract(year from ${holidays.day}) = ${year}`)).orderBy(asc(holidays.day));
  return { national: [...nationalHolidays(year)].sort(([a], [b]) => a.localeCompare(b)).map(([day, name]) => ({ day, name })), own };
}
const holidaySchema = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida"), name: z.string().trim().min(2, "Informe o nome do feriado").max(80) });
export async function addHoliday(db: DB, actorId: string, companyId: string, input: unknown) {
  await requirePerm(db, actorId, companyId, "contracts.approve"); // altera quando se emite: gerente/diretoria
  const p = holidaySchema.safeParse(input);
  if (!p.success || Number.isNaN(Date.parse(`${p.data.day}T00:00:00Z`))) throw new Invalid(p.success ? "Data inválida" : p.error.issues[0].message);
  await db.insert(holidays).values({ companyId, day: p.data.day, name: p.data.name }).onConflictDoUpdate({ target: [holidays.companyId, holidays.day], set: { name: p.data.name, updatedAt: new Date() } });
  await db.insert(auditLog).values({ companyId, actorId, action: "holiday.saved", detail: { day: p.data.day } });
}
export async function removeHoliday(db: DB, actorId: string, companyId: string, id: string) {
  await requirePerm(db, actorId, companyId, "contracts.approve");
  const r = await db.delete(holidays).where(and(eq(holidays.id, id), eq(holidays.companyId, companyId))).returning({ day: holidays.day });
  if (!r.length) throw new Invalid("Feriado não encontrado");
  await db.insert(auditLog).values({ companyId, actorId, action: "holiday.removed", detail: { day: r[0].day } });
}
