import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { auditLog, commissionLines, commissionStatements, contracts } from "@/lib/db/schema";
import { toCsv } from "@/lib/csv";
import { isIsoDate } from "@/lib/iso-date";
import { centsFromNumeric, numericFromCents } from "@/lib/money";
import { Invalid, requirePerm } from "@/modules/identity/service";
import { todayManaus } from "@/modules/messaging/service";
import { commissionCents, parsePercent, payDateOf, percentLabel } from "./calc";

/**
 * E18 — comissão de parceiros (ex.: Medina). Regra do dono: no dia 16 paga-se, ao parceiro, o percentual de CADA contrato marcado sobre o
 * VALOR MENSAL do contrato, das cobranças RECEBIDAS (quitadas) no mês anterior. O sistema NÃO paga: calcula, congela (fechamento) e registra o pagamento feito à mão.
 */
const audit = (x: DB, companyId: string, actorId: string, action: string, detail: Record<string, unknown>) => x.insert(auditLog).values({ companyId, actorId, action, detail });
const uuidOk = (s: string) => /^[0-9a-f-]{36}$/i.test(s);
const monthOk = (m: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
const cleanPartner = (p: string) => p.replace(/\s+/g, " ").trim();
const pgMessage = (e: unknown) => (e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message ?? "";

export type PreviewLine = { chargeId: string; contractId: string; customerId: string; customerName: string; competenceMonth: string; receivedOn: string; baseCents: number; bps: number; commissionCents: number };
export type MissingPercent = { contractId: string; customerName: string; baseCents: number };

/** Define (ou limpa) a marca de parceiro e o percentual de UM contrato. Só vale para os próximos fechamentos; fechamentos feitos não mudam. */
export async function setContractCommission(db: DB, actorId: string, companyId: string, contractId: string, input: { partner: string; percent: string }) {
  await requirePerm(db, actorId, companyId, "commissions.manage");
  if (!uuidOk(contractId)) throw new Invalid("Contrato não encontrado");
  const partner = cleanPartner(input.partner ?? "");
  let bps: number | null = null;
  if (partner) {
    if (partner.length < 2 || partner.length > 60) throw new Invalid("O nome do parceiro deve ter de 2 a 60 caracteres");
    if (input.percent.trim()) { bps = parsePercent(input.percent); if (bps === null) throw new Invalid("Percentual inválido (use de 0,01 a 100, por exemplo 30 ou 12,5)"); }
  }
  return db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    const [c] = await x.select({ id: contracts.id, partner: contracts.commissionPartner, bps: contracts.commissionBps }).from(contracts).where(and(eq(contracts.id, contractId), eq(contracts.companyId, companyId))).for("update");
    if (!c) throw new Invalid("Contrato não encontrado");
    // Mudar o parceiro ou o percentual JÁ definido com recebimentos ainda fora de um fechamento reescreveria o que já se qualificou: fecha-se o mês antes.
    const changing = !!c.partner && (c.partner !== (partner || null) || (c.bps !== null && c.bps !== bps));
    if (changing) {
      const [{ n }] = await x.execute<{ n: number }>(sql`select count(*)::int as n from charges c
        join billing_batches b on b.company_id = c.company_id and b.id = c.batch_id and b.status = 'aprovado'
        join lateral (select sum(amount) as paid from payments where company_id = c.company_id and charge_id = c.id and status = 'ativo') p on true
        where c.company_id = ${companyId} and c.contract_id = ${contractId} and c.status = 'aprovada' and p.paid >= c.amount
          and not exists (select 1 from commission_lines l where l.company_id = c.company_id and l.charge_id = c.id and l.voided_at is null)`);
      if (n > 0) throw new Invalid(`Este contrato tem ${n} cobrança(s) recebida(s) que ainda não entraram em um fechamento de comissão. Feche o mês (ou cancele o recebimento) antes de mudar o parceiro ou o percentual`);
    }
    await x.update(contracts).set({ commissionPartner: partner || null, commissionBps: bps, updatedAt: new Date() }).where(and(eq(contracts.id, contractId), eq(contracts.companyId, companyId)));
    await audit(x, companyId, actorId, "commission.contract_set", { contractId, hadPartner: !!c.partner, partnerSet: !!partner, bpsBefore: c.bps, bpsAfter: bps });
  });
}

