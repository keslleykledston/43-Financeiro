import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { auditLog, bankAccounts, bankAllocations, bankImportBatches, bankImportRows, bankTransactionMarks, bankTransactions } from "@/lib/db/schema";
import { formatBRL } from "@/lib/format";
import { isIsoDate } from "@/lib/iso-date";
import { centsFromNumeric, numericFromCents } from "@/lib/money";
import { Invalid, requirePerm } from "@/modules/identity/service";
import { todayManaus } from "@/modules/messaging/service";
import { recordPaymentTx, reversePaymentTx, splitReceipt } from "@/modules/receivables/service";
import { ParseError, parseSignedMoney, parseStatement, sha256, withRefKeys } from "./parsers";

/**
 * E08 — conciliação bancária (importação de extrato + vínculo manual/sugerido a cobranças). Nada é enviado ao banco; o extrato só é LIDO.
 * Transações importadas são imutáveis. Vincular crédito a cobrança cria um pagamento (E07, forma "extrato") e pode ser desfeito com motivo.
 * Nenhuma sugestão se aplica sozinha: sempre há clique humano. Sem identificador confiável, nunca há sugestão "forte".
 */
const audit = (x: DB, companyId: string, actorId: string, action: string, detail: Record<string, unknown>) => x.insert(auditLog).values({ companyId, actorId, action, detail });
const uuidOk = (s: string) => /^[0-9a-f-]{36}$/i.test(s);
const lockBank = (x: DB, companyId: string, accountId: string) => x.execute(sql`select pg_advisory_xact_lock(hashtext(${`bank:${companyId}:${accountId}`}))`);
type Row = Record<string, unknown>;
const rowsOf = (r: unknown) => r as Row[];
const br = (d: string) => d.split("-").reverse().join("/");
const alnum = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

// ---------- Contas ----------
export type AccountInput = { name: string; bank: string; last4?: string; openingBalance: string; openingDate: string };

export async function createAccount(db: DB, actorId: string, companyId: string, i: AccountInput) {
  await requirePerm(db, actorId, companyId, "bank.accounts");
  const name = i.name.trim(), bank = i.bank.trim(), last4 = (i.last4 ?? "").trim();
  if (name.length < 2 || name.length > 60) throw new Invalid("Informe o nome da conta (2 a 60 caracteres)");
  if (bank.length < 2 || bank.length > 40) throw new Invalid("Informe o banco (2 a 40 caracteres)");
  if (last4 && !/^\d{4}$/.test(last4)) throw new Invalid("O final da conta deve ter 4 dígitos (nunca informe o número completo)");
  const bal = parseSignedMoney(i.openingBalance.trim() || "0");
  if (bal === null) throw new Invalid("Saldo inicial inválido");
  if (!isIsoDate(i.openingDate)) throw new Invalid("Data do saldo inicial inválida");
  try {
    const [a] = await db.insert(bankAccounts).values({ companyId, name, bank, last4: last4 || null, openingBalance: numericFromSigned(bal), openingDate: i.openingDate, createdBy: actorId }).returning({ id: bankAccounts.id });
    await audit(db, companyId, actorId, "bank.account.created", { accountId: a.id });
    return a.id;
  } catch (e) {
    if ((e as { cause?: { code?: string } }).cause?.code === "23505") throw new Invalid("Já existe uma conta com este nome");
    throw e;
  }
}
const numericFromSigned = (c: number) => (c < 0 ? `-${numericFromCents(-c)}` : numericFromCents(c));

async function loadAccount(x: DB, companyId: string, accountId: string) {
  if (!uuidOk(accountId)) throw new Invalid("Conta não encontrada");
  const [a] = await x.select().from(bankAccounts).where(and(eq(bankAccounts.id, accountId), eq(bankAccounts.companyId, companyId)));
  if (!a) throw new Invalid("Conta não encontrada");
  return a;
}

