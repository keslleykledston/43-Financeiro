import { and, asc, eq, sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { auditLog, payablePayments, payables, payablesSettings, vendors } from "@/lib/db/schema";
import { toCsv } from "@/lib/csv";
import { formatBRL } from "@/lib/format";
import { isIsoDate } from "@/lib/iso-date";
import { centsFromNumeric, numericFromCents, parseMoneyToCents } from "@/lib/money";
import { Forbidden, Invalid, activeRole, requirePerm } from "@/modules/identity/service";
import { todayManaus } from "@/modules/messaging/service";
import { FILTERS, METHODS, SITUATION_LABEL, payableSituation, type Filter } from "./status";

/**
 * E11 — contas a pagar. A aplicação NÃO paga nada: o pagamento é executado à mão no banco (Cora) por quem tem alçada e depois REGISTRADO aqui.
 * Fluxo: rascunho → aguardando_aprovacao → aprovado | rejeitado | cancelado. Segregação: quem criou não aprova (exceto diretoria, se a empresa permitir).
 * Alçada: gerente aprova até o limite da empresa; acima disso, só a diretoria.
 */
const audit = (x: DB, companyId: string, actorId: string, action: string, detail: Record<string, unknown>) => x.insert(auditLog).values({ companyId, actorId, action, detail });
const uuidOk = (s: string) => /^[0-9a-f-]{36}$/i.test(s);
type Row = Record<string, unknown>;
const rows = (r: unknown) => r as Row[];
const clean = (s: string | undefined, max: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export type PayablesSettings = { managerLimitCents: number; directorSelfApproval: boolean };
export async function getPayablesSettings(db: DB, actorId: string, companyId: string): Promise<PayablesSettings> {
  await requirePerm(db, actorId, companyId, "payables.read");
  return load(db, companyId);
}
async function load(x: DB, companyId: string): Promise<PayablesSettings> {
  const [r] = await x.select().from(payablesSettings).where(eq(payablesSettings.companyId, companyId));
  return r ? { managerLimitCents: centsFromNumeric(r.managerLimit), directorSelfApproval: r.directorSelfApproval } : { managerLimitCents: 500000, directorSelfApproval: false };
}
export async function savePayablesSettings(db: DB, actorId: string, companyId: string, i: { managerLimit: string; directorSelfApproval: boolean }) {
  await requirePerm(db, actorId, companyId, "payables.manage");
  const cents = parseMoneyToCents(i.managerLimit.trim() || "0");
  if (cents === null) throw new Invalid("Limite do gerente inválido");
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await x.insert(payablesSettings).values({ companyId, managerLimit: numericFromCents(cents), directorSelfApproval: i.directorSelfApproval === true, updatedBy: actorId })
      .onConflictDoUpdate({ target: payablesSettings.companyId, set: { managerLimit: numericFromCents(cents), directorSelfApproval: i.directorSelfApproval === true, updatedBy: actorId, updatedAt: new Date() } });
    await audit(x, companyId, actorId, "payables.settings.saved", { directorSelfApproval: i.directorSelfApproval === true });
  });
}

export type PayableInput = { vendorId: string; description: string; documentNumber?: string; amount: string; dueDate: string; category?: string; force?: boolean };

function validate(i: PayableInput) {
  if (!uuidOk(i.vendorId ?? "")) throw new Invalid("Escolha o fornecedor");
  const description = clean(i.description, 200);
  if (description.length < 2) throw new Invalid("Descreva a despesa (2 a 200 caracteres)");
  const cents = parseMoneyToCents(i.amount ?? "");
  if (cents === null || cents <= 0) throw new Invalid("Informe um valor válido, maior que zero");
  if (!isIsoDate(i.dueDate ?? "")) throw new Invalid("Vencimento inválido");
  const documentNumber = clean(i.documentNumber, 40) || null;
  const category = clean(i.category, 40) || null;
  return { description, cents, documentNumber, category };
}

/** Serializa lançamentos do MESMO fornecedor: a checagem de duplicidade provável (valor + vencimento) não tem índice, então precisa de lock. */
const lockVendor = (x: DB, companyId: string, vendorId: string) => x.execute(sql`select pg_advisory_xact_lock(hashtext(${`payable-vendor:${companyId}:${vendorId}`}))`);

