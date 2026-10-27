import { and, desc, eq, sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { auditLog, boletoCancelRequests, charges, issuanceRequests, users } from "@/lib/db/schema";
import { Forbidden, Invalid, requirePerm } from "@/modules/identity/service";
import type { Providers } from "@/modules/providers/types";
import { cancelBoleto } from "./cancel";

/**
 * E30 — PEDIDO de cancelamento de boleto por gerente/assistente (`boletos.request`). Quem CANCELA continua sendo só a diretoria (`boletos.cancel`, ADR-017).
 *  - Pedir: exige boleto emitido e nenhum pagamento; um pedido pendente por cobrança; motivo obrigatório.
 *  - Aprovar (diretoria): marca o pedido, executa o cancelamento NORMAL (`cancelBoleto`, com o nome de quem aprovou) e liga o pedido ao cancelamento.
 *    Se o cancelamento for recusado antes de ser enviado (ex.: pagamento chegou), o pedido volta a "pendente". Nada de dinheiro é movido.
 *  - Recusar (diretoria, com observação) e Retirar (quem pediu) não mexem no boleto.
 * Se o processo cair entre marcar e cancelar, o pedido fica "aprovado" sem cancelamento; passados 10 minutos a diretoria pode aprovar de novo para CONCLUIR (mesma regra do cancelamento preso).
 * Recusar vale a qualquer momento enquanto pendente (inclusive se a diretoria cancelou direto ou entrou pagamento: o pedido não fica preso na fila).
 */
const audit = (x: DB, companyId: string, actorId: string, action: string, detail: Record<string, unknown>) => x.insert(auditLog).values({ companyId, actorId, action, detail });
const uuidOk = (s: string) => /^[0-9a-f-]{36}$/i.test(s ?? "");
const clean = (s: string, label: string) => {
  const v = String(s ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  if (v.length < 3 || v.length > 200) throw new Invalid(`${label} (3 a 200 caracteres)`);
  return v;
};

export const REQUEST_STATUS_LABEL: Record<string, string> = { pendente: "Aguardando a diretoria", aprovado: "Aprovado", recusado: "Recusado", retirado: "Retirado" };

export async function requestBoletoCancel(db: DB, actorId: string, companyId: string, input: { chargeId: string; reason: string }) {
  await requirePerm(db, actorId, companyId, "boletos.request");
  if (!uuidOk(input.chargeId)) throw new Invalid("Cobrança não encontrada");
  const reason = clean(input.reason, "Explique o motivo do pedido");
  return db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    const [ch] = await x.select({ id: charges.id }).from(charges).where(and(eq(charges.id, input.chargeId), eq(charges.companyId, companyId))).for("update"); // mesma trava da baixa e do cancelamento
    if (!ch) throw new Invalid("Cobrança não encontrada");
    const [req] = await x.select({ id: issuanceRequests.id }).from(issuanceRequests).where(and(eq(issuanceRequests.companyId, companyId), eq(issuanceRequests.chargeId, input.chargeId), eq(issuanceRequests.kind, "boleto"), eq(issuanceRequests.status, "emitido")));
    if (!req) throw new Invalid("Esta cobrança não tem boleto emitido para cancelar");
    const [{ paid }] = (await x.execute(sql`select count(*)::int paid from payments where company_id = ${companyId} and charge_id = ${input.chargeId} and status = 'ativo'`)) as unknown as { paid: number }[];
    if (paid > 0) throw new Invalid("Esta cobrança tem pagamento registrado. Estorne o pagamento antes de pedir o cancelamento do boleto");
    const [dup] = await x.select({ id: boletoCancelRequests.id }).from(boletoCancelRequests).where(and(eq(boletoCancelRequests.companyId, companyId), eq(boletoCancelRequests.chargeId, input.chargeId), eq(boletoCancelRequests.status, "pendente")));
    if (dup) throw new Invalid("Já existe um pedido de cancelamento aguardando a diretoria para esta cobrança");
    const [r] = await x.insert(boletoCancelRequests).values({ companyId, chargeId: input.chargeId, reason, requestedBy: actorId }).returning({ id: boletoCancelRequests.id });
    await audit(x, companyId, actorId, "boleto.cancel_request_created", { requestId: r.id, chargeId: input.chargeId });
    return r.id;
  });
}

