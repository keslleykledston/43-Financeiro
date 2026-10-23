import { CanonicalHttpAdapter } from "./http";
import { K3gCrmAdapter } from "./k3g";
import type { CrmAdapter } from "./types";
import { Invalid } from "@/modules/identity/service";

/**
 * Credenciais vêm do ambiente (secret store), nunca do banco nem do Git.
 * CRM_PROVIDER: "k3g" (padrão — K3G CRM real) | "canonical" (formato canônico, usado como referência/testes).
 * CRM_ACTIVE_STATUSES: lista separada por vírgula dos `crmStatus` que contam como cliente (padrão "ACTIVE").
 */
export function getCrmAdapter(env: NodeJS.ProcessEnv = process.env): CrmAdapter {
  if (!env.CRM_BASE_URL || !env.CRM_API_TOKEN) throw new Invalid("CRM não configurado no servidor (CRM_BASE_URL / CRM_API_TOKEN).");
  const o = { baseUrl: env.CRM_BASE_URL, token: env.CRM_API_TOKEN, allowInsecureHttp: env.CRM_ALLOW_INSECURE_HTTP === "true" };
  if ((env.CRM_PROVIDER ?? "k3g") === "canonical") return new CanonicalHttpAdapter(o);
  return new K3gCrmAdapter({ ...o, activeStatuses: (env.CRM_ACTIVE_STATUSES ?? "ACTIVE").split(",").map((s) => s.trim()).filter(Boolean) });
}