async function assertVendor(x: DB, companyId: string, vendorId: string) {
  const [v] = await x.select({ s: vendors.status, archived: vendors.archivedAt }).from(vendors).where(and(eq(vendors.id, vendorId), eq(vendors.companyId, companyId)));
  if (!v || v.archived) throw new Invalid("Fornecedor não encontrado");
  if (v.s !== "ativo") throw new Invalid("Fornecedor inativo: reative o cadastro antes de lançar contas");
}

/** Duplicidade: nº do documento igual para o mesmo fornecedor é BLOQUEADO (índice único); mesmo valor e vencimento para o mesmo fornecedor pede confirmação (`force`). */
async function checkDuplicate(x: DB, companyId: string, vendorId: string, cents: number, dueDate: string, ignoreId?: string) {
  const dup = rows(await x.execute(sql`select id from payables where company_id = ${companyId} and vendor_id = ${vendorId} and amount = ${numericFromCents(cents)}::numeric and due_date = ${dueDate}::date
    and status not in ('cancelado', 'rejeitado') ${ignoreId ? sql`and id <> ${ignoreId}` : sql``} limit 1`));
  return dup.length > 0;
}
const mapUnique = (e: unknown): never => {
  const c = (e as { cause?: { code?: string; constraint_name?: string } }).cause;
  if (c?.code === "23505" && c.constraint_name === "payables_doc_uq") throw new Invalid("Já existe uma conta a pagar deste fornecedor com este número de documento");
  throw e;
};

export async function createPayable(db: DB, actorId: string, companyId: string, i: PayableInput) {
  await requirePerm(db, actorId, companyId, "payables.write");
  const v = validate(i);
  try {
    return await db.transaction(async (tx) => {
      const x = tx as unknown as DB;
      await lockVendor(x, companyId, i.vendorId);
      await assertVendor(x, companyId, i.vendorId);
      if (!i.force && (await checkDuplicate(x, companyId, i.vendorId, v.cents, i.dueDate))) throw new Invalid("POSSIVEL_DUPLICIDADE: já há uma conta deste fornecedor com o mesmo valor e vencimento. Confirme que não é a mesma");
      const [p] = await x.insert(payables).values({ companyId, vendorId: i.vendorId, description: v.description, documentNumber: v.documentNumber, amount: numericFromCents(v.cents), dueDate: i.dueDate, category: v.category, createdBy: actorId }).returning({ id: payables.id });
      await audit(x, companyId, actorId, "payable.created", { payableId: p.id, vendorId: i.vendorId });
      return p.id;
    });
  } catch (e) { return mapUnique(e); }
}

async function lockPayable(x: DB, companyId: string, id: string) {
  if (!uuidOk(id)) throw new Invalid("Conta a pagar não encontrada");
  const [p] = await x.select().from(payables).where(and(eq(payables.id, id), eq(payables.companyId, companyId))).for("update");
  if (!p) throw new Invalid("Conta a pagar não encontrada");
  return p;
}

/** Edita um RASCUNHO (só quem criou, ou aprovador). Depois de enviada, é imutável: para corrigir, cancele e lance de novo. */
export async function updatePayable(db: DB, actorId: string, companyId: string, id: string, i: PayableInput) {
  await requirePerm(db, actorId, companyId, "payables.write");
  const role = await activeRole(db, actorId, companyId);
  const v = validate(i);
  try {
    await db.transaction(async (tx) => {
      const x = tx as unknown as DB;
      const p = await lockPayable(x, companyId, id);
      if (p.status !== "rascunho") throw new Invalid("Só é possível editar um rascunho");
      if (p.createdBy !== actorId && role !== "diretoria" && role !== "gerente") throw new Forbidden("Só quem criou o rascunho (ou a gerência) pode editá-lo");
      await lockVendor(x, companyId, i.vendorId);
      await assertVendor(x, companyId, i.vendorId);
      if (!i.force && (await checkDuplicate(x, companyId, i.vendorId, v.cents, i.dueDate, id))) throw new Invalid("POSSIVEL_DUPLICIDADE: já há uma conta deste fornecedor com o mesmo valor e vencimento. Confirme que não é a mesma");
      await x.update(payables).set({ vendorId: i.vendorId, description: v.description, documentNumber: v.documentNumber, amount: numericFromCents(v.cents), dueDate: i.dueDate, category: v.category, updatedAt: new Date() }).where(eq(payables.id, id));
      await audit(x, companyId, actorId, "payable.updated", { payableId: id });
    });
  } catch (e) { mapUnique(e); }
}

