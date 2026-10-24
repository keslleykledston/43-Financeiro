import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Cofre simples para segredos guardados no banco (ex.: credenciais de provedores). AES-256-GCM com chave derivada (HKDF) do segredo do servidor.
 * - A chave NUNCA vai para o banco nem para o Git: vem de K3G_CREDENTIALS_KEY ou, na falta dela, de AUTH_SECRET (variáveis do servidor).
 * - O contexto (empresa/provedor/campo) entra como dado autenticado: um valor copiado para outra linha NÃO decifra.
 * - Trocar a chave do servidor invalida os segredos guardados (precisam ser digitados de novo). Nunca logue o resultado de `open`.
 */
const VERSION = "v1";
const secret = (): string => {
  const s = process.env.K3G_CREDENTIALS_KEY || process.env.AUTH_SECRET;
  if (!s || s.length < 32) throw new SecretBoxUnavailable(); // 32+ caracteres aleatórios; o HKDF não cria entropia que a chave não tem
  return s;
};

export class SecretBoxUnavailable extends Error {
  constructor() { super("Cofre de credenciais indisponível: falta a chave de criptografia no servidor"); this.name = "SecretBoxUnavailable"; }
}
export class SecretBoxCorrupt extends Error {
  constructor() { super("Segredo guardado ilegível (chave do servidor mudou ou o dado foi alterado)"); this.name = "SecretBoxCorrupt"; }
}

const key = () => Buffer.from(hkdfSync("sha256", secret(), "k3g-finance/secretbox", `credentials/${VERSION}`, 32));

/** Cifra `plain` ligando-o a `context` (ex.: "empresa|cora|homologacao|chave"). Saída: "v1.<iv>.<tag>.<texto>" em base64url. */
export function seal(plain: string, context: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  c.setAAD(Buffer.from(context, "utf8"));
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [VERSION, iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

const MAX_SEALED = 64 * 1024; // um envelope maior que isto não é um segredo nosso: recusa antes de alocar
const B64URL = /^[A-Za-z0-9_-]*$/;

export function open(sealed: string, context: string): string {
  if (typeof sealed !== "string" || sealed.length > MAX_SEALED) throw new SecretBoxCorrupt();
  const parts = sealed.split(".");
  if (parts.length !== 4) throw new SecretBoxCorrupt();
  const [v, iv, tag, ct] = parts;
  if (v !== VERSION || !B64URL.test(iv) || !B64URL.test(tag) || !B64URL.test(ct)) throw new SecretBoxCorrupt();
  if (Buffer.from(iv, "base64url").length !== 12 || Buffer.from(tag, "base64url").length !== 16) throw new SecretBoxCorrupt();
  try {
    const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
    d.setAAD(Buffer.from(context, "utf8"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
  } catch (e) {
    if (e instanceof SecretBoxUnavailable) throw e;
    throw new SecretBoxCorrupt();
  }
}
