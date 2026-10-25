import { describe, expect, it } from "vitest";
import { passwordProblem, passwordStrength } from "@/modules/identity/password";

describe("E27 — política de senha", () => {
  it("aceita frase longa e recusa curta, sequência, repetição, comum e o próprio e-mail", () => {
    expect(passwordProblem("cavalo-azul-torneira-77")).toBeNull();
    expect(passwordProblem("curta")).toMatch(/ao menos 12/);
    expect(passwordProblem("a".repeat(257))).toMatch(/longa demais/);
    expect(passwordProblem("111111111111")).toMatch(/só com números/);
    expect(passwordProblem("aaaaaaaaaaaaaa")).toMatch(/previsível/);
    expect(passwordProblem("123456789012")).toMatch(/só com números/);
    expect(passwordProblem("123456789")).toMatch(/ao menos 12/);
    expect(passwordProblem("12345678901234")).toMatch(/só com números/);
    expect(passwordProblem("abcdefghijklm")).toMatch(/previsível/);
    expect(passwordProblem("Senha-1234567")).toMatch(/comum/);
    expect(passwordProblem("minhasenha123")).toMatch(/comum/);
    expect(passwordProblem("Password12345")).toMatch(/comum/);
    expect(passwordProblem("joaosilva-2026-xx", { email: "joaosilva@t.com" })).toMatch(/e-mail/);
    expect(passwordProblem("ana-cavalo-azul-77", { email: "ana@t.com" })).toBeNull(); // nome curto (<4) não conta
  });
  it("indicador de força: reprovada nunca passa de 1", () => {
    expect(passwordStrength("")).toBe(0);
    expect(passwordStrength("curta")).toBeLessThanOrEqual(1);
    expect(passwordStrength("cavalo-azul-torneira-77")).toBeGreaterThanOrEqual(3);
  });
});