export async function listAccounts(db: DB, actorId: string, companyId: string) {
  await requirePerm(db, actorId, companyId, "bank.read");
  const rows = rowsOf(await db.execute(sql`
    select a.id, a.name, a.bank, a.last4, a.opening_balance::text, a.opening_date::text, a.active,
      (a.opening_balance + coalesce((select sum(t.amount) from bank_transactions t where t.company_id = a.company_id and t.account_id = a.id and t.status = 'ativa'), 0))::text balance,
      (select count(*) from bank_transactions t where t.company_id = a.company_id and t.account_id = a.id and t.status = 'ativa')::int tx_count,
      p.n pending_n, p.cents pending_cents
    from bank_accounts a
    left join lateral (
      select count(*)::int n, coalesce(sum(t.amount - coalesce(al.s, 0)), 0)::text cents
      from bank_transactions t
      left join (select transaction_id, sum(amount) s from bank_allocations where company_id = ${companyId} and status = 'ativa' group by 1) al on al.transaction_id = t.id
      where t.company_id = a.company_id and t.account_id = a.id and t.status = 'ativa' and t.amount > 0 and t.amount - coalesce(al.s, 0) > 0
        and not exists (select 1 from bank_transaction_marks m where m.transaction_id = t.id)
    ) p on true
    where a.company_id = ${companyId} order by a.active desc, a.name`));
  return rows.map((r) => ({ id: String(r.id), name: String(r.name), bank: String(r.bank), last4: (r.last4 as string | null) ?? null, openingDate: String(r.opening_date), active: Boolean(r.active), balanceCents: centsFromSigned(String(r.balance)), txCount: Number(r.tx_count), pendingCount: Number(r.pending_n), pendingCents: centsFromSigned(String(r.pending_cents)) }));
}
function centsFromSigned(v: string): number { const neg = v.startsWith("-"); const c = centsFromNumeric(neg ? v.slice(1) : v); return neg ? -c : c; }

// ---------- Importação: prévia → confirmar ----------
const safeName = (n: string) => (n.split(/[\\/]/).pop() ?? "extrato").replace(/[^\w .()-]/g, "_").slice(0, 120) || "extrato";

export async function previewImport(db: DB, actorId: string, companyId: string, accountId: string, fileName: string, bytes: Uint8Array) {
  await requirePerm(db, actorId, companyId, "bank.import");
  const acc = await loadAccount(db, companyId, accountId);
  if (!acc.active) throw new Invalid("Esta conta está inativa");
  let st;
  try { st = parseStatement(bytes); } catch (e) { if (e instanceof ParseError) throw new Invalid(e.message); throw e; }
  if (acc.last4 && st.accountLast4 && acc.last4 !== st.accountLast4) throw new Invalid(`O arquivo parece ser de outra conta (final ${st.accountLast4}); esta conta termina em ${acc.last4}`);
  const early = st.rows.find((r) => r.postedAt < acc.openingDate);
  if (early) throw new Invalid(`O arquivo tem lançamentos anteriores à data do saldo inicial da conta (${br(acc.openingDate)}). Ajuste a data do saldo inicial ou use outro período`);
  const keyed = withRefKeys(st.rows);
  const checksum = sha256(bytes);
  return db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await lockBank(x, companyId, accountId);
    const [same] = await x.select({ id: bankImportBatches.id, status: bankImportBatches.status }).from(bankImportBatches)
      .where(and(eq(bankImportBatches.companyId, companyId), eq(bankImportBatches.accountId, accountId), eq(bankImportBatches.checksum, checksum), inArray(bankImportBatches.status, ["previa", "aplicado"])));
    if (same) throw new Invalid(same.status === "aplicado" ? "Este arquivo já foi importado nesta conta" : "Este arquivo já está em análise: confirme ou cancele a prévia existente");
    const known = new Set((await x.select({ k: bankTransactions.refKey }).from(bankTransactions)
      .where(and(eq(bankTransactions.companyId, companyId), eq(bankTransactions.accountId, accountId), eq(bankTransactions.status, "ativa"), inArray(bankTransactions.refKey, keyed.map((r) => r.refKey))))).map((r) => r.k));
    const dates = keyed.map((r) => r.postedAt).sort();
    const dup = keyed.filter((r) => known.has(r.refKey)).length;
    const [b] = await x.insert(bankImportBatches).values({
      companyId, accountId, format: st.format, fileName: safeName(fileName), checksum, rowCount: keyed.length, newCount: keyed.length - dup, dupCount: dup,
      periodStart: dates[0], periodEnd: dates[dates.length - 1], ledgerBalance: st.ledgerBalanceCents === null ? null : numericFromSigned(st.ledgerBalanceCents), ledgerDate: st.ledgerDate, importedBy: actorId,
    }).returning({ id: bankImportBatches.id });
    for (let i = 0; i < keyed.length; i += 500) {
      await x.insert(bankImportRows).values(keyed.slice(i, i + 500).map((r) => ({ companyId, batchId: b.id, lineNo: r.lineNo, postedAt: r.postedAt, amount: numericFromSigned(r.amountCents), description: r.description, externalRef: r.externalRef, refKey: r.refKey, duplicate: known.has(r.refKey) })));
    }
    await audit(x, companyId, actorId, "bank.import.previewed", { batchId: b.id, accountId, format: st.format, rows: keyed.length, duplicates: dup });
    return { batchId: b.id };
  });
}

