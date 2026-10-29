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
