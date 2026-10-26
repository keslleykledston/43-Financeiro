import { and, eq, sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { auditLog, payableSeries, payableTemplates, payables } from "@/lib/db/schema";
import { isIsoDate } from "@/lib/iso-date";
import { centsFromNumeric, numericFromCents, parseMoneyToCents } from "@/lib/money";
import { Invalid, requirePerm } from "@/modules/identity/service";
import { todayManaus } from "@/modules/messaging/service";
import { assertVendor, resolveClass, listPayables, type PayableRow } from "./service";
import { dueDateIn, firstOf, isMonth, monthOf, seriesSchedule } from "./schedule";

/**
 * D2 — contas recorrentes e parcelas. Nada paga nem aprova sozinho: "Gerar o mês" cria RASCUNHOS de contas a pagar (sem duplicar: índices únicos por
 * modelo+mês e por série+parcela), que seguem o fluxo normal (enviar, aprovar, baixar). Cancelar um rascunho gerado NÃO o recria no mesmo mês.
 * Modelos e séries: criar/alterar só `payables.manage` (diretoria). Gerar o mês: `payables.write`. Ver: `payables.read`.
 */
const audit = (x: DB, companyId: string, actorId: string, action: string, detail: Record<string, unknown>) => x.insert(auditLog).values({ companyId, actorId, action, detail });
const uuidOk = (s: string) => /^[0-9a-f-]{36}$/i.test(s ?? "");
type Row = Record<string, unknown>;
const rows = (r: unknown) => r as Row[];
const clean = (s: unknown, max: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export type TemplateInput = { vendorId: string; description: string; amount: string; dueDay: unknown; categoryId?: string; costCenterId?: string; startMonth: string; endMonth?: string };

function parseTemplate(i: TemplateInput) {
  if (!uuidOk(i.vendorId ?? "")) throw new Invalid("Escolha o fornecedor");
  const description = clean(i.description, 200);
  if (description.length < 2) throw new Invalid("Descreva a despesa (2 a 200 caracteres)");
  const cents = parseMoneyToCents(i.amount ?? "");
  if (cents === null || cents <= 0) throw new Invalid("Informe o valor esperado, maior que zero");
  const day = Number(i.dueDay);
  if (!Number.isInteger(day) || day < 1 || day > 31) throw new Invalid("Dia do vencimento: de 1 a 31 (em meses curtos vale o último dia)");
  if (!isMonth(i.startMonth ?? "")) throw new Invalid("Informe o mês de início");
  const end = (i.endMonth ?? "").trim();
  if (end && (!isMonth(end) || end < i.startMonth)) throw new Invalid("Mês final inválido (não pode ser antes do início)");
  return { description, cents, day, start: firstOf(i.startMonth), end: end ? firstOf(end) : null };
}

export async function createTemplate(db: DB, actorId: string, companyId: string, i: TemplateInput) {
  await requirePerm(db, actorId, companyId, "payables.manage");
  const v = parseTemplate(i);
  return db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await assertVendor(x, companyId, i.vendorId);
    const cls = await resolveClass(x, companyId, { ...i, vendorId: i.vendorId, description: v.description, amount: i.amount, dueDate: "" });
    const [t] = await x.insert(payableTemplates).values({ companyId, vendorId: i.vendorId, description: v.description, amount: numericFromCents(v.cents), dueDay: v.day, categoryId: cls.categoryId, costCenterId: cls.costCenterId, startMonth: v.start, endMonth: v.end, createdBy: actorId }).returning({ id: payableTemplates.id });
    await audit(x, companyId, actorId, "payable.template_saved", { templateId: t.id, created: true });
    return t.id;
  });
}

/** Altera o modelo: vale só para os meses AINDA NÃO gerados (contas já geradas não mudam). */
export async function updateTemplate(db: DB, actorId: string, companyId: string, id: string, i: TemplateInput) {
  await requirePerm(db, actorId, companyId, "payables.manage");
  if (!uuidOk(id)) throw new Invalid("Modelo não encontrado");
  const v = parseTemplate(i);
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await assertVendor(x, companyId, i.vendorId);
    const cls = await resolveClass(x, companyId, { ...i, description: v.description, amount: i.amount, dueDate: "" });
    const r = await x.update(payableTemplates).set({ vendorId: i.vendorId, description: v.description, amount: numericFromCents(v.cents), dueDay: v.day, categoryId: cls.categoryId, costCenterId: cls.costCenterId, startMonth: v.start, endMonth: v.end, updatedAt: new Date() })
      .where(and(eq(payableTemplates.id, id), eq(payableTemplates.companyId, companyId))).returning({ id: payableTemplates.id });
    if (!r.length) throw new Invalid("Modelo não encontrado");
    await audit(x, companyId, actorId, "payable.template_saved", { templateId: id, created: false });
  });
}