/**
 * Linhas SEM identificador do banco são identificadas por hash + ocorrência. Se o arquivo traz uma quantidade diferente de lançamentos idênticos
 * da já importada (ex.: 1 ou 3 Pix iguais, quando já havia 2), o sistema não consegue distinguir "novo" de "repetido": exige conferência.
 * Devolve os hashes ambíguos.
 */
async function ambiguousGroups(x: DB, companyId: string, accountId: string, refKeys: string[]) {
  const mine = new Map<string, number>();
  for (const k of refKeys) if (k.startsWith("fp:")) { const h = k.split(":")[1]; mine.set(h, (mine.get(h) ?? 0) + 1); }
  if (mine.size === 0) return new Set<string>();
  const hashExpr = sql`split_part(${bankTransactions.refKey}, ':', 2)`;
  const rows = await x.select({ h: sql<string>`${hashExpr}`, n: sql<number>`count(*)::int` }).from(bankTransactions)
    .where(and(eq(bankTransactions.companyId, companyId), eq(bankTransactions.accountId, accountId), eq(bankTransactions.status, "ativa"), sql`${bankTransactions.refKey} like 'fp:%'`, inArray(hashExpr, [...mine.keys()])))
    .groupBy(hashExpr);
  return new Set(rows.filter((r) => r.n > 0 && r.n !== mine.get(r.h)).map((r) => r.h));
}

export async function getImport(db: DB, actorId: string, companyId: string, batchId: string) {
  await requirePerm(db, actorId, companyId, "bank.read");
  if (!uuidOk(batchId)) return null;
  const [b] = await db.select().from(bankImportBatches).where(and(eq(bankImportBatches.id, batchId), eq(bankImportBatches.companyId, companyId)));
  if (!b) return null;
  const acc = await loadAccount(db, companyId, b.accountId);
  const sample = b.status === "previa"
    ? await db.select().from(bankImportRows).where(and(eq(bankImportRows.companyId, companyId), eq(bankImportRows.batchId, b.id))).orderBy(bankImportRows.lineNo).limit(60)
    : [];
  const warnings: string[] = [];
  if (b.status === "previa" && b.ledgerBalance !== null && b.ledgerDate) {
    const [r] = rowsOf(await db.execute(sql`select
      (${acc.openingBalance}::numeric + coalesce((select sum(amount) from bank_transactions where company_id = ${companyId} and account_id = ${b.accountId} and status = 'ativa' and posted_at <= ${b.ledgerDate}::date), 0)
        + coalesce((select sum(amount) from bank_import_rows where company_id = ${companyId} and batch_id = ${b.id} and not duplicate and posted_at <= ${b.ledgerDate}::date), 0))::text projected`));
    const proj = centsFromSigned(String(r.projected)), file = centsFromSigned(b.ledgerBalance);
    if (proj !== file) warnings.push(`O saldo informado no arquivo (${formatBRL(file)} em ${br(b.ledgerDate)}) difere do saldo calculado após importar (${formatBRL(proj)}). Confira o saldo inicial da conta e se faltam períodos.`);
  }
  if (b.status === "previa" && b.newCount === 0) warnings.push("Nenhuma transação nova: tudo neste arquivo já foi importado.");
  let amb = new Set<string>();
  if (b.status === "previa") {
    const all = await db.select({ k: bankImportRows.refKey }).from(bankImportRows).where(and(eq(bankImportRows.companyId, companyId), eq(bankImportRows.batchId, b.id)));
    amb = await ambiguousGroups(db, companyId, b.accountId, all.map((r) => r.k));
    if (amb.size > 0) warnings.push(`${amb.size} grupo(s) de lançamentos idênticos sem identificador do banco têm quantidade diferente da já importada (por exemplo, dois Pix iguais). O sistema não consegue dizer se são novos ou repetidos: confira antes de confirmar.`);
  }
  return {
    batch: b, account: { id: acc.id, name: acc.name }, warnings, ambiguous: amb.size,
    rows: sample.map((r) => ({ lineNo: r.lineNo, postedAt: r.postedAt, amountCents: centsFromSigned(r.amount), description: r.description, duplicate: r.duplicate, ambiguous: r.refKey.startsWith("fp:") && amb.has(r.refKey.split(":")[1]) })),
  };
}

