import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { open, seal, SecretBoxCorrupt, SecretBoxUnavailable } from "@/lib/security/secretbox";

const KEEP = { a: process.env.AUTH_SECRET, k: process.env.K3G_CREDENTIALS_KEY };
beforeEach(() => { process.env.K3G_CREDENTIALS_KEY = "chave-de-teste-0123456789abcdef-0123456789"; });
afterEach(() => { for (const [k, v] of [["AUTH_SECRET", KEEP.a], ["K3G_CREDENTIALS_KEY", KEEP.k]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

describe("cofre de segredos (AES-256-GCM)", () => {
  it("cifra e decifra; o texto puro não aparece; cada cifra é diferente", () => {
    const s = seal("segredo-do-cora", "emp|cora|homologacao|key");
    expect(s.startsWith("v1.")).toBe(true);
    expect(s).not.toContain("segredo");
    expect(open(s, "emp|cora|homologacao|key")).toBe("segredo-do-cora");
    expect(seal("segredo-do-cora", "emp|cora|homologacao|key")).not.toBe(s); // IV aleatório
    expect(open(seal("", "c"), "c")).toBe("");
    expect(open(seal("acentuação — ñ 🔐", "c"), "c")).toBe("acentuação — ñ 🔐");
  });

  it("o contexto é autenticado: valor copiado para outra empresa/campo/ambiente não decifra", () => {
    const s = seal("x", "empA|cora|homologacao|key");
    for (const c of ["empB|cora|homologacao|key", "empA|cora|producao|key", "empA|cora|homologacao|cert"]) expect(() => open(s, c)).toThrow(SecretBoxCorrupt);
  });

  it("detecta adulteração e formato inválido", () => {
    const [v, iv, tag, ct] = seal("valor", "c").split(".");
    const flip = (b64: string) => (b64[0] === "A" ? "B" : "A") + b64.slice(1);
    expect(() => open([v, iv, tag, flip(ct)].join("."), "c")).toThrow(SecretBoxCorrupt);
    expect(() => open([v, iv, flip(tag), ct].join("."), "c")).toThrow(SecretBoxCorrupt);
    expect(() => open(["v2", iv, tag, ct].join("."), "c")).toThrow(SecretBoxCorrupt);
    expect(() => open("lixo", "c")).toThrow(SecretBoxCorrupt);
  });

  it("envelope malformado ou gigante é recusado antes de decifrar", () => {
    const [v, iv, tag, ct] = seal("valor", "c").split(".");
    expect(() => open([v, iv, tag, ct].join(".") + "." + "x", "c")).toThrow(SecretBoxCorrupt);       // partes a mais
    expect(() => open([v, "AAAA", tag, ct].join("."), "c")).toThrow(SecretBoxCorrupt);                 // IV de tamanho errado
    expect(() => open([v, iv, "AAAA", ct].join("."), "c")).toThrow(SecretBoxCorrupt);                  // tag de tamanho errado
    expect(() => open([v, iv, tag, "***"].join("."), "c")).toThrow(SecretBoxCorrupt);                  // não é base64url
    expect(() => open(`v1.${iv}.${tag}.${"A".repeat(70_000)}`, "c")).toThrow(SecretBoxCorrupt);        // grande demais
  });

  it("chave do servidor: K3G_CREDENTIALS_KEY tem precedência; sem nenhuma, indisponível; trocar a chave invalida", () => {
    const s = seal("x", "c");
    process.env.K3G_CREDENTIALS_KEY = "outra-chave-0123456789abcdef-0123456789";
    expect(() => open(s, "c")).toThrow(SecretBoxCorrupt);
    delete process.env.K3G_CREDENTIALS_KEY; delete process.env.AUTH_SECRET;
    expect(() => seal("x", "c")).toThrow(SecretBoxUnavailable);
    process.env.AUTH_SECRET = "auth-secret-de-teste-0123456789-abcdefgh";
    expect(open(seal("y", "c"), "c")).toBe("y");
    process.env.AUTH_SECRET = "curto-demais-0123456789abcdef";
    expect(() => seal("x", "c")).toThrow(SecretBoxUnavailable);
  });
});
