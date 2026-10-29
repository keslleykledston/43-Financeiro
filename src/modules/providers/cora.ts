import { X509Certificate, createPrivateKey } from "node:crypto";
import { Invalid } from "@/modules/identity/service";

/**
 * Cora — o que a integração PODE e NÃO PODE fazer (decisão do dono, 2026-10-24): só boletos.
 * Emitir, consultar a situação (emitido / pago / atrasado), segunda via e CANCELAR boleto (este só pela diretoria, com motivo e registro; ver `permissions.ts`). A plataforma NUNCA movimenta dinheiro da conta:
 * sem pagamento, transferência, Pix enviado, leitura de saldo/extrato. Esta lista é a fonte da tela e dos testes; um adaptador real só pode usar o que está em `allowed`.
 */
export const CORA_SCOPE = {
  allowed: [
    { key: "boleto.emitir", label: "Emitir boleto" },
    { key: "boleto.consultar", label: "Consultar a situação do boleto (emitido, pago, atrasado)" },
    { key: "boleto.segunda_via", label: "Emitir segunda via do boleto" },
    { key: "boleto.cancelar", label: "Cancelar boleto — só a diretoria, com motivo; fica tudo registrado" },
    { key: "boleto.avisos", label: "Receber avisos (webhook) de boleto pago ou cancelado e reconsultar o boleto" },
  ],
  forbidden: [
    { key: "pagamento", label: "Pagar contas ou boletos" },
    { key: "transferencia", label: "Transferir ou enviar Pix" },
    { key: "extrato_saldo", label: "Ler saldo ou extrato da conta" },
  ],
} as const;

export const CORA_ENVIRONMENTS = ["homologacao", "producao"] as const;
export type CoraEnvironment = (typeof CORA_ENVIRONMENTS)[number];
export const ENV_LABEL: Record<CoraEnvironment, string> = { homologacao: "Homologação (testes)", producao: "Produção" };

const MAX_PEM = 16_384;
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export function parseClientId(raw: string): string {
  const v = oneLine(raw);
  if (v.length < 6 || v.length > 200 || !/^[A-Za-z0-9._:\-]+$/.test(v)) throw new Invalid("Client ID inválido (use só letras, números e - _ . :, de 6 a 200 caracteres)");
  return v;
}

export function parseLabel(raw: string): string | null {
  const v = oneLine(raw);
  if (!v) return null;
  if (v.length < 2 || v.length > 60) throw new Invalid("O apelido da conta deve ter de 2 a 60 caracteres");
  return v;
}

function pemOf(raw: string, what: string): string {
  const v = raw.replace(/\r\n/g, "\n").trim();
  if (!v) throw new Invalid(`Informe ${what}`);
  if (v.length > MAX_PEM) throw new Invalid(`${what[0].toUpperCase()}${what.slice(1)} grande demais`);
  return v;
}

export type ParsedCert = { pem: string; fingerprint: string; notBefore: string; notAfter: string };

/** Valida o certificado (PEM): um só certificado, dentro da validade. Nunca devolve nem registra o conteúdo em erros. */
export function parseCertificate(raw: string, now = new Date()): ParsedCert {
  const pem = pemOf(raw, "o certificado");
  if (/PRIVATE KEY/.test(pem)) throw new Invalid("Este campo é do certificado, mas contém uma chave privada. Confira os campos");
  if ((pem.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length !== 1) throw new Invalid("Cole exatamente um certificado no formato PEM (-----BEGIN CERTIFICATE-----)");
  let c: X509Certificate;
  try { c = new X509Certificate(pem); } catch { throw new Invalid("Certificado ilegível: confira se é o arquivo .pem/.crt completo"); }
  const from = new Date(c.validFrom), to = new Date(c.validTo);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new Invalid("Certificado com datas inválidas");
  if (to < now) throw new Invalid("Certificado vencido: gere um novo na Cora");
  if (from > now) throw new Invalid("Certificado ainda não é válido (data de início no futuro)");
  return { pem, fingerprint: c.fingerprint256.replace(/:/g, "").toLowerCase(), notBefore: from.toISOString().slice(0, 10), notAfter: to.toISOString().slice(0, 10) };
}

/** Valida a chave privada (PEM, sem senha) e confere se ela é a do certificado. */
export function parsePrivateKey(raw: string, cert: string): string {
  const pem = pemOf(raw, "a chave privada");
  if (/ENCRYPTED PRIVATE KEY/.test(pem) || /Proc-Type:\s*4,ENCRYPTED/.test(pem)) throw new Invalid("A chave privada está protegida por senha. Informe a chave sem senha, como a Cora entrega");
  if (!/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(pem)) throw new Invalid("Cole a chave privada no formato PEM (-----BEGIN PRIVATE KEY-----)");
  if ((pem.match(/PRIVATE KEY-----/g) ?? []).length !== 2) throw new Invalid("Cole exatamente uma chave privada");
  let ok = false;
  try { ok = new X509Certificate(cert).checkPrivateKey(createPrivateKey(pem)); } catch { throw new Invalid("Chave privada ilegível: confira se é o arquivo completo"); }
  if (!ok) throw new Invalid("A chave privada não combina com o certificado informado");
  return pem;
}