export async function confirmImport(db: DB, actorId: string, companyId: string, batchId: string, ackAmbiguous = false) {
  await requirePerm(db, actorId, companyId, "bank.import");
  if (!uuidOk(batchId)) throw new Invalid("Importação não encontrada");
  return db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    const [b0] = await x.select({ accountId: bankImportBatches.accountId }).from(bankImportBatches).where(and(eq(bankImportBatches.id, batchId), eq(bankImportBatches.companyId, companyId)));
    if (!b0) throw new Invalid("Importação não encontrada");
    await lockBank(x, companyId, b0.accountId);
    const [b] = await x.select().from(bankImportBatches).where(and(eq(bankImportBatches.id, batchId), eq(bankImportBatches.companyId, companyId))).for("update");
    if (!b || b.status !== "previa") throw new Invalid(b?.status === "aplicado" ? "Esta importação já foi confirmada" : "Esta importação não está mais em análise");
    const rows = await x.select().from(bankImportRows).where(and(eq(bankImportRows.companyId, companyId), eq(bankImportRows.batchId, b.id)));
    const known = new Set((await x.select({ k: bankTransactions.refKey }).from(bankTransactions)
      .where(and(eq(bankTransactions.companyId, companyId), eq(bankTransactions.accountId, b.accountId), eq(bankTransactions.status, "ativa"), inArray(bankTransactions.refKey, rows.map((r) => r.refKey))))).map((r) => r.k));
    const fresh = rows.filter((r) => !known.has(r.refKey));
    if (fresh.length === 0) throw new Invalid("Nenhuma transação nova para importar");
    const amb = await ambiguousGroups(x, companyId, b.accountId, rows.map((r) => r.refKey));
    if (amb.size > 0 && !ackAmbiguous) throw new Invalid("Há lançamentos idênticos sem identificador cuja quantidade difere da já importada. Confira a prévia e marque a confirmação para prosseguir");
    for (let i = 0; i < fresh.length; i += 500) {
      await x.insert(bankTransactions).values(fresh.slice(i, i + 500).map((r) => ({ companyId, accountId: b.accountId, batchId: b.id, postedAt: r.postedAt, amount: r.amount, description: r.description, externalRef: r.externalRef, refKey: r.refKey })));
    }
    const now = new Date();
    await x.update(bankImportBatches).set({ status: "aplicado", newCount: fresh.length, dupCount: rows.length - fresh.length, appliedBy: actorId, appliedAt: now, updatedAt: now }).where(eq(bankImportBatches.id, b.id));
    await x.delete(bankImportRows).where(and(eq(bankImportRows.companyId, companyId), eq(bankImportRows.batchId, b.id)));
    await audit(x, companyId, actorId, "bank.import.applied", { batchId: b.id, accountId: b.accountId, imported: fresh.length, duplicates: rows.length - fresh.length, ambiguousAcknowledged: amb.size > 0 });
    return { imported: fresh.length, duplicates: rows.length - fresh.length };
  });
}

export async function cancelImport(db: DB, actorId: string, companyId: string, batchId: string) {
  await requirePerm(db, actorId, companyId, "bank.import");
  if (!uuidOk(batchId)) throw new Invalid("Importação não encontrada");
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    const [b] = await x.select().from(bankImportBatches).where(and(eq(bankImportBatches.id, batchId), eq(bankImportBatches.companyId, companyId))).for("update");
    if (!b || b.status !== "previa") throw new Invalid("Só é possível cancelar uma prévia em análise");
    await x.delete(bankImportRows).where(and(eq(bankImportRows.companyId, companyId), eq(bankImportRows.batchId, b.id)));
    await x.update(bankImportBatches).set({ status: "cancelado", updatedAt: new Date() }).where(eq(bankImportBatches.id, b.id));
    await audit(x, companyId, actorId, "bank.import.cancelled", { batchId: b.id });
  });
}

/** Desfaz uma importação aplicada (erro de arquivo/conta). Só se nenhuma transação dela estiver vinculada; as marcações somem junto. */
export async function undoImport(db: DB, actorId: string, companyId: string, batchId: string, reason: string) {
  await requirePerm(db, actorId, companyId, "bank.undo");
  const why = (reason ?? "").replace(/[\r\n\t]+/g, " ").trim();
  if (why.length < 5 || why.length > 300) throw new Invalid("Informe o motivo (5 a 300 caracteres)");
  if (!uuidOk(batchId)) throw new Invalid("Importação não encontrada");
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    const [b0] = await x.select({ accountId: bankImportBatches.accountId }).from(bankImportBatches).where(and(eq(bankImportBatches.id, batchId), eq(bankImportBatches.companyId, companyId)));
    if (!b0) throw new Invalid("Importação não encontrada");
    await lockBank(x, companyId, b0.accountId);
    const [b] = await x.select().from(bankImportBatches).where(and(eq(bankImportBatches.id, batchId), eq(bankImportBatches.companyId, companyId))).for("update");
    if (!b || b.status !== "aplicado") throw new Invalid("Só é possível desfazer uma importação aplicada");
    const txs = await x.select({ id: bankTransactions.id }).from(bankTransactions).where(and(eq(bankTransactions.companyId, companyId), eq(bankTransactions.batchId, b.id), eq(bankTransactions.status, "ativa"))).for("update");
    const ids = txs.map((t) => t.id);
    if (ids.length) {
      const [al] = await x.select({ n: sql<number>`count(*)::int` }).from(bankAllocations).where(and(eq(bankAllocations.companyId, companyId), eq(bankAllocations.status, "ativa"), inArray(bankAllocations.transactionId, ids)));
      if (Number(al.n) > 0) throw new Invalid("Há transações desta importação vinculadas a cobranças. Desfaça os vínculos antes");
      await x.delete(bankTransactionMarks).where(and(eq(bankTransactionMarks.companyId, companyId), inArray(bankTransactionMarks.transactionId, ids)));
      await x.update(bankTransactions).set({ status: "desfeita", updatedAt: new Date() }).where(and(eq(bankTransactions.companyId, companyId), eq(bankTransactions.batchId, b.id), eq(bankTransactions.status, "ativa")));
    }
    const now = new Date();
    await x.update(bankImportBatches).set({ status: "desfeito", undoneBy: actorId, undoneAt: now, undoReason: why, updatedAt: now }).where(eq(bankImportBatches.id, b.id));
    await audit(x, companyId, actorId, "bank.import.undone", { batchId: b.id, accountId: b.accountId, transactions: ids.length });
  });
}

