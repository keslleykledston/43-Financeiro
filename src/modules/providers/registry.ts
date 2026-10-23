import { createMockProviders } from "./mock";
import type { Providers } from "./types";

/** Chaves de emissão/envio reais. TODAS desligadas; ligar uma sem adaptador real implementado (E10) é recusado. */
export const LIVE_FLAGS = ["BILLING_LIVE_ENABLED", "EMAIL_EXTERNAL_ENABLED", "CORA_LIVE_ENABLED", "FISCAL_LIVE_ENABLED", "WHATSAPP_LIVE_ENABLED"] as const;

export class LiveNotAvailable extends Error {
  constructor(flags: string[]) {
    super(`Chave(s) ${flags.join(", ")} ligada(s), mas não há adaptador real homologado (E10). Desligue-as: nada será enviado.`);
    this.name = "LiveNotAvailable";
  }
}

export const liveFlagsOn = (env: Record<string, string | undefined> = process.env) => LIVE_FLAGS.filter((f) => env[f] === "true");

/** Falha FECHADA: com qualquer chave real ligada, recusa em vez de fingir que enviou ou de enviar de verdade. */
export function getProviders(env: Record<string, string | undefined> = process.env): Providers {
  const on = liveFlagsOn(env);
  if (on.length > 0) throw new LiveNotAvailable([...on]);
  return createMockProviders();
}

export const PROVIDER_CATALOG = [
  { key: "cora-boleto", label: "Cora — boletos e Pix", note: "Aguardando credenciais (certificado mTLS + client-id)", flag: "CORA_LIVE_ENABLED" },
  { key: "cora-extrato", label: "Cora — extrato e saldo", note: "Aguardando credenciais", flag: "CORA_LIVE_ENABLED" },
  { key: "cora-nfse", label: "NFS-e da Cora (beta)", note: "Confirmar cobertura do município e CNAEs", flag: "FISCAL_LIVE_ENABLED" },
  { key: "smtp", label: "E-mail (SMTP k3gsolutions.com.br)", note: "Falta SPF/DKIM/DMARC e remetente por empresa", flag: "EMAIL_EXTERNAL_ENABLED" },
  { key: "waha", label: "WhatsApp (WAHA, não oficial)", note: "Risco de bloqueio aceito; exige lista de opt-in e número dedicado", flag: "WHATSAPP_LIVE_ENABLED" },
] as const;
