import { and, desc, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { DB } from "@/lib/db";
import { auditLog, customers, legacyBillingRows, legacyDocumentFixes, legacyImports, users } from "@/lib/db/schema";
import { centsFromNumeric, numericFromCents } from "@/lib/money";
import { toCsv } from "@/lib/csv";
import { checkDocument, formatDocument, parseDocument } from "@/lib/validators/document";
import { Invalid, requirePerm } from "@/modules/identity/service";
import type { Entry } from "@/modules/contracts/planilha";
import { analyze, DIV_LABEL, DIV_SEVERITY, nameKeyOf, type Report, type StageRow } from "./analysis";
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
        observation: e.obs ? e.obs.slice(0, 200) : null, grossAmount: n(e.grossCents), planAmount: n(e.planoCents), excessAmount: n(e.excedenteCents), netAmount: n(e.netCents), dueOn: e.dueOn, paidOn: e.paidOn, paidRaw: e.paidRaw };
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
  if (!current) return { imps, current, rows: [] as StageRow[], fixRows: [] as (typeof legacyDocumentFixes.$inferSelect)[] };
  const raw = await db.select().from(legacyBillingRows).where(and(eq(legacyBillingRows.companyId, companyId), eq(legacyBillingRows.importId, current.id)));
  const c = (v: string | null) => (v === null ? null : centsFromNumeric(v));
  const fixRows = await db.select().from(legacyDocumentFixes).where(eq(legacyDocumentFixes.companyId, companyId));
  const fixBy = new Map(fixRows.map((f) => [f.nameKey, f.document]));
  return { imps, current, fixRows, rows: raw.map((r): StageRow => { const fx = fixBy.get(nameKeyOf(r.customerName)); // a correção só vale onde o documento falta ou não confere: nunca sobrescreve documento válido de outra linha (nomes parecidos)
    const docFixed = !!fx && r.document === null; return ({ docFixed,  sheet: r.sheet, row: r.rowNumber, month: r.month, name: r.customerName, documentRaw: r.documentRaw, document: docFixed ? fx! : r.document, amountCents: centsFromNumeric(r.amount), netCents: c(r.netAmount), dueOn: r.dueOn, paidOn: r.paidOn, paidRaw: r.paidRaw }); }) };
}

export type FixView = { id: string; name: string; formatted: string; note: string | null; at: Date };
export async function getHistoryReport(db: DB, actorId: string, companyId: string, today: string): Promise<{ imports: Awaited<ReturnType<typeof load>>["imps"]; current: Awaited<ReturnType<typeof load>>["current"]; report: Report | null; fixes: FixView[] }> {
  await requirePerm(db, actorId, companyId, "history.read");
  const { imps, current, rows, fixRows } = await load(db, companyId);
  if (!current) return { imports: imps, current, report: null, fixes: [] as FixView[] };
  const docs = await db.select({ d: customers.document, n: customers.legalName, t: customers.tradeName }).from(customers).where(eq(customers.companyId, companyId));
  const registry = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const d of docs) for (const nm of [d.n, d.t]) { if (!nm) continue; const k = nameKeyOf(nm); if (registry.has(k) && registry.get(k) !== d.d) ambiguous.add(k); registry.set(k, d.d); }
  for (const k of ambiguous) registry.delete(k); // dois cadastros com o mesmo nome e documentos diferentes: não sugere (ambíguo)
  const fixes: FixView[] = fixRows.map((f) => ({ id: f.id, name: f.customerName, formatted: formatDocument(f.document.length === 11 ? "cpf" : "cnpj", f.document), note: f.note, at: f.updatedAt }));
  return { imports: imps, current, report: analyze(rows, new Set(docs.map((d) => d.d)), today, registry), fixes };
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

/** Registra (ou troca) o CNPJ/CPF correto de um cliente do histórico. Valida os dígitos; o nome precisa existir na importação atual; o staging NÃO muda. */
/** `expected`: documento que a pessoa viu como atual (vazio = ainda sem correção). Se mudou no meio, recusa em vez de sobrescrever em silêncio. */
export async function saveDocumentFix(db: DB, actorId: string, companyId: string, input: { name: string; document: string; note?: string; expected?: string | null }) {
  await requirePerm(db, actorId, companyId, "history.fix");
  const key = nameKeyOf(String(input.name ?? ""));
  if (!key) throw new Invalid("Cliente inválido");
  const c = checkDocument(String(input.document ?? ""));
  if (c.state === "vazio") throw new Invalid("Informe o CNPJ ou CPF correto");
  if (c.state === "incompleto") throw new Invalid("CNPJ/CPF incompleto: o CPF tem 11 dígitos e o CNPJ tem 14");
  if (c.state === "invalido") throw new Invalid(`${c.message}${c.suggestions.length ? `. Será que é ${c.suggestions.map((s) => s.formatted).join(" ou ")}?` : ""}`);
  const note = String(input.note ?? "").replace(/\s+/g, " ").trim().slice(0, 200) || null;
  return db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    const { current } = await load(x, companyId);
    if (!current) throw new Invalid("Não há histórico importado");
    const names = await x.selectDistinct({ n: legacyBillingRows.customerName }).from(legacyBillingRows).where(and(eq(legacyBillingRows.companyId, companyId), eq(legacyBillingRows.importId, current.id)));
    const shown = names.find((r) => nameKeyOf(r.n) === key)?.n;
    if (!shown) throw new Invalid("Cliente não encontrado no histórico importado");
    await x.execute(sql`select pg_advisory_xact_lock(hashtext(${"history-fix:" + companyId}))`); // duas correções do mesmo cliente não se cruzam
    const [prev] = await x.select({ id: legacyDocumentFixes.id, document: legacyDocumentFixes.document }).from(legacyDocumentFixes).where(and(eq(legacyDocumentFixes.companyId, companyId), eq(legacyDocumentFixes.nameKey, key)));
    if (input.expected !== undefined && (prev?.document ?? "") !== (input.expected ?? "")) throw new Invalid("Outra pessoa acabou de corrigir este cliente. Recarregue a página para ver a correção atual");
    const [f] = await x.insert(legacyDocumentFixes).values({ companyId, nameKey: key, customerName: shown.slice(0, 200), document: c.digits, note, fixedBy: actorId })
      .onConflictDoUpdate({ target: [legacyDocumentFixes.companyId, legacyDocumentFixes.nameKey], set: { document: c.digits, note, fixedBy: actorId, updatedAt: new Date() } }).returning({ id: legacyDocumentFixes.id });
    await audit(x, companyId, actorId, "history.fix_saved", { fixId: f.id, replaced: !!prev });
    return { id: f.id, formatted: c.formatted };
  });
}

export async function removeDocumentFix(db: DB, actorId: string, companyId: string, fixId: string) {
  await requirePerm(db, actorId, companyId, "history.fix");
  if (!/^[0-9a-f-]{36}$/i.test(fixId)) throw new Invalid("Correção inválida");
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    const gone = await x.delete(legacyDocumentFixes).where(and(eq(legacyDocumentFixes.id, fixId), eq(legacyDocumentFixes.companyId, companyId))).returning({ id: legacyDocumentFixes.id });
    if (!gone.length) throw new Invalid("Correção não encontrada nesta empresa");
    await audit(x, companyId, actorId, "history.fix_removed", { fixId });
  });
}

