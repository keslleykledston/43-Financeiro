import { describe, expect, it } from "vitest";
import { CrmPending, K3gCrmWriter, backoffMs, crmStatusFor, writebackConfig, writebackReady } from "@/modules/integrations/crm/writeback";
import { CrmError } from "@/modules/integrations/crm/types";

type Call = { method: string; url: string; body: unknown; auth: string | null };
function fakeFetch(handler: (c: Call) => { status: number; body?: unknown; raw?: string }) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const c: Call = { method: init?.method ?? "GET", url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers.get("authorization") };
    calls.push(c);
    const r = handler(c);
    return new Response(r.raw ?? (r.body === undefined ? null : JSON.stringify(r.body)), { status: r.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}
const mk = (f: typeof fetch, extra: Record<string, unknown> = {}) => new K3gCrmWriter({ baseUrl: "https://api.k3gsolutions.com.br/api", token: "write-token", allowedHosts: ["api.k3gsolutions.com.br"], fetchImpl: f, sleep: async () => {}, ...extra });
const doc = { legalName: "Empresa X Ltda", tradeName: "Empresa X", document: "11.222.333/0001-81", email: "f@x.com", phone: null, status: "ativo" as const };

describe("envio ao CRM: escritor HTTP", () => {
  it("situação: Finance → valor do CRM (inverso do mapa; mapa próprio vale; sem valor = espera)", () => {
    expect(crmStatusFor("ativo")).toBe("ACTIVE"); expect(crmStatusFor("suspenso")).toBe("INACTIVE"); expect(crmStatusFor("cancelado")).toBe("CHURNED");
    expect(crmStatusFor("suspenso", { ATIVO: "ativo", PAUSADO: "suspenso" })).toBe("PAUSADO");
    expect(() => crmStatusFor("cancelado", { ATIVO: "ativo" })).toThrow(CrmPending);
  });

  it("PATCH da situação usa o token de ESCRITA, o caminho certo e só crmStatus", async () => {
    const f = fakeFetch(() => ({ status: 200, body: { ok: true } }));
    await mk(f.fetchImpl).setStatus("abc/123", "suspenso");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ method: "PATCH", auth: "Bearer write-token", body: { crmStatus: "INACTIVE" } });
    expect(f.calls[0].url).toBe("https://api.k3gsolutions.com.br/api/crm/companies/abc%2F123");
  });

  it("resposta vazia (204) de escrita conta como sucesso; 5xx repete em PATCH; 4xx não repete", async () => {
    let n = 0;
    const ok = fakeFetch(() => ({ status: 204 }));
    await mk(ok.fetchImpl).setStatus("1", "ativo");
    const flaky = fakeFetch(() => (++n < 3 ? { status: 503 } : { status: 200, body: {} }));
    await mk(flaky.fetchImpl).setStatus("1", "ativo");
    expect(flaky.calls).toHaveLength(3);
    const bad = fakeFetch(() => ({ status: 422, body: { error: "x" } }));
    await expect(mk(bad.fetchImpl).setStatus("1", "ativo")).rejects.toMatchObject({ retryable: false });
    expect(bad.calls).toHaveLength(1);
    const denied = fakeFetch(() => ({ status: 403 }));
    await expect(mk(denied.fetchImpl).setStatus("1", "ativo")).rejects.toThrow(/recusou o acesso/);
  });

  it("busca por CNPJ ignora pontuação e caixa e consulta o CRM uma única vez", async () => {
    const f = fakeFetch(() => ({ status: 200, body: { companies: [{ id: "k1", cnpj: "11.222.333/0001-81", crmStatus: "ACTIVE" }, { id: "k2", cnpj: "12.abc.345/01de-35", crmStatus: "CHURNED" }, { name: "sem id" }] } }));
    const w = mk(f.fetchImpl);
    expect(await w.findByDocument("11222333000181")).toEqual({ externalId: "k1", crmStatus: "ACTIVE" });
    expect(await w.findByDocument("12ABC34501DE35")).toEqual({ externalId: "k2", crmStatus: "CHURNED" });
    expect(await w.findByDocument("00000000000191")).toBeNull();
    expect(f.calls).toHaveLength(1);
  });

  it("criar: sem rota informada espera a equipe do CRM e NÃO chama a API; com rota, envia os campos e devolve o id (em qualquer formato conhecido)", async () => {
    const none = fakeFetch(() => ({ status: 200, body: {} }));
    await expect(mk(none.fetchImpl).createCompany(doc)).rejects.toThrow(CrmPending);
    expect(none.calls).toHaveLength(0);
    for (const body of [{ id: "novo-1" }, { company: { id: "novo-1" } }, { data: { id: "novo-1" } }]) {
      const f = fakeFetch(() => ({ status: 200, body }));
      expect(await mk(f.fetchImpl, { createPath: "crm/companies" }).createCompany(doc)).toEqual({ externalId: "novo-1" });
      expect(f.calls[0]).toMatchObject({ method: "POST", body: { name: "Empresa X", razaoSocial: "Empresa X Ltda", cnpj: "11.222.333/0001-81", email: "f@x.com", crmStatus: "ACTIVE" } });
      expect((f.calls[0].body as Record<string, unknown>).phone).toBeUndefined();
    }
    const noId = fakeFetch((c) => ({ status: 200, body: c.method === "POST" ? { ok: true } : { companies: [] } })); // criou, sem id, e a busca pelo CNPJ também não acha
    await expect(mk(noId.fetchImpl, { createPath: "crm/companies" }).createCompany(doc)).rejects.toThrow(/não devolveu o identificador/);
  });

  it("criar NÃO se repete sozinho (uma tentativa só, mesmo com 5xx)", async () => {
    const f = fakeFetch(() => ({ status: 500 }));
    await expect(mk(f.fetchImpl, { createPath: "crm/companies" }).createCompany(doc)).rejects.toMatchObject({ retryable: true });
    expect(f.calls).toHaveLength(1);
  });

  it("host fora da lista é recusado (o token de escrita não vai a destino errado)", () => {
    expect(() => new K3gCrmWriter({ baseUrl: "https://evil.example/api", token: "t", allowedHosts: ["api.k3gsolutions.com.br"] })).toThrow(/lista permitida/);
  });

  it("chaves do servidor: precisa da chave E do token de escrita E da URL; backoff dobra até 6 h", () => {
    expect(writebackReady({} as NodeJS.ProcessEnv)).toBe(false);
    expect(writebackReady({ CRM_WRITEBACK_ENABLED: "true", CRM_BASE_URL: "https://x" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(writebackReady({ CRM_WRITE_TOKEN: "t", CRM_BASE_URL: "https://x" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(writebackReady({ CRM_WRITEBACK_ENABLED: "true", CRM_WRITE_TOKEN: "t", CRM_BASE_URL: "https://x" } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(writebackConfig({ CRM_CREATE_PATH: "/crm/companies/" } as unknown as NodeJS.ProcessEnv).createPath).toBe("crm/companies");
    expect([1, 2, 3].map(backoffMs)).toEqual([120_000, 240_000, 480_000]);
    expect(backoffMs(20)).toBe(6 * 3_600_000);
  });

  it("o caminho de escrita nunca desvia o token: «//host», «://», «..», barra invertida e consulta são recusados antes de qualquer chamada", async () => {
    const f = fakeFetch(() => ({ status: 200, body: { id: "x" } }));
    for (const bad of ["//evil.example/x", "https://evil.example/x", "crm/../x", "crm\\x", "crm/x?y=1", "crm/%2e%2e/x", "crm /x"]) {
      await expect(mk(f.fetchImpl, { createPath: bad }).createCompany(doc), bad).rejects.toThrow(/Caminho do CRM/);
    }
    await expect(mk(f.fetchImpl).setStatus("..", "ativo")).rejects.toThrow(/Caminho do CRM/);
    expect(f.calls).toHaveLength(0);
    await mk(f.fetchImpl, { createPath: "crm/companies" }).createCompany(doc);
    expect(f.calls[0].url).toBe("https://api.k3gsolutions.com.br/api/crm/companies");
  });

  it("CNPJ repetido no CRM: não escolhe um registro (sem escrita no possivelmente errado)", async () => {
    const f = fakeFetch(() => ({ status: 200, body: { companies: [{ id: "a", cnpj: "11.222.333/0001-81" }, { id: "b", cnpj: "11222333000181" }, { id: "c", cnpj: "45.723.174/0001-10" }] } }));
    const w = mk(f.fetchImpl);
    await expect(w.findByDocument("11222333000181")).rejects.toThrow(/repetido no CRM/);
    expect(await w.findByDocument("45723174000110")).toEqual({ externalId: "c", crmStatus: "" });
  });

  it("criou mas não devolveu o id: acha pelo CNPJ em vez de arriscar criar de novo", async () => {
    let posted = false;
    const f = fakeFetch((c) => (c.method === "POST" ? ((posted = true), { status: 200, body: { ok: true } }) : { status: 200, body: { companies: posted ? [{ id: "novo-9", cnpj: "11.222.333/0001-81" }] : [] } }));
    expect(await mk(f.fetchImpl, { createPath: "crm/companies" }).createCompany(doc)).toEqual({ externalId: "novo-9" });
  });
});

