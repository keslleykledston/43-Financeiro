import type { DB } from "@/lib/db";
import { createMockProviders } from "./mock";
import { createCoraBoletoProvider } from "./cora-boleto";
import { coraClientFor, prodEmissionOn, PROD_EMISSION_FLAG, type Transport } from "./cora-http";
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
 * Modos do provedor de BOLETO por empresa. "simulado" (padrão), "cora_homologacao" (E10b-1, stage: nenhum boleto real nasce) e "cora_producao" (E10b-6: boletos REAIS).
 * O modo de TESTES exige: chave CORA_STAGE_ENABLED="true", empresa nesse modo (diretoria, auditado) e credenciais de homologação.
 * O modo de PRODUÇÃO exige, além de credenciais de produção: a chave CORA_PROD_EMISSION_ENABLED="true" (compose; vem "false"), a empresa configurada nesse modo com AUTORIZAÇÃO REGISTRADA
 * (diretoria digita a confirmação; quem e quando ficam no banco, e o banco recusa o modo sem isso), modo canário (3 por dia) até a diretoria liberar, e cada rodada confirmada na tela.
 * A chave legada CORA_LIVE_ENABLED continua sendo a CHAVE DE EMERGÊNCIA GERAL: ligada, tudo é recusado (inclusive os modos da Cora). Qualquer outra chave real ligada idem.
 */
export const BOLETO_PROVIDER_MODES = ["simulado", "cora_homologacao", "cora_producao"] as const;
export type BoletoProviderMode = (typeof BOLETO_PROVIDER_MODES)[number];
export const MODE_LABEL: Record<string, string> = { simulado: "Simulado", cora_homologacao: "Cora — testes (homologação)", cora_producao: "Cora — PRODUÇÃO (boletos reais)" };
export const LIVE_CONFIRM_PHRASE = "EMITIR BOLETOS REAIS";
export const LIVE_CANARY_DAILY_MAX = 3;
export { prodEmissionOn, PROD_EMISSION_FLAG };
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
  if (mode !== "cora_homologacao" && mode !== "cora_producao") throw new LiveNotAvailable([mode], "Modo de provedor desconhecido: nada será emitido.");
  if (injected && env.VITEST !== "true") throw new Error("Injeção de provedor é proibida fora dos testes");
  const on = unsupportedFlagsOn(env);
  if (on.length > 0) throw new LiveNotAvailable([...on]);
  const prod = mode === "cora_producao";
  if (!prod && !coraStageOn(env)) throw new LiveNotAvailable([CORA_STAGE_FLAG], "A Cora de testes está desligada neste servidor (CORA_STAGE_ENABLED). Nada será emitido.");
  if (prod && !prodEmissionOn(env)) throw new LiveNotAvailable([PROD_EMISSION_FLAG], "A emissão em produção está desligada neste servidor (CORA_PROD_EMISSION_ENABLED). Nada será emitido.");
  let client;
  try { client = await coraClientFor(db, companyId, prod ? "producao" : "homologacao", env.VITEST === "true" ? testTransport : undefined, { liveWrites: prod }); }
  catch { throw new LiveNotAvailable(["credenciais"], `Credenciais da Cora ${prod ? "de produção" : "de testes"} não cadastradas (Integrações → Cora, aba ${prod ? "Produção" : "Homologação"}). Nada será emitido.`); }
  return { ...createMockProviders(), boleto: createCoraBoletoProvider(client, { live: prod }) };
}