export async function listImports(db: DB, actorId: string, companyId: string, accountId: string) {
  await requirePerm(db, actorId, companyId, "bank.read");
  await loadAccount(db, companyId, accountId);
  return db.select().from(bankImportBatches).where(and(eq(bankImportBatches.companyId, companyId), eq(bankImportBatches.accountId, accountId))).orderBy(desc(bankImportBatches.createdAt)).limit(30);
}

// ---------- Transações, sugestões e vínculo ----------
export type Suggestion =
  | { level: "forte"; chargeId: string; customerName: string; docTail: string }
  | { level: "ambigua"; customerName: string; count: number }
  | { level: "cliente"; customerName: string }
  | { level: "valor"; count: number }
  | { level: "nenhuma" };

type OpenCharge = { id: string; customerId: string; customerName: string; doc: string; description: string; dueDate: string; openCents: number; competence: string };

async function openCharges(x: DB, companyId: string): Promise<OpenCharge[]> {
  const rows = rowsOf(await x.execute(sql`
    select c.id, c.customer_id, cu.legal_name, cu.document, c.description, c.due_date::text, c.competence_month::text, (c.amount - coalesce(p.paid, 0))::text open
    from charges c
    join billing_batches b on b.company_id = c.company_id and b.id = c.batch_id
    join customers cu on cu.company_id = c.company_id and cu.id = c.customer_id
    left join (select charge_id, sum(amount) paid from payments where company_id = ${companyId} and status = 'ativo' group by charge_id) p on p.charge_id = c.id
    where c.company_id = ${companyId} and c.status = 'aprovada' and b.status = 'aprovado' and coalesce(p.paid, 0) < c.amount
    order by c.due_date, cu.legal_name limit 3000`));
  return rows.map((r) => ({ id: String(r.id), customerId: String(r.customer_id), customerName: String(r.legal_name), doc: alnum(String(r.document ?? "")), description: String(r.description), dueDate: String(r.due_date), openCents: centsFromNumeric(String(r.open)), competence: String(r.competence_month).slice(0, 7) }));
}

/** O documento só vale se não estiver colado a outros dígitos (um CPF dentro de um CNPJ, ou parte de um número maior, não conta). */
export function docInText(text: string, doc: string): boolean {
  if (doc.length < 11) return false;
  const t = text.toUpperCase().replace(/[.\-/]/g, "").replace(/[^A-Z0-9]+/g, " ");
  return new RegExp(`(?<![0-9])${doc}(?![0-9])`).test(t);
}

/** Sugestão SEGURA: só é "forte" com documento do cliente no histórico (com fronteira) E exatamente uma cobrança dele com saldo igual ao valor. Valor igual sozinho nunca é forte. */
export function suggest(description: string, remainingCents: number, charges: OpenCharge[]): Suggestion {
  const matched = new Map<string, OpenCharge[]>();
  for (const c of charges) if (docInText(description, c.doc)) matched.set(c.customerId, [...(matched.get(c.customerId) ?? []), c]);
  if (matched.size > 1) return { level: "ambigua", customerName: "mais de um cliente identificado", count: matched.size };
  if (matched.size === 1) {
    const mine = [...matched.values()][0];
    const eq = mine.filter((c) => c.openCents === remainingCents);
    if (eq.length === 1) return { level: "forte", chargeId: eq[0].id, customerName: eq[0].customerName, docTail: eq[0].doc.slice(-4) };
    if (eq.length > 1) return { level: "ambigua", customerName: mine[0].customerName, count: eq.length };
    return { level: "cliente", customerName: mine[0].customerName };
  }
  const same = charges.filter((c) => c.openCents === remainingCents);
  return same.length > 0 ? { level: "valor", count: same.length } : { level: "nenhuma" };
}

