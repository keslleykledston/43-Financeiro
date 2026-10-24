import { and, desc, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { DB } from "@/lib/db";
import { auditLog, customers, legacyBillingRows, legacyImports, users } from "@/lib/db/schema";
import { centsFromNumeric, numericFromCents } from "@/lib/money";
import { toCsv } from "@/lib/csv";
import { formatDocument, parseDocument } from "@/lib/validators/document";
import { Invalid, requirePerm } from "@/modules/identity/service";
import type { Entry } from "@/modules/contracts/planilha";
import { analyze, DIV_LABEL, DIV_SEVERITY, type Report, type StageRow } from "./analysis";
import { sql } from "drizzle-orm";

const pgCode = (e: unknown) => (e as { code?: string })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;

/**
 * H1 — staging do histórico da planilha. NÃO cria cobrança, pagamento, contrato nem cliente: só guarda cada linha como veio (imutável) e mede divergências.
 * Importar exige `history.import` (diretoria); ler, `history.read`. Idempotente por (empresa, hash do arquivo): o mesmo arquivo não entra duas vezes.
 */
const audit = (x: DB, companyId: string, actorId: string, action: string, detail: Record<string, unknown>) => x.insert(auditLog).values({ companyId, actorId, action, detail });
export const sha256 = (buf: Buffer | string) => createHash("sha256").update(buf).digest("hex");
const MAX_ROWS = 5000;

export type ImportInput = { fileSha256: string; fileLabel: string; year: number; entries: Entry[] };

/** Chamado pelo script de operação (ator = usuário da diretoria). `entries` já vêm filtradas para o bloco desta empresa. */
export async function importLegacy(db: DB, actorId: string, companyId: string, input: ImportInput) {
  await requirePerm(db, actorId, companyId, "history.import");
  if (!/^[0-9a-f]{64}$/.test(input.fileSha256)) throw new Invalid("Hash do arquivo inválido");
  if (input.entries.length === 0) throw new Invalid("Nenhuma linha para importar");
  if (input.entries.length > MAX_ROWS) throw new Invalid(`Mais de ${MAX_ROWS} linhas: recusado`);
  const label = input.fileLabel.replace(/[^\w.\- ]/g, "").slice(0, 80) || "planilha";
  const run = () => db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    const [dup] = await x.select({ id: legacyImports.id }).from(legacyImports).where(and(eq(legacyImports.companyId, companyId), eq(legacyImports.fileSha256, input.fileSha256)));
    if (dup) return { importId: dup.id, rows: 0, already: true as const, linked: 0 };
    const known = await x.select({ id: customers.id, document: customers.document }).from(customers).where(eq(customers.companyId, companyId));
    const byDoc = new Map(known.map((c) => [c.document, c.id]));
    const [imp] = await x.insert(legacyImports).values({ companyId, fileSha256: input.fileSha256, fileLabel: label, year: input.year, rowCount: input.entries.length, createdBy: actorId }).returning({ id: legacyImports.id });
    let linked = 0;
    const values = input.entries.map((e) => {
      const doc = parseDocument(e.documentRaw)?.digits ?? null;
      const customerId = doc ? byDoc.get(doc) ?? null : null;
      if (customerId) linked++;
      const n = (c: number | null) => (c === null ? null : numericFromCents(c));
      const amount = e.block === "solutions" ? e.grossCents ?? 0 : (e.planoCents ?? 0) + (e.excedenteCents ?? 0); // regra do bloco: Solutions = bruto; Call = plano + excedente
      return { companyId, importId: imp.id, sheet: e.sheet.slice(0, 60), rowNumber: e.row, month: e.month, customerName: e.name.slice(0, 200), documentRaw: e.documentRaw.slice(0, 40), document: doc, customerId, block: e.block, amount: numericFromCents(amount), service: e.service ? e.service.slice(0, 200) : null,
        observation: e.obs ? e.obs.slice(0, 200) : null, grossAmount: n(e.grossCents), planAmount: n(e.planoCents), excessAmount: n(e.excedenteCents), netAmount: n(e.netCents), dueOn: e.dueOn, paidOn: e.paidOn };
    });
    for (let i = 0; i < values.length; i += 500) await x.insert(legacyBillingRows).values(values.slice(i, i + 500));
    await audit(x, companyId, actorId, "history.imported", { importId: imp.id, rows: values.length, linked });
    return { importId: imp.id, rows: values.length, already: false as const, linked };
  });
  try { return await run(); }
  catch (e) { // duas importações do MESMO arquivo ao mesmo tempo: a segunda bate no UNIQUE e deve responder "já importado", não falhar
    if (pgCode(e) !== "23505") throw e;
    const [dup] = await db.select({ id: legacyImports.id }).from(legacyImports).where(and(eq(legacyImports.companyId, companyId), eq(legacyImports.fileSha256, input.fileSha256)));
    if (!dup) throw e;
    return { importId: dup.id, rows: 0, already: true as const, linked: 0 };
  }
}

