import { describe, expect, it } from "vitest";
import { CORA_HOSTS, CoraClient, CoraHttpError, READ_ONLY_ENVS, normalizeInvoice, routeAllowed, type Creds, type Transport } from "@/modules/providers/cora-http";

const creds: Creds = { clientId: "int-test", certificate: "CERT", privateKey: "KEY" };
const UUID = "3f1d2c4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
type Call = { host: string; method: string; path: string; headers: Record<string, string>; body?: string };
const fake = (handler: (c: Call) => { status: number; body: unknown }) => {
  const calls: Call[] = [];
  const t: Transport = async (o) => { calls.push({ host: o.host, method: o.method, path: o.path, headers: o.headers, body: o.body }); const r = handler(calls[calls.length - 1]); return { status: r.status, body: JSON.stringify(r.body) }; };
  return { t, calls };
};
const ok = (c: Call) => c.path === "/token" ? { status: 200, body: { access_token: "eyJabcdefghij.klmnopqrst.uvw", expires_in: 3600 } } : { status: 200, body: { items: [{ id: "inv_abc1234", status: "OPEN", total_amount: 1000, payment_terms: { due_date: "2026-12-01" } }], totalItems: 1 } };

describe("Cora — escopo estrutural (só boletos; produção só leitura)", () => {
  it("rotas permitidas: token e boletos; todo o resto é recusado (pagamento, transferência, extrato, saldo, cancelamento)", () => {
    expect(routeAllowed("POST", "/token")).toBe(true);
    expect(routeAllowed("GET", "/v2/invoices")).toBe(true);
    expect(routeAllowed("GET", "/v2/invoices/inv_abc1234")).toBe(true);
    expect(routeAllowed("POST", "/v2/invoices")).toBe(true);
    for (const [m, p] of [["POST", "/v2/invoices/pay"], ["POST", "/v2/transfers"], ["GET", "/v2/accounts/balance"], ["GET", "/bank-statement"], ["DELETE", "/v2/invoices/inv_abc1234"], ["POST", "/v2/invoices/installments"], ["GET", "/v2/invoices/../transfers"], ["POST", "/v2/payments"]]) expect(routeAllowed(m, p)).toBe(false);
  });
  it("hosts: stage e produção, só mTLS; produção é somente leitura", () => {
    expect(CORA_HOSTS.homologacao).toBe("matls-clients.api.stage.cora.com.br");
    expect(CORA_HOSTS.producao).toBe("matls-clients.api.cora.com.br");
    expect(READ_ONLY_ENVS).toContain("producao");
    expect(READ_ONLY_ENVS).not.toContain("homologacao");
  });
  it("produção: token e consulta funcionam; EMITIR é recusado antes de qualquer chamada de rede", async () => {
    const { t, calls } = fake(ok);
    const c = new CoraClient(creds, "producao", t);
    expect((await c.listInvoices()).items).toHaveLength(1);
    await expect(c.createInvoice({ idempotencyKey: UUID, code: "x", amountCents: 500, dueDate: "2026-12-01", customerName: "T", customerDocument: "52998224725", description: "d" })).rejects.toThrow(/bloqueada em produção/);
    expect(calls.every((x) => x.host === "matls-clients.api.cora.com.br" && (x.method === "GET" || x.path === "/token"))).toBe(true);
  });
  it("homologação: emite com Idempotency-Key, JSON e Bearer; valida entrada", async () => {
    const { t, calls } = fake((c) => c.path === "/token" ? ok(c) : { status: 200, body: { id: "inv_zzz9999", status: "OPEN", total_amount: 500, payment_terms: { due_date: "2026-12-01" }, payment_options: { bank_slip: { digitable: "123", barcode: "456", url: "https://x/y.pdf" } } } });
    const c = new CoraClient(creds, "homologacao", t);
    const inv = await c.createInvoice({ idempotencyKey: UUID, code: "x", amountCents: 500, dueDate: "2026-12-01", customerName: "T", customerDocument: "529.982.247-25", description: "d" });
    expect(inv).toMatchObject({ id: "inv_zzz9999", status: "OPEN", totalAmountCents: 500, dueDate: "2026-12-01", digitable: "123" });
    const post = calls.find((x) => x.path === "/v2/invoices")!;
    expect(post.headers["Idempotency-Key"]).toBe(UUID);
    expect(post.headers["content-type"]).toBe("application/json");
    expect(post.headers.authorization).toMatch(/^Bearer /);
    expect(JSON.parse(post.body!)).toMatchObject({ customer: { document: { identity: "52998224725", type: "CPF" } }, services: [{ amount: 500 }], payment_terms: { due_date: "2026-12-01" } });
    const base = { code: "x", dueDate: "2026-12-01", customerName: "T", customerDocument: "52998224725", description: "d" };
    await expect(c.createInvoice({ ...base, idempotencyKey: "nao-uuid", amountCents: 500 })).rejects.toThrow(RangeError);
    await expect(c.createInvoice({ ...base, idempotencyKey: UUID, amountCents: 499 })).rejects.toThrow(RangeError);
    await expect(c.createInvoice({ ...base, idempotencyKey: UUID, amountCents: 500, customerDocument: "123" })).rejects.toThrow(RangeError);
  });
  it("token reaproveitado; 401 limpa o token; erro da Cora não vaza token", async () => {
    let n = 0;
    const { t, calls } = fake((c) => { if (c.path === "/token") { n++; return ok(c); } return n < 2 && calls.filter((x) => x.path !== "/token").length === 1 ? { status: 401, body: { error: "access_denied", message: "Bearer eyJabcdefghij.klmnopqrst.uvw rejeitado" } } : ok(c); });
    const c = new CoraClient(creds, "producao", t);
    const e = await c.listInvoices().catch((x) => x as CoraHttpError);
    expect(e).toBeInstanceOf(CoraHttpError);
    expect((e as CoraHttpError).status).toBe(401);
    expect((e as CoraHttpError).message).not.toMatch(/eyJ/);
    expect((e as CoraHttpError).code).toBe("access_denied");
    await c.listInvoices(); // pede outro token e segue
    expect(n).toBe(2);
    await c.listInvoices();
    expect(n).toBe(2); // reaproveitou
  });
  it("trava de produção é imutável em tempo de execução; código de erro com texto livre é descartado", async () => {
    expect(Object.isFrozen(READ_ONLY_ENVS)).toBe(true);
    expect(Object.isFrozen(CORA_HOSTS)).toBe(true);
    expect(() => { (READ_ONLY_ENVS as unknown as string[]).length = 0; }).toThrow();
    expect(() => { (CORA_HOSTS as Record<string, string>).producao = "evil.example"; }).toThrow();
    const { t } = fake((c) => c.path === "/token" ? { status: 400, body: { error: "Bearer eyJabcdefghij.klmnopqrst.uvw sujo" } } : ok(c));
    const e = await new CoraClient(creds, "producao", t).accessToken().catch((x) => x as CoraHttpError);
    expect((e as CoraHttpError).code).toBeUndefined();
    expect(JSON.stringify([(e as CoraHttpError).message, (e as CoraHttpError).code])).not.toMatch(/eyJ/);
  });
  it("normalizeInvoice: campos ausentes viram null/0, nunca inventa", () => {
    expect(normalizeInvoice({})).toMatchObject({ id: "", totalAmountCents: 0, totalPaidCents: 0, dueDate: null, customerName: null, digitable: null });
    expect(normalizeInvoice({ id: "inv_a", status: "PAID", total_amount: 1234.4, total_paid: 1234, customer: { name: "Ana" } })).toMatchObject({ totalAmountCents: 1234, totalPaidCents: 1234, customerName: "Ana" });
  });
});