export type TxFilter = "pendentes" | "conciliadas" | "ignoradas" | "debitos" | "todas";
export const TX_FILTERS: TxFilter[] = ["pendentes", "conciliadas", "ignoradas", "debitos", "todas"];

export async function listTransactions(db: DB, actorId: string, companyId: string, accountId: string, filter: string = "pendentes", q = "") {
  await requirePerm(db, actorId, companyId, "bank.read");
  const acc = await loadAccount(db, companyId, accountId);
  const f = (TX_FILTERS as string[]).includes(filter) ? (filter as TxFilter) : "pendentes";
  const cond = {
    pendentes: sql`t.amount > 0 and t.amount - coalesce(al.s, 0) > 0 and m.kind is null`,
    conciliadas: sql`coalesce(al.s, 0) > 0`,
    ignoradas: sql`m.kind is not null`,
    debitos: sql`t.amount < 0 and m.kind is null`,
    todas: sql`true`,
  }[f];
  const text = q.trim().slice(0, 60);
  const rows = rowsOf(await db.execute(sql`
    select t.id, t.posted_at::text, t.amount::text, t.description, coalesce(al.s, 0)::text alloc, m.kind mark_kind
    from bank_transactions t
    left join (select transaction_id, sum(amount) s from bank_allocations where company_id = ${companyId} and status = 'ativa' group by 1) al on al.transaction_id = t.id
    left join bank_transaction_marks m on m.transaction_id = t.id
    where t.company_id = ${companyId} and t.account_id = ${accountId} and t.status = 'ativa' and ${cond}
      ${text ? sql`and t.description ilike ${"%" + text.replace(/[\\%_]/g, "\\$&") + "%"}` : sql``}
    order by t.posted_at desc, t.created_at desc, t.id limit 300`));
  const needSuggest = f === "pendentes" || f === "todas";
  const charges = needSuggest ? await openCharges(db, companyId) : [];
  const items = rows.map((r) => {
    const amountCents = centsFromSigned(String(r.amount)), allocCents = centsFromSigned(String(r.alloc)), remaining = amountCents - allocCents;
    const pending = amountCents > 0 && remaining > 0 && !r.mark_kind;
    return { id: String(r.id), postedAt: String(r.posted_at), amountCents, description: String(r.description), allocatedCents: allocCents, remainingCents: remaining, mark: (r.mark_kind as string | null) ?? null, suggestion: pending && needSuggest ? suggest(String(r.description), remaining, charges) : null };
  });
  return { account: { id: acc.id, name: acc.name, bank: acc.bank, last4: acc.last4 }, items };
}

export async function getTransaction(db: DB, actorId: string, companyId: string, txId: string, q = "") {
  await requirePerm(db, actorId, companyId, "bank.read");
  if (!uuidOk(txId)) return null;
  const [t] = await db.select().from(bankTransactions).where(and(eq(bankTransactions.id, txId), eq(bankTransactions.companyId, companyId)));
  if (!t) return null;
  const acc = await loadAccount(db, companyId, t.accountId);
  const als = rowsOf(await db.execute(sql`select a.id, a.charge_id, a.amount::text, a.status, a.undo_reason, a.created_at, cu.legal_name, c.description
    from bank_allocations a join charges c on c.company_id = a.company_id and c.id = a.charge_id join customers cu on cu.company_id = c.company_id and cu.id = c.customer_id
    where a.company_id = ${companyId} and a.transaction_id = ${txId} order by a.created_at`));
  const [mk] = await db.select().from(bankTransactionMarks).where(and(eq(bankTransactionMarks.companyId, companyId), eq(bankTransactionMarks.transactionId, txId)));
  const amountCents = centsFromSigned(t.amount);
  const allocated = als.filter((a) => a.status === "ativa").reduce((s, a) => s + centsFromNumeric(String(a.amount)), 0);
  const remaining = amountCents - allocated;
  let candidates: (OpenCharge & { rank: string })[] = [];
  let suggestion: Suggestion | null = null;
  if (amountCents > 0 && remaining > 0 && !mk && t.status === "ativa") {
    const all = await openCharges(db, companyId);
    suggestion = suggest(t.description, remaining, all);
    const text = q.trim().toUpperCase();
    const ranked = all.map((c) => ({ ...c, rank: docInText(t.description, c.doc) ? "0-documento" : c.openCents === remaining ? "1-valor" : text && c.customerName.toUpperCase().includes(text) ? "2-busca" : "9" }));
    candidates = ranked.filter((c) => c.rank !== "9").sort((a, b) => a.rank.localeCompare(b.rank) || a.dueDate.localeCompare(b.dueDate)).slice(0, 25);
  }
  return {
    tx: { id: t.id, accountId: t.accountId, accountName: acc.name, postedAt: t.postedAt, amountCents, description: t.description, status: t.status },
    allocatedCents: allocated, remainingCents: remaining, mark: mk ? { kind: mk.kind, note: mk.note } : null, suggestion,
    allocations: als.map((a) => ({ id: String(a.id), chargeId: String(a.charge_id), amountCents: centsFromNumeric(String(a.amount)), status: String(a.status), undoReason: (a.undo_reason as string | null) ?? null, customerName: String(a.legal_name), description: String(a.description) })),
    candidates: candidates.map((c) => ({ id: c.id, customerName: c.customerName, description: c.description, dueDate: c.dueDate, competence: c.competence, openCents: c.openCents, rank: c.rank.slice(2) })),
  };
}