export async function submitPayable(db: DB, actorId: string, companyId: string, id: string) {
  await requirePerm(db, actorId, companyId, "payables.write");
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    const p = await lockPayable(x, companyId, id);
    if (p.status !== "rascunho") throw new Invalid("Só um rascunho pode ser enviado para aprovação");
    await x.update(payables).set({ status: "aguardando_aprovacao", submittedAt: new Date(), updatedAt: new Date() }).where(eq(payables.id, id));
    await audit(x, companyId, actorId, "payable.submitted", { payableId: id });
  });
}

/** Alçada + segregação. Gerente: até o limite da empresa. Diretoria: sem teto. Ninguém aprova o que criou (diretoria só se a empresa permitir). */
export async function approvePayable(db: DB, actorId: string, companyId: string, id: string, note = "") {
  await requirePerm(db, actorId, companyId, "payables.approve");
  const role = (await activeRole(db, actorId, companyId))!;
  const n = clean(note, 300);
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    const p = await lockPayable(x, companyId, id);
    if (p.status !== "aguardando_aprovacao") throw new Invalid("Só uma conta aguardando aprovação pode ser aprovada");
    const st = await load(x, companyId);
    if (role === "gerente" && centsFromNumeric(p.amount) > st.managerLimitCents) throw new Forbidden(`Valor acima da alçada do gerente (${formatBRL(st.managerLimitCents)}): a aprovação é da diretoria`);
    if (p.createdBy === actorId && !(role === "diretoria" && st.directorSelfApproval)) throw new Forbidden("Quem lançou a conta não pode aprová-la");
    const now = new Date();
    await x.update(payables).set({ status: "aprovado", decidedBy: actorId, decidedAt: now, decisionNote: n || null, updatedAt: now }).where(eq(payables.id, id));
    await audit(x, companyId, actorId, "payable.approved", { payableId: id, selfApproved: p.createdBy === actorId });
  });
}

export async function rejectPayable(db: DB, actorId: string, companyId: string, id: string, reason: string) {
  await requirePerm(db, actorId, companyId, "payables.approve");
  const why = clean(reason, 300);
  if (why.length < 5) throw new Invalid("Informe o motivo (5 a 300 caracteres)");
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    const p = await lockPayable(x, companyId, id);
    if (p.status !== "aguardando_aprovacao") throw new Invalid("Só uma conta aguardando aprovação pode ser rejeitada");
    const now = new Date();
    await x.update(payables).set({ status: "rejeitado", decidedBy: actorId, decidedAt: now, decisionNote: why, updatedAt: now }).where(eq(payables.id, id));
    await audit(x, companyId, actorId, "payable.rejected", { payableId: id });
  });
}

/** Cancela (com motivo). Rascunho: quem criou ou a gerência. Enviada/aprovada: só quem aprova. Com baixa registrada não cancela: estorne a baixa antes. */
export async function cancelPayable(db: DB, actorId: string, companyId: string, id: string, reason: string) {
  await requirePerm(db, actorId, companyId, "payables.write");
  const role = (await activeRole(db, actorId, companyId))!;
  const why = clean(reason, 300);
  if (why.length < 5) throw new Invalid("Informe o motivo (5 a 300 caracteres)");
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    const p = await lockPayable(x, companyId, id);
    if (p.status === "rejeitado" || p.status === "cancelado") throw new Invalid("Esta conta já está encerrada");
    if (p.status === "rascunho") { if (p.createdBy !== actorId && role !== "diretoria" && role !== "gerente") throw new Forbidden("Só quem criou o rascunho (ou a gerência) pode cancelá-lo"); }
    else await requirePerm(x, actorId, companyId, "payables.approve");
    const [{ n }] = rows(await x.execute(sql`select count(*)::int n from payable_payments where company_id = ${companyId} and payable_id = ${id}`)) as { n: number }[];
    if (Number(n) > 0) throw new Invalid("Há baixas registradas (ativas ou estornadas): não é possível cancelar. Estorne a baixa e lance a conta correta");
    const now = new Date();
    await x.update(payables).set({ status: "cancelado", cancelledBy: actorId, cancelledAt: now, cancelReason: why, updatedAt: now }).where(eq(payables.id, id));
    await audit(x, companyId, actorId, "payable.cancelled", { payableId: id });
  });
}

