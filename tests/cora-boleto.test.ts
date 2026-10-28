import { describe, expect, it } from "vitest";
import { CoraClient, CoraHttpError, CoraNetworkError, type Creds, type Transport } from "@/modules/providers/cora-http";
import { codeFromKey, createCoraBoletoProvider, mapCoraError, statusOf, uuidFromKey } from "@/modules/providers/cora-boleto";

const creds: Creds = { clientId: "int-test", certificate: "C", privateKey: "K" };
const provider = (handler: (path: string, method: string, body?: string) => { status: number; body: unknown }) => {
  const t: Transport = async (o) => { if (o.path === "/token") return { status: 200, body: JSON.stringify({ access_token: "t", expires_in: 3600 }) }; const r = handler(o.path, o.method, o.body); return { status: r.status, body: r.body === null ? "" : JSON.stringify(r.body) }; };
  return createCoraBoletoProvider(new CoraClient(creds, "homologacao", t));
};
const input = { idempotencyKey: "boleto:abc", amountCents: 12345, dueDate: "2026-12-10", customerName: "Cliente", customerDocument: "11.222.333/0001-81" };

describe("adaptador de boleto da Cora (contrato do motor)", () => {
  it("chave do motor → UUID determinístico e válido; code com prefixo; situações mapeadas", () => {
    expect(uuidFromKey("boleto:abc")).toBe(uuidFromKey("boleto:abc"));
    expect(uuidFromKey("boleto:abc")).not.toBe(uuidFromKey("boleto:abc:g1"));
    expect(uuidFromKey("boleto:abc")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(codeFromKey("boleto:abc")).toBe("k3g:boleto:abc");
    expect(["OPEN", "LATE", "IN_PAYMENT", "DRAFT"].map(statusOf)).toEqual(["emitido", "emitido", "emitido", "emitido"]);
    expect(statusOf("PAID")).toBe("pago"); expect(statusOf("CANCELLED")).toBe("cancelado");
  });
  it("mapeia erros: rede → timeout; 400/422 → RangeError com campo seguro; 401/429 → repetível; 404 → inexistente; REC-0006 → pago; 500 → desconhecido; trava local → RangeError", () => {
    expect(() => mapCoraError(new CoraNetworkError("x"), "issue")).toThrow(expect.objectContaining({ name: "IssuanceTimeout" }));
    expect(() => mapCoraError(new CoraHttpError(400, "m", "invalid_request", "paymentterms_duedate"), "issue")).toThrow(new RangeError("paymentterms_duedate"));
    expect(() => mapCoraError(new CoraHttpError(400, "m"), "issue")).toThrow(new RangeError("validacao_provedor"));
    expect(() => mapCoraError(new CoraHttpError(401, "m"), "issue")).toThrow(expect.objectContaining({ name: "IssuanceRetryable" }));
    expect(() => mapCoraError(new CoraHttpError(429, "m"), "issue")).toThrow(expect.objectContaining({ name: "IssuanceRetryable" }));
    expect(() => mapCoraError(new CoraHttpError(404, "m"), "status")).toThrow("boleto_inexistente");
    expect(() => mapCoraError(new CoraHttpError(422, "m", "REC-0006"), "cancel")).toThrow("boleto_pago");
    expect(() => mapCoraError(new CoraHttpError(422, "m", "REC-0001"), "cancel")).toThrow(new RangeError("erro_provedor"));
    const e500 = (() => { try { mapCoraError(new CoraHttpError(500, "m"), "issue"); } catch (e) { return e as Error; } })()!;
    expect(e500).toBeInstanceOf(CoraHttpError); // erro genérico: o motor trata como "desconhecido" e reconsulta
    expect(() => mapCoraError(new CoraHttpError(0, "bloqueado"), "issue")).toThrow(new RangeError("bloqueado_localmente"));
  });
  it("issue valida a entrada antes da rede e recusa boleto cancelado/valor divergente", async () => {
    const p = provider(() => { throw new Error("não deveria chamar a rede"); });
    await expect(p.issue({ ...input, amountCents: 0 })).rejects.toThrow("valor_invalido");
    await expect(p.issue({ ...input, amountCents: 499 })).rejects.toThrow("valor_minimo");
    await expect(p.issue({ ...input, dueDate: "10/12/2026" })).rejects.toThrow("vencimento_invalido");
    await expect(p.issue({ ...input, customerDocument: "123" })).rejects.toThrow("documento_invalido");
    await expect(p.issue({ ...input, customerName: "  " })).rejects.toThrow("cliente_sem_nome");
    const inv = (status: string, total = 12345) => ({ status: 200, body: { id: "inv_abcd1234", status, total_amount: total, payment_terms: { due_date: "2026-12-10" }, payment_options: { bank_slip: { digitable: "00190000090321583700012584580174791420000002000" } } } });
    await expect(provider(() => inv("CANCELLED")).issue(input)).rejects.toThrow("boleto_cancelado");
    await expect(provider(() => inv("OPEN", 1)).issue(input)).rejects.toThrow("valor_divergente");
    const ok = await provider(() => inv("OPEN")).issue(input);
    expect(ok).toMatchObject({ providerRef: "inv_abcd1234", status: "emitido" });
    expect(ok.digitableLineMasked).not.toContain("0321583700012584"); // linha digitável mascarada
  });
  it("find: acha pelo code no detalhe; com candidatos demais NÃO afirma que não existe (erro → o motor trata como desconhecido)", async () => {
    const ctx = { customerDocument: "11222333000181", dueDate: "2026-12-10" };
    const many = Array.from({ length: 100 }, (_, i) => ({ id: `inv_x${String(i).padStart(5, "0")}`, status: "OPEN" }));
    const code = codeFromKey("boleto:abc");
    const hit = provider((path) => path.startsWith("/v2/invoices?") ? { status: 200, body: { totalItems: 100, items: many } } : { status: 200, body: { id: path.split("/").pop(), status: "OPEN", code: path.endsWith("x00077") ? code : "outro", total_amount: 1, payment_terms: { due_date: "2026-12-10" } } });
    expect(await hit.find("boleto:abc", ctx)).toMatchObject({ providerRef: "inv_x00077", status: "emitido" }); // o 78º candidato também é verificado (antes só os 40 primeiros)
    const none = provider((path) => path.startsWith("/v2/invoices?") ? { status: 200, body: { totalItems: 50, items: many.slice(0, 50) } } : { status: 200, body: { id: path.split("/").pop(), status: "OPEN", code: "outro", total_amount: 1 } });
    const lots = provider((path, _m, _b) => path.startsWith("/v2/invoices?") ? { status: 200, body: { totalItems: 300, items: many } } : { status: 200, body: { id: path.split("/").pop(), status: "OPEN", code: "outro", total_amount: 1 } });
    expect(await none.find("boleto:abc", ctx)).toBeNull(); // 50 candidatos, nenhum é o nosso, lista terminou: não existe
    await expect(lots.find("boleto:abc", ctx)).rejects.toThrow("busca_incompleta"); // 300 candidatos > limite de consulta: inconclusivo
  });
  it("find sem contexto (documento e vencimento) não consulta nada e devolve null", async () => {
    const p = provider(() => { throw new Error("sem rede"); });
    expect(await p.find("boleto:abc")).toBeNull();
    expect(await p.find("boleto:abc", { customerDocument: "11222333000181", dueDate: "inválido" })).toBeNull();
  });
});