/** `amountStr` = valor do CRÉDITO aplicado a esta cobrança (dinheiro). `extras`: juros/multa incluídos nele e desconto concedido; o principal quitado é recebido − juros + desconto. */
export async function allocate(db: DB, actorId: string, companyId: string, txId: string, chargeId: string, amountStr: string, requestKey?: string, today = todayManaus(), extras: { interest?: string; discount?: string } = {}) {
  await requirePerm(db, actorId, companyId, "bank.reconcile");
  if (!uuidOk(txId) || !uuidOk(chargeId)) throw new Invalid("Transação ou cobrança não encontrada");
  const sp = splitReceipt(amountStr, extras.interest, extras.discount);
  const cents = sp.cash;
  const key = (requestKey ?? "").trim() || null;
  if (key && !/^[A-Za-z0-9_-]{8,64}$/.test(key)) throw new Invalid("Chave de envio inválida");
  try {
    return await db.transaction(async (tx) => {
      const x = tx as unknown as DB;
      const [t] = await x.select().from(bankTransactions).where(and(eq(bankTransactions.id, txId), eq(bankTransactions.companyId, companyId))).for("update");
      if (!t || t.status !== "ativa") throw new Invalid("Transação não encontrada");
      if (key) {
        const [dup] = await x.select().from(bankAllocations).where(and(eq(bankAllocations.companyId, companyId), eq(bankAllocations.requestKey, key)));
        if (dup) { if (dup.transactionId !== txId || dup.chargeId !== chargeId) throw new Invalid("Chave de envio já usada"); return { allocationId: dup.id, duplicate: true, settled: false }; }
      }
      const txCents = centsFromSigned(t.amount);
      if (txCents <= 0) throw new Invalid("Só créditos (entradas) podem ser vinculados a cobranças");
      const [mk] = await x.select({ id: bankTransactionMarks.id }).from(bankTransactionMarks).where(eq(bankTransactionMarks.transactionId, txId));
      if (mk) throw new Invalid("Esta transação está classificada como ignorada. Remova a classificação para vincular");
      const [{ s }] = await x.select({ s: sql<string>`coalesce(sum(${bankAllocations.amount}), 0)::text` }).from(bankAllocations).where(and(eq(bankAllocations.companyId, companyId), eq(bankAllocations.transactionId, txId), eq(bankAllocations.status, "ativa")));
      const remaining = txCents - centsFromNumeric(s);
      if (cents > remaining) throw new Invalid(`O valor passa do que resta do crédito (${formatBRL(remaining)})`);
      if (t.postedAt > today) throw new Invalid("A data do crédito é futura");
      const pay = await recordPaymentTx(x, companyId, actorId, chargeId, { cents: sp.principalCents, interestCents: sp.interestCents, discountCents: sp.discountCents, paidAt: t.postedAt, method: "extrato", note: "Conciliação bancária", key: null }, { source: "bank" });
      const [a] = await x.insert(bankAllocations).values({ companyId, transactionId: txId, chargeId, paymentId: pay.paymentId, amount: numericFromCents(cents), requestKey: key, createdBy: actorId }).returning({ id: bankAllocations.id });
      await audit(x, companyId, actorId, "bank.allocated", { transactionId: txId, chargeId, allocationId: a.id, paymentId: pay.paymentId, settled: pay.settled });
      return { allocationId: a.id, duplicate: false, settled: pay.settled };
    });
  } catch (e) {
    const m = (e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message;
    if (/bank_alloc_exceeds_credit/.test(m)) throw new Invalid("O valor passa do que resta do crédito (outra conciliação acabou de acontecer)");
    if (/payment_exceeds_open/.test(m)) throw new Invalid("O valor passa do saldo em aberto da cobrança");
    throw e;
  }
}

export async function undoAllocation(db: DB, actorId: string, companyId: string, allocationId: string, reason: string) {
  await requirePerm(db, actorId, companyId, "bank.undo");
  const why = (reason ?? "").replace(/[\r\n\t]+/g, " ").trim();
  if (why.length < 5 || why.length > 270) throw new Invalid("Informe o motivo (5 a 270 caracteres)");
  if (!uuidOk(allocationId)) throw new Invalid("Vínculo não encontrado");
  return db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    const [a0] = await x.select({ txId: bankAllocations.transactionId }).from(bankAllocations).where(and(eq(bankAllocations.id, allocationId), eq(bankAllocations.companyId, companyId)));
    if (!a0) throw new Invalid("Vínculo não encontrado");
    await x.select({ id: bankTransactions.id }).from(bankTransactions).where(and(eq(bankTransactions.id, a0.txId), eq(bankTransactions.companyId, companyId))).for("update"); // mesma ordem: crédito → cobrança → pagamento
    const [a] = await x.select().from(bankAllocations).where(and(eq(bankAllocations.id, allocationId), eq(bankAllocations.companyId, companyId))).for("update");
    if (!a || a.status !== "ativa") throw new Invalid("Este vínculo já foi desfeito");
    await x.execute(sql`select set_config('k3g.bank_undo', 'on', true)`); // libera o estorno deste pagamento no trigger (só dentro desta transação)
    await reversePaymentTx(x, companyId, actorId, a.paymentId, `Conciliação desfeita: ${why}`, { source: "bank" });
    const now = new Date();
    await x.update(bankAllocations).set({ status: "desfeita", undoneBy: actorId, undoneAt: now, undoReason: why, updatedAt: now }).where(eq(bankAllocations.id, a.id));
    await audit(x, companyId, actorId, "bank.allocation_undone", { transactionId: a.transactionId, chargeId: a.chargeId, allocationId: a.id, paymentId: a.paymentId });
    return { chargeId: a.chargeId, transactionId: a.transactionId };
  });
}

