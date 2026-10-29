/** W1 — regras PURAS do módulo WhatsApp (sem banco nem rede). */
import { createHash } from "node:crypto";
import type { WahaStatus } from "@/modules/providers/waha";

export type SessionStatus = "CREATED" | "STARTING" | "QR_REQUIRED" | "CONNECTED" | "DISCONNECTED" | "DEGRADED" | "REVOKED";

export const STATUS_LABEL: Record<SessionStatus, string> = {
  CREATED: "Criada", STARTING: "Iniciando", QR_REQUIRED: "Aguardando leitura do QR", CONNECTED: "Conectada", DISCONNECTED: "Desconectada", DEGRADED: "Com problema", REVOKED: "Removida",
};

/** Estado da WAHA → estado nosso. Desconhecido vira "com problema" (nunca "conectada" por engano). */
export function mapWahaStatus(s: WahaStatus): SessionStatus {
  switch (s) {
    case "WORKING": return "CONNECTED";
    case "SCAN_QR_CODE": return "QR_REQUIRED";
    case "STARTING": return "STARTING";
    case "STOPPED": return "DISCONNECTED";
    default: return "DEGRADED"; // FAILED e qualquer estado novo da WAHA
  }
}

/** Número brasileiro → dígitos com DDI ("5592991234567"). Aceita máscara, +55 e sem DDI; celular (11 dígitos) ou fixo/antigo (10). null = inválido. */
export function parseBrPhone(raw: string): string | null {
  let d = String(raw ?? "").replace(/[\s().+-]/g, "");
  if (!/^\d+$/.test(d)) return null;
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) d = d.slice(2);
  if (d.length !== 10 && d.length !== 11) return null;
  const ddd = Number(d.slice(0, 2));
  if (ddd < 11 || ddd > 99 || d.startsWith("0", 2)) return null;
  if (d.length === 11 && d[2] !== "9") return null; // celular com 11 dígitos começa em 9
  return `55${d}`;
}

export const chatIdFor = (digits: string) => `${digits}@c.us`;

/** "+55 92 •••••-1234" — só o mascarado é guardado em lista, log e auditoria. */
export function maskPhone(digits: string): string {
  const d = digits.replace(/\D/g, "");
  if (d.length < 10) return "•••••";
  const national = d.startsWith("55") ? d.slice(2) : d;
  return `+55 ${national.slice(0, 2)} •••••-${national.slice(-4)}`;
}

/** Telefone próprio da sessão a partir do `me.id` da WAHA ("5592999999999@c.us"). */
export function maskMe(meId: string | null): string | null {
  const m = /^(\d{10,15})(?::\d+)?@/.exec(meId ?? "");
  return m ? maskPhone(m[1]) : null;
}

/** Texto FIXO do teste: sem dado de cliente, sem link, sem promessa de "responda PARAR" (o recebimento de respostas só existe na entrega 3). */
export function testText(senderIdentity: string): string {
  return `Teste do K3G Finance. Esta é uma mensagem de teste de ${senderIdentity.trim()}, enviada pela equipe para validar a conexão do WhatsApp. Nenhuma cobrança está envolvida e não é preciso responder.`;
}

export const CAPS = { sessionDaily: 20, companyDaily: 10, authorizationMax: 10 } as const;

export type Check = { key: string; ok: boolean; label: string; detail?: string };

/** O id devolvido pela WAHA traz o telefone: o banco guarda só este hash (32 hex). A entrega 3 correlaciona ACK/eventos aplicando o MESMO hash ao id que chegar. */
export const refHash = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 32);

/**
 * Mesmo assinante? Igualdade exata, OU a equivalência oficial do 9º dígito dos celulares brasileiros: `55 DDD 9 XXXXXXXX` (13 dígitos) e `55 DDD XXXXXXXX` (12) são a MESMA linha
 * quando o DDD e os 8 dígitos finais coincidem e o 8-dígito é de celular (começa em 6 a 9; fixos começam em 2 a 5 e nunca casam). Só isto: qualquer outra diferença = outro número.
 * Usada para aceitar o id canônico que a WAHA devolve para o número JÁ AUTORIZADO (contas antigas do WhatsApp existem sem o 9).
 */
export function sameBrNumber(a: string, b: string): boolean {
  if (!/^55\d{10,11}$/.test(a) || !/^55\d{10,11}$/.test(b)) return false;
  if (a === b) return true;
  const [long, short] = a.length === 13 && b.length === 12 ? [a, b] : a.length === 12 && b.length === 13 ? [b, a] : [null, null];
  if (!long || !short) return false;
  return long.slice(2, 4) === short.slice(2, 4) && long[4] === "9" && long.slice(5) === short.slice(4) && /^[6-9]/.test(short.slice(4));
}

export const EVIDENCE_SOURCES = ["verbal", "escrito", "formulario", "cliente_iniciou"] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];
export const EVIDENCE_LABEL: Record<EvidenceSource, string> = { verbal: "Autorização verbal (anotada)", escrito: "Autorização por escrito (e-mail, contrato)", formulario: "Formulário assinado/online", cliente_iniciou: "Cliente iniciou a conversa" };
/** Estado do contato para esta empresa: o evento mais recente vale; opt-out GLOBAL do número prevalece sobre tudo. */
export type ConsentState = "opt_in" | "opt_out_company" | "opt_out_global" | "none";
export const CONSENT_LABEL: Record<ConsentState, string> = { opt_in: "Consentiu", opt_out_company: "Pediu para parar (esta empresa)", opt_out_global: "Pediu para parar (todas as empresas)", none: "Sem consentimento" };
export const BLOCK_REASON_LABEL: Record<string, string> = {
  server_flag: "Chave de envio do servidor desligada", module: "Módulo/WAHA não configurados", bound: "Conexão sem vínculo com a empresa", session_active: "Conexão pausada", session_connected: "Conexão não conectada",
  company_active: "Envios da empresa pausados", authorization: "Sem autorização de envio", phone: "Número inválido", allowed: "Número fora da lista autorizada", optout: "Contato pediu para não receber",
  window: "Fora da janela de envio", cap_auth: "Limite da autorização", cap_company: "Limite diário da empresa", cap_session: "Limite diário da conexão",
};

/** A prova do consentimento é uma REFERÊNCIA («e-mail de 28/10», «contrato 123»), nunca dado pessoal: recusa e-mail, telefone, CPF/CNPJ e sequências longas de dígitos. Datas e números curtos passam. */
export function looksLikePii(ref: string): boolean {
  if (/[^\s@]+@[^\s@]+/.test(ref)) return true;                                   // e-mail
  if (/\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?!\d)/.test(ref)) return true;                 // CPF
  if (/\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}/.test(ref)) return true;              // CNPJ
  if (/(?:\+?55\s?)?\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4}(?!\d)/.test(ref)) return true; // telefone
  if (/\d{9,}/.test(ref.replace(/[\s.\-()/]/g, ""))) return true;                  // qualquer sequência longa
  return false;
}
/** Para DESFAZER um pedido de parar global: só prova escrita ou iniciada pelo próprio cliente (nunca «verbal»). */
export const GLOBAL_OPT_IN_SOURCES: readonly EvidenceSource[] = ["escrito", "formulario", "cliente_iniciou"];
