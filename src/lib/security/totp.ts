import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/**
 * E28 — TOTP (RFC 6238) e códigos de recuperação. PURO (sem banco). HMAC-SHA1, 6 dígitos, passo de 30 s: é o que todo aplicativo autenticador aceita.
 * Aceita o passo atual e um para cada lado (relógio levemente fora). Quem chama grava o último passo aceito para impedir reuso do mesmo código.
 */
export const STEP_SECONDS = 30;
export const DIGITS = 6;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  const clean = s.replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("base32 inválido");
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const generateSecret = () => base32Encode(randomBytes(20)); // 160 bits

export function hotp(secretB32: string, counter: number): string {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", base32Decode(secretB32)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, "0");
}
export const stepOf = (now: Date) => Math.floor(now.getTime() / 1000 / STEP_SECONDS);
export const totpAt = (secretB32: string, now: Date) => hotp(secretB32, stepOf(now));

const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Retorna o passo que bateu (para gravar como "último usado") ou null. Só passos MAIORES que `lastStep` valem: o mesmo código não entra duas vezes. */
export function verifyTotp(secretB32: string, code: string, now: Date, lastStep: number | null): number | null {
  const c = String(code ?? "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const cur = stepOf(now);
  let hit: number | null = null;
  for (const d of [-1, 0, 1]) { // percorre os três sempre (tempo constante em relação ao acerto)
    const st = cur + d;
    if (eq(hotp(secretB32, st), c) && (lastStep === null || st > lastStep) && (hit === null || st > hit)) hit = st;
  }
  return hit;
}

export const otpauthUri = (issuer: string, account: string, secretB32: string) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;

/** Agrupa a chave de 4 em 4 para digitar no aplicativo. */
export const groupSecret = (s: string) => s.replace(/(.{4})/g, "$1 ").trim();

// Códigos de recuperação: 10 caracteres de um alfabeto sem ambíguos (≈ 50 bits), no formato XXXXX-XXXXX; comparados pelo hash.
const RC = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const RECOVERY_COUNT = 10;
export function generateRecoveryCode(): string {
  let s = ""; for (let i = 0; i < 10; i++) s += RC[randomInt(RC.length)];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}
export const normalizeRecovery = (c: string) => String(c ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
export const looksLikeRecovery = (c: string) => /^[A-Z2-9]{10}$/.test(normalizeRecovery(c)) && !/^\d{6}$/.test(String(c ?? "").replace(/\s/g, ""));
export const hashRecovery = (c: string) => createHash("sha256").update("k3g-recovery|" + normalizeRecovery(c)).digest("hex");