// ---------- Baixa (registro da execução manual no banco) ----------
export type PayInput = { amount: string; paidAt: string; method: string; reference?: string; note?: string; requestKey?: string };

export async function registerPayablePayment(db: DB, actorId: string, companyId: string, id: string, i: PayInput, today = todayManaus()) {
  await requirePerm(db, actorId, companyId, "payables.pay");
  const cents = parseMoneyToCents(i.amount ?? "");
  if (cents === null || cents <= 0) throw new Invalid("Informe um valor válido, maior que zero");
  if (!(METHODS as readonly string[]).includes(i.method)) throw new Invalid("Forma de pagamento inválida");
  if (!isIsoDate(i.paidAt ?? "")) throw new Invalid("Data do pagamento inválida");
  if (i.paidAt > today) throw new Invalid("A data do pagamento não pode ser futura");
  const reference = clean(i.reference, 60) || null, note = clean(i.note, 200) || null;
  const key = (i.requestKey ?? "").trim() || null;
  if (key && !/^[A-Za-z0-9_-]{8,64}$/.test(key)) throw new Invalid("Chave de envio inválida");
  try {
    return await db.transaction(async (tx) => {
      const x = tx as unknown as DB;
      const p = await lockPayable(x, companyId, id);
      if (p.status !== "aprovado") throw new Invalid("Só uma conta aprovada recebe baixa");
      if (key) {
        const [dup] = await x.select().from(payablePayments).where(and(eq(payablePayments.companyId, companyId), eq(payablePayments.requestKey, key)));
        if (dup) { if (dup.payableId !== id) throw new Invalid("Chave de envio já usada"); return { paymentId: dup.id, duplicate: true, settled: false }; }
      }
      const [{ paid }] = rows(await x.execute(sql`select coalesce(sum(amount), 0)::text paid from payable_payments where company_id = ${companyId} and payable_id = ${id} and status = 'ativo'`)) as { paid: string }[];
      const open = centsFromNumeric(p.amount) - centsFromNumeric(paid);
      if (cents > open) throw new Invalid(`O valor passa do saldo em aberto (${formatBRL(open)})`);
      const [r] = await x.insert(payablePayments).values({ companyId, payableId: id, amount: numericFromCents(cents), paidAt: i.paidAt, method: i.method, reference, note, requestKey: key, registeredBy: actorId }).returning({ id: payablePayments.id });
      await audit(x, companyId, actorId, "payable.payment_registered", { payableId: id, paymentId: r.id, method: i.method, settled: cents === open });
      return { paymentId: r.id, duplicate: false, settled: cents === open };
    });
  } catch (e) {
    const c = (e as { cause?: { code?: string; constraint_name?: string; message?: string } }).cause;
    if (key && c?.code === "23505" && c.constraint_name === "payable_payments_request_key_uq") {
      const [dup] = await db.select().from(payablePayments).where(and(eq(payablePayments.companyId, companyId), eq(payablePayments.requestKey, key)));
      if (dup && dup.payableId === id) return { paymentId: dup.id, duplicate: true, settled: false };
      throw new Invalid("Chave de envio já usada");
    }
    if (/payable_payment_exceeds_open/.test(c?.message ?? "")) throw new Invalid("O valor passa do saldo em aberto (outra baixa acabou de ser registrada)");
    if (/payable_not_approved/.test(c?.message ?? "")) throw new Invalid("Só uma conta aprovada recebe baixa");
    throw e;
  }
}