export async function setTemplateActive(db: DB, actorId: string, companyId: string, id: string, active: boolean) {
  await requirePerm(db, actorId, companyId, "payables.manage");
  if (!uuidOk(id)) throw new Invalid("Modelo não encontrado");
  await db.transaction(async (tx) => {
    const r = await tx.update(payableTemplates).set({ active, updatedAt: new Date() }).where(and(eq(payableTemplates.id, id), eq(payableTemplates.companyId, companyId))).returning({ id: payableTemplates.id });
    if (!r.length) throw new Invalid("Modelo não encontrado");
    await audit(tx as unknown as DB, companyId, actorId, "payable.template_active", { templateId: id, active });
  });
}

export type SeriesInput = { vendorId: string; description: string; installments: unknown; firstDue: string; amount: string; categoryId?: string; costCenterId?: string };

export async function createSeries(db: DB, actorId: string, companyId: string, i: SeriesInput) {
  await requirePerm(db, actorId, companyId, "payables.manage");
  if (!uuidOk(i.vendorId ?? "")) throw new Invalid("Escolha o fornecedor");
  const description = clean(i.description, 160);
  if (description.length < 2) throw new Invalid("Descreva o parcelamento (2 a 160 caracteres)");
  const n = Number(i.installments);
  if (!Number.isInteger(n) || n < 2 || n > 120) throw new Invalid("Quantidade de parcelas: de 2 a 120");
  if (!isIsoDate(i.firstDue ?? "")) throw new Invalid("Primeiro vencimento inválido");
  const cents = parseMoneyToCents(i.amount ?? "");
  if (cents === null || cents <= 0) throw new Invalid("Informe o valor de cada parcela, maior que zero");
  return db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await assertVendor(x, companyId, i.vendorId);
    const cls = await resolveClass(x, companyId, { ...i, description, amount: i.amount, dueDate: i.firstDue });
    const [t] = await x.insert(payableSeries).values({ companyId, vendorId: i.vendorId, description, installments: n, firstDue: i.firstDue, amount: numericFromCents(cents), categoryId: cls.categoryId, costCenterId: cls.costCenterId, createdBy: actorId }).returning({ id: payableSeries.id });
    await audit(x, companyId, actorId, "payable.series_created", { seriesId: t.id, installments: n });
    return t.id;
  });
}

/** Encerrar a série: as parcelas ainda não geradas deixam de existir (as já geradas seguem seu fluxo). */
export async function setSeriesActive(db: DB, actorId: string, companyId: string, id: string, active: boolean) {
  await requirePerm(db, actorId, companyId, "payables.manage");
  if (!uuidOk(id)) throw new Invalid("Parcelamento não encontrado");
  await db.transaction(async (tx) => {
    const r = await tx.update(payableSeries).set({ active, updatedAt: new Date() }).where(and(eq(payableSeries.id, id), eq(payableSeries.companyId, companyId))).returning({ id: payableSeries.id });
    if (!r.length) throw new Invalid("Parcelamento não encontrado");
    await audit(tx as unknown as DB, companyId, actorId, "payable.series_active", { seriesId: id, active });
  });
}

export type TemplateRow = { id: string; vendorId: string; vendorName: string; description: string; amountCents: number; dueDay: number; categoryName: string | null; costCenterName: string | null; startMonth: string; endMonth: string | null; active: boolean; categoryId: string | null; costCenterId: string | null; lastGenerated: string | null };
export async function listTemplates(db: DB, actorId: string, companyId: string): Promise<TemplateRow[]> {
  await requirePerm(db, actorId, companyId, "payables.read");
  const r = rows(await db.execute(sql`select t.id, t.vendor_id, v.legal_name, t.description, t.amount::text, t.due_day, t.category_id, t.cost_center_id, t.start_month::text, t.end_month::text, t.active,
      (select name from expense_categories where company_id = t.company_id and id = t.category_id) category_name, (select name from cost_centers where company_id = t.company_id and id = t.cost_center_id) cc_name,
      (select max(competence)::text from payables where company_id = t.company_id and template_id = t.id) last_generated
    from payable_templates t join vendors v on v.company_id = t.company_id and v.id = t.vendor_id where t.company_id = ${companyId} order by t.active desc, v.legal_name, t.description`));
  return r.map((x) => ({ id: String(x.id), vendorId: String(x.vendor_id), vendorName: String(x.legal_name), description: String(x.description), amountCents: centsFromNumeric(String(x.amount)), dueDay: Number(x.due_day), categoryId: (x.category_id as string | null) ?? null, costCenterId: (x.cost_center_id as string | null) ?? null, categoryName: (x.category_name as string | null) ?? null, costCenterName: (x.cc_name as string | null) ?? null, startMonth: String(x.start_month).slice(0, 7), endMonth: x.end_month ? String(x.end_month).slice(0, 7) : null, active: Boolean(x.active), lastGenerated: x.last_generated ? String(x.last_generated).slice(0, 7) : null }));
}

