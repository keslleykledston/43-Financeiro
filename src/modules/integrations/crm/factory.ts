import { CanonicalHttpAdapter } from "./http";
import { K3gCrmAdapter, parseStatusMap } from "./k3g";
import type { CrmAdapter } from "./types";
import { Invalid } from "@/modules/identity/service";

/**
 * Credenciais vêm do ambiente (secret store), nunca do banco nem do Git.
 * CRM_PROVIDER: "k3g" (padrão — K3G CRM real) | "canonical" (formato canônico, usado como referência/testes).
 * CRM_ALLOWED_HOSTS: hosts permitidos para o token (padrão "api.k3gsolutions.com.br"). HTTP só com CRM_ALLOW_INSECURE_HTTP=true e host interno sem ponto.
 * CRM_STATUS_MAP (opcional): "ACTIVE:ativo,INACTIVE:suspenso,CHURNED:cancelado" (padrão). Status fora do mapa (ex.: PROSPECT) não são clientes.
 */
export function getCrmAdapter(env: NodeJS.ProcessEnv = process.env): CrmAdapter {
  if (!env.CRM_BASE_URL || !env.CRM_API_TOKEN) throw new Invalid("CRM não configurado no servidor (CRM_BASE_URL / CRM_API_TOKEN).");
  const o = {
    baseUrl: env.CRM_BASE_URL, token: env.CRM_API_TOKEN, allowInsecureHttp: env.CRM_ALLOW_INSECURE_HTTP === "true",
    allowedHosts: (env.CRM_ALLOWED_HOSTS ?? "api.k3gsolutions.com.br").split(",").map((h) => h.trim()).filter(Boolean),
  };
  if ((env.CRM_PROVIDER ?? "k3g") === "canonical") return new CanonicalHttpAdapter(o);
  return new K3gCrmAdapter({ ...o, statusMap: parseStatusMap(env.CRM_STATUS_MAP) });
}
