import { and, eq, ilike, sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { auditLog, expenseApplications, expenseCategories, expenseImportRows, expenseImports, costCenters, partnerEntries, partners, payablePayments, payables, payableSeries, payableTemplates, vendors } from "@/lib/db/schema";
import { centsFromNumeric, numericFromCents } from "@/lib/money";
import { Invalid, requirePerm } from "@/modules/identity/service";
import { todayManaus } from "@/modules/messaging/service";
import { addMonths } from "@/modules/payables/schedule";
import { createSeries, createTemplate } from "@/modules/payables/planning";
import { ensureExpenseDefaults } from "./catalog";
import { recurringCandidates, seriesCandidates, suggest, vendorKeyOf } from "./classify";
import type { ExpenseRow } from "./planilha";

/**
 * D3b — aplica o staging da planilha de despesas ao sistema. Exige autorização escrita do dono (registrada na operação).
 * Regras do dono: tudo o que está na planilha de despesas é gasto REAL; só vale como PAGO quem tem DATA de pagamento. Sem data = pendente de pagamento (em aberto).
 *  - Aba Empresa: com data de pagamento → conta a pagar APROVADA + baixa (valor = o que foi pago; se difere da conta, a diferença vai na observação da baixa, sem criar dívida fantasma).
 *    Sem data → conta APROVADA em aberto (valor da conta). Categoria e centro (K3G 2) pela sugestão do D3.
 *  - Aba Casa: com data de pagamento → RETIRADA na conta-corrente do Keslley (decisão do dono). Sem data: não vira nada (não há "retirada pendente"); fica no relatório.
 *  - Ficam de fora (e o motivo é contado): faturas de cartão (referência), dízimos (a planilha não diz se foi pago), linhas sem valor, data escrita como texto ("19/02").
 * Fornecedor: um cadastro único "Histórico da planilha" (a planilha não tem CNPJ de fornecedor); a descrição original fica na conta.
 * Idempotente: cada linha tem no máximo uma aplicação (índice único). Tudo numa transação: ou entra tudo ou nada.
 */
export type StagedRow = ExpenseRow & { id: string };
export type SkipReason = "cartao" | "dizimo" | "sem_valor" | "data_em_texto" | "casa_sem_data";
export const SKIP_LABEL: Record<SkipReason, string> = { cartao: "Faturas de cartão (só referência)", dizimo: "Dízimos (a planilha não diz se foi pago)", sem_valor: "Linhas sem valor", data_em_texto: "Data de pagamento escrita como texto (\"19/02\")", casa_sem_data: "Casa sem data de pagamento (não há retirada pendente)" };
export type ApplyItem =
  | { kind: "conta_paga"; rowId: string; description: string; month: string; dueOn: string; amountCents: number; paidOn: string; note: string | null; categoryCode: string; k3g2: boolean }
  | { kind: "conta_aberta"; rowId: string; description: string; month: string; dueOn: string; amountCents: number; categoryCode: string; k3g2: boolean }
  | { kind: "retirada"; rowId: string; description: string; month: string; occurredOn: string; amountCents: number; categoryCode: string };
export type ApplyPlan = { items: ApplyItem[]; skipped: Record<SkipReason, { n: number; cents: number }>; callHintCents: number; callHintN: number };

export const HISTORY_VENDOR_DOC = "00000000000000";
export const HISTORY_VENDOR_NAME = "Histórico da planilha (fornecedor a conferir)";
const MIN_RECENT = "2026-09"; // só vira recorrente/parcelamento o que ainda aparecia nos últimos meses

const brl = (c: number) => (c / 100).toFixed(2).replace(".", ",");
const lastDayOf = (month: string) => { const [y, m] = month.split("-").map(Number); return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`; };
const desc2 = (s: string) => (s.length >= 2 ? s : `${s} (planilha)`).slice(0, 200);

/** PURO. Decide o que cada linha vira. `today` impede baixa com data futura (vira conta em aberto). */
export function buildApplyPlan(rows: StagedRow[], today: string): ApplyPlan {
  const items: ApplyItem[] = [];
  const skipped = Object.fromEntries((Object.keys(SKIP_LABEL) as SkipReason[]).map((k) => [k, { n: 0, cents: 0 }])) as ApplyPlan["skipped"];
  let callHintCents = 0, callHintN = 0;
  const skip = (r: StagedRow, why: SkipReason) => { skipped[why].n++; skipped[why].cents += r.paidCents ?? r.amountCents ?? 0; };
  for (const r of rows) {
    if (r.block === "cartao") { skip(r, "cartao"); continue; }
    if (r.block === "dizimo") { skip(r, "dizimo"); continue; }
    const paid = r.paidCents !== null && r.paidCents > 0 ? r.paidCents : null;
    const account = r.amountCents !== null && r.amountCents > 0 ? r.amountCents : null;
    if (paid === null && account === null) { skip(r, "sem_valor"); continue; }
    if (!r.paidOn && r.paidRaw) { skip(r, "data_em_texto"); continue; }
    const s = suggest(r);
    const isPaid = !!r.paidOn && r.paidOn <= today;
    if (r.block === "casa") {
      if (!isPaid) { skip(r, "casa_sem_data"); continue; }
      items.push({ kind: "retirada", rowId: r.id, description: desc2(r.description), month: r.month, occurredOn: r.paidOn!, amountCents: (paid ?? account)!, categoryCode: s.categoryCode });
      continue;
    }
    if (s.companyHint === "call") { callHintN++; callHintCents += (paid ?? account)!; }
    const dueOn = r.dueOn ?? r.paidOn ?? lastDayOf(r.month);
    if (isPaid) {
      const amountCents = (paid ?? account)!;
      const note = account !== null && account !== amountCents ? `Planilha: conta R$ ${brl(account)}, pago R$ ${brl(amountCents)}` : null;
      items.push({ kind: "conta_paga", rowId: r.id, description: desc2(r.description), month: r.month, dueOn, amountCents, paidOn: r.paidOn!, note, categoryCode: s.categoryCode, k3g2: s.centerHint === "k3g2" });
    } else {
      items.push({ kind: "conta_aberta", rowId: r.id, description: desc2(r.description), month: r.month, dueOn, amountCents: (account ?? paid)!, categoryCode: s.categoryCode, k3g2: s.centerHint === "k3g2" });
    }
  }
  return { items, skipped, callHintCents, callHintN };
}

export type ApplySummary = { rows: number; paid: { n: number; cents: number }; open: { n: number; cents: number }; withdrawals: { n: number; cents: number }; skipped: ApplyPlan["skipped"]; callHint: { n: number; cents: number } };
export function summarize(p: ApplyPlan): ApplySummary {
  const pick = (k: ApplyItem["kind"]) => { const l = p.items.filter((i) => i.kind === k); return { n: l.length, cents: l.reduce((a, i) => a + i.amountCents, 0) }; };
  return { rows: p.items.length, paid: pick("conta_paga"), open: pick("conta_aberta"), withdrawals: pick("retirada"), skipped: p.skipped, callHint: { n: p.callHintN, cents: p.callHintCents } };
}

const audit = (x: DB, companyId: string, actorId: string, action: string, detail: Record<string, unknown>) => x.insert(auditLog).values({ companyId, actorId, action, detail });

async function perms(db: DB, actorId: string, companyId: string) {
  for (const p of ["history.import", "partners.manage", "payables.manage", "payables.pay"] as const) await requirePerm(db, actorId, companyId, p);
}

/** Linhas da importação atual ainda sem aplicação, mais todas as linhas (para recorrências). */
async function loadCurrent(x: DB, companyId: string) {
  const [imp] = await x.select({ id: expenseImports.id }).from(expenseImports).where(eq(expenseImports.companyId, companyId)).orderBy(sql`${expenseImports.createdAt} desc`).limit(1);
  if (!imp) throw new Invalid("Nenhuma planilha de despesas importada para esta empresa");
  const raw = await x.select().from(expenseImportRows).where(and(eq(expenseImportRows.companyId, companyId), eq(expenseImportRows.importId, imp.id))).orderBy(expenseImportRows.month, expenseImportRows.rowNumber);
  const done = new Set((await x.select({ rowId: expenseApplications.rowId }).from(expenseApplications).where(eq(expenseApplications.companyId, companyId))).map((a) => a.rowId));
  const c = (v: string | null) => (v === null ? null : centsFromNumeric(v));
  const all: StagedRow[] = raw.map((r) => ({ id: r.id, sheet: r.sheet, row: r.rowNumber, month: r.month, block: r.block as ExpenseRow["block"], description: r.description, dueOn: r.dueOn, amountCents: c(r.amount), paidCents: c(r.paidAmount), paidOn: r.paidOn, paidRaw: r.paidRaw, installmentNo: r.installmentNo, installmentsTotal: r.installmentsTotal }));
  return { importId: imp.id, all, pending: all.filter((r) => !done.has(r.id)), appliedRows: done.size };
}

/** Prévia: nada é gravado. */
export async function previewExpenseApplication(db: DB, actorId: string, companyId: string, today = todayManaus()) {
  await perms(db, actorId, companyId);
  const cur = await loadCurrent(db, companyId);
  return { ...summarize(buildApplyPlan(cur.pending, today)), alreadyApplied: cur.appliedRows };
}

/** Situação para a tela (leitura): quanto já foi aplicado. */
export async function applicationStatus(db: DB, actorId: string, companyId: string) {
  await requirePerm(db, actorId, companyId, "partners.read");
  const r = (await db.execute(sql`select a.kind, count(*)::int n from expense_applications a join expense_import_rows r on r.id = a.row_id and r.company_id = a.company_id
    where a.company_id = ${companyId} and r.import_id = (select id from expense_imports where company_id = ${companyId} order by created_at desc limit 1) group by a.kind`)) as unknown as { kind: string; n: number }[];
  const get = (k: string) => r.find((x) => x.kind === k)?.n ?? 0;
  return { paid: get("conta_paga"), open: get("conta_aberta"), withdrawals: get("retirada"), total: get("conta_paga") + get("conta_aberta") + get("retirada") };
}

async function historyVendor(x: DB, companyId: string, actorId: string): Promise<string> {
  const [v] = await x.select({ id: vendors.id }).from(vendors).where(and(eq(vendors.companyId, companyId), eq(vendors.document, HISTORY_VENDOR_DOC), sql`${vendors.archivedAt} is null`));
  if (v) return v.id;
  const [n] = await x.insert(vendors).values({ companyId, legalName: HISTORY_VENDOR_NAME, docType: "cnpj", document: HISTORY_VENDOR_DOC, status: "ativo", createdBy: actorId, source: "manual" }).returning({ id: vendors.id });
  return n.id;
}

export async function applyExpenseHistory(db: DB, actorId: string, companyId: string, today = todayManaus()): Promise<ApplySummary & { applied: number }> {
  await perms(db, actorId, companyId);
  return db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await x.execute(sql`select pg_advisory_xact_lock(hashtext(${"expense-apply:" + companyId}))`);
    await ensureExpenseDefaults(x, companyId);
    const cur = await loadCurrent(x, companyId);
    const plan = buildApplyPlan(cur.pending, today);
    if (plan.items.length === 0) return { ...summarize(plan), applied: 0 };
    const keslley = await x.select({ id: partners.id }).from(partners).where(and(eq(partners.companyId, companyId), eq(partners.active, true), ilike(partners.name, "Keslley%")));
    if (plan.items.some((i) => i.kind === "retirada") && keslley.length !== 1) throw new Invalid("Cadastre o sócio Keslley (um único cadastro ativo) antes de aplicar as retiradas da Casa");
    const cats = await x.select({ id: expenseCategories.id, code: expenseCategories.code, kind: expenseCategories.kind }).from(expenseCategories).where(eq(expenseCategories.companyId, companyId));
    const byCode = new Map(cats.map((c) => [c.code, c]));
    const catFor = (code: string, kind: "empresa" | "pessoal") => { const c = byCode.get(code); return (c && c.kind === kind ? c : byCode.get(kind === "empresa" ? "a_classificar" : "a_classificar_pessoal"))?.id ?? null; };
    const [k3g2] = await x.select({ id: costCenters.id }).from(costCenters).where(and(eq(costCenters.companyId, companyId), eq(costCenters.active, true), ilike(costCenters.name, "K3G 2%")));
    const vendorId = await historyVendor(x, companyId, actorId);
    const now = new Date();
    for (const it of plan.items) {
      if (it.kind === "retirada") {
        const [e] = await x.insert(partnerEntries).values({ companyId, partnerId: keslley[0].id, kind: "retirada", amount: numericFromCents(it.amountCents), occurredOn: it.occurredOn, categoryId: catFor(it.categoryCode, "pessoal"), description: it.description, requestKey: `d3b:${it.rowId}`, createdBy: actorId }).returning({ id: partnerEntries.id });
        await x.insert(expenseApplications).values({ companyId, rowId: it.rowId, kind: "retirada", entryId: e.id, appliedBy: actorId });
        continue;
      }
      const [p] = await x.insert(payables).values({
        companyId, vendorId, description: it.description, amount: numericFromCents(it.amountCents), dueDate: it.dueOn, categoryId: catFor(it.categoryCode, "empresa"), costCenterId: it.k3g2 ? (k3g2?.id ?? null) : null,
        competence: `${it.month}-01`, status: "aprovado", createdBy: actorId, submittedAt: now, decidedBy: actorId, decidedAt: now, decisionNote: "Histórico da planilha de despesas (aplicado com autorização do dono)",
      }).returning({ id: payables.id });
      if (it.kind === "conta_paga") {
        const [pay] = await x.insert(payablePayments).values({ companyId, payableId: p.id, amount: numericFromCents(it.amountCents), paidAt: it.paidOn, method: "outro", reference: "planilha", note: it.note, requestKey: `d3b:${it.rowId}`, registeredBy: actorId }).returning({ id: payablePayments.id });
        await x.insert(expenseApplications).values({ companyId, rowId: it.rowId, kind: "conta_paga", payableId: p.id, paymentId: pay.id, appliedBy: actorId });
      } else {
        await x.insert(expenseApplications).values({ companyId, rowId: it.rowId, kind: "conta_aberta", payableId: p.id, appliedBy: actorId });
      }
    }
    const sum = summarize(plan);
    await audit(x, companyId, actorId, "expenses.history_applied", { importId: cur.importId, paid: sum.paid.n, open: sum.open.n, withdrawals: sum.withdrawals.n });
    return { ...sum, applied: plan.items.length };
  });
}

const EXCLUDED_RECURRING = new Set(["cartao_pj", "a_classificar", "comissoes"]); // fatura variável; sem classe; comissão já é calculada pelos contratos (D4)
const stripInstallment = (s: string) => s.replace(/\s*\d{1,3}\s*\/\s*\d{1,3}\s*$/, "").replace(/\s*\d{1,3}\s*[ºO°]\s*$/, "").trim();
const clampDay = (month: string, day: number) => Math.min(day, Number(lastDayOf(month).slice(8, 10)));

export type RecurringSummary = { templates: number; series: number; skippedSeries: number };
/** Cria modelos recorrentes e parcelamentos ATIVOS a partir do que a planilha ainda mostra nos últimos meses. Não duplica (descrição igual). Só gera contas quando alguém usa "Gerar o mês". */
export async function proposeRecurring(db: DB, actorId: string, companyId: string, today = todayManaus()): Promise<RecurringSummary> {
  await perms(db, actorId, companyId);
  const cur = await loadCurrent(db, companyId);
  return db.transaction(async (tx) => { // tudo ou nada: falha no meio não deixa metade criada
  const x = tx as unknown as DB;
  const emp = cur.all.filter((r) => r.block === "empresa");
  const series = seriesCandidates(emp).filter((s) => s.block === "empresa" && s.total !== null && s.lastMonth >= MIN_RECENT);
  const recurring = recurringCandidates(emp).filter((c) => c.block === "empresa" && c.lastMonth >= MIN_RECENT && !EXCLUDED_RECURRING.has(c.categoryCode));
  const inSeries = new Set(series.map((s) => s.vendorKey));
  await ensureExpenseDefaults(x, companyId);
  const cats = new Map((await x.select({ id: expenseCategories.id, code: expenseCategories.code, kind: expenseCategories.kind }).from(expenseCategories).where(eq(expenseCategories.companyId, companyId))).map((c) => [c.code, c]));
  const catId = (code: string) => { const c = cats.get(code); return c && c.kind === "empresa" ? c.id : cats.get("a_classificar")?.id; };
  const [k3g2] = await x.select({ id: costCenters.id }).from(costCenters).where(and(eq(costCenters.companyId, companyId), eq(costCenters.active, true), ilike(costCenters.name, "K3G 2%")));
  const vendorId = await historyVendor(x, companyId, actorId);
  const haveT = new Set((await x.select({ d: payableTemplates.description }).from(payableTemplates).where(eq(payableTemplates.companyId, companyId))).map((t) => t.d));
  const haveS = new Set((await x.select({ d: payableSeries.description }).from(payableSeries).where(eq(payableSeries.companyId, companyId))).map((t) => t.d));
  const out: RecurringSummary = { templates: 0, series: 0, skippedSeries: 0 };
  const startMonth = addMonths(today.slice(0, 7), 1);
  for (const s of series) {
    if (s.remaining === null || s.remaining < 2 || s.installmentCents <= 0) { out.skippedSeries++; continue; }
    const name = `${stripInstallment(s.sample)} (restantes após ${s.lastNo}/${s.total})`.slice(0, 160);
    if (haveS.has(name)) continue;
    const lastRow = [...emp].reverse().find((r) => vendorKeyOf(r.description) === s.vendorKey && r.month === s.lastMonth && r.dueOn);
    const month = addMonths(s.lastMonth, 1);
    const day = lastRow?.dueOn ? Number(lastRow.dueOn.slice(8, 10)) : 10;
    const sg = suggest({ block: "empresa", description: s.sample });
    await createSeries(x, actorId, companyId, { vendorId, description: name, installments: s.remaining, firstDue: `${month}-${String(clampDay(month, day)).padStart(2, "0")}`, amount: (s.installmentCents / 100).toFixed(2).replace(".", ","), categoryId: catId(sg.categoryCode), costCenterId: sg.centerHint === "k3g2" ? k3g2?.id : undefined });
    haveS.add(name); out.series++;
  }
  for (const c of recurring) {
    if (inSeries.has(c.vendorKey)) continue;
    const name = stripInstallment(c.sample).slice(0, 200);
    if (name.length < 2 || haveT.has(name)) continue;
    const sg = suggest({ block: "empresa", description: c.sample });
    await createTemplate(x, actorId, companyId, { vendorId, description: name, amount: (c.typicalCents / 100).toFixed(2).replace(".", ","), dueDay: c.typicalDay ?? 10, categoryId: catId(c.categoryCode), costCenterId: sg.centerHint === "k3g2" ? k3g2?.id : undefined, startMonth });
    haveT.add(name); out.templates++;
  }
  await audit(x, companyId, actorId, "expenses.recurring_proposed", { ...out });
  return out;
  });
}
