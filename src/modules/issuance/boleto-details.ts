import { and, desc, eq } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { issuanceRequests } from "@/lib/db/schema";
import { requirePerm } from "@/modules/identity/service";
import { LiveNotAvailable, resolveProvidersForMode } from "@/modules/providers/registry";
import type { BoletoDetails, Providers } from "@/modules/providers/types";

/**
 * E10b-3 — dados do boleto de uma cobrança (linha digitável, código de barras, PDF e pagamentos), consultados NA HORA no provedor que emitiu (só leitura).
 * Nada é guardado no nosso banco: a linha digitável e o link do PDF não ficam em log, auditoria nem tabela. Boleto simulado não tem dados reais.
 * O link do PDF só é devolvido se for https (nunca um esquema perigoso vindo de resposta externa).
 */
export type BoletoView =
  | { kind: "nenhum" }
  | { kind: "simulado" }
  | { kind: "indisponivel"; reason: string }
  | { kind: "ok"; mode: string; ref: string; details: Omit<BoletoDetails, "pdfUrl"> & { pdfUrl: string | null } };

const uuidOk = (s: string) => /^[0-9a-f-]{36}$/i.test(s);
/** Só https e só domínio da Cora (a resposta é externa: nada de redirecionar o usuário para outro endereço). */
const CORA_HOST = /(^|\.)cora\.com\.br$/i;
export const safePdfUrl = (u: string | null) => { try { if (!u) return null; const x = new URL(u); return x.protocol === "https:" && !x.username && !x.password && CORA_HOST.test(x.hostname) ? u : null; } catch { return null; } };

export async function boletoView(db: DB, actorId: string, companyId: string, chargeId: string, providers?: Providers): Promise<BoletoView> {
  await requirePerm(db, actorId, companyId, "issuance.read");
  if (!uuidOk(chargeId ?? "")) return { kind: "nenhum" };
  const [r] = await db.select({ mode: issuanceRequests.mode, ref: issuanceRequests.externalRef }).from(issuanceRequests)
    .where(and(eq(issuanceRequests.companyId, companyId), eq(issuanceRequests.chargeId, chargeId), eq(issuanceRequests.kind, "boleto"), eq(issuanceRequests.status, "emitido"))).orderBy(desc(issuanceRequests.createdAt)).limit(1);
  if (!r || !r.ref) return { kind: "nenhum" };
  if (r.mode === "simulado") return { kind: "simulado" };
  try {
    const prov = await resolveProvidersForMode(db, companyId, r.mode, providers);
    const d = await prov.boleto.details(r.ref);
    return { kind: "ok", mode: r.mode, ref: r.ref, details: { ...d, pdfUrl: safePdfUrl(d.pdfUrl) } };
  } catch (e) {
    return { kind: "indisponivel", reason: e instanceof LiveNotAvailable ? e.message : "Não foi possível consultar o boleto agora. Tente de novo em instantes." };
  }
}