export async function withdrawCancelRequest(db: DB, actorId: string, companyId: string, requestId: string) {
  await requirePerm(db, actorId, companyId, "boletos.request");
  if (!uuidOk(requestId)) throw new Invalid("Pedido não encontrado");
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    const [r] = await x.select().from(boletoCancelRequests).where(and(eq(boletoCancelRequests.id, requestId), eq(boletoCancelRequests.companyId, companyId))).for("update");
    if (!r) throw new Invalid("Pedido não encontrado");
    if (r.requestedBy !== actorId) throw new Forbidden("Só quem fez o pedido pode retirá-lo");
    if (r.status !== "pendente") throw new Invalid("Este pedido já foi decidido");
    await x.update(boletoCancelRequests).set({ status: "retirado", decidedBy: actorId, decidedAt: new Date(), updatedAt: new Date() }).where(eq(boletoCancelRequests.id, r.id));
    await audit(x, companyId, actorId, "boleto.cancel_request_withdrawn", { requestId: r.id, chargeId: r.chargeId });
  });
}

/** Diretoria decide. Aprovar executa o cancelamento (pode terminar "sem resposta conclusiva" — ver a cobrança). */
export const STUCK_MS = 10 * 60_000; // aprovado sem cancelamento há mais que isso = o processo caiu no meio: a diretoria pode concluir
export async function decideCancelRequest(db: DB, actorId: string, companyId: string, requestId: string, decision: "aprovar" | "recusar", note = "", providers?: Providers, now = new Date()) {
  await requirePerm(db, actorId, companyId, "boletos.cancel");
  if (!uuidOk(requestId)) throw new Invalid("Pedido não encontrado");
  const why = String(note ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (decision === "recusar" && why.length < 3) throw new Invalid("Explique por que o pedido foi recusado (3 a 200 caracteres)");
  // 1) reservar a decisão
  const r = await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    const [q] = await x.select().from(boletoCancelRequests).where(and(eq(boletoCancelRequests.id, requestId), eq(boletoCancelRequests.companyId, companyId))).for("update");
    if (!q) throw new Invalid("Pedido não encontrado");
    const stuck = decision === "aprovar" && q.status === "aprovado" && !q.cancellationId && !!q.decidedAt && now.getTime() - q.decidedAt.getTime() > STUCK_MS;
    if (q.status !== "pendente" && !stuck) throw new Invalid("Este pedido já foi decidido");
    await x.update(boletoCancelRequests).set({ status: decision === "aprovar" ? "aprovado" : "recusado", decidedBy: actorId, decidedAt: now, decisionNote: why || null, updatedAt: now }).where(eq(boletoCancelRequests.id, q.id));
    if (decision === "recusar") await audit(x, companyId, actorId, "boleto.cancel_request_refused", { requestId: q.id, chargeId: q.chargeId });
    return q;
  });
  if (decision === "recusar") return { status: "recusado" as const };
  // 2) cancelar de verdade (fora de transação, como o motor de cancelamento exige)
  const revert = () => db.update(boletoCancelRequests).set({ status: "pendente", decidedBy: null, decidedAt: null, decisionNote: null, updatedAt: new Date() }).where(and(eq(boletoCancelRequests.id, r.id), eq(boletoCancelRequests.companyId, companyId), eq(boletoCancelRequests.status, "aprovado"), sql`${boletoCancelRequests.cancellationId} is null`));
  try {
    const out = await cancelBoleto(db, actorId, companyId, { chargeId: r.chargeId, reason: `Pedido aprovado: ${r.reason}`.slice(0, 200), confirm: true }, providers);
    await db.update(boletoCancelRequests).set({ cancellationId: out.cancellationId, updatedAt: new Date() }).where(eq(boletoCancelRequests.id, r.id));
    await audit(db, companyId, actorId, "boleto.cancel_request_approved", { requestId: r.id, chargeId: r.chargeId, cancellationId: out.cancellationId, result: out.status });
    return { status: "aprovado" as const, result: out.status, cancellationId: out.cancellationId };
  } catch (e) {
    await revert(); // não foi possível nem iniciar o cancelamento (ex.: pagamento chegou, boleto já cancelado): o pedido volta para a fila
    throw e;
  }
}

