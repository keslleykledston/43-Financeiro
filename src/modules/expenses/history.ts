import { and, desc, eq, sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { auditLog, expenseImportRows, expenseImports, users } from "@/lib/db/schema";
import { toCsv } from "@/lib/csv";
import { centsFromNumeric, numericFromCents } from "@/lib/money";
import { Invalid, requirePerm } from "@/modules/identity/service";
import { sha256 } from "@/modules/history/service";
import type { ExpenseRow } from "./planilha";
import { DIV_LABEL, DIV_SEVERITY, analyzeExpenses, type ExpenseReport } from "./report";
import { suggest } from "./classify";

/**
 * D3 — staging do histórico de DESPESAS. NÃO cria conta a pagar, sócio, lançamento, fornecedor nem categoria: guarda cada linha como veio (imutável) e mede.
 * Importar: `history.import` (diretoria). Ler: `partners.read` (diretoria): a aba "Casa" tem gasto pessoal dos sócios. Idempotente por (empresa, hash do arquivo).
 */
export { sha256 };
const audit = (x: DB, companyId: string, actorId: string, action: string, detail: Record<string, unknown>) => x.insert(auditLog).values({ companyId, actorId, action, detail });
const MAX_ROWS = 5000;
const pgCode = (e: unknown) => (e as { code?: string })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;

export type ImportInput = { fileSha256: string; fileLabel: string; year: number; rows: ExpenseRow[]; /** troca as importações anteriores da empresa NA MESMA transação: se a nova falhar, a antiga continua */ replace?: boolean };

export async function importExpenses(db: DB, actorId: string, companyId: string, input: ImportInput) {
  await requirePerm(db, actorId, companyId, "history.import");
  await requirePerm(db, actorId, companyId, "partners.read");
  if (!/^[0-9a-f]{64}$/.test(input.fileSha256)) throw new Invalid("Hash do arquivo inválido");
  if (input.rows.length === 0) throw new Invalid("Nenhuma linha para importar");
  if (input.rows.length > MAX_ROWS) throw new Invalid(`Mais de ${MAX_ROWS} linhas: recusado`);
  const label = input.fileLabel.replace(/[^\w.\- ]/g, "").slice(0, 80) || "planilha";
  const run = () => db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    const [dup] = await x.select({ id: expenseImports.id }).from(expenseImports).where(and(eq(expenseImports.companyId, companyId), eq(expenseImports.fileSha256, input.fileSha256)));
    if (dup) return { importId: dup.id, rows: 0, already: true as const };
    if (input.replace) { // só chega aqui se o arquivo é NOVO (o mesmo hash já respondeu "já importado" acima, sem apagar nada)
      await x.execute(sql`select set_config('k3g.allow_expense_import_delete', 'on', true)`);
      const gone = await x.delete(expenseImports).where(eq(expenseImports.companyId, companyId)).returning({ id: expenseImports.id, rows: expenseImports.rowCount });
      for (const g of gone) await audit(x, companyId, actorId, "expenses.history_removed", { importId: g.id, rows: g.rows, replaced: true });
    }
    const [imp] = await x.insert(expenseImports).values({ companyId, fileSha256: input.fileSha256, fileLabel: label, year: input.year, rowCount: input.rows.length, createdBy: actorId }).returning({ id: expenseImports.id });
    const n = (c: number | null) => (c === null ? null : numericFromCents(c));
    const values = input.rows.map((r) => ({ companyId, importId: imp.id, sheet: r.sheet.slice(0, 60), rowNumber: r.row, month: r.month, block: r.block, description: r.description.slice(0, 200), dueOn: r.dueOn, amount: n(r.amountCents), paidAmount: n(r.paidCents), paidOn: r.paidOn, paidRaw: r.paidRaw, installmentNo: r.installmentNo, installmentsTotal: r.installmentsTotal }));
    for (let i = 0; i < values.length; i += 500) await x.insert(expenseImportRows).values(values.slice(i, i + 500));
    await audit(x, companyId, actorId, "expenses.history_imported", { importId: imp.id, rows: values.length });
    return { importId: imp.id, rows: values.length, already: false as const };
  });
  try { return await run(); }
  catch (e) { // duas importações do MESMO arquivo ao mesmo tempo: a segunda responde "já importado"
    const cause = (e as { cause?: { constraint_name?: string } }).cause;
    if (pgCode(e) === "23514" || (pgCode(e) === "23505" && cause?.constraint_name !== "expense_imports_file_uq")) throw new Invalid(`Uma linha foi recusada pelo banco (${cause?.constraint_name ?? "regra de integridade"}); nada foi gravado e a importação anterior foi mantida`);
    if (pgCode(e) !== "23505") throw e;
    const [dup] = await db.select({ id: expenseImports.id }).from(expenseImports).where(and(eq(expenseImports.companyId, companyId), eq(expenseImports.fileSha256, input.fileSha256)));
    if (!dup) throw e;
    return { importId: dup.id, rows: 0, already: true as const };
  }
}

