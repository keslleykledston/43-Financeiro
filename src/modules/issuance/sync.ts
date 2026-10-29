import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { auditLog, boletoCancellations, charges, issuanceRequests } from "@/lib/db/schema";
import { requirePerm } from "@/modules/identity/service";
import { cancelQueueForCharges } from "@/modules/messaging/service";
import { IssuanceRetryable } from "@/modules/providers/errors";
import { LiveNotAvailable, resolveProvidersForMode } from "@/modules/providers/registry";

/**
 * E10b-2 — ATUALIZAR A SITUAÇÃO dos boletos emitidos na Cora de TESTES (só consulta: GET /v2/invoices/{id}). Não cria baixa, não mexe em dinheiro:
 *  - pago no provedor  → marca `external_status = 'pago'`, para a régua de mensagens e audita (a baixa continua sendo feita por quem confere o recebimento: A receber/Conciliação).
 *  - cancelado lá fora → a solicitação sai da lista de ativas (a cobrança volta a ficar "sem boleto ativo" e pode ganhar um novo, com chave de nova geração), régua para, audita.
 *  - aberto/atrasado   → nada muda; só registra que foi conferido (rodízio justo entre os boletos).
 * Só olha linhas do modo `cora_homologacao` (simuladas não têm o que consultar; não existe modo de produção). Erro de um boleto não derruba os demais;
 * limite de acesso/credencial (401/403/429) interrompe a rodada sem alterar nada.
 */
export const SYNC_BATCH = 50;
export type SyncOutcome = { checked: number; paid: number; cancelled: number; failed: number; skipped: string | null };

export async function syncBoletoStatus(db: DB, actorId: string, companyId: string, now = new Date()): Promise<SyncOutcome> {
  await requirePerm(db, actorId, companyId, "issuance.run");
  const out: SyncOutcome = { checked: 0, paid: 0, cancelled: 0, failed: 0, skipped: null };
  const rows = await db.select({ id: issuanceRequests.id, chargeId: issuanceRequests.chargeId, ref: issuanceRequests.externalRef }).from(issuanceRequests)
    .where(and(eq(issuanceRequests.companyId, companyId), eq(issuanceRequests.kind, "boleto"), eq(issuanceRequests.mode, "cora_homologacao"), eq(issuanceRequests.status, "emitido"),
      sql`${issuanceRequests.externalRef} is not null and coalesce(${issuanceRequests.externalStatus}, 'emitido') <> 'pago'`))
    .orderBy(asc(issuanceRequests.updatedAt), asc(issuanceRequests.id)).limit(SYNC_BATCH);
  if (rows.length === 0) return out;
  let prov;
  try { prov = await resolveProvidersForMode(db, companyId, "cora_homologacao"); }
  catch (e) { if (e instanceof LiveNotAvailable) { out.skipped = e.message; return out; } throw e; }

  for (const r of rows) {
    let s: "emitido" | "pago" | "cancelado";
    try { s = (await prov.boleto.status(r.ref!)) as typeof s; }
    catch (e) {
      if (e instanceof IssuanceRetryable) { out.skipped = "A Cora recusou ou limitou o acesso agora. Tente de novo em alguns minutos."; break; }
      out.failed++;
      await db.update(issuanceRequests).set({ updatedAt: now }).where(and(eq(issuanceRequests.id, r.id), eq(issuanceRequests.companyId, companyId))); // vai para o fim da fila: um boleto que sempre falha não trava o rodízio
      continue;
    }
    out.checked++;
    await db.transaction(async (tx) => {
      const x = tx as unknown as DB;
      // Mesma trava e mesma ordem do cancelamento (cancel.ts): sync e cancelamento/baixa da mesma cobrança não se cruzam. A consulta à Cora foi feita FORA desta transação.
      await x.execute(sql`select pg_advisory_xact_lock(hashtext(${"issuance:" + companyId}))`);
      await x.select({ id: charges.id }).from(charges).where(and(eq(charges.id, r.chargeId), eq(charges.companyId, companyId))).for("update");
      const [busy] = await x.select({ id: boletoCancellations.id }).from(boletoCancellations).where(and(eq(boletoCancellations.companyId, companyId), eq(boletoCancellations.requestId, r.id), inArray(boletoCancellations.status, ["enviando", "desconhecido"])));
      if (busy) return; // há um cancelamento em andamento deste boleto: ele decide o resultado; a sync não grava por cima (a próxima rodada confere de novo)
      const live = and(eq(issuanceRequests.id, r.id), eq(issuanceRequests.companyId, companyId), eq(issuanceRequests.status, "emitido"), eq(issuanceRequests.mode, "cora_homologacao"));
      if (s === "pago") {
        const u = await x.update(issuanceRequests).set({ externalStatus: "pago", updatedAt: now }).where(live).returning({ id: issuanceRequests.id });
        if (!u.length) return;
        await cancelQueueForCharges(x, companyId, [r.chargeId]);
        await x.insert(auditLog).values({ companyId, actorId, action: "boleto.paid_at_provider", detail: { chargeId: r.chargeId, requestId: r.id, via: "sync" } });
        out.paid++;
      } else if (s === "cancelado") {
        const u = await x.update(issuanceRequests).set({ status: "cancelado", externalStatus: "cancelado", updatedAt: now }).where(live).returning({ id: issuanceRequests.id });
        if (!u.length) return;
        await cancelQueueForCharges(x, companyId, [r.chargeId]);
        await x.insert(auditLog).values({ companyId, actorId, action: "boleto.cancelled_at_provider", detail: { chargeId: r.chargeId, requestId: r.id, via: "sync" } });
        out.cancelled++;
      } else {
        await x.update(issuanceRequests).set({ updatedAt: now }).where(live);
      }
    });
  }
  await db.insert(auditLog).values({ companyId, actorId, action: "issuance.sync", detail: { checked: out.checked, paid: out.paid, cancelled: out.cancelled, failed: out.failed } });
  return out;
}
