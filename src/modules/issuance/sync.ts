import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { auditLog, boletoCancellations, charges, issuanceRequests, issuanceSettings, users } from "@/lib/db/schema";
import { centsFromNumeric } from "@/lib/money";
import { requirePerm } from "@/modules/identity/service";
import { cancelQueueForCharges, todayManaus } from "@/modules/messaging/service";
import { IssuanceRetryable } from "@/modules/providers/errors";
import { LiveNotAvailable, resolveProvidersForMode } from "@/modules/providers/registry";
import type { BoletoDetails } from "@/modules/providers/types";
import { recordPaymentTx } from "@/modules/receivables/service";

/**
 * E10b-2/E10b-4 — ATUALIZAR A SITUAÇÃO dos boletos emitidos pela Cora e, se a empresa ligou a BAIXA AUTOMÁTICA, registrar o pagamento. Só consulta a Cora (GET); nunca paga nem transfere.
 *  - pago no provedor  → marca `external_status = 'pago'`, para a régua e audita. Com "baixa automática" LIGADA e valores conferindo, cria o pagamento (forma "boleto", usuário de sistema "Cora (automático)").
 *    A baixa só é feita quando TUDO bate: pagamento concluído na Cora, soma dos pagamentos = total pago, principal (pago − juros/multa) = saldo em aberto da cobrança. Senão fica "pago, aguardando conferência" (baixa manual).
 *  - cancelado lá fora → a solicitação sai da lista de ativas (a cobrança fica "sem boleto ativo" e pode ganhar outro, com chave de nova geração), régua para, audita.
 *  - aberto/atrasado   → nada muda; só registra que foi conferido (rodízio justo entre os boletos).
 * Só olha linhas de modos da Cora (simuladas não têm o que consultar). Erro de um boleto não derruba os demais; limite de acesso/credencial (401/403/429) interrompe a rodada sem alterar nada.
 * A consulta à Cora é feita FORA da transação; a gravação toma a mesma trava de empresa e o mesmo `FOR UPDATE` da cobrança do cancelamento e da baixa.
 */
export const SYNC_BATCH = 50;
export const CORA_SYSTEM_EMAIL = "sistema-cora@k3g.invalid";
export type SyncOutcome = { checked: number; paid: number; settled: number; needsReview: number; cancelled: number; failed: number; skipped: string | null };
const CORA_MODES = ["cora_homologacao", "cora_producao"] as const;
type CoraMode = (typeof CORA_MODES)[number];

/** Usuário de sistema (sem senha utilizável, desativado: não entra no site) que consta como autor das baixas automáticas. */
export async function ensureCoraSystemUser(db: DB): Promise<string> {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, CORA_SYSTEM_EMAIL));
  if (u) return u.id;
  const [n] = await db.insert(users).values({ email: CORA_SYSTEM_EMAIL, name: "Cora (automático)", passwordHash: "!sem-login", disabledAt: new Date() }).onConflictDoNothing().returning({ id: users.id });
  if (n) return n.id;
  return (await db.select({ id: users.id }).from(users).where(eq(users.email, CORA_SYSTEM_EMAIL)))[0].id;
}

/** Chave de idempotência da baixa: uma por boleto (o mesmo pagamento nunca vira dois lançamentos, nem por reconsulta, nem por webhook + agendador). */
export const settleKey = (invoiceRef: string) => `cora_${createHash("sha256").update(`settle|${invoiceRef}`).digest("hex").slice(0, 40)}`;

