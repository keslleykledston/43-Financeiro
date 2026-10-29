import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { auditLog, boletoCancellations, charges, issuanceRequests, users } from "@/lib/db/schema";
import { Invalid, requirePerm } from "@/modules/identity/service";
import { cancelQueueForCharges } from "@/modules/messaging/service";
import { resolveProvidersForMode } from "@/modules/providers/registry";
import type { Providers } from "@/modules/providers/types";

/**
 * E20 — CANCELAR BOLETO pela plataforma (autorizado pelo dono em 2026-10-24; ADR-017). SOMENTE a diretoria (`boletos.cancel`), com motivo e confirmação.
 * Só cancela boleto EMITIDO e SEM nenhum pagamento registrado. Não mexe em dinheiro: só pede ao provedor que invalide o boleto.
 * Mesmo padrão do motor de emissão: 1) RESERVAR (registro `enviando`) 2) CHAMAR o provedor fora de transação 3) REGISTRAR o resultado.
 * Resposta perdida/erro inesperado vira `desconhecido`: a diretoria "reconsulta" (status no provedor) antes de qualquer nova tentativa.
 * Tudo fica registrado: `boleto_cancellations` (imutável, o banco recusa mudar quem/quando/por quê) + auditoria.
 */
const audit = (x: DB, companyId: string, actorId: string, action: string, detail: Record<string, unknown>) => x.insert(auditLog).values({ companyId, actorId, action, detail });
const uuidOk = (s: string) => /^[0-9a-f-]{36}$/i.test(s);
const lock = (x: DB, companyId: string) => x.execute(sql`select pg_advisory_xact_lock(hashtext(${"issuance:" + companyId}))`);
export const MAX_CANCEL_ATTEMPTS = 5;
const STUCK_MS = 10 * 60_000;
const safeCode = (m: string) => (/^[a-z0-9_]{1,40}$/.test(m) ? m : "erro_provedor");

export const CANCEL_STATUS_LABEL: Record<string, string> = { enviando: "Enviando", cancelado: "Cancelado", desconhecido: "Sem resposta conclusiva", falhou: "Não cancelado" };
export const CANCEL_ERROR_LABEL: Record<string, string> = { boleto_pago: "o provedor informa que o boleto já foi pago", boleto_inexistente: "o provedor não encontrou o boleto", tentativas_esgotadas: "tentativas esgotadas: confira no provedor", erro_provedor: "o provedor recusou o cancelamento", timeout: "o provedor não respondeu a tempo", erro_desconhecido: "falha sem resposta conclusiva" };

type Row = Record<string, unknown>;
/** `confirmLive`: confirmação ESPECÍFICA de cancelar um boleto REAL (Cora produção), conferida no servidor, além da confirmação genérica. */
export type CancelInput = { chargeId: string; reason: string; confirm: boolean; confirmLive?: boolean };