export async function removeLegacyImport(db: DB, actorId: string, companyId: string, importId: string) {
  await requirePerm(db, actorId, companyId, "history.import");
  if (!/^[0-9a-f-]{36}$/i.test(importId)) throw new Invalid("Importação inválida");
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await x.execute(sql`select set_config('k3g.allow_legacy_delete', 'on', true)`); // só nesta transação: o trigger libera o DELETE do fluxo auditado
    const gone = await x.delete(legacyImports).where(and(eq(legacyImports.id, importId), eq(legacyImports.companyId, companyId))).returning({ rows: legacyImports.rowCount });
    if (!gone.length) throw new Invalid("Importação não encontrada nesta empresa");
    await audit(x, companyId, actorId, "history.import_removed", { importId, rows: gone[0].rows });
  });
}

/** A importação mais recente da empresa (relatórios usam só ela) e o histórico de importações. */
async function load(db: DB, companyId: string) {
  const imps = await db.select({ id: legacyImports.id, label: legacyImports.fileLabel, year: legacyImports.year, rows: legacyImports.rowCount, at: legacyImports.createdAt, sha: legacyImports.fileSha256, by: users.name })
    .from(legacyImports).innerJoin(users, eq(users.id, legacyImports.createdBy)).where(eq(legacyImports.companyId, companyId)).orderBy(desc(legacyImports.createdAt));
  const current = imps[0] ?? null;
  if (!current) return { imps, current, rows: [] as StageRow[] };
  const raw = await db.select().from(legacyBillingRows).where(and(eq(legacyBillingRows.companyId, companyId), eq(legacyBillingRows.importId, current.id)));
  const c = (v: string | null) => (v === null ? null : centsFromNumeric(v));
  return { imps, current, rows: raw.map((r): StageRow => ({ sheet: r.sheet, row: r.rowNumber, month: r.month, name: r.customerName, documentRaw: r.documentRaw, document: r.document, amountCents: centsFromNumeric(r.amount), netCents: c(r.netAmount), dueOn: r.dueOn, paidOn: r.paidOn })) };
}

export async function getHistoryReport(db: DB, actorId: string, companyId: string, today: string): Promise<{ imports: Awaited<ReturnType<typeof load>>["imps"]; current: Awaited<ReturnType<typeof load>>["current"]; report: Report | null }> {
  await requirePerm(db, actorId, companyId, "history.read");
  const { imps, current, rows } = await load(db, companyId);
  if (!current) return { imports: imps, current, report: null };
  const docs = await db.select({ d: customers.document }).from(customers).where(eq(customers.companyId, companyId));
  return { imports: imps, current, report: analyze(rows, new Set(docs.map((d) => d.d)), today) };
}

export async function exportDivergencesCsv(db: DB, actorId: string, companyId: string, today: string): Promise<string> {
  await requirePerm(db, actorId, companyId, "history.read");
  const { report } = await getHistoryReport(db, actorId, companyId, today);
  const head = ["tipo", "gravidade", "aba", "linha", "mes_da_aba", "cliente", "documento", "detalhe"];
  const rows = (report?.divergences ?? []).map((d) => {
    const doc = d.document && /^[0-9A-Z]{14}$/i.test(d.document) ? formatDocument("cnpj", d.document.toUpperCase()) : d.document ?? "";
    return [DIV_LABEL[d.kind], DIV_SEVERITY[d.kind], d.sheet, String(d.row), d.month, d.name, doc, d.detail];
  });
  return toCsv([head, ...rows]);
}
