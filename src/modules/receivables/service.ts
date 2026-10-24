import { and, asc, eq, sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { auditLog, billingBatches, charges, customers, messageQueue, payments, users } from "@/lib/db/schema";
import { toCsv } from "@/lib/csv";
import { isIsoDate } from "@/lib/iso-date";
import { formatBRL } from "@/lib/format";
import { centsFromNumeric, numericFromCents, parseMoneyToCents } from "@/lib/money";
import { Invalid, requirePerm } from "@/modules/identity/service";
import { cancelQueueForCharges, todayManaus } from "@/modules/messaging/service";
import { AGING, FILTERS, METHODS, SITUATION_LABEL, situationOf, type Filter, type Method } from "./status";

/**
 * E07 — contas a receber. Pagamentos são registrados MANUALMENTE (a baixa automática por extrato é a E08). Nada é emitido ou enviado.
 * O saldo é sempre `valor − soma dos pagamentos ativos`; estornar não apaga, só marca; quitada = saldo zero, jamais um botão.
 */
const audit = (x: DB, companyId: string, actorId: string, action: string, detail: Record<string, unknown>) => x.insert(auditLog).values({ companyId, actorId, action, detail });
const isoDate = isIsoDate;
const uuidOk = (s: string) => /^[0-9a-f-]{36}$/i.test(s);
type Row = Record<string, unknown>;

export type ListFilters = { status?: string; q?: string; dueFrom?: string; dueTo?: string; competence?: string };

/** Fragmentos SQL do filtro (todos parametrizados). `paid` = soma dos pagamentos ativos da cobrança. */
function where(companyId: string, f: ListFilters, today: string) {
  const parts = [sql`c.company_id = ${companyId}`, sql`c.status = 'aprovada'`, sql`b.status = 'aprovado'`];
  const st = (FILTERS as readonly string[]).includes(f.status ?? "") ? (f.status as Filter) : "abertas";
  if (st === "abertas") parts.push(sql`coalesce(p.paid, 0) < c.amount`);
  if (st === "a_vencer") parts.push(sql`coalesce(p.paid, 0) = 0 and c.due_date >= ${today}::date`);
  if (st === "vencidas") parts.push(sql`coalesce(p.paid, 0) < c.amount and c.due_date < ${today}::date`);
  if (st === "parciais") parts.push(sql`coalesce(p.paid, 0) > 0 and coalesce(p.paid, 0) < c.amount`);
  if (st === "quitadas") parts.push(sql`coalesce(p.paid, 0) >= c.amount`);
  const q = (f.q ?? "").trim().slice(0, 80);
  if (q) parts.push(sql`cu.legal_name ilike ${"%" + q.replace(/[\\%_]/g, "\\$&") + "%"}`);
  if (f.dueFrom && isoDate(f.dueFrom)) parts.push(sql`c.due_date >= ${f.dueFrom}::date`);
  if (f.dueTo && isoDate(f.dueTo)) parts.push(sql`c.due_date <= ${f.dueTo}::date`);
  if (f.competence && /^\d{4}-(0[1-9]|1[0-2])$/.test(f.competence)) parts.push(sql`c.competence_month = ${f.competence + "-01"}::date`);
  return sql.join(parts, sql` and `);
}
const FROM = (companyId: string) => sql`
  from charges c
  join billing_batches b on b.company_id = c.company_id and b.id = c.batch_id
  join customers cu on cu.company_id = c.company_id and cu.id = c.customer_id
  left join (select charge_id, sum(amount) paid, sum(interest_amount) interest, sum(discount_amount) discount from payments where company_id = ${companyId} and status = 'ativo' group by charge_id) p on p.charge_id = c.id`;

export type ReceivableRow = {
  id: string; customerId: string; customerName: string; description: string; competenceMonth: string; issueDate: string; dueDate: string;
  amountCents: number; paidCents: number; interestCents: number; discountCents: number; openCents: number; situation: ReturnType<typeof situationOf>["situation"]; overdueDays: number;
};
const toRow = (r: Row, today: string): ReceivableRow => {
  const amountCents = centsFromNumeric(String(r.amount)), paidCents = centsFromNumeric(String(r.paid));
  const s = situationOf({ amountCents, paidCents, dueDate: String(r.due_date), today });
  return { id: String(r.id), customerId: String(r.customer_id), customerName: String(r.legal_name), description: String(r.description), competenceMonth: String(r.competence_month), issueDate: String(r.issue_date), dueDate: String(r.due_date), amountCents, paidCents, interestCents: centsFromNumeric(String(r.interest ?? 0)), discountCents: centsFromNumeric(String(r.discount ?? 0)), openCents: s.openCents, situation: s.situation, overdueDays: s.overdueDays };
};

export async function listReceivables(db: DB, actorId: string, companyId: string, f: ListFilters = {}, today = todayManaus()) {
  await requirePerm(db, actorId, companyId, "receivables.read");
  const rows = await db.execute(sql`select c.id, c.customer_id, cu.legal_name, c.description, c.competence_month::text, c.issue_date::text, c.due_date::text, c.amount::text, coalesce(p.paid, 0)::text paid, coalesce(p.interest, 0)::text interest, coalesce(p.discount, 0)::text discount
    ${FROM(companyId)} where ${where(companyId, f, today)} order by c.due_date asc, cu.legal_name asc, c.id asc limit 500`);
  return (rows as unknown as Row[]).map((r) => toRow(r, today));
}

/** Indicadores da empresa ativa (todas as cobranças aprovadas, independentemente dos filtros da lista). */
export async function receivablesSummary(db: DB, actorId: string, companyId: string, today = todayManaus()) {
  await requirePerm(db, actorId, companyId, "receivables.read");
  const base = sql`${FROM(companyId)} where c.company_id = ${companyId} and c.status = 'aprovada' and b.status = 'aprovado'`;
  const [tot] = (await db.execute(sql`select
      coalesce(sum(c.amount - coalesce(p.paid, 0)) filter (where coalesce(p.paid, 0) < c.amount), 0)::text open,
      coalesce(sum(c.amount - coalesce(p.paid, 0)) filter (where coalesce(p.paid, 0) < c.amount and c.due_date < ${today}::date), 0)::text overdue,
      count(*) filter (where coalesce(p.paid, 0) < c.amount and c.due_date < ${today}::date)::int overdue_n,
      count(*) filter (where coalesce(p.paid, 0) < c.amount)::int open_n
    ${base}`)) as unknown as Row[];
  const month = today.slice(0, 7);
  const [rec] = (await db.execute(sql`select coalesce(sum(amount + interest_amount - discount_amount), 0)::text s, count(*)::int n from payments where company_id = ${companyId} and status = 'ativo' and paid_at >= ${month + "-01"}::date and paid_at < (${month + "-01"}::date + interval '1 month')`)) as unknown as Row[];
  const aging = (await db.execute(sql`select (${today}::date - c.due_date) days, (c.amount - coalesce(p.paid, 0))::text open ${base} and coalesce(p.paid, 0) < c.amount and c.due_date < ${today}::date`)) as unknown as Row[];
  const buckets = AGING.map((b) => ({ key: b.key, label: b.label, cents: 0, count: 0 }));
  for (const a of aging) { const d = Number(a.days); const k = buckets.find((_, i) => d >= AGING[i].min && d <= AGING[i].max); if (k) { k.cents += centsFromNumeric(String(a.open)); k.count++; } }
  const debtors = (await db.execute(sql`select cu.id, cu.legal_name, sum(c.amount - coalesce(p.paid, 0))::text open, max(${today}::date - c.due_date) oldest, count(*)::int n
    ${base} and coalesce(p.paid, 0) < c.amount and c.due_date < ${today}::date group by cu.id, cu.legal_name order by sum(c.amount - coalesce(p.paid, 0)) desc, cu.legal_name limit 10`)) as unknown as Row[];
  return {
    openCents: centsFromNumeric(String(tot.open)), openCount: Number(tot.open_n), overdueCents: centsFromNumeric(String(tot.overdue)), overdueCount: Number(tot.overdue_n),
    receivedMonthCents: centsFromNumeric(String(rec.s)), receivedMonthCount: Number(rec.n), aging: buckets,
    topDebtors: debtors.map((d) => ({ customerId: String(d.id), name: String(d.legal_name), overdueCents: centsFromNumeric(String(d.open)), oldestDays: Number(d.oldest), count: Number(d.n) })),
  };
}

export type TimelineEvent = { at: Date; kind: "aprovada" | "pagamento" | "estorno" | "mensagem"; text: string };

export async function getReceivable(db: DB, actorId: string, companyId: string, id: string, today = todayManaus()) {
  await requirePerm(db, actorId, companyId, "receivables.read");
  if (!uuidOk(id)) return null;
  const [r] = (await db.execute(sql`select c.id, c.customer_id, cu.legal_name, c.description, c.competence_month::text, c.issue_date::text, c.due_date::text, c.amount::text, coalesce(p.paid, 0)::text paid, coalesce(p.interest, 0)::text interest, coalesce(p.discount, 0)::text discount, c.batch_id, c.contract_id, b.approved_at
    ${FROM(companyId)} where c.company_id = ${companyId} and c.id = ${id} and c.status = 'aprovada' and b.status = 'aprovado'`)) as unknown as Row[];
  if (!r) return null;
  const row = toRow(r, today);
  const pays = await db.select({ p: payments, by: users.name, revBy: sql<string | null>`(select name from users where id = ${payments.reversedBy})` }).from(payments)
    .innerJoin(users, eq(users.id, payments.registeredBy)).where(and(eq(payments.companyId, companyId), eq(payments.chargeId, id))).orderBy(asc(payments.createdAt));
  const msgs = await db.select({ kind: messageQueue.kind, channel: messageQueue.channel, at: messageQueue.processedAt }).from(messageQueue)
    .where(and(eq(messageQueue.companyId, companyId), eq(messageQueue.chargeId, id), eq(messageQueue.status, "simulado")));
  const events: TimelineEvent[] = [];
  if (r.approved_at) events.push({ at: new Date(String(r.approved_at)), kind: "aprovada", text: "Cobrança aprovada no lote de emissão" });
  for (const x of pays) {
    events.push({ at: x.p.createdAt, kind: "pagamento", text: `Recebimento de ${formatBRL(cashOf(x.p))} registrado por ${x.by}` });
    if (x.p.status === "estornado" && x.p.reversedAt) events.push({ at: x.p.reversedAt, kind: "estorno", text: `Recebimento de ${formatBRL(cashOf(x.p))} estornado por ${x.revBy ?? "—"}: ${x.p.reverseReason}` });
  }
  for (const m of msgs) if (m.at) events.push({ at: m.at, kind: "mensagem", text: `Mensagem simulada (${m.kind}, ${m.channel})` });
  events.sort((a, b) => a.at.getTime() - b.at.getTime());
  return {
    ...row, batchId: String(r.batch_id), contractId: String(r.contract_id),
    payments: pays.map((x) => ({ id: x.p.id, amountCents: centsFromNumeric(x.p.amount), interestCents: centsFromNumeric(x.p.interestAmount), discountCents: centsFromNumeric(x.p.discountAmount), cashCents: cashOf(x.p), paidAt: x.p.paidAt, method: x.p.method as Method, note: x.p.note, status: x.p.status, registeredBy: x.by, reversedBy: x.revBy, reverseReason: x.p.reverseReason, createdAt: x.p.createdAt })),
    events,
  };
}

/** Dinheiro efetivamente recebido = principal + juros/multa − desconto. */
const cashOf = (p: { amount: string; interestAmount: string; discountAmount: string }) => centsFromNumeric(p.amount) + centsFromNumeric(p.interestAmount) - centsFromNumeric(p.discountAmount);

/** `amount` = valor RECEBIDO (como no extrato). `interest` = juros/multa incluídos nele; `discount` = abatimento/desconto concedido (quita o principal sem entrar dinheiro). Principal quitado = recebido − juros + desconto. */
export type PaymentInput = { amount: string; paidAt: string; method: string; note?: string; requestKey?: string; interest?: string; discount?: string };

/** Valida e separa recebido/juros/desconto → principal. */
export function splitReceipt(amount: string, interest: string | undefined, discount: string | undefined) {
  const cash = parseMoneyToCents(amount ?? "");
  if (cash === null || cash <= 0) throw new Invalid("Informe um valor válido, maior que zero");
  const i = (interest ?? "").trim() ? parseMoneyToCents(interest!) : 0, d = (discount ?? "").trim() ? parseMoneyToCents(discount!) : 0;
  if (i === null) throw new Invalid("Juros/multa inválido");
  if (d === null) throw new Invalid("Desconto inválido");
  const principal = cash - i + d;
  if (principal <= 0) throw new Invalid("Os juros/multa não podem ser maiores ou iguais ao valor recebido");
  return { cash, interestCents: i, discountCents: d, principalCents: principal };
}

export async function registerPayment(db: DB, actorId: string, companyId: string, chargeId: string, input: PaymentInput, today = todayManaus()) {
  await requirePerm(db, actorId, companyId, "receivables.pay");
  if (!uuidOk(chargeId)) throw new Invalid("Cobrança não encontrada");
  const sp = splitReceipt(input.amount, input.interest, input.discount);
  if (!(METHODS as readonly string[]).includes(input.method)) throw new Invalid("Forma de pagamento inválida");
  if (!isoDate(input.paidAt ?? "")) throw new Invalid("Data do pagamento inválida");
  if (input.paidAt > today) throw new Invalid("A data do pagamento não pode ser futura");
  const note = (input.note ?? "").replace(/[\r\n\t]+/g, " ").trim();
  if (note.length > 200) throw new Invalid("A observação passa de 200 caracteres");
  const key = (input.requestKey ?? "").trim() || null;
  if (key && !/^[A-Za-z0-9_-]{8,64}$/.test(key)) throw new Invalid("Chave de envio inválida");
  try {
    return await db.transaction(async (tx) => {
      const x = tx as unknown as DB;
      return recordPaymentTx(x, companyId, actorId, chargeId, { cents: sp.principalCents, interestCents: sp.interestCents, discountCents: sp.discountCents, paidAt: input.paidAt, method: input.method, note, key });
    });
  } catch (e) {
    const cause = (e as { cause?: { code?: string; constraint_name?: string; message?: string } }).cause;
    if (key && cause?.code === "23505" && cause.constraint_name === "payments_request_key_uq") { // duas requisições com a mesma chave ao mesmo tempo
      const [dup] = await db.select().from(payments).where(and(eq(payments.companyId, companyId), eq(payments.requestKey, key)));
      if (dup && dup.chargeId === chargeId) return { paymentId: dup.id, duplicate: true, settled: false };
      throw new Invalid("Chave de envio já usada");
    }
    const m = cause?.message ?? (e as Error).message;
    if (/payment_exceeds_open/.test(m)) throw new Invalid("O valor passa do saldo em aberto (outro pagamento acabou de ser registrado)");
    if (/payment_charge_not_approved/.test(m)) throw new Invalid("Cobrança não encontrada");
    throw e;
  }
}

type PaymentCore = { cents: number; interestCents?: number; discountCents?: number; paidAt: string; method: string; note: string; key: string | null }; // cents = PRINCIPAL quitado
/** Núcleo da baixa, DENTRO de uma transação do chamador (registro manual e conciliação bancária). Trava a cobrança; o trigger do banco é a 2ª barreira. */
export async function recordPaymentTx(x: DB, companyId: string, actorId: string, chargeId: string, p0: PaymentCore, auditExtra: Record<string, unknown> = {}) {
  const { cents, key, note } = p0; const input = { paidAt: p0.paidAt, method: p0.method };
      const [c] = await x.select({ c: charges, bs: billingBatches.status }).from(charges).innerJoin(billingBatches, and(eq(billingBatches.id, charges.batchId), eq(billingBatches.companyId, charges.companyId)))
        .where(and(eq(charges.id, chargeId), eq(charges.companyId, companyId))).for("update", { of: charges });
      if (!c || c.c.status !== "aprovada" || c.bs !== "aprovado") throw new Invalid("Cobrança não encontrada");
      // cancelamento de boleto em andamento (a chamada ao provedor corre fora da transação): a baixa espera o resultado, senão o boleto seria cancelado COM pagamento (E20)
      const [inflight] = (await x.execute(sql`select 1 from boleto_cancellations where company_id = ${companyId} and charge_id = ${chargeId} and status in ('enviando', 'desconhecido') limit 1`)) as unknown as unknown[];
      if (inflight) throw new Invalid("Há um cancelamento de boleto em andamento nesta cobrança. Aguarde o resultado (ou reconsulte) antes de registrar o pagamento");
      if (key) { // reenvio do mesmo formulário (duplo clique, recarga): devolve o que já foi gravado
        const [dup] = await x.select().from(payments).where(and(eq(payments.companyId, companyId), eq(payments.requestKey, key)));
        if (dup) { if (dup.chargeId !== chargeId) throw new Invalid("Chave de envio já usada"); return { paymentId: dup.id, duplicate: true, settled: false }; }
      }
      if (input.paidAt < c.c.issueDate) throw new Invalid("A data do pagamento não pode ser anterior à emissão");
      const [{ paid }] = await x.select({ paid: sql<string>`coalesce(sum(${payments.amount}), 0)::text` }).from(payments).where(and(eq(payments.companyId, companyId), eq(payments.chargeId, chargeId), eq(payments.status, "ativo")));
      const open = centsFromNumeric(c.c.amount) - centsFromNumeric(paid);
      if (cents > open) throw new Invalid(`O valor passa do saldo em aberto (${formatBRL(open)})`);
      const [p] = await x.insert(payments).values({ companyId, chargeId, amount: numericFromCents(cents), interestAmount: numericFromCents(p0.interestCents ?? 0), discountAmount: numericFromCents(p0.discountCents ?? 0), paidAt: input.paidAt, method: input.method, note: note || null, requestKey: key, registeredBy: actorId }).returning();
      const settled = cents === open;
      const stopped = settled ? await cancelQueueForCharges(x, companyId, [chargeId]) : 0; // quitou: as mensagens da régua param
      await audit(x, companyId, actorId, "receivable.payment_registered", { chargeId, paymentId: p.id, method: input.method, settled, hasExtras: (p0.interestCents ?? 0) > 0 || (p0.discountCents ?? 0) > 0, messagesStopped: stopped, ...auditExtra });
      return { paymentId: p.id, duplicate: false, settled };
}

/** Estorno: o pagamento fica no histórico como estornado (com motivo) e o saldo volta. Nunca apaga. */
export async function reversePayment(db: DB, actorId: string, companyId: string, paymentId: string, reason: string) {
  await requirePerm(db, actorId, companyId, "receivables.reverse");
  const why = (reason ?? "").replace(/[\r\n\t]+/g, " ").trim();
  if (why.length < 5 || why.length > 300) throw new Invalid("Informe o motivo (5 a 300 caracteres)");
  if (!uuidOk(paymentId)) throw new Invalid("Pagamento não encontrado");
  return db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    const [linked] = await x.execute(sql`select 1 from bank_allocations where company_id = ${companyId} and payment_id = ${paymentId} and status = 'ativa'`) as unknown as Row[];
    if (linked) throw new Invalid("Este pagamento veio da conciliação bancária: desfaça o vínculo em Conciliação");
    return reversePaymentTx(x, companyId, actorId, paymentId, why);
  });
}

