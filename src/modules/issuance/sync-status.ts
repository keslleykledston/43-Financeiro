import { and, desc, eq } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { auditLog, coraWebhooks, issuanceSettings } from "@/lib/db/schema";
import { requirePerm } from "@/modules/identity/service";

/**
 * F1 — a plataforma está conferindo na Cora quais boletos foram pagos? Só leitura. A conferência (consulta a cada 10 min + aviso instantâneo/webhook) já existe (E10b-2/4/5);
 * aqui ela fica VISÍVEL: última conferência, quantos boletos olhou, quantos pagos, se o aviso instantâneo está registrado e se a conferência parou (alerta).
 */
export const SYNC_STALE_MS = 30 * 60_000;
export type PaymentSyncStatus = { active: boolean; reason: string | null; provider: string; lastAt: Date | null; checked: number; paid: number; needsReview: number; failed: number; stale: boolean; webhook: boolean };

export async function paymentSyncStatus(db: DB, actorId: string, companyId: string, now = new Date()): Promise<PaymentSyncStatus> {
  await requirePerm(db, actorId, companyId, "billing.read");
  const [st] = await db.select().from(issuanceSettings).where(eq(issuanceSettings.companyId, companyId));
  const provider = st?.boletoProvider ?? "simulado";
  const base = { provider, lastAt: null, checked: 0, paid: 0, needsReview: 0, failed: 0, stale: false, webhook: false };
  if (provider === "simulado") return { ...base, active: false, reason: "Boletos simulados: não há o que conferir na Cora." };
  const env = provider === "cora_producao" ? "producao" : "homologacao";
  const [wh] = await db.select({ id: coraWebhooks.id }).from(coraWebhooks).where(and(eq(coraWebhooks.companyId, companyId), eq(coraWebhooks.environment, env)));
  if (!st?.autoSettle) return { ...base, webhook: !!wh, active: false, reason: "A baixa automática está desligada: a plataforma não confere pagamentos sozinha (use «Atualizar situação» em Emissões)." };
  const [last] = await db.select({ at: auditLog.createdAt, d: auditLog.detail }).from(auditLog).where(and(eq(auditLog.companyId, companyId), eq(auditLog.action, "issuance.sync"))).orderBy(desc(auditLog.createdAt)).limit(1);
  const d = (last?.d ?? {}) as Record<string, number>;
  const lastAt = last?.at ?? null;
  return { active: true, reason: null, provider, lastAt, checked: Number(d.checked ?? 0), paid: Number(d.paid ?? 0), needsReview: Number(d.needsReview ?? 0), failed: Number(d.failed ?? 0), stale: !lastAt || now.getTime() - lastAt.getTime() > SYNC_STALE_MS, webhook: !!wh };
}