/** Cobranças marcadas, QUITADAS (principal pago ≥ valor) com a última baixa ativa em `month`, que ainda não estão em fechamento válido. */
async function receivedIn(db: DB, companyId: string, partner: string, month: string) {
  const from = `${month}-01`;
  const rows = await db.execute<{ charge_id: string; contract_id: string; customer_id: string; customer_name: string; competence_month: string; received_on: string; base_amount: string; bps: number | null }>(sql`
    select c.id as charge_id, c.contract_id, c.customer_id, cu.display_name as customer_name, c.competence_month::text as competence_month,
           p.received_on::text as received_on, c.base_amount::text as base_amount, k.commission_bps as bps
    from charges c
    join billing_batches b on b.company_id = c.company_id and b.id = c.batch_id and b.status = 'aprovado'
    join contracts k on k.company_id = c.company_id and k.id = c.contract_id
    join customers cu on cu.company_id = c.company_id and cu.id = c.customer_id
    join lateral (select sum(amount) as paid, max(paid_at) as received_on from payments where company_id = c.company_id and charge_id = c.id and status = 'ativo') p on true
    where c.company_id = ${companyId} and c.status = 'aprovada' and k.commission_partner = ${partner}
      and p.paid >= c.amount and p.received_on >= ${from}::date and p.received_on < (${from}::date + interval '1 month')
      and not exists (select 1 from commission_lines l where l.company_id = c.company_id and l.charge_id = c.id and l.voided_at is null)
    order by cu.display_name, c.competence_month`);
  const lines: PreviewLine[] = [], missing: MissingPercent[] = [];
  for (const r of rows) {
    const baseCents = centsFromNumeric(r.base_amount);
    if (r.bps === null) { missing.push({ contractId: r.contract_id, customerName: r.customer_name, baseCents }); continue; }
    lines.push({ chargeId: r.charge_id, contractId: r.contract_id, customerId: r.customer_id, customerName: r.customer_name, competenceMonth: r.competence_month, receivedOn: r.received_on, baseCents, bps: r.bps, commissionCents: commissionCents(baseCents, r.bps) });
  }
  return { lines, missing };
}

export const sumCents = (l: { commissionCents: number }[]) => l.reduce((s, x) => s + x.commissionCents, 0);

/** Parceiros que existem hoje nos contratos da empresa (para o seletor da tela). */
export async function listPartners(db: DB, actorId: string, companyId: string) {
  await requirePerm(db, actorId, companyId, "commissions.read");
  const rows = await db.execute<{ partner: string; contracts: number; without_percent: number }>(sql`
    select commission_partner as partner, count(*)::int as contracts, count(*) filter (where commission_bps is null)::int as without_percent
    from contracts where company_id = ${companyId} and commission_partner is not null group by commission_partner order by commission_partner`);
  return rows.map((r) => ({ partner: r.partner, contracts: r.contracts, withoutPercent: r.without_percent }));
}

/** Tela do mês: o fechamento válido (se houver, congelado) + o que ainda está pendente de entrar nele. */
export async function monthView(db: DB, actorId: string, companyId: string, partner: string, month: string) {
  await requirePerm(db, actorId, companyId, "commissions.read");
  if (!monthOk(month)) throw new Invalid("Mês inválido");
  partner = cleanPartner(partner);
  const [st] = await db.select().from(commissionStatements).where(and(eq(commissionStatements.companyId, companyId), eq(commissionStatements.partner, partner), eq(commissionStatements.month, `${month}-01`), sql`${commissionStatements.status} <> 'cancelado'`));
  const pending = await receivedIn(db, companyId, partner, month);
  let closed: PreviewLine[] = [], reversed = new Set<string>();
  if (st) {
    const rows = await db.select().from(commissionLines).where(and(eq(commissionLines.companyId, companyId), eq(commissionLines.statementId, st.id))).orderBy(asc(commissionLines.customerName), asc(commissionLines.competenceMonth));
    closed = rows.map((l) => ({ chargeId: l.chargeId, contractId: l.contractId, customerId: l.customerId, customerName: l.customerName, competenceMonth: l.competenceMonth, receivedOn: l.receivedOn, baseCents: centsFromNumeric(l.baseAmount), bps: l.bps, commissionCents: centsFromNumeric(l.commissionAmount) }));
    // baixa estornada DEPOIS do fechamento: o fechamento não muda, mas a pessoa precisa saber
    const rev = await db.execute<{ charge_id: string }>(sql`select l.charge_id from commission_lines l join charges c on c.company_id = l.company_id and c.id = l.charge_id
      where l.company_id = ${companyId} and l.statement_id = ${st.id} and (c.status <> 'aprovada' or coalesce((select sum(amount) from payments where company_id = c.company_id and charge_id = c.id and status = 'ativo'), 0) < c.amount)`);
    reversed = new Set(rev.map((r) => r.charge_id));
  }
  return {
    partner, month, payDate: payDateOf(month),
    statement: st ? { id: st.id, status: st.status as "fechado" | "pago", totalCents: centsFromNumeric(st.totalAmount), paidOn: st.paidOn, paidNote: st.paidNote } : null,
    closed, reversedChargeIds: [...reversed],
    pending: pending.lines, pendingTotalCents: sumCents(pending.lines), missing: pending.missing,
  };
}