export const MARK_KINDS = ["tarifa", "transferencia_grupo", "outro"] as const;
export const MARK_LABEL: Record<(typeof MARK_KINDS)[number], string> = { tarifa: "Tarifa bancária", transferencia_grupo: "Transferência entre contas do grupo", outro: "Outro (sem cobrança)" };

/** Classifica uma transação que não é pagamento de cobrança. Não cria pagamento nem receita. (Pareamento entre CNPJs fica para a próxima fase.) */
export async function markTransaction(db: DB, actorId: string, companyId: string, txId: string, kind: string, note: string) {
  await requirePerm(db, actorId, companyId, "bank.reconcile");
  if (!uuidOk(txId)) throw new Invalid("Transação não encontrada");
  if (!(MARK_KINDS as readonly string[]).includes(kind)) throw new Invalid("Classificação inválida");
  const n = (note ?? "").replace(/[\r\n\t]+/g, " ").trim();
  if (n.length > 200) throw new Invalid("A observação passa de 200 caracteres");
  try {
    await db.transaction(async (tx) => {
      const x = tx as unknown as DB;
      const [t] = await x.select({ id: bankTransactions.id }).from(bankTransactions).where(and(eq(bankTransactions.id, txId), eq(bankTransactions.companyId, companyId), eq(bankTransactions.status, "ativa"))).for("update");
      if (!t) throw new Invalid("Transação não encontrada");
      await x.insert(bankTransactionMarks).values({ companyId, transactionId: txId, kind, note: n || null, createdBy: actorId });
      await audit(x, companyId, actorId, "bank.marked", { transactionId: txId, kind });
    });
  } catch (e) {
    const m = (e as { cause?: { message?: string; code?: string } }).cause;
    if (m?.code === "23505") throw new Invalid("Esta transação já está classificada");
    if (/bank_mark_tx_allocated/.test(m?.message ?? "")) throw new Invalid("Esta transação já tem vínculo com cobrança. Desfaça o vínculo antes");
    throw e;
  }
}

export async function unmarkTransaction(db: DB, actorId: string, companyId: string, txId: string) {
  await requirePerm(db, actorId, companyId, "bank.reconcile");
  if (!uuidOk(txId)) throw new Invalid("Transação não encontrada");
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    const del = await x.delete(bankTransactionMarks).where(and(eq(bankTransactionMarks.companyId, companyId), eq(bankTransactionMarks.transactionId, txId))).returning({ id: bankTransactionMarks.id });
    if (del.length === 0) throw new Invalid("Esta transação não está classificada");
    await audit(x, companyId, actorId, "bank.unmarked", { transactionId: txId });
  });
}