export type SeriesRow = { id: string; vendorName: string; description: string; installments: number; amountCents: number; firstDue: string; active: boolean; generated: number; paid: number; remaining: number; remainingCents: number; nextDue: string | null; lastDue: string };
/** Progresso por parcela: paga = conta aprovada e quitada; restante = parcelas ainda sem pagamento completo (geradas ou não). Série encerrada não tem restante futuro. */
export async function listSeries(db: DB, actorId: string, companyId: string, _today = todayManaus()): Promise<SeriesRow[]> {
  await requirePerm(db, actorId, companyId, "payables.read");
  const ss = rows(await db.execute(sql`select s.id, v.legal_name, s.description, s.installments, s.amount::text, s.first_due::text, s.active from payable_series s join vendors v on v.company_id = s.company_id and v.id = s.vendor_id where s.company_id = ${companyId} order by s.active desc, s.first_due desc`));
  const ps = rows(await db.execute(sql`select p.series_id, p.installment_no, p.status, p.amount::text, coalesce((select sum(amount) from payable_payments where company_id = p.company_id and payable_id = p.id and status = 'ativo'), 0)::text paid from payables p where p.company_id = ${companyId} and p.series_id is not null`));
  return ss.map((s) => {
    const n = Number(s.installments), amount = centsFromNumeric(String(s.amount)), first = String(s.first_due);
    const sched = seriesSchedule(first, n);
    const mine = ps.filter((p) => p.series_id === s.id);
    const state = new Map<number, { st: "paga" | "gerada" | "encerrada"; openCents: number }>();
    for (const p of mine) {
      const no = Number(p.installment_no), status = String(p.status), amt = centsFromNumeric(String(p.amount)), paidC = centsFromNumeric(String(p.paid));
      state.set(no, status === "cancelado" || status === "rejeitado" ? { st: "encerrada", openCents: 0 } : status === "aprovado" && paidC >= amt ? { st: "paga", openCents: 0 } : { st: "gerada", openCents: status === "aprovado" ? amt - paidC : amt }); // valor REAL da conta (o rascunho pode ter sido ajustado) menos as baixas ativas
    }
    const active = Boolean(s.active);
    const open = sched.map((d, k) => ({ d, k: k + 1 })).filter(({ k }) => state.get(k)?.st !== "paga" && state.get(k)?.st !== "encerrada" && (active || state.get(k)?.st === "gerada"));
    const remainingCents = open.reduce((a, { k }) => a + (state.get(k)?.openCents ?? amount), 0);
    return { id: String(s.id), vendorName: String(s.legal_name), description: String(s.description), installments: n, amountCents: amount, firstDue: first, active, generated: mine.length, paid: [...state.values()].filter((v) => v.st === "paga").length, remaining: open.length, remainingCents, nextDue: open[0]?.d ?? null, lastDue: sched[n - 1] };
  });
}

export type Forecast = { kind: "recorrente" | "parcela"; key: string; refId: string; installmentNo: number | null; vendorName: string; description: string; dueDate: string; amountCents: number };
export type MonthPlan = { month: string; items: PayableRow[]; forecasts: Forecast[]; totals: { itemsCents: number; forecastCents: number; paidCents: number } };