/** Fecha o mês: congela as linhas pendentes. Bloqueia se houver contrato marcado sem percentual com recebimento no mês. */
export async function closeMonth(db: DB, actorId: string, companyId: string, partner: string, month: string, today = todayManaus()) {
  await requirePerm(db, actorId, companyId, "commissions.manage");
  if (!monthOk(month)) throw new Invalid("Mês inválido");
  partner = cleanPartner(partner);
  if (!partner) throw new Invalid("Informe o parceiro");
  if (month >= today.slice(0, 7)) throw new Invalid("O mês ainda não terminou: feche a comissão depois que o mês acabar");
  try {
    return await db.transaction(async (tx) => {
      const x = tx as unknown as DB;
      await x.execute(sql`select pg_advisory_xact_lock(hashtext(${"commission:" + companyId + ":" + partner}))`);
      const [open] = await x.select({ id: commissionStatements.id }).from(commissionStatements).where(and(eq(commissionStatements.companyId, companyId), eq(commissionStatements.partner, partner), eq(commissionStatements.month, `${month}-01`), sql`${commissionStatements.status} <> 'cancelado'`));
      if (open) throw new Invalid("Este mês já foi fechado para este parceiro");
      const { lines, missing } = await receivedIn(x, companyId, partner, month);
      if (missing.length) throw new Invalid(`Defina o percentual de ${missing.length} contrato(s) antes de fechar: ${[...new Set(missing.map((m) => m.customerName))].slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}`);
      if (!lines.length) throw new Invalid("Nenhuma cobrança deste parceiro foi recebida nesse mês");
      const total = sumCents(lines);
      const [st] = await x.insert(commissionStatements).values({ companyId, partner, month: `${month}-01`, totalAmount: numericFromCents(total), lineCount: lines.length, closedBy: actorId }).returning({ id: commissionStatements.id });
      await x.insert(commissionLines).values(lines.map((l) => ({ companyId, statementId: st.id, chargeId: l.chargeId, contractId: l.contractId, customerId: l.customerId, customerName: l.customerName, competenceMonth: l.competenceMonth, receivedOn: l.receivedOn, baseAmount: numericFromCents(l.baseCents), bps: l.bps, commissionAmount: numericFromCents(l.commissionCents) })));
      await audit(x, companyId, actorId, "commission.closed", { statementId: st.id, month, lines: lines.length });
      return { statementId: st.id, lines: lines.length, totalCents: total };
    });
  } catch (e) {
    if (e instanceof Invalid) throw e;
    const m = pgMessage(e);
    if (/commission_lines_charge_uq|commission_statements_one_uq/.test(m)) throw new Invalid("Outro fechamento acabou de incluir estas cobranças: recarregue a tela");
    throw e;
  }
}