export async function reversePayablePayment(db: DB, actorId: string, companyId: string, paymentId: string, reason: string) {
  await requirePerm(db, actorId, companyId, "payables.reverse");
  const why = clean(reason, 300);
  if (why.length < 5) throw new Invalid("Informe o motivo (5 a 300 caracteres)");
  if (!uuidOk(paymentId)) throw new Invalid("Baixa não encontrada");
  return db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    const [p0] = await x.select({ payableId: payablePayments.payableId }).from(payablePayments).where(and(eq(payablePayments.id, paymentId), eq(payablePayments.companyId, companyId)));
    if (!p0) throw new Invalid("Baixa não encontrada");
    await lockPayable(x, companyId, p0.payableId); // mesma ordem de lock da baixa: conta → baixa
    const [p] = await x.select().from(payablePayments).where(and(eq(payablePayments.id, paymentId), eq(payablePayments.companyId, companyId))).for("update");
    if (!p || p.status !== "ativo") throw new Invalid("Esta baixa já foi estornada");
    const now = new Date();
    await x.update(payablePayments).set({ status: "estornado", reversedBy: actorId, reversedAt: now, reverseReason: why, updatedAt: now }).where(eq(payablePayments.id, p.id));
    await audit(x, companyId, actorId, "payable.payment_reversed", { payableId: p.payableId, paymentId: p.id });
    return { payableId: p.payableId };
  });
}

// ---------- Consultas ----------
export type ListFilters = { status?: string; q?: string; dueFrom?: string; dueTo?: string };
const FROM = (companyId: string) => sql`from payables p join vendors v on v.company_id = p.company_id and v.id = p.vendor_id
  left join (select payable_id, sum(amount) paid from payable_payments where company_id = ${companyId} and status = 'ativo' group by payable_id) pp on pp.payable_id = p.id`;
function where(companyId: string, f: ListFilters, today: string) {
  const parts = [sql`p.company_id = ${companyId}`];
  const st = (FILTERS as readonly string[]).includes(f.status ?? "") ? (f.status as Filter) : "abertas";
  const unpaid = sql`p.status = 'aprovado' and coalesce(pp.paid, 0) < p.amount`;
  if (st === "abertas") parts.push(sql`(p.status = 'aguardando_aprovacao' or (${unpaid}))`);
  if (st === "aguardando") parts.push(sql`p.status = 'aguardando_aprovacao'`);
  if (st === "aprovadas") parts.push(unpaid);
  if (st === "vencidas") parts.push(sql`((${unpaid}) or p.status = 'aguardando_aprovacao') and p.due_date < ${today}::date`);
  if (st === "pagas") parts.push(sql`p.status = 'aprovado' and coalesce(pp.paid, 0) >= p.amount`);
  if (st === "rascunhos") parts.push(sql`p.status = 'rascunho'`);
  if (st === "encerradas") parts.push(sql`p.status in ('rejeitado', 'cancelado')`);
  const q = (f.q ?? "").trim().slice(0, 80);
  if (q) parts.push(sql`(v.legal_name ilike ${"%" + q.replace(/[\\%_]/g, "\\$&") + "%"} or p.description ilike ${"%" + q.replace(/[\\%_]/g, "\\$&") + "%"})`);
  if (f.dueFrom && isIsoDate(f.dueFrom)) parts.push(sql`p.due_date >= ${f.dueFrom}::date`);
  if (f.dueTo && isIsoDate(f.dueTo)) parts.push(sql`p.due_date <= ${f.dueTo}::date`);
  return sql.join(parts, sql` and `);
}
export type PayableRow = { id: string; vendorId: string; vendorName: string; description: string; documentNumber: string | null; category: string | null; dueDate: string; status: string; amountCents: number; paidCents: number; openCents: number; situation: ReturnType<typeof payableSituation>["situation"]; overdueDays: number; createdBy: string };
const toRow = (r: Row, today: string): PayableRow => {
  const amountCents = centsFromNumeric(String(r.amount)), paidCents = centsFromNumeric(String(r.paid));
  const s = payableSituation({ status: String(r.status), amountCents, paidCents, dueDate: String(r.due_date), today });
  return { id: String(r.id), vendorId: String(r.vendor_id), vendorName: String(r.legal_name), description: String(r.description), documentNumber: (r.document_number as string | null) ?? null, category: (r.category as string | null) ?? null, dueDate: String(r.due_date), status: String(r.status), amountCents, paidCents, openCents: s.openCents, situation: s.situation, overdueDays: s.overdueDays, createdBy: String(r.created_by) };
};
const COLS = sql`p.id, p.vendor_id, v.legal_name, p.description, p.document_number, p.category, p.due_date::text, p.status, p.amount::text, coalesce(pp.paid, 0)::text paid, p.created_by`;

