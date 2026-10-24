import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { auditLog, chargeAdjustments, charges, contracts } from "@/lib/db/schema";
import { MAX_CENTS, centsFromNumeric, numericFromCents, parseMoneyToCents } from "@/lib/money";
import { Invalid, requirePerm } from "@/modules/identity/service";
import { addMonths } from "./calendar";
import { loadScheduledMany } from "./service";

/**
 * Ajustes da competência (E05c; remover = marcar como removido, o histórico fica): EXCEDENTE (K3G Call: calculado em outro sistema e lançado à mão), ACRÉSCIMO e DESCONTO.
 * O valor da cobrança na prévia do lote = valor do contrato + ajustes da competência. Travados quando a cobrança está em lote APROVADO
 * (para alterar, reabrir o lote). Serializam com o lote pelo mesmo lock de empresa, então a aprovação nunca perde um ajuste concorrente.
 */
export const ADJ_KINDS = ["excedente", "acrescimo", "desconto"] as const;
export type AdjKind = (typeof ADJ_KINDS)[number];
export const ADJ_LABEL: Record<AdjKind, string> = { excedente: "Excedente", acrescimo: "Acréscimo", desconto: "Desconto" };
export const signed = (kind: string, cents: number) => (kind === "desconto" ? -cents : cents);
export const MAX_PER_COMPETENCE = 10;

const lockCompany = (x: DB, companyId: string) => x.execute(sql`select pg_advisory_xact_lock(hashtext(${"billing-batch:" + companyId}))`);
const audit = (x: DB, companyId: string, actorId: string, action: string, detail: Record<string, unknown>) => x.insert(auditLog).values({ companyId, actorId, action, detail });
const competenceOk = (c: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(c);
const key = (contractId: string, competence: string) => `${contractId}|${competence.slice(0, 7)}`;

export type AdjRow = { id: string; kind: AdjKind; description: string; amountCents: number };

/** Ajustes por (contrato, competência). Sem checagem de permissão: quem chama autoriza. */
export async function adjustmentsFor(x: DB, companyId: string, pairs: { contractId: string; competence: string }[]) {
  const out = new Map<string, { totalCents: number; items: AdjRow[] }>();
  if (pairs.length === 0) return out;
  const rows = await x.select().from(chargeAdjustments).where(and(eq(chargeAdjustments.companyId, companyId), isNull(chargeAdjustments.removedAt), inArray(chargeAdjustments.contractId, [...new Set(pairs.map((p) => p.contractId))]),
    inArray(chargeAdjustments.competenceMonth, [...new Set(pairs.map((p) => `${p.competence.slice(0, 7)}-01`))]))).orderBy(asc(chargeAdjustments.createdAt));
  for (const r of rows) {
    const k = key(r.contractId, r.competenceMonth); const e = out.get(k) ?? { totalCents: 0, items: [] };
    const c = centsFromNumeric(r.amount); e.totalCents += signed(r.kind, c); e.items.push({ id: r.id, kind: r.kind as AdjKind, description: r.description, amountCents: c }); out.set(k, e);
  }
  return out;
}

/** Contratos faturáveis na competência, com valor base, ajustes e se já estão travados (cobrança em lote aprovado). */
export async function listCompetence(db: DB, actorId: string, companyId: string, competence: string) {
  await requirePerm(db, actorId, companyId, "billing.read");
  if (!competenceOk(competence)) return [];
  const sched = await loadScheduledMany(db, companyId, [competence, addMonths(competence, 1)]);
  const byContract = new Map<string, { contractId: string; customerName: string; description: string; baseCents: number }>();
  for (const m of sched.values()) for (const { item } of m.entries) if (item.competenceMonth === competence && !item.review && item.dueDate) byContract.set(item.contractId, { contractId: item.contractId, customerName: item.customerName, description: item.description, baseCents: item.amountCents });
  const list = [...byContract.values()];
  if (list.length === 0) return [];
  const adj = await adjustmentsFor(db, companyId, list.map((l) => ({ contractId: l.contractId, competence })));
  const ch = await db.select({ contractId: charges.contractId, status: charges.status }).from(charges).where(and(eq(charges.companyId, companyId), eq(charges.competenceMonth, `${competence}-01`), inArray(charges.contractId, list.map((l) => l.contractId)), sql`${charges.status} <> 'cancelada'`));
  const st = new Map(ch.map((c) => [c.contractId, c.status]));
  return list.map((l) => { const a = adj.get(key(l.contractId, competence)); return { ...l, adjustments: a?.items ?? [], adjustmentCents: a?.totalCents ?? 0, totalCents: l.baseCents + (a?.totalCents ?? 0), chargeStatus: st.get(l.contractId) ?? null, locked: st.get(l.contractId) === "aprovada" }; })
    .sort((a, b) => a.customerName.localeCompare(b.customerName));
}

export type AdjInput = { contractId: string; competence: string; kind: string; description: string; amount: string };

export async function addAdjustment(db: DB, actorId: string, companyId: string, i: AdjInput) {
  await requirePerm(db, actorId, companyId, "billing.write");
  if (!competenceOk(i.competence ?? "")) throw new Invalid("Competência inválida");
  if (!(ADJ_KINDS as readonly string[]).includes(i.kind)) throw new Invalid("Tipo de ajuste inválido");
  const description = (i.description ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (description.length < 2) throw new Invalid("Descreva o ajuste (2 a 120 caracteres)");
  const cents = parseMoneyToCents(i.amount ?? "");
  if (cents === null || cents <= 0) throw new Invalid("Informe um valor válido, maior que zero");
  if (!/^[0-9a-f-]{36}$/i.test(i.contractId ?? "")) throw new Invalid("Contrato não encontrado");
  return db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await lockCompany(x, companyId);
    const [c] = await x.select({ id: contracts.id }).from(contracts).where(and(eq(contracts.id, i.contractId), eq(contracts.companyId, companyId)));
    if (!c) throw new Invalid("Contrato não encontrado");
    const sched = await loadScheduledMany(x, companyId, [i.competence, addMonths(i.competence, 1)]);
    let base: number | null = null;
    for (const m of sched.values()) for (const { item } of m.entries) if (item.contractId === i.contractId && item.competenceMonth === i.competence && !item.review && item.dueDate) base = item.amountCents;
    if (base === null) throw new Invalid("Este contrato não é faturável nesta competência (inativo, fora da vigência ou data a revisar)");
    const [locked] = await x.select({ id: charges.id }).from(charges).where(and(eq(charges.companyId, companyId), eq(charges.contractId, i.contractId), eq(charges.competenceMonth, `${i.competence}-01`), eq(charges.status, "aprovada")));
    if (locked) throw new Invalid("A cobrança desta competência já está em lote aprovado: reabra o lote para ajustar");
    const cur = (await adjustmentsFor(x, companyId, [{ contractId: i.contractId, competence: i.competence }])).get(key(i.contractId, i.competence));
    if ((cur?.items.length ?? 0) >= MAX_PER_COMPETENCE) throw new Invalid(`No máximo ${MAX_PER_COMPETENCE} ajustes por contrato e competência`);
    const final = base + (cur?.totalCents ?? 0) + signed(i.kind, cents);
    if (final <= 0) throw new Invalid("O valor final da cobrança precisa continuar maior que zero");
    if (final > MAX_CENTS) throw new Invalid("O valor final da cobrança passa do limite suportado (R$ 99.999.999.999,99)");
    const [r] = await x.insert(chargeAdjustments).values({ companyId, contractId: i.contractId, competenceMonth: `${i.competence}-01`, kind: i.kind, description, amount: numericFromCents(cents), createdBy: actorId }).returning({ id: chargeAdjustments.id });
    await audit(x, companyId, actorId, "billing.adjustment.added", { adjustmentId: r.id, contractId: i.contractId, competence: i.competence, kind: i.kind });
    return r.id;
  });
}

