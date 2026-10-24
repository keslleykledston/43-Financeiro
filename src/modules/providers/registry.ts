import { createMockProviders } from "./mock";
import type { Providers } from "./types";

/** Chaves de emissão/envio reais. TODAS desligadas; ligar uma sem adaptador real implementado (E10) é recusado. */
export const LIVE_FLAGS = ["BILLING_LIVE_ENABLED", "EMAIL_EXTERNAL_ENABLED", "CORA_LIVE_ENABLED", "FISCAL_LIVE_ENABLED", "WHATSAPP_LIVE_ENABLED"] as const;

export class LiveNotAvailable extends Error {
  constructor(flags: string[], message?: string) {
    super(message ?? `Chave(s) ${flags.join(", ")} ligada(s), mas não há adaptador real homologado (E10). Desligue-as: nada será enviado.`);
    this.name = "LiveNotAvailable";
  }
}

export const liveFlagsOn = (env: Record<string, string | undefined> = process.env) => LIVE_FLAGS.filter((f) => env[f] === "true");
/** Chaves SEM adaptador real: ligadas, o sistema recusa tudo. O e-mail (E23) tem adaptador, mas só vale com autorização registrada por empresa (providers/email-live.ts): a chave sozinha não envia. */
export const UNSUPPORTED_FLAGS = LIVE_FLAGS.filter((f) => f !== "EMAIL_EXTERNAL_ENABLED");
export const unsupportedFlagsOn = (env: Record<string, string | undefined> = process.env) => UNSUPPORTED_FLAGS.filter((f) => env[f] === "true");

/** Falha FECHADA: com qualquer chave real ligada, recusa em vez de fingir que enviou ou de enviar de verdade. */
export function getProviders(env: Record<string, string | undefined> = process.env): Providers {
  const on = unsupportedFlagsOn(env);
  if (on.length > 0) throw new LiveNotAvailable([...on]);
  return createMockProviders();
}

/** Vale também para provedores INJETADOS (testes ou chamadores futuros): chave real ligada ou adaptador não simulado → recusa. */
export function assertSimulated(p: Providers, env: Record<string, string | undefined> = process.env): Providers {
  const on = unsupportedFlagsOn(env);
  if (on.length > 0) throw new LiveNotAvailable([...on]);
  const real = Object.entries(p).filter(([, v]) => v.mode !== "mock").map(([k]) => k);
  if (real.length > 0) throw new LiveNotAvailable(real, `Provedor(es) ${real.join(", ")} não simulado(s): adaptador real só entra na fase E10, com homologação e autorização.`);
  return p;
}

/** Ponto único de resolução dos provedores. Injeção só existe sob o executor de testes (VITEST): fora dele, o runtime usa apenas os provedores do registro. */
export function resolveProviders(injected?: Providers, env: Record<string, string | undefined> = process.env): Providers {
  if (injected && env.VITEST !== "true") throw new Error("Injeção de provedor é proibida fora dos testes");
  return assertSimulated(injected ?? getProviders(env), env);
}

export const PROVIDER_CATALOG = [
  { key: "cora-boleto", label: "Cora — boletos (emitir, consultar situação, segunda via)", note: "Credenciais na seção «Cora — boletos» acima. Sem pagamentos, transferências nem leitura de saldo/extrato", flag: "CORA_LIVE_ENABLED" },
  { key: "cora-nfse", label: "NFS-e da Cora (beta)", note: "Confirmar cobertura do município e CNAEs", flag: "FISCAL_LIVE_ENABLED" },
  { key: "smtp", label: "E-mail (SMTP k3gsolutions.com.br)", note: "Falta SPF/DKIM/DMARC e remetente por empresa", flag: "EMAIL_EXTERNAL_ENABLED" },
  { key: "waha", label: "WhatsApp (WAHA, não oficial)", note: "Risco de bloqueio aceito; exige lista de opt-in e número dedicado", flag: "WHATSAPP_LIVE_ENABLED" },
] as const;