export async function markPaid(db: DB, actorId: string, companyId: string, statementId: string, input: { paidOn: string; note?: string }, today = todayManaus()) {
  await requirePerm(db, actorId, companyId, "commissions.manage");
  if (!uuidOk(statementId)) throw new Invalid("Fechamento não encontrado");
  if (!isIsoDate(input.paidOn ?? "")) throw new Invalid("Data do pagamento inválida");
  if (input.paidOn > today) throw new Invalid("A data do pagamento não pode ser futura");
  const note = (input.note ?? "").replace(/[\r\n\t]+/g, " ").trim();
  if (note.length > 200) throw new Invalid("A observação passa de 200 caracteres");
  return db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    const [st] = await x.select().from(commissionStatements).where(and(eq(commissionStatements.id, statementId), eq(commissionStatements.companyId, companyId))).for("update");
    if (!st) throw new Invalid("Fechamento não encontrado");
    if (st.status !== "fechado") throw new Invalid(st.status === "pago" ? "Este fechamento já foi pago" : "Fechamento cancelado");
    if (input.paidOn < st.month) throw new Invalid("O pagamento não pode ser anterior ao mês de recebimento");
    await x.update(commissionStatements).set({ status: "pago", paidOn: input.paidOn, paidBy: actorId, paidNote: note || null, updatedAt: new Date() }).where(and(eq(commissionStatements.id, statementId), eq(commissionStatements.companyId, companyId)));
    await audit(x, companyId, actorId, "commission.paid", { statementId, paidOn: input.paidOn });
  });
}

/** Cancela um fechamento ainda NÃO pago (erro de baixa, percentual errado…). As linhas ficam no histórico (anuladas) e as cobranças voltam a poder entrar em outro fechamento. */
export async function cancelStatement(db: DB, actorId: string, companyId: string, statementId: string, reason: string) {
  await requirePerm(db, actorId, companyId, "commissions.manage");
  if (!uuidOk(statementId)) throw new Invalid("Fechamento não encontrado");
  const why = (reason ?? "").replace(/[\r\n\t]+/g, " ").trim();
  if (why.length < 3 || why.length > 200) throw new Invalid("Explique o motivo (3 a 200 caracteres)");
  return db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    const [st] = await x.select().from(commissionStatements).where(and(eq(commissionStatements.id, statementId), eq(commissionStatements.companyId, companyId))).for("update");
    if (!st) throw new Invalid("Fechamento não encontrado");
    if (st.status !== "fechado") throw new Invalid(st.status === "pago" ? "Fechamento pago não pode ser cancelado" : "Fechamento já cancelado");
    const now = new Date();
    await x.update(commissionStatements).set({ status: "cancelado", cancelledBy: actorId, cancelledAt: now, cancelReason: why, updatedAt: now }).where(and(eq(commissionStatements.id, statementId), eq(commissionStatements.companyId, companyId)));
    await x.update(commissionLines).set({ voidedAt: now, updatedAt: now }).where(and(eq(commissionLines.statementId, statementId), eq(commissionLines.companyId, companyId))); // o banco só aceita depois do fechamento estar cancelado
    await audit(x, companyId, actorId, "commission.cancelled", { statementId, month: st.month });
  });
}

/** Histórico de fechamentos de um parceiro (mais recentes primeiro). */
export async function listStatements(db: DB, actorId: string, companyId: string, partner: string) {
  await requirePerm(db, actorId, companyId, "commissions.read");
  const rows = await db.select().from(commissionStatements).where(and(eq(commissionStatements.companyId, companyId), eq(commissionStatements.partner, cleanPartner(partner)))).orderBy(desc(commissionStatements.month), desc(commissionStatements.createdAt)).limit(36);
  return rows.map((r) => ({ id: r.id, month: r.month.slice(0, 7), status: r.status as "fechado" | "pago" | "cancelado", totalCents: centsFromNumeric(r.totalAmount), lines: r.lineCount, paidOn: r.paidOn, payDate: payDateOf(r.month.slice(0, 7)) }));
}

export async function exportStatementCsv(db: DB, actorId: string, companyId: string, partner: string, month: string) {
  const v = await monthView(db, actorId, companyId, partner, month);
  const fmt = (c: number) => `${Math.floor(c / 100)},${String(c % 100).padStart(2, "0")}`;
  const rows = v.statement ? v.closed : v.pending;
  return toCsv([["cliente", "competencia", "recebido_em", "valor_mensal", "percentual", "comissao"], ...rows.map((l) => [l.customerName, l.competenceMonth.slice(0, 7), l.receivedOn, fmt(l.baseCents), percentLabel(l.bps), fmt(l.commissionCents)]), ["TOTAL", "", "", "", "", fmt(sumCents(rows))]]);
}