type Settle = { kind: "settled" } | { kind: "already" } | { kind: "review"; reason: string } | { kind: "wait" };
/** Decide e (se tudo conferir) grava a baixa. Chamada DENTRO da transação, com a cobrança já travada. */
async function settle(x: DB, companyId: string, systemUser: string, chargeId: string, ref: string, d: BoletoDetails): Promise<Settle> {
  const sum = d.payments.reduce((a, p) => a + p.totalPaidCents, 0);
  if (d.payments.length === 0 || sum <= 0 || sum !== d.totalPaidCents) return { kind: "review", reason: "pagamentos_nao_conferem" };
  const extras = d.payments.reduce((a, p) => a + p.interestCents + p.fineCents, 0);
  const principal = sum - extras;
  if (principal <= 0) return { kind: "review", reason: "valor_invalido" };
  const [ch] = await x.select({ amount: charges.amount }).from(charges).where(and(eq(charges.id, chargeId), eq(charges.companyId, companyId)));
  if (!ch) return { kind: "review", reason: "cobranca_inexistente" };
  if (d.totalAmountCents !== centsFromNumeric(ch.amount)) return { kind: "review", reason: "valor_do_boleto_diferente_da_cobranca" }; // o boleto na Cora não tem o valor que emitimos
  const [{ paid }] = (await x.execute(sql`select coalesce(sum(amount), 0)::text paid from payments where company_id = ${companyId} and charge_id = ${chargeId} and status = 'ativo'`)) as unknown as { paid: string }[];
  const open = centsFromNumeric(ch.amount) - centsFromNumeric(paid);
  if (open <= 0) return { kind: "already" }; // já foi baixada (manual ou conciliação): só registra que o provedor também informa pago
  if (principal !== open) return { kind: "review", reason: "valor_diferente_do_saldo" };
  const [inflight] = (await x.execute(sql`select 1 from boleto_cancellations where company_id = ${companyId} and charge_id = ${chargeId} and status in ('enviando', 'desconhecido') limit 1`)) as unknown as unknown[];
  if (inflight) return { kind: "wait" };
  const today = todayManaus();
  const stamp = d.paidOn ?? (d.payments[0].finalizedAt ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(stamp) || stamp > today) return { kind: "review", reason: "data_do_pagamento_ausente_ou_futura" }; // nunca inventa nem ajusta a data
  const paidAt = stamp;
  try {
    const r = await recordPaymentTx(x, companyId, systemUser, chargeId, { cents: principal, interestCents: extras, discountCents: 0, paidAt, method: d.payments.every((p) => p.method === "PIX") ? "pix" : "boleto", note: "Baixa automática: boleto pago na Cora", key: settleKey(ref) }, { via: "cora_auto", ref });
    if (r.duplicate) return { kind: "review", reason: "baixa_anterior_estornada" }; // já houve baixa automática deste boleto e ela foi estornada: nova baixa só com decisão humana
  } catch (e) {
    if ((e as Error).name === "Invalid") return { kind: "review", reason: "recusada_pela_baixa" }; // ex.: data anterior à emissão; revisão humana
    throw e;
  }
  return { kind: "settled" };
}

