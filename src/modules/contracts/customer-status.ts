import { and, eq } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { contracts, customers } from "@/lib/db/schema";

/**
 * Sugestão de situação do CLIENTE a partir da situação dos CONTRATOS dele (o K3G Finance gerencia os contratos; a situação do cliente segue).
 * Regra: algum contrato ativo → ativo; senão algum suspenso → suspenso; senão todos encerrados → cancelado; só rascunho/sem contrato → nenhuma sugestão.
 * É SUGESTÃO: quem aplica é uma pessoa (cancelar/suspender para de cobrar; reativar exige gerente ou diretoria). Aplicar também atualiza o CRM (caixa de saída).
 */
export type CustomerStatus = "ativo" | "suspenso" | "cancelado";
export function suggestCustomerStatus(contractStatuses: string[]): CustomerStatus | null {
  if (contractStatuses.includes("ativo")) return "ativo";
  if (contractStatuses.includes("suspenso")) return "suspenso";
  if (contractStatuses.length > 0 && contractStatuses.every((s) => s === "encerrado")) return "cancelado";
  return null;
}

/** Sugestão para um cliente (só quando difere da situação atual). */
export async function customerStatusSuggestion(db: DB, companyId: string, customerId: string): Promise<{ suggested: CustomerStatus; current: string } | null> {
  const [c] = await db.select({ status: customers.status, archivedAt: customers.archivedAt }).from(customers).where(and(eq(customers.id, customerId), eq(customers.companyId, companyId)));
  if (!c || c.archivedAt) return null;
  const rows = await db.select({ status: contracts.status }).from(contracts).where(and(eq(contracts.companyId, companyId), eq(contracts.customerId, customerId)));
  const s = suggestCustomerStatus(rows.map((r) => r.status));
  return s && s !== c.status ? { suggested: s, current: c.status } : null;
}
