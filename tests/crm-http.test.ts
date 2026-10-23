import { describe, expect, it, vi } from "vitest";
import { CanonicalHttpAdapter } from "@/modules/integrations/crm/http";
import { CrmError } from "@/modules/integrations/crm/types";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const mk = (fetchImpl: typeof fetch, o: Partial<ConstructorParameters<typeof CanonicalHttpAdapter>[0]> = {}) => {
  const sleep = vi.fn(async () => {});
  return { sleep, a: new CanonicalHttpAdapter({ baseUrl: "https://crm.exemplo.test/api", token: "tok-secreto", fetchImpl, sleep, maxRetries: 3, ...o }) };
};

describe("CanonicalHttpAdapter — limites e redirects (revisão Codex)", () => {
  it("nunca segue redirect", async () => {
    const f = vi.fn(async () => json({ items: [] }));
    await mk(f as unknown as typeof fetch).a.listCustomers({});
    expect((f.mock.calls[0] as unknown as [URL, RequestInit])[1].redirect).toBe("error");
  });

  it("corta resposta gigante por content-length e em streaming, e página com itens demais", async () => {
    const big = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-length": "99999999" } }));
    await expect(mk(big as unknown as typeof fetch).a.listCustomers({})).rejects.toThrow(/grande demais/);
    const stream = vi.fn(async () => new Response(new ReadableStream({ start(c) { for (let i = 0; i < 5; i++) c.enqueue(new Uint8Array(600_000)); c.close(); } })));
    await expect(mk(stream as unknown as typeof fetch).a.listCustomers({})).rejects.toThrow(/grande demais/);
    const many = vi.fn(async () => json({ items: Array.from({ length: 5001 }, (_, i) => ({ i })) }));
    await expect(mk(many as unknown as typeof fetch).a.listCustomers({})).rejects.toThrow(/mais de 5000 itens/);
    const notJson = vi.fn(async () => new Response("<html>", { status: 200 }));
    await expect(mk(notJson as unknown as typeof fetch).a.listCustomers({})).rejects.toThrow(/JSON válido/);
  });
});

describe("CanonicalHttpAdapter", () => {
  it("exige HTTPS (exceto dev explícito) e token", () => {
    expect(() => new CanonicalHttpAdapter({ baseUrl: "http://crm.test", token: "t" })).toThrow(/HTTPS/);
    expect(() => new CanonicalHttpAdapter({ baseUrl: "http://crm.test", token: "t", allowInsecureHttp: true })).not.toThrow();
    expect(() => new CanonicalHttpAdapter({ baseUrl: "https://crm.test", token: "" })).toThrow(/Token/);
  });

  it("envia Bearer, cursor e updated_since; devolve nextCursor", async () => {
    const f = vi.fn(async () => json({ items: [{ a: 1 }], nextCursor: "p2" }));
    const { a } = mk(f as unknown as typeof fetch);
    const r = await a.listCustomers({ cursor: "p1", updatedSince: "2026-01-01" });
    expect(r).toEqual({ items: [{ a: 1 }], nextCursor: "p2" });
    const [url, init] = f.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe("https://crm.exemplo.test/api/customers?cursor=p1&updated_since=2026-01-01");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok-secreto");
  });

  it("429 respeita Retry-After e tenta de novo", async () => {
    const f = vi.fn().mockResolvedValueOnce(json({}, 429, { "retry-after": "2" })).mockResolvedValueOnce(json({ items: [] }));
    const { a, sleep } = mk(f as unknown as typeof fetch);
    expect((await a.listCustomers({})).items).toEqual([]);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("5xx repete com backoff e desiste com erro claro (sem vazar o token)", async () => {
    const f = vi.fn(async () => json({}, 503));
    const { a, sleep } = mk(f as unknown as typeof fetch);
    const err = await a.listCustomers({}).catch((e) => e);
    expect(err).toBeInstanceOf(CrmError);
    expect(err.message).toMatch(/503.*4 tentativas/);
    expect(err.message).not.toContain("tok-secreto");
    expect(f).toHaveBeenCalledTimes(4); expect(sleep).toHaveBeenCalledTimes(4);
  });

  it("4xx não repete; resposta fora do formato é erro; timeout/rede viram erro genérico", async () => {
    const f401 = vi.fn(async () => json({}, 401));
    await expect(mk(f401 as unknown as typeof fetch).a.listCustomers({})).rejects.toThrow(/401/);
    expect(f401).toHaveBeenCalledTimes(1);
    await expect(mk((async () => json({ naoItems: 1 })) as unknown as typeof fetch).a.listCustomers({})).rejects.toThrow(/formato/);
    const abort = vi.fn(async () => { const e = new Error("x"); e.name = "AbortError"; throw e; });
    const err = await mk(abort as unknown as typeof fetch, { maxRetries: 1 }).a.listCustomers({}).catch((e) => e);
    expect(err.message).toMatch(/tempo esgotado/);
    const net = vi.fn(async () => { throw new Error("ECONNRESET https://crm?token=tok-secreto"); });
    const err2 = await mk(net as unknown as typeof fetch, { maxRetries: 0 }).a.listCustomers({}).catch((e) => e);
    expect(err2.message).not.toContain("tok-secreto");
  });
});
