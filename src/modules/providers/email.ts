import { Invalid } from "@/modules/identity/service";

/**
 * E22 — conta de e-mail (SMTP) usada para enviar cobranças. Validações PURAS (sem banco, sem rede).
 * O servidor é digitado pela diretoria e, no envio real (E10b), o sistema vai se conectar a ele: por isso só aceita nome de domínio público
 * (sem IP, sem "localhost", sem nomes internos) e portas SMTP conhecidas, para a tela não servir de ponte para a rede interna.
 */
export const SMTP_PORTS = [465, 587, 2525, 25] as const;
export const SECURITY = ["ssl", "starttls"] as const;
export type Security = (typeof SECURITY)[number];
export const SECURITY_LABEL: Record<Security, string> = { ssl: "SSL/TLS direto (porta 465)", starttls: "STARTTLS (portas 587, 2525 ou 25)" };

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F]/;
const INTERNAL = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|test|invalid|example)$/;

export function parseHost(raw: string): string {
  const h = oneLine(raw).toLowerCase().replace(/\.$/, "");
  if (!h) throw new Invalid("Informe o servidor SMTP");
  if (/^[0-9.]+$/.test(h) || /^\[?[0-9a-f:]+\]?$/.test(h) && h.includes(":") || INTERNAL.test(h)) throw new Invalid("Use o nome público do servidor SMTP (não aceitamos endereço IP nem nomes internos)");
  if (h.length > 253 || !/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(h)) throw new Invalid("Servidor SMTP inválido: use só o nome (ex.: smtp.seudominio.com.br), sem http://, porta ou espaços");
  return h;
}

export function parsePort(raw: unknown): number {
  const n = Number(typeof raw === "string" ? raw.trim() : raw);
  if (!Number.isInteger(n) || !(SMTP_PORTS as readonly number[]).includes(n)) throw new Invalid("Porta inválida: use 465, 587, 2525 ou 25");
  return n;
}

export function parseSecurity(raw: unknown, port: number): Security {
  const s = String(raw ?? "");
  if (!(SECURITY as readonly string[]).includes(s)) throw new Invalid("Escolha o tipo de segurança da conexão");
  if ((s === "ssl") !== (port === 465)) throw new Invalid("SSL/TLS direto usa a porta 465; STARTTLS usa 587, 2525 ou 25");
  return s as Security;
}

export function parseEmailAddress(raw: string, what: string, required = true): string | null {
  const v = oneLine(raw);
  if (!v) { if (required) throw new Invalid(`Informe ${what}`); return null; }
  if (v.length > 200 || CONTROL.test(v) || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(v)) throw new Invalid(`${what[0].toUpperCase()}${what.slice(1)} inválido`);
  return v.toLowerCase();
}

/** Nome do remetente vai no cabeçalho do e-mail: sem quebra de linha, aspas ou < > (injeção de cabeçalho). */
export function parseFromName(raw: string): string | null {
  const v = oneLine(raw);
  if (!v) return null;
  if (v.length > 80 || /["<>@;]/.test(v) || CONTROL.test(v)) throw new Invalid("Nome do remetente inválido (até 80 caracteres, sem aspas, < > @ ou ;)");
  return v;
}

export function parseSmtpUser(raw: string): string {
  const v = raw.trim();
  if (!v || v.length > 200 || CONTROL.test(v)) throw new Invalid("Usuário SMTP inválido");
  return v;
}

export function parseSmtpPassword(raw: string): string {
  if (!raw || raw.length > 500 || CONTROL.test(raw)) throw new Invalid("Senha SMTP inválida (não pode ficar vazia nem ter quebra de linha)");
  return raw;
}