/** Núcleo (sem checagem de papel): usado pelo botão (com papel), pelo agendador e pelo webhook (com o usuário de sistema). `only` limita a um boleto (webhook). */
export async function syncCore(db: DB, companyId: string, actorId: string, now = new Date(), only?: { requestId: string }): Promise<SyncOutcome> {
  const out: SyncOutcome = { checked: 0, paid: 0, settled: 0, needsReview: 0, cancelled: 0, failed: 0, skipped: null };
  const [st] = await db.select({ auto: issuanceSettings.autoSettle }).from(issuanceSettings).where(eq(issuanceSettings.companyId, companyId));
  const auto = !!st?.auto;
  // 'pago' sem baixa feita (aguardando conferência) é reconsultado quando a baixa automática está ligada: pode ter sido resolvido ou o valor pode ter sido corrigido
  const rows = await db.select({ id: issuanceRequests.id, chargeId: issuanceRequests.chargeId, ref: issuanceRequests.externalRef, mode: issuanceRequests.mode }).from(issuanceRequests)
    .where(and(eq(issuanceRequests.companyId, companyId), eq(issuanceRequests.kind, "boleto"), inArray(issuanceRequests.mode, [...CORA_MODES]), eq(issuanceRequests.status, "emitido"),
      only ? eq(issuanceRequests.id, only.requestId) : sql`true`,
      sql`${issuanceRequests.externalRef} is not null and (coalesce(${issuanceRequests.externalStatus}, 'emitido') <> 'pago' ${auto ? sql`or ${issuanceRequests.settledAt} is null` : sql``})`))
    .orderBy(asc(issuanceRequests.updatedAt), asc(issuanceRequests.id)).limit(only ? 1 : SYNC_BATCH);
  if (rows.length === 0) return out;
  const provs = new Map<CoraMode, Awaited<ReturnType<typeof resolveProvidersForMode>>>();
  for (const m of new Set(rows.map((r) => r.mode as CoraMode))) {
    try { provs.set(m, await resolveProvidersForMode(db, companyId, m)); }
    catch (e) { if (e instanceof LiveNotAvailable) { out.skipped = e.message; continue; } throw e; }
  }
  const systemUser = auto ? await ensureCoraSystemUser(db) : actorId;

  for (const r of rows) {
    const prov = provs.get(r.mode as CoraMode);
    if (!prov) continue;
    let d: BoletoDetails;
    try { d = await prov.boleto.details(r.ref!); }
    catch (e) {
      if (e instanceof IssuanceRetryable) { out.skipped = "A Cora recusou ou limitou o acesso agora. Tente de novo em alguns minutos."; break; }
      out.failed++;
      await db.update(issuanceRequests).set({ updatedAt: now }).where(and(eq(issuanceRequests.id, r.id), eq(issuanceRequests.companyId, companyId))); // vai para o fim da fila: um boleto que sempre falha não trava o rodízio
      continue;
    }
    out.checked++;
    try {
      await db.transaction(async (tx) => {
        const x = tx as unknown as DB;
        // Mesma trava e mesma ordem do cancelamento (cancel.ts) e da baixa: sync, cancelamento e baixa da mesma cobrança não se cruzam.
        await x.execute(sql`select pg_advisory_xact_lock(hashtext(${"issuance:" + companyId}))`);
        await x.select({ id: charges.id }).from(charges).where(and(eq(charges.id, r.chargeId), eq(charges.companyId, companyId))).for("update");
        const [busy] = await x.select({ id: boletoCancellations.id }).from(boletoCancellations).where(and(eq(boletoCancellations.companyId, companyId), eq(boletoCancellations.requestId, r.id), inArray(boletoCancellations.status, ["enviando", "desconhecido"])));
        if (busy) return; // há um cancelamento em andamento deste boleto: ele decide o resultado; a sync não grava por cima (a próxima rodada confere de novo)
        const live = and(eq(issuanceRequests.id, r.id), eq(issuanceRequests.companyId, companyId), eq(issuanceRequests.status, "emitido"), eq(issuanceRequests.mode, r.mode));
        if (d.status === "pago") {
          const first = (await x.select({ s: issuanceRequests.externalStatus }).from(issuanceRequests).where(live))[0];
          if (!first) return;
          let res: Settle | null = null;
          if (auto) res = await settle(x, companyId, systemUser, r.chargeId, r.ref!, d);
          if (res?.kind === "wait") return;
          const done = res?.kind === "settled" || res?.kind === "already";
          await x.update(issuanceRequests).set({ externalStatus: "pago", settledAt: done ? now : null, updatedAt: now }).where(live);
          if (first.s !== "pago") { // a primeira vez que o provedor informa pago: régua para e audita
            await cancelQueueForCharges(x, companyId, [r.chargeId]);
            await x.insert(auditLog).values({ companyId, actorId, action: "boleto.paid_at_provider", detail: { chargeId: r.chargeId, requestId: r.id, via: "sync" } });
            out.paid++;
          }
          if (res?.kind === "settled") out.settled++;
          if (res?.kind === "review") {
            out.needsReview++;
            const [seen] = (await x.execute(sql`select 1 from audit_log where company_id = ${companyId} and action = 'boleto.settle_review' and detail->>'requestId' = ${r.id} and detail->>'reason' = ${res.reason} limit 1`)) as unknown as unknown[];
            if (!seen) await x.insert(auditLog).values({ companyId, actorId, action: "boleto.settle_review", detail: { chargeId: r.chargeId, requestId: r.id, reason: res.reason } }); // uma vez por boleto e motivo (a conferência repete a cada 10 min)
          }
        } else if (d.status === "cancelado") {
          const u = await x.update(issuanceRequests).set({ status: "cancelado", externalStatus: "cancelado", updatedAt: now }).where(live).returning({ id: issuanceRequests.id });
          if (!u.length) return;
          await cancelQueueForCharges(x, companyId, [r.chargeId]);
          await x.insert(auditLog).values({ companyId, actorId, action: "boleto.cancelled_at_provider", detail: { chargeId: r.chargeId, requestId: r.id, via: "sync" } });
          out.cancelled++;
        } else {
          await x.update(issuanceRequests).set({ updatedAt: now }).where(live);
        }
      });
    } catch { out.failed++; } // a transação foi desfeita (nada gravado); a próxima rodada tenta de novo
  }
  if (!only) await db.insert(auditLog).values({ companyId, actorId, action: "issuance.sync", detail: { checked: out.checked, paid: out.paid, settled: out.settled, needsReview: out.needsReview, cancelled: out.cancelled, failed: out.failed } });
  return out;
}

export async function syncBoletoStatus(db: DB, actorId: string, companyId: string, now = new Date()): Promise<SyncOutcome> {
  await requirePerm(db, actorId, companyId, "issuance.run");
  return syncCore(db, companyId, actorId, now);
}

/** Agendador: empresas com provedor da Cora e baixa automática ligada. Roda como o usuário de sistema. Devolve só contagens. */
export async function syncAllAuto(db: DB, now = new Date()): Promise<{ companies: number; checked: number; settled: number; needsReview: number; cancelled: number; failed: number; skipped: number }> {
  const sum = { companies: 0, checked: 0, settled: 0, needsReview: 0, cancelled: 0, failed: 0, skipped: 0 };
  const cs = await db.select({ id: issuanceSettings.companyId }).from(issuanceSettings).where(and(eq(issuanceSettings.autoSettle, true), inArray(issuanceSettings.boletoProvider, [...CORA_MODES])));
  if (cs.length === 0) return sum;
  const sys = await ensureCoraSystemUser(db);
  for (const c of cs) {
    sum.companies++;
    try {
      const o = await syncCore(db, c.id, sys, now);
      sum.checked += o.checked; sum.settled += o.settled; sum.needsReview += o.needsReview; sum.cancelled += o.cancelled; sum.failed += o.failed; if (o.skipped) sum.skipped++;
    } catch { sum.failed++; }
  }
  return sum;
}