export async function listPayables(db: DB, actorId: string, companyId: string, f: ListFilters = {}, today = todayManaus()) {
  await requirePerm(db, actorId, companyId, "payables.read");
  const r = rows(await db.execute(sql`select ${COLS} ${FROM(companyId)} where ${where(companyId, f, today)} order by p.due_date asc, v.legal_name asc, p.id asc limit 500`));
  return r.map((x) => toRow(x, today));
}

export async function payablesSummary(db: DB, actorId: string, companyId: string, today = todayManaus()) {
  await requirePerm(db, actorId, companyId, "payables.read");
  const [s] = rows(await db.execute(sql`select
      coalesce(sum(p.amount - coalesce(pp.paid, 0)) filter (where p.status = 'aprovado' and coalesce(pp.paid, 0) < p.amount), 0)::text approved_open,
      coalesce(sum(p.amount - coalesce(pp.paid, 0)) filter (where p.status = 'aprovado' and coalesce(pp.paid, 0) < p.amount and p.due_date < ${today}::date), 0)::text overdue,
      count(*) filter (where p.status = 'aprovado' and coalesce(pp.paid, 0) < p.amount and p.due_date < ${today}::date)::int overdue_n,
      coalesce(sum(p.amount) filter (where p.status = 'aguardando_aprovacao'), 0)::text pending,
      count(*) filter (where p.status = 'aguardando_aprovacao')::int pending_n,
      count(*) filter (where p.status = 'aprovado' and coalesce(pp.paid, 0) < p.amount and p.due_date between ${today}::date and (${today}::date + 3))::int due_soon
    ${FROM(companyId)} where p.company_id = ${companyId}`));
  const [m] = rows(await db.execute(sql`select coalesce(sum(amount), 0)::text s from payable_payments where company_id = ${companyId} and status = 'ativo' and paid_at >= ${today.slice(0, 7) + "-01"}::date and paid_at < (${today.slice(0, 7) + "-01"}::date + interval '1 month')`));
  return { approvedOpenCents: centsFromNumeric(String(s.approved_open)), overdueCents: centsFromNumeric(String(s.overdue)), overdueCount: Number(s.overdue_n), pendingCents: centsFromNumeric(String(s.pending)), pendingCount: Number(s.pending_n), dueSoonCount: Number(s.due_soon), paidMonthCents: centsFromNumeric(String(m.s)) };
}

