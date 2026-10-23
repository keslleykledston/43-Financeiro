import { describe, expect, it } from "vitest";
import { formatDocument, parseDocument, validateCnpj, validateCpf } from "@/lib/validators/document";

describe("CPF", () => {
  it("aceita válido, com ou sem máscara", () => {
    expect(validateCpf("529.982.247-25")).toBe(true);
    expect(validateCpf("52998224725")).toBe(true);
  });
  it("rejeita dígito errado, repetido e tamanho errado", () => {
    expect(validateCpf("529.982.247-24")).toBe(false);
    expect(validateCpf("111.111.111-11")).toBe(false);
    expect(validateCpf("1234")).toBe(false);
  });
});

describe("CNPJ", () => {
  it("numérico válido", () => {
    expect(validateCnpj("11.222.333/0001-81")).toBe(true);
    expect(validateCnpj("11222333000181")).toBe(true);
  });
  it("alfanumérico (formato 2026) válido", () => {
    expect(validateCnpj("12.ABC.345/01DE-35")).toBe(true);
    expect(validateCnpj("12abc34501de35")).toBe(true);
  });
  it("rejeita DV errado, repetido e DV não numérico", () => {
    expect(validateCnpj("11.222.333/0001-80")).toBe(false);
    expect(validateCnpj("12.ABC.345/01DE-34")).toBe(false);
    expect(validateCnpj("00.000.000/0000-00")).toBe(false);
    expect(validateCnpj("11.222.333/0001-8A")).toBe(false);
  });
});

describe("parseDocument/formatDocument", () => {
  it("normaliza e detecta o tipo", () => {
    expect(parseDocument("529.982.247-25")).toEqual({ type: "cpf", digits: "52998224725" });
    expect(parseDocument("12.abc.345/01de-35")).toEqual({ type: "cnpj", digits: "12ABC34501DE35" });
    expect(parseDocument("123")).toBeNull();
    expect(parseDocument("")).toBeNull();
  });
  it("formata de volta", () => {
    expect(formatDocument("cpf", "52998224725")).toBe("529.982.247-25");
    expect(formatDocument("cnpj", "11222333000181")).toBe("11.222.333/0001-81");
    expect(formatDocument("cnpj", "12ABC34501DE35")).toBe("12.ABC.345/01DE-35");
  });
});