/** Núcleo do estorno dentro de uma transação do chamador (também usado ao desfazer um vínculo bancário). */
export async function reversePaymentTx(x: DB, companyId: string, actorId: string, paymentId: string, why: string, auditExtra: Record<string, unknown> = {}) {
  const [p0] = await x.select({ chargeId: payments.chargeId }).from(payments).where(and(eq(payments.id, paymentId), eq(payments.companyId, companyId)));
  if (!p0) throw new Invalid("Pagamento não encontrado");
  await x.select({ id: charges.id }).from(charges).where(and(eq(charges.id, p0.chargeId), eq(charges.companyId, companyId))).for("update"); // mesma ordem de lock do registro
  const [p] = await x.select().from(payments).where(and(eq(payments.id, paymentId), eq(payments.companyId, companyId))).for("update");
  if (!p || p.status !== "ativo") throw new Invalid("Este pagamento já foi estornado");
  const now = new Date();
  await x.update(payments).set({ status: "estornado", reversedBy: actorId, reversedAt: now, reverseReason: why, updatedAt: now }).where(eq(payments.id, p.id));
  await audit(x, companyId, actorId, "receivable.payment_reversed", { chargeId: p.chargeId, paymentId: p.id, ...auditExtra });
  return { chargeId: p.chargeId };
}

export async function exportReceivables(db: DB, actorId: string, companyId: string, f: ListFilters = {}, today = todayManaus()) {
  await requirePerm(db, actorId, companyId, "receivables.export");
  const rows = await listReceivables(db, actorId, companyId, f, today).catch((e) => { throw e; });
  const br = (d: string) => d.split("-").reverse().join("/");
  const money = (c: number) => (c / 100).toFixed(2).replace(".", ",");
  const csv = toCsv([
    ["Cliente", "Descrição", "Competência", "Emissão", "Vencimento", "Valor", "Pago", "Juros/multa", "Descontos", "Saldo", "Situação", "Dias de atraso"],
    ...rows.map((r) => [r.customerName, r.description, `${r.competenceMonth.slice(5, 7)}/${r.competenceMonth.slice(0, 4)}`, br(r.issueDate), br(r.dueDate), money(r.amountCents), money(r.paidCents), money(r.interestCents), money(r.discountCents), money(r.openCents), SITUATION_LABEL[r.situation], String(r.overdueDays)]),
  ]);
  await db.insert(auditLog).values({ companyId, actorId, action: "receivable.exported", detail: { count: rows.length, status: f.status ?? "abertas" } });
  return csv;
}
