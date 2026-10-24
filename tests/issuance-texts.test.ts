import { describe, expect, it } from "vitest";
import { issuanceTexts } from "@/modules/issuance/texts";

const base = { nfText: null, boletoText: null, contractDescription: "Monitoramento de redes", customerName: "GR PLUS SOLUTIONS", companyName: "K3G Solutions", amountCents: 250000, dueDate: "2026-11-14", competenceMonth: "2026-10-01", issueDate: "2026-11-01" };

describe("E26 — textos da nota fiscal e do boleto por cliente", () => {
  it("sem texto do cliente: nota usa a descrição do contrato; boleto sem instruções", () => {
    expect(issuanceTexts(base)).toEqual({ nfDescription: "Monitoramento de redes", boletoInstructions: undefined });
    expect(issuanceTexts({ ...base, nfText: "   ", boletoText: "  " })).toEqual({ nfDescription: "Monitoramento de redes", boletoInstructions: undefined });
  });
  it("com texto: preenche os campos {{…}}; campo desconhecido some; valores não são reinterpretados", () => {
    const t = issuanceTexts({ ...base, nfText: "Serviços de {{descricao}} — competência {{competencia}} para {{cliente}} ({{valor}})", boletoText: "Vence em {{vencimento}}. {{x}}Não receber após 10 dias." });
    expect(t.nfDescription).toBe("Serviços de Monitoramento de redes — competência 10/2026 para GR PLUS SOLUTIONS (R$ 2.500,00)");
    expect(t.boletoInstructions).toBe("Vence em 14/11/2026. Não receber após 10 dias.");
    expect(issuanceTexts({ ...base, customerName: "{{valor}} Ltda", nfText: "{{cliente}}" }).nfDescription).toBe("{{valor}} Ltda");
  });
  it("limita o tamanho (nota 1000, boleto 400)", () => {
    const t = issuanceTexts({ ...base, nfText: "a".repeat(1500), boletoText: "b".repeat(900) });
    expect(t.nfDescription).toHaveLength(1000); expect(t.boletoInstructions).toHaveLength(400);
  });
});