const cleanReason = (r: string) => {
  const v = (r ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  if (v.length < 3 || v.length > 200) throw new Invalid("Explique o motivo do cancelamento (3 a 200 caracteres)");
  return v;
};

/** Chama o provedor (fora de transação) e registra o resultado. `row` já está reservado como `enviando`. */
async function attempt(db: DB, companyId: string, actorId: string, row: { id: string; requestId: string; chargeId: string; externalRef: string; attempts: number }, prov: Providers) {
  const finish = async (status: "cancelado" | "falhou" | "desconhecido", lastError: string | null) => {
    await db.transaction(async (tx) => {
      const x = tx as unknown as DB;
      const done = status !== "desconhecido";
      const res = await x.update(boletoCancellations).set({ status, lastError, resolvedAt: done ? new Date() : null, updatedAt: new Date() })
        .where(and(eq(boletoCancellations.id, row.id), eq(boletoCancellations.companyId, companyId), eq(boletoCancellations.attempts, row.attempts), inArray(boletoCancellations.status, ["enviando", "desconhecido"]))).returning({ id: boletoCancellations.id });
      if (res.length === 0) return; // outra tentativa (reconsulta) assumiu ou já decidiu: só vale o resultado da tentativa mais recente
      if (status === "cancelado") {
        // o boleto deixou de existir: a solicitação sai da lista de ativas (permite emitir outro, com chave nova) e a régua da cobrança para
        await x.update(issuanceRequests).set({ status: "cancelado", externalStatus: "cancelado", updatedAt: new Date() }).where(and(eq(issuanceRequests.id, row.requestId), eq(issuanceRequests.companyId, companyId)));
        await cancelQueueForCharges(x, companyId, [row.chargeId]);
        await audit(x, companyId, actorId, "boleto.cancelled", { cancellationId: row.id, chargeId: row.chargeId, requestId: row.requestId, attempts: row.attempts });
      } else if (status === "falhou") {
        if (lastError === "boleto_pago") { // o provedor diz que foi pago: a cobrança precisa de conferência/baixa, e a régua não deve mais cobrar
          await x.update(issuanceRequests).set({ externalStatus: "pago", updatedAt: new Date() }).where(and(eq(issuanceRequests.id, row.requestId), eq(issuanceRequests.companyId, companyId)));
          await cancelQueueForCharges(x, companyId, [row.chargeId]);
          await audit(x, companyId, actorId, "boleto.paid_at_provider", { cancellationId: row.id, chargeId: row.chargeId, requestId: row.requestId });
        }
        await audit(x, companyId, actorId, "boleto.cancel_failed", { cancellationId: row.id, chargeId: row.chargeId, error: lastError });
      } else {
        await audit(x, companyId, actorId, "boleto.cancel_unknown", { cancellationId: row.id, chargeId: row.chargeId, error: lastError });
      }
    });
    return status;
  };
  try {
    if (row.attempts > 1) { // já houve tentativa sem resposta: conferir o estado ANTES de pedir de novo
      const s = await prov.boleto.status(row.externalRef);
      if (s === "cancelado") return finish("cancelado", null);
      if (s === "pago") return finish("falhou", "boleto_pago");
    }
    await prov.boleto.cancel(row.externalRef);
    return finish("cancelado", null);
  } catch (e) {
    const m = (e as Error).message;
    if (m === "boleto_pago" || m === "boleto_inexistente") return finish("falhou", m);
    if (e instanceof RangeError) return finish("falhou", safeCode(m));
    if (row.attempts >= MAX_CANCEL_ATTEMPTS) return finish("falhou", "tentativas_esgotadas");
    return finish("desconhecido", (e as Error).name === "IssuanceTimeout" ? "timeout" : "erro_desconhecido");
  }
}

export async function cancelBoleto(db: DB, actorId: string, companyId: string, input: CancelInput, providers?: Providers) {
  await requirePerm(db, actorId, companyId, "boletos.cancel");
  if (!uuidOk(input.chargeId ?? "")) throw new Invalid("Cobrança não encontrada");
  const reason = cleanReason(input.reason);
  if (input.confirm !== true) throw new Invalid("Confirme o cancelamento marcando a caixa de confirmação");
  // O cancelamento fala com o provedor que EMITIU o boleto (modo da solicitação), não com o configurado hoje. Falha FECHADA antes de reservar qualquer coisa.
  const [pre] = await db.select({ mode: issuanceRequests.mode }).from(issuanceRequests).where(and(eq(issuanceRequests.companyId, companyId), eq(issuanceRequests.chargeId, input.chargeId), eq(issuanceRequests.kind, "boleto"), eq(issuanceRequests.status, "emitido")));
  if (!pre) throw new Invalid("Esta cobrança não tem boleto emitido para cancelar");
  // Cancelar um boleto REAL é permitido mesmo depois de a empresa sair do modo de produção (o boleto existe lá fora e pode precisar ser desfeito),
  // mas só pela diretoria, com a chave do servidor ligada e com esta confirmação própria, diferente da genérica.
  if (pre.mode === "cora_producao" && input.confirmLive !== true) throw new Invalid("Este é um boleto REAL (Cora produção). Marque a confirmação específica de cancelamento de boleto real");
  const prov = await resolveProvidersForMode(db, companyId, pre.mode, providers);

  const row = await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await lock(x, companyId);
    const [ch] = await x.select({ id: charges.id }).from(charges).where(and(eq(charges.id, input.chargeId), eq(charges.companyId, companyId))).for("update"); // mesma trava da baixa: pagamento e cancelamento não se cruzam
    if (!ch) throw new Invalid("Cobrança não encontrada");
    const [req] = await x.select().from(issuanceRequests).where(and(eq(issuanceRequests.companyId, companyId), eq(issuanceRequests.chargeId, input.chargeId), eq(issuanceRequests.kind, "boleto"), eq(issuanceRequests.status, "emitido")));
    if (!req || !req.externalRef) throw new Invalid("Esta cobrança não tem boleto emitido para cancelar");
    if (req.mode !== pre.mode) throw new Invalid("O boleto mudou durante a operação. Tente de novo");
    const [{ paid }] = (await x.execute(sql`select count(*)::int paid from payments where company_id = ${companyId} and charge_id = ${input.chargeId} and status = 'ativo'`)) as unknown as { paid: number }[];
    if (paid > 0) throw new Invalid("Esta cobrança tem pagamento registrado. Estorne o pagamento antes de cancelar o boleto");
    const [open] = await x.select({ id: boletoCancellations.id }).from(boletoCancellations).where(and(eq(boletoCancellations.companyId, companyId), eq(boletoCancellations.requestId, req.id), inArray(boletoCancellations.status, ["enviando", "desconhecido", "cancelado"])));
    if (open) throw new Invalid("Já existe um cancelamento em andamento ou concluído para este boleto");
    const [c] = await x.insert(boletoCancellations).values({ companyId, chargeId: input.chargeId, requestId: req.id, externalRef: req.externalRef, mode: req.mode, reason, requestedBy: actorId }).returning({ id: boletoCancellations.id });
    await audit(x, companyId, actorId, "boleto.cancel_requested", { cancellationId: c.id, chargeId: input.chargeId, requestId: req.id });
    return { id: c.id, requestId: req.id, chargeId: input.chargeId, externalRef: req.externalRef, attempts: 1 };
  });
  const status = await attempt(db, companyId, actorId, row, prov);
  return { cancellationId: row.id, status };
}