export type CancelRequestRow = { stuck: boolean; id: string; chargeId: string; reason: string; status: string; requestedByName: string; requestedBy: string; createdAt: Date; decidedByName: string | null; decidedAt: Date | null; decisionNote: string | null; cancellationId: string | null };
export async function cancelRequestsForCharge(db: DB, actorId: string, companyId: string, chargeId: string): Promise<CancelRequestRow[]> {
  await requirePerm(db, actorId, companyId, "issuance.read");
  if (!uuidOk(chargeId)) return [];
  const rq = db.select({ id: boletoCancelRequests.id, chargeId: boletoCancelRequests.chargeId, reason: boletoCancelRequests.reason, status: boletoCancelRequests.status, requestedBy: boletoCancelRequests.requestedBy, createdAt: boletoCancelRequests.createdAt, decidedAt: boletoCancelRequests.decidedAt, decisionNote: boletoCancelRequests.decisionNote, cancellationId: boletoCancelRequests.cancellationId, by: users.name })
    .from(boletoCancelRequests).innerJoin(users, eq(users.id, boletoCancelRequests.requestedBy)).where(and(eq(boletoCancelRequests.companyId, companyId), eq(boletoCancelRequests.chargeId, chargeId))).orderBy(desc(boletoCancelRequests.createdAt)).limit(20);
  const list = await rq;
  const dec = await db.select({ id: boletoCancelRequests.id, name: users.name }).from(boletoCancelRequests).innerJoin(users, eq(users.id, boletoCancelRequests.decidedBy)).where(and(eq(boletoCancelRequests.companyId, companyId), eq(boletoCancelRequests.chargeId, chargeId)));
  const dn = new Map(dec.map((d) => [d.id, d.name]));
  const now = Date.now();
  return list.map((r) => ({ stuck: r.status === "aprovado" && !r.cancellationId && !!r.decidedAt && now - r.decidedAt.getTime() > STUCK_MS, id: r.id, chargeId: r.chargeId, reason: r.reason, status: r.status, requestedBy: r.requestedBy, requestedByName: r.by, createdAt: r.createdAt, decidedByName: dn.get(r.id) ?? null, decidedAt: r.decidedAt, decisionNote: r.decisionNote, cancellationId: r.cancellationId }));
}

/** Para o painel da diretoria: quantos pedidos aguardam decisão. */
export async function pendingCancelRequests(db: DB, actorId: string, companyId: string) {
  await requirePerm(db, actorId, companyId, "boletos.cancel");
  const r = (await db.execute(sql`select q.id::text, q.charge_id::text, q.reason, q.created_at, u.name requester, cu.display_name customer, c.amount::text amount from boleto_cancel_requests q
    join users u on u.id = q.requested_by join charges c on c.company_id = q.company_id and c.id = q.charge_id join customers cu on cu.company_id = c.company_id and cu.id = c.customer_id
    where q.company_id = ${companyId} and q.status = 'pendente' order by q.created_at limit 100`)) as unknown as Record<string, unknown>[];
  return r.map((x) => ({ id: String(x.id), chargeId: String(x.charge_id), reason: String(x.reason), requester: String(x.requester), customer: String(x.customer), amount: String(x.amount), createdAt: x.created_at as Date }));
}
