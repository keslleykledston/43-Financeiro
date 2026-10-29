import { describe, expect, it } from "vitest";
import { asksAll, classifyInbound, mentionsOtherTopic, normalizeText } from "@/modules/whatsapp/optout";

describe("W3b — reconhecimento do pedido de parar", () => {
  it("normaliza caixa, acento, pontuação e emoji", () => {
    expect(normalizeText("  PARAR!!! 🙏 ")).toBe("parar");
    expect(normalizeText("Não me envie mais")).toBe("nao me envie mais");
    expect(normalizeText("sair...")).toBe("sair");
  });
  it("pedidos INEQUÍVOCOS (palavras do pacote e variações óbvias) → opt_out", () => {
    for (const m of ["PARAR", "Parar", "pare", "SAIR", "Sair!", "cancelar", "STOP", "stop", "Parar por favor", "pare de enviar", "Pare de me mandar", "Não me envie mais", "NÃO ME ENVIE", "não quero", "Não quero receber",
      "nao quero mais mensagens", "Parar de receber", "parar mensagens", "sair da lista", "pare por favor!", "Cancelar mensagens", "descadastrar", "remover", "não me envie nada", "NAO ME ENVIE NENHUMA MENSAGEM", "parar de receber mensagens aqui", "🛑 PARAR 🛑"]) expect(classifyInbound(m), m).toBe("opt_out");
  });
  it("AMBÍGUOS (intenção misturada com outro assunto) → opt_out_ambiguo: vai para humano e o bloqueio é conservador", () => {
    for (const m of ["cancelar contrato", "quero cancelar o plano", "pode parar de ligar", "isso é spam", "vou denunciar", "não quero pagar", "chega disso", "me remova da lista e do cadastro", "bloquear este número",
      "parar o serviço de internet", "não me perturbe", "já paguei, pare de cobrar"]) expect(classifyInbound(m), m).toBe("opt_out_ambiguo");
  });
  it("respostas NORMAIS não disparam nada", () => {
    for (const m of ["oi", "Bom dia, já paguei", "pode enviar o boleto de novo?", "ok obrigado", "vou pagar amanhã", "qual o valor?", "👍", "Recebi, obrigada", "", "   ", "o comprovante está anexo", "quero negociar", "posso pagar dia 20?"]) expect(classifyInbound(m), m).toBe("resposta");
  });
  it("«parar» só vale como palavra inteira (não dispara em palavras parecidas)", () => {
    for (const m of ["comparar preços", "preparar o pagamento", "separar a nota", "desistir não", "saída do contrato fiscal"]) expect(classifyInbound(m), m).toBe("resposta");
  });
  it("pedido de parar TUDO e assunto de contrato são detectados", () => {
    expect(asksAll("não me envie nenhuma mensagem")).toBe(true);
    expect(asksAll("parar de todas as empresas")).toBe(true);
    expect(asksAll("parar")).toBe(false);
    expect(mentionsOtherTopic("cancelar contrato")).toBe(true);
    expect(mentionsOtherTopic("parar")).toBe(false);
  });
  it("texto gigante ou lixo não quebra", () => {
    expect(classifyInbound("a".repeat(100_000))).toBe("resposta");
    expect(classifyInbound(String.fromCharCode(0, 1, 2, 3))).toBe("resposta");
    expect(classifyInbound(undefined as unknown as string)).toBe("resposta");
  });
});