export async function removeAdjustment(db: DB, actorId: string, companyId: string, id: string) {
  await requirePerm(db, actorId, companyId, "billing.write");
  if (!/^[0-9a-f-]{36}$/i.test(id ?? "")) throw new Invalid("Ajuste não encontrado");
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await lockCompany(x, companyId);
    const [a] = await x.select().from(chargeAdjustments).where(and(eq(chargeAdjustments.id, id), eq(chargeAdjustments.companyId, companyId), isNull(chargeAdjustments.removedAt)));
    if (!a) throw new Invalid("Ajuste não encontrado");
    const [locked] = await x.select({ id: charges.id }).from(charges).where(and(eq(charges.companyId, companyId), eq(charges.contractId, a.contractId), eq(charges.competenceMonth, a.competenceMonth), eq(charges.status, "aprovada")));
    if (locked) throw new Invalid("A cobrança desta competência já está em lote aprovado: reabra o lote para ajustar");
    await x.update(chargeAdjustments).set({ removedBy: actorId, removedAt: new Date(), updatedAt: new Date() }).where(eq(chargeAdjustments.id, id)); // não apaga: fica no histórico
    await audit(x, companyId, actorId, "billing.adjustment.removed", { adjustmentId: id, contractId: a.contractId, competence: a.competenceMonth.slice(0, 7), kind: a.kind });
  });
}
