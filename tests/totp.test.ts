import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, generateRecoveryCode, generateSecret, hashRecovery, hotp, looksLikeRecovery, normalizeRecovery, otpauthUri, totpAt, verifyTotp } from "@/lib/security/totp";

const RFC = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // "12345678901234567890" (RFC 6238, SHA-1)

describe("E28 — TOTP (RFC 6238)", () => {
  it("vetores oficiais (6 últimos dígitos dos códigos de 8)", () => {
    const at = (s: number) => totpAt(RFC, new Date(s * 1000));
    expect(at(59)).toBe("287082"); expect(at(1111111109)).toBe("081804"); expect(at(1111111111)).toBe("050471");
    expect(at(1234567890)).toBe("005924"); expect(at(2000000000)).toBe("279037"); expect(at(20000000000)).toBe("353130");
  });
  it("base32 ida e volta; recusa caractere inválido", () => {
    expect(base32Encode(Buffer.from("12345678901234567890"))).toBe(RFC);
    expect(base32Decode(RFC).toString()).toBe("12345678901234567890");
    expect(() => base32Decode("AAA1")).toThrow();
    const s = generateSecret(); expect(s).toMatch(/^[A-Z2-7]{32}$/); expect(base32Decode(s)).toHaveLength(20);
  });
  it("aceita o passo atual e ±1; recusa fora da janela, formato errado e REUSO do passo", () => {
    const now = new Date(1234567890 * 1000);
    const step = Math.floor(1234567890 / 30);
    const cur = hotp(RFC, step), prev = hotp(RFC, step - 1), next = hotp(RFC, step + 1), far = hotp(RFC, step + 2);
    expect(verifyTotp(RFC, cur, now, null)).toBe(step);
    expect(verifyTotp(RFC, prev, now, null)).toBe(step - 1);
    expect(verifyTotp(RFC, next, now, null)).toBe(step + 1);
    expect(verifyTotp(RFC, far, now, null)).toBeNull();
    expect(verifyTotp(RFC, cur, now, step)).toBeNull(); // já usado
    expect(verifyTotp(RFC, prev, now, step)).toBeNull(); // passo anterior ao último aceito
    expect(verifyTotp(RFC, next, now, step)).toBe(step + 1);
    for (const bad of ["", "12345", "1234567", "abcdef", "12 34 5"]) expect(verifyTotp(RFC, bad, now, null)).toBeNull();
    expect(verifyTotp(RFC, `${cur.slice(0, 3)} ${cur.slice(3)}`, now, null)).toBe(step); // espaço do meio é tolerado
  });
  it("URI otpauth", () => {
    const u = otpauthUri("K3G Finance", "a@b.com", RFC);
    expect(u).toBe(`otpauth://totp/K3G%20Finance:a%40b.com?secret=${RFC}&issuer=K3G%20Finance&algorithm=SHA1&digits=6&period=30`);
  });
  it("códigos de recuperação: formato, normalização, hash estável e distinção de código TOTP", () => {
    const c = generateRecoveryCode();
    expect(c).toMatch(/^[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}$/);
    expect(normalizeRecovery(c.toLowerCase())).toBe(c.replace("-", ""));
    expect(hashRecovery(c)).toBe(hashRecovery(c.toLowerCase().replace("-", " ")));
    expect(hashRecovery(c)).not.toBe(hashRecovery(generateRecoveryCode()));
    expect(looksLikeRecovery(c)).toBe(true);
    expect(looksLikeRecovery("123456")).toBe(false); expect(looksLikeRecovery("12 34 56")).toBe(false); expect(looksLikeRecovery("abc")).toBe(false);
  });
});