export async function pendingForecasts(db: DB, companyId: string, month: string): Promise<Forecast[]> {
  const m01 = firstOf(month);
  const t = rows(await db.execute(sql`select t.id, v.legal_name, t.description, t.amount::text, t.due_day from payable_templates t join vendors v on v.company_id = t.company_id and v.id = t.vendor_id
    where t.company_id = ${companyId} and t.active and t.start_month <= ${m01}::date and (t.end_month is null or t.end_month >= ${m01}::date)
      and not exists (select 1 from payables p where p.company_id = t.company_id and p.template_id = t.id and p.competence = ${m01}::date) order by v.legal_name, t.description`));
  const out: Forecast[] = t.map((x) => ({ kind: "recorrente", key: `t:${x.id}`, refId: String(x.id), installmentNo: null, vendorName: String(x.legal_name), description: String(x.description), dueDate: dueDateIn(month, Number(x.due_day)), amountCents: centsFromNumeric(String(x.amount)) }));
  const ss = rows(await db.execute(sql`select s.id, v.legal_name, s.description, s.installments, s.amount::text, s.first_due::text from payable_series s join vendors v on v.company_id = s.company_id and v.id = s.vendor_id where s.company_id = ${companyId} and s.active`));
  const made = rows(await db.execute(sql`select series_id, installment_no from payables where company_id = ${companyId} and series_id is not null`));
  for (const s of ss) {
    const n = Number(s.installments);
    seriesSchedule(String(s.first_due), n).forEach((d, k) => {
      if (monthOf(d) !== month || made.some((p) => p.series_id === s.id && Number(p.installment_no) === k + 1)) return;
      out.push({ kind: "parcela", key: `s:${s.id}:${k + 1}`, refId: String(s.id), installmentNo: k + 1, vendorName: String(s.legal_name), description: `${s.description} ${k + 1}/${n}`, dueDate: d, amountCents: centsFromNumeric(String(s.amount)) });
    });
  }
  return out.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.vendorName.localeCompare(b.vendorName) || a.description.localeCompare(b.description));
}

export async function monthPlan(db: DB, actorId: string, companyId: string, month: string, today = todayManaus()): Promise<MonthPlan> {
  await requirePerm(db, actorId, companyId, "payables.read");
  if (!isMonth(month)) throw new Invalid("Mês inválido");
  const [all, forecasts] = await Promise.all([listPayables(db, actorId, companyId, { status: "todas", dueFrom: firstOf(month), dueTo: dueDateIn(month, 31) }, today), pendingForecasts(db, companyId, month)]);
  const items = all.filter((p) => p.status !== "cancelado" && p.status !== "rejeitado");
  return { month, items, forecasts, totals: { itemsCents: items.reduce((a, p) => a + p.amountCents, 0), forecastCents: forecasts.reduce((a, f) => a + f.amountCents, 0), paidCents: items.reduce((a, p) => a + p.paidCents, 0) } };
}

/** Gera os RASCUNHOS do mês (modelos ativos + parcelas que vencem no mês). Idempotente: o que já foi gerado é pulado (contagem devolvida). */
export async function generateMonth(db: DB, actorId: string, companyId: string, month: string) {
  await requirePerm(db, actorId, companyId, "payables.write");
  if (!isMonth(month)) throw new Invalid("Mês inválido");
  const m01 = firstOf(month);
  const result = await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await x.execute(sql`select pg_advisory_xact_lock(hashtext(${"payable-generate:" + companyId + ":" + month}))`);
    const fc = await pendingForecasts(x, companyId, month);
    let created = 0, skipped = 0;
    for (const f of fc) {
      const full = f.kind === "recorrente"
        ? (await x.select().from(payableTemplates).where(and(eq(payableTemplates.id, f.refId), eq(payableTemplates.companyId, companyId))))[0]
        : (await x.select().from(payableSeries).where(and(eq(payableSeries.id, f.refId), eq(payableSeries.companyId, companyId))))[0];
      if (!full) { skipped++; continue; }
      try { await assertVendor(x, companyId, full.vendorId); } catch { skipped++; continue; } // fornecedor inativo: não gera (aparece de novo depois de reativar)
      const base = { companyId, vendorId: full.vendorId, description: f.description, amount: full.amount, dueDate: f.dueDate, categoryId: full.categoryId, costCenterId: full.costCenterId, competence: m01, createdBy: actorId };
      const ins = await x.insert(payables).values(f.kind === "recorrente" ? { ...base, templateId: f.refId } : { ...base, seriesId: f.refId, installmentNo: f.installmentNo }).onConflictDoNothing().returning({ id: payables.id });
      if (ins.length) created++; else skipped++;
    }
    await audit(x, companyId, actorId, "payable.generated", { month, created, skipped });
    return { created, skipped };
  });
  return result;
}

export async function commitments(db: DB, actorId: string, companyId: string, today = todayManaus()) {
  await requirePerm(db, actorId, companyId, "payables.read");
  const [series, templates] = await Promise.all([listSeries(db, actorId, companyId, today), listTemplates(db, actorId, companyId)]);
  const act = series.filter((s) => s.remaining > 0);
  return { installmentsCents: act.reduce((a, s) => a + s.remainingCents, 0), installmentsCount: act.reduce((a, s) => a + s.remaining, 0), seriesCount: act.length, recurringMonthlyCents: templates.filter((t) => t.active && t.startMonth <= today.slice(0, 7) && (!t.endMonth || t.endMonth >= today.slice(0, 7))).reduce((a, t) => a + t.amountCents, 0) };
}
