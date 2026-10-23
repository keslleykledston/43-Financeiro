import { CanonicalHttpAdapter } from "./http";
import type { CrmAdapter } from "./types";
import { Invalid } from "@/modules/identity/service";

/** Credenciais vêm do ambiente (secret store), nunca do banco nem do Git. Trocar por um mapeador quando o CRM real for definido. */
export function getCrmAdapter(env: NodeJS.ProcessEnv = process.env): CrmAdapter {
  if (!env.CRM_BASE_URL || !env.CRM_API_TOKEN) throw new Invalid("CRM não configurado no servidor (CRM_BASE_URL / CRM_API_TOKEN).");
  return new CanonicalHttpAdapter({ baseUrl: env.CRM_BASE_URL, token: env.CRM_API_TOKEN, allowInsecureHttp: env.CRM_ALLOW_INSECURE_HTTP === "true" });
}