/** Reconsulta um cancelamento sem resposta conclusiva (ou preso em "enviando" há mais de 10 min). */
export async function recheckCancellation(db: DB, actorId: string, companyId: string, cancellationId: string, providers?: Providers, now = new Date()) {
  await requirePerm(db, actorId, companyId, "boletos.cancel");
  if (!uuidOk(cancellationId ?? "")) throw new Invalid("Cancelamento não encontrado");
  const [mc] = await db.select({ mode: boletoCancellations.mode }).from(boletoCancellations).where(and(eq(boletoCancellations.id, cancellationId), eq(boletoCancellations.companyId, companyId)));
  if (!mc) throw new Invalid("Cancelamento não encontrado");
  const prov = await resolveProvidersForMode(db, companyId, mc.mode, providers);
  const row = await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await lock(x, companyId);
    const [c] = await x.select().from(boletoCancellations).where(and(eq(boletoCancellations.id, cancellationId), eq(boletoCancellations.companyId, companyId))).for("update");
    if (!c) throw new Invalid("Cancelamento não encontrado");
    const stuck = c.status === "enviando" && now.getTime() - c.updatedAt.getTime() > STUCK_MS;
    if (c.status !== "desconhecido" && !stuck) throw new Invalid(c.status === "enviando" ? "O cancelamento ainda está em andamento" : "Este cancelamento já foi decidido");
    const attempts = c.attempts + 1;
    await x.update(boletoCancellations).set({ status: "enviando", attempts, updatedAt: now }).where(eq(boletoCancellations.id, c.id));
    await audit(x, companyId, actorId, "boleto.cancel_rechecked", { cancellationId: c.id, chargeId: c.chargeId, attempts });
    return { id: c.id, requestId: c.requestId, chargeId: c.chargeId, externalRef: c.externalRef, attempts };
  });
  return { cancellationId: row.id, status: await attempt(db, companyId, actorId, row, prov) };
}

/** Painel do boleto de uma cobrança: situação da emissão + histórico completo de cancelamentos (quem, quando, por quê, resultado). */
export async function boletoPanel(db: DB, actorId: string, companyId: string, chargeId: string) {
  await requirePerm(db, actorId, companyId, "issuance.read");
  if (!uuidOk(chargeId ?? "")) return { request: null, history: [] };
  const reqs = await db.select({ id: issuanceRequests.id, mode: issuanceRequests.mode, status: issuanceRequests.status, externalStatus: issuanceRequests.externalStatus, externalRef: issuanceRequests.externalRef, createdAt: issuanceRequests.createdAt })
    .from(issuanceRequests).where(and(eq(issuanceRequests.companyId, companyId), eq(issuanceRequests.chargeId, chargeId), eq(issuanceRequests.kind, "boleto"))).orderBy(desc(issuanceRequests.createdAt));
  const live = reqs.find((r) => r.status !== "cancelado") ?? null;
  const history = await db.select({ id: boletoCancellations.id, status: boletoCancellations.status, reason: boletoCancellations.reason, attempts: boletoCancellations.attempts, lastError: boletoCancellations.lastError, createdAt: boletoCancellations.createdAt, resolvedAt: boletoCancellations.resolvedAt, by: users.name })
    .from(boletoCancellations).innerJoin(users, eq(users.id, boletoCancellations.requestedBy)).where(and(eq(boletoCancellations.companyId, companyId), eq(boletoCancellations.chargeId, chargeId))).orderBy(asc(boletoCancellations.createdAt));
  return { request: live ? { id: live.id, mode: live.mode, status: live.status, externalStatus: live.externalStatus } : null, history };
}

