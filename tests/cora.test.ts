import { describe, expect, it } from "vitest";
import { CORA_SCOPE, parseCertificate, parseClientId, parseLabel, parsePrivateKey } from "@/modules/providers/cora";
import { createMockProviders } from "@/modules/providers/mock";
import { PROVIDER_CATALOG } from "@/modules/providers/registry";
import { Invalid } from "@/modules/identity/service";
import { ENCRYPTED_KEY, OTHER_KEY, TEST_CERT, TEST_KEY } from "./fixtures/cora-teste";

const NOW = new Date(); // o certificado de teste vale 10 anos a partir de quando foi gerado

describe("Cora — escopo somente de boletos", () => {
  it("a lista permitida não tem nada que mexa em dinheiro, e a proibida cobre pagamento, transferência e extrato", () => {
    expect(CORA_SCOPE.allowed.map((a) => a.key)).toEqual(["boleto.emitir", "boleto.consultar", "boleto.segunda_via", "boleto.cancelar"]);
    expect(CORA_SCOPE.allowed.some((a) => /pag|transf|pix|saldo|extrato/i.test(a.key))).toBe(false);
    expect(CORA_SCOPE.forbidden.map((a) => a.key)).toEqual(expect.arrayContaining(["pagamento", "transferencia", "extrato_saldo"]));
  });

  it("o provedor de boleto não tem operação de pagamento/transferência/saldo e o catálogo não promete extrato", () => {
    const methods = Object.keys(createMockProviders().boleto).sort();
    expect(methods).toEqual(["cancel", "find", "issue", "mode", "status"]);                      // nada além do escopo
    expect(methods.filter((m) => /pag|transf|pix|saldo|extrato|withdraw|send/i.test(m))).toEqual([]);
    expect(Object.keys(createMockProviders()).sort()).toEqual(["boleto", "email", "nfse", "whatsapp"]); // sem provedor de extrato
    expect(PROVIDER_CATALOG.some((p) => /extrato|saldo/i.test(p.label))).toBe(false);
  });
});

describe("Cora — validação das credenciais (dados descartáveis)", () => {
  it("client id e apelido", () => {
    expect(parseClientId("  int-abc123XYZ  ")).toBe("int-abc123XYZ");
    for (const bad of ["", "abc", "tem espaço no meio", "x".repeat(201), "<script>alert(1)</script>"]) expect(() => parseClientId(bad)).toThrow(Invalid);
    expect(parseLabel("")).toBeNull();
    expect(parseLabel("  Conta   K3G ")).toBe("Conta K3G");
    expect(() => parseLabel("x")).toThrow(Invalid);
  });

  it("certificado válido: impressão digital e validade; erros em português e sem vazar conteúdo", () => {
    const c = parseCertificate(TEST_CERT, NOW);
    expect(c.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(c.notAfter > "2030-01-01").toBe(true);
    expect(parseCertificate(TEST_CERT.replace(/\n/g, "\r\n"), NOW).fingerprint).toBe(c.fingerprint);
    expect(() => parseCertificate("", NOW)).toThrow(/Informe o certificado/);
    expect(() => parseCertificate(TEST_KEY, NOW)).toThrow(/contém uma chave privada/);
    expect(() => parseCertificate(TEST_CERT + "\n" + TEST_CERT, NOW)).toThrow(/exatamente um certificado/);
    expect(() => parseCertificate("-----BEGIN CERTIFICATE-----\nlixo\n-----END CERTIFICATE-----", NOW)).toThrow(/ilegível/);
    expect(() => parseCertificate(TEST_CERT, new Date("2040-01-01T00:00:00Z"))).toThrow(/vencido/);
    expect(() => parseCertificate(TEST_CERT, new Date("2000-01-01T00:00:00Z"))).toThrow(/ainda não é válido/);
    expect(() => parseCertificate("x".repeat(20_000), NOW)).toThrow(/grande demais/);
    try { parseCertificate("-----BEGIN CERTIFICATE-----\nSEGREDOXYZ\n-----END CERTIFICATE-----", NOW); } catch (e) { expect((e as Error).message).not.toContain("SEGREDOXYZ"); }
  });

  it("chave privada: precisa combinar com o certificado, sem senha, uma só", () => {
    expect(parsePrivateKey(TEST_KEY, TEST_CERT)).toContain("PRIVATE KEY");
    expect(() => parsePrivateKey(OTHER_KEY, TEST_CERT)).toThrow(/não combina/);
    expect(() => parsePrivateKey(ENCRYPTED_KEY, TEST_CERT)).toThrow(/protegida por senha/);
    expect(() => parsePrivateKey("", TEST_CERT)).toThrow(/Informe a chave/);
    expect(() => parsePrivateKey(TEST_CERT, TEST_CERT)).toThrow(/formato PEM/);
    expect(() => parsePrivateKey(TEST_KEY + "\n" + TEST_KEY, TEST_CERT)).toThrow(/exatamente uma chave/);
    expect(() => parsePrivateKey("-----BEGIN PRIVATE KEY-----\nlixo\n-----END PRIVATE KEY-----", TEST_CERT)).toThrow(/ilegível/);
  });
});