export async function removeExpenseImport(db: DB, actorId: string, companyId: string, importId: string) {
  await requirePerm(db, actorId, companyId, "history.import");
  if (!/^[0-9a-f-]{36}$/i.test(importId)) throw new Invalid("Importação inválida");
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await x.execute(sql`select set_config('k3g.allow_expense_import_delete', 'on', true)`); // só nesta transação: o gatilho libera o DELETE do fluxo auditado
    const gone = await x.delete(expenseImports).where(and(eq(expenseImports.id, importId), eq(expenseImports.companyId, companyId))).returning({ rows: expenseImports.rowCount });
    if (!gone.length) throw new Invalid("Importação não encontrada nesta empresa");
    await audit(x, companyId, actorId, "expenses.history_removed", { importId, rows: gone[0].rows });
  });
}

async function loadRows(db: DB, companyId: string) {
  const imps = await db.select({ id: expenseImports.id, label: expenseImports.fileLabel, year: expenseImports.year, rows: expenseImports.rowCount, at: expenseImports.createdAt, sha: expenseImports.fileSha256, by: users.name })
    .from(expenseImports).innerJoin(users, eq(users.id, expenseImports.createdBy)).where(eq(expenseImports.companyId, companyId)).orderBy(desc(expenseImports.createdAt));
  const current = imps[0] ?? null;
  if (!current) return { imps, current, rows: [] as ExpenseRow[] };
  const raw = await db.select().from(expenseImportRows).where(and(eq(expenseImportRows.companyId, companyId), eq(expenseImportRows.importId, current.id))).orderBy(expenseImportRows.month, expenseImportRows.rowNumber);
  const c = (v: string | null) => (v === null ? null : centsFromNumeric(v));
  return { imps, current, rows: raw.map((r): ExpenseRow => ({ sheet: r.sheet, row: r.rowNumber, month: r.month, block: r.block as ExpenseRow["block"], description: r.description, dueOn: r.dueOn, amountCents: c(r.amount), paidCents: c(r.paidAmount), paidOn: r.paidOn, paidRaw: r.paidRaw, installmentNo: r.installmentNo, installmentsTotal: r.installmentsTotal })) };
}

export async function getExpenseReport(db: DB, actorId: string, companyId: string): Promise<{ imports: Awaited<ReturnType<typeof loadRows>>["imps"]; current: Awaited<ReturnType<typeof loadRows>>["current"]; report: ExpenseReport | null }> {
  await requirePerm(db, actorId, companyId, "partners.read");
  const { imps, current, rows } = await loadRows(db, companyId);
  return { imports: imps, current, report: current ? analyzeExpenses(rows) : null };
}

export async function exportExpenseCsv(db: DB, actorId: string, companyId: string, what: "divergencias" | "classificacao"): Promise<string> {
  await requirePerm(db, actorId, companyId, "partners.read");
  const { rows } = await loadRows(db, companyId);
  const money = (c: number | null) => (c === null ? "" : (c / 100).toFixed(2).replace(".", ","));
  if (what === "divergencias") {
    const rep = analyzeExpenses(rows);
    await audit(db, companyId, actorId, "expenses.history_exported", { what, count: rep.divergences.length });
    return toCsv([["tipo", "gravidade", "aba", "linha", "bloco", "descricao", "detalhe"], ...rep.divergences.map((d) => [DIV_LABEL[d.kind], DIV_SEVERITY[d.kind], d.sheet, String(d.row), d.block, d.description, d.detail])]);
  }
  const money2 = rows.filter((r) => r.block === "empresa" || r.block === "casa" || r.block === "dizimo");
  await audit(db, companyId, actorId, "expenses.history_exported", { what, count: money2.length });
  return toCsv([["aba", "linha", "bloco", "descricao", "vencimento", "valor", "pago", "pago_em", "categoria_sugerida", "natureza_sugerida", "empresa_sugerida", "centro_sugerido", "aviso"],
    ...money2.map((r) => { const s = suggest(r); return [r.sheet, String(r.row), r.block, r.description, r.dueOn ?? "", money(r.amountCents), money(r.paidCents), r.paidOn ?? r.paidRaw ?? "", s.categoryCode, s.nature, s.companyHint ?? "", s.centerHint ?? "", s.ambiguous ?? ""]; })]);
}