export type PayableDetail = Awaited<ReturnType<typeof getPayable>>;
export async function getPayable(db: DB, actorId: string, companyId: string, id: string, today = todayManaus()) {
  await requirePerm(db, actorId, companyId, "payables.read");
  if (!uuidOk(id)) return null;
  const [r] = rows(await db.execute(sql`select ${COLS}, p.submitted_at, p.decided_at, p.decision_note, p.cancelled_at, p.cancel_reason, p.created_at,
      (select name from users where id = p.created_by) created_name, (select name from users where id = p.decided_by) decided_name, (select name from users where id = p.cancelled_by) cancelled_name
    ${FROM(companyId)} where p.company_id = ${companyId} and p.id = ${id}`));
  if (!r) return null;
  const pays = rows(await db.execute(sql`select pm.id, pm.amount::text, pm.paid_at::text, pm.method, pm.reference, pm.note, pm.status, pm.reverse_reason, pm.created_at, pm.reversed_at,
      (select name from users where id = pm.registered_by) by_name, (select name from users where id = pm.reversed_by) rev_name
    from payable_payments pm where pm.company_id = ${companyId} and pm.payable_id = ${id} order by pm.created_at`));
  const row = toRow(r, today);
  type Ev = { at: Date; text: string };
  const events: Ev[] = [{ at: new Date(String(r.created_at)), text: `Lançada por ${r.created_name}` }];
  if (r.submitted_at) events.push({ at: new Date(String(r.submitted_at)), text: "Enviada para aprovação" });
  if (r.decided_at) events.push({ at: new Date(String(r.decided_at)), text: `${row.status === "rejeitado" ? "Rejeitada" : "Aprovada"} por ${r.decided_name}${r.decision_note ? `: ${r.decision_note}` : ""}` });
  if (r.cancelled_at) events.push({ at: new Date(String(r.cancelled_at)), text: `Cancelada por ${r.cancelled_name}: ${r.cancel_reason}` });
  for (const p of pays) {
    events.push({ at: new Date(String(p.created_at)), text: `Baixa de ${formatBRL(centsFromNumeric(String(p.amount)))} registrada por ${p.by_name}` });
    if (p.status === "estornado" && p.reversed_at) events.push({ at: new Date(String(p.reversed_at)), text: `Baixa de ${formatBRL(centsFromNumeric(String(p.amount)))} estornada por ${p.rev_name}: ${p.reverse_reason}` });
  }
  events.sort((a, b) => a.at.getTime() - b.at.getTime());
  return {
    ...row, submittedAt: r.submitted_at ? new Date(String(r.submitted_at)) : null, decisionNote: (r.decision_note as string | null) ?? null, cancelReason: (r.cancel_reason as string | null) ?? null, createdName: String(r.created_name), decidedName: (r.decided_name as string | null) ?? null,
    payments: pays.map((p) => ({ id: String(p.id), amountCents: centsFromNumeric(String(p.amount)), paidAt: String(p.paid_at), method: String(p.method), reference: (p.reference as string | null) ?? null, note: (p.note as string | null) ?? null, status: String(p.status), registeredBy: String(p.by_name), reversedBy: (p.rev_name as string | null) ?? null, reverseReason: (p.reverse_reason as string | null) ?? null })),
    events,
  };
}

/** Fila para quem executa no banco: contas APROVADAS e em aberto, por vencimento. */
export async function executionQueue(db: DB, actorId: string, companyId: string, today = todayManaus()) {
  await requirePerm(db, actorId, companyId, "payables.read");
  const r = rows(await db.execute(sql`select ${COLS} ${FROM(companyId)} where p.company_id = ${companyId} and p.status = 'aprovado' and coalesce(pp.paid, 0) < p.amount order by p.due_date asc, v.legal_name asc, p.id asc limit 500`));
  return r.map((x) => toRow(x, today));
}

export async function listActiveVendors(db: DB, actorId: string, companyId: string) {
  await requirePerm(db, actorId, companyId, "payables.read");
  return db.select({ id: vendors.id, name: vendors.legalName }).from(vendors).where(and(eq(vendors.companyId, companyId), eq(vendors.status, "ativo"), sql`${vendors.archivedAt} is null`)).orderBy(asc(vendors.legalName)).limit(500);
}

export async function exportPayables(db: DB, actorId: string, companyId: string, f: ListFilters = {}, queue = false, today = todayManaus()) {
  await requirePerm(db, actorId, companyId, "payables.export");
  const items = queue ? await executionQueue(db, actorId, companyId, today) : await listPayables(db, actorId, companyId, f, today);
  const br = (d: string) => d.split("-").reverse().join("/");
  const money = (c: number) => (c / 100).toFixed(2).replace(".", ",");
  const csv = toCsv([
    ["Fornecedor", "Descrição", "Documento", "Categoria", "Vencimento", "Valor", "Pago", "Saldo", "Situação", "Dias de atraso"],
    ...items.map((r) => [r.vendorName, r.description, r.documentNumber ?? "", r.category ?? "", br(r.dueDate), money(r.amountCents), money(r.paidCents), money(r.status === "aprovado" ? r.amountCents - r.paidCents : r.amountCents), SITUATION_LABEL[r.situation], String(r.overdueDays)]),
  ]);
  await audit(db, companyId, actorId, "payable.exported", { count: items.length, queue });
  return csv;
}
