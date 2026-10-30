import { describe, expect, it } from "vitest";
import { msgRef, phoneKey, refHash } from "@/modules/whatsapp/domain";

describe("W3b — chaves estáveis (mensagem e telefone)", () => {
  it("msgRef: o MESMO ID de mensagem casa com a conversa em «@c.us» (envio) e «@lid» (aviso de entrega/leitura); outro ID ou formato desconhecido não casa", () => {
    expect(msgRef("true_5592999990000@c.us_3EB0A1B2C3D4E5F60718")).toBe(msgRef("true_123456789012345@lid_3EB0A1B2C3D4E5F60718"));
    expect(msgRef("true_5592999990000@c.us_3eb0a1b2c3d4e5f60718")).toBe(msgRef("false_999@lid_3EB0A1B2C3D4E5F60718"));   // caixa do hex não importa
    expect(msgRef("true_1@lid_3EB0A1B2C3D4E5F60718")).not.toBe(msgRef("true_1@lid_3EB0A1B2C3D4E5F60719"));
    expect(msgRef("ref-1")).toBe(refHash("ref-1"));                                                      // fora do formato: hash do id inteiro (compatível)
    expect(msgRef("ref-1")).toMatch(/^[0-9a-f]{32}$/);
  });
  it("phoneKey: celular com e sem o 9º dígito é a mesma chave; fixo, 8 dígitos que começam em 2–5 e número estrangeiro ficam como estão", () => {
    expect(phoneKey("5592999990000")).toBe("559299990000");
    expect(phoneKey("559299990000")).toBe("559299990000");
    expect(phoneKey("5592912345678")).toBe("5592912345678");                                             // 8 dígitos começando em 1: não é celular antigo, não mexe
    expect(phoneKey("559232211234")).toBe("559232211234");                                               // fixo (12)
    expect(phoneKey("12025550123")).toBe("12025550123");
  });
});
