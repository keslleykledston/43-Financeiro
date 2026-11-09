import { eq, sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { companies, crmOutbox } from "@/lib/db/schema";

/**
 * Corte do CRM (ADR-043): depois do corte o K3G Finance é a fonte da verdade dos clientes e EMPURRA mudanças ao CRM.
 * Este arquivo só enfileira (caixa de saída transacional): a mudança do cliente e o pedido de envio ao CRM nascem na MESMA transação,
 * então nenhuma troca de situação ou cliente novo se perde se o CRM estiver fora do ar. Quem envia é `writeback.ts` (agendador).
 * Sem dependência do serviço de clientes (evita ciclo de importação).
 */
export type PushKind = "status" | "create";

/** O corte já foi feito nesta empresa? Só então as mudanças vão para a fila. */
export async function isCutover(db: DB, companyId: string): Promise<boolean> {
  const [c] = await db.select({ at: companies.crmCutoverAt }).from(companies).where(eq(companies.id, companyId));
  return !!c?.at;
}

/** Enfileira o envio ao CRM. Junta pedidos repetidos do mesmo cliente (um aberto por cliente+tipo: vale o mais recente). Sem corte feito, não faz nada. */
export async function enqueueCrmPush(db: DB, companyId: string, customerId: string, kind: PushKind, desiredStatus: string): Promise<boolean> {
  if (!(await isCutover(db, companyId))) return false;
  await db.insert(crmOutbox).values({ companyId, customerId, kind, desiredStatus })
    .onConflictDoUpdate({ target: [crmOutbox.companyId, crmOutbox.customerId, crmOutbox.kind], targetWhere: sql`state = 'pendente'`, set: { desiredStatus, nextAttemptAt: new Date(), lastError: null, updatedAt: new Date() } });
  return true;
}
