import type { DB } from "@/lib/db";
import { createMockProviders } from "./mock";
import { createCoraBoletoProvider } from "./cora-boleto";
import { coraClientFor, type Transport } from "./cora-http";
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


/**
 * E10b-1 — modos do provedor de BOLETO por empresa. "simulado" (padrão) ou "cora_homologacao" (stage da Cora: nenhum boleto real nasce).
 * NÃO existe modo de produção: emitir em produção exige novo modo, nova migração, mudança do cliente HTTP e autorização escrita do dono.
 * O modo da Cora de testes só funciona com TRÊS travas: a chave CORA_STAGE_ENABLED="true" (compose, commit), a empresa configurada nesse modo (diretoria,
 * auditado) e credenciais de homologação cadastradas. Qualquer outra chave real ligada (CORA_LIVE_ENABLED etc.) continua recusando tudo.
 */
export const BOLETO_PROVIDER_MODES = ["simulado", "cora_homologacao"] as const;
export type BoletoProviderMode = (typeof BOLETO_PROVIDER_MODES)[number];
export const MODE_LABEL: Record<string, string> = { simulado: "Simulado", cora_homologacao: "Cora — testes (homologação)" };
export const CORA_STAGE_FLAG = "CORA_STAGE_ENABLED";
export const coraStageOn = (env: Record<string, string | undefined> = process.env) => env[CORA_STAGE_FLAG] === "true";
export const isBoletoMode = (m: string): m is BoletoProviderMode => (BOLETO_PROVIDER_MODES as readonly string[]).includes(m);

// Transporte falso dos testes: só existe sob o executor de testes (como a injeção de provedores).
let testTransport: Transport | undefined;
export function __setCoraTransportForTests(t: Transport | undefined) {
  if (process.env.VITEST !== "true") throw new Error("Transporte injetado é proibido fora dos testes");
  testTransport = t;
}

/** Provedores para um modo de boleto. NFS-e, e-mail e WhatsApp seguem SEMPRE simulados. Falha FECHADA (LiveNotAvailable) se faltar qualquer trava. */
export async function resolveProvidersForMode(db: DB, companyId: string, mode: string, injected?: Providers, env: Record<string, string | undefined> = process.env): Promise<Providers> {
  if (mode === "simulado") return resolveProviders(injected, env);
  if (mode !== "cora_homologacao") throw new LiveNotAvailable([mode], "Modo de provedor desconhecido: nada será emitido.");
  if (injected && env.VITEST !== "true") throw new Error("Injeção de provedor é proibida fora dos testes");
  const on = unsupportedFlagsOn(env);
  if (on.length > 0) throw new LiveNotAvailable([...on]);
  if (!coraStageOn(env)) throw new LiveNotAvailable([CORA_STAGE_FLAG], "A Cora de testes está desligada neste servidor (CORA_STAGE_ENABLED). Nada será emitido.");
  let client;
  try { client = await coraClientFor(db, companyId, "homologacao", env.VITEST === "true" ? testTransport : undefined); }
  catch { throw new LiveNotAvailable(["credenciais"], "Credenciais da Cora de testes não cadastradas (Integrações → Cora, aba Homologação). Nada será emitido."); }
  return { ...createMockProviders(), boleto: createCoraBoletoProvider(client) };
}
