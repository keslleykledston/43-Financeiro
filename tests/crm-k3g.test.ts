import { describe, expect, it, vi } from "vitest";
import { K3gCrmAdapter, mapK3gCompany } from "@/modules/integrations/crm/k3g";
import { buildPlan } from "@/modules/integrations/crm/sync";
import { getCrmAdapter } from "@/modules/integrations/crm/factory";
import { CrmError } from "@/modules/integrations/crm/types";

// Forma real observada na API do K3G CRM (valores fictícios).
const company = (o: Record<string, unknown> = {}) => ({
  id: "0b7c2f0e-1111-4222-8333-444455556666", name: "Alfa Net", razaoSocial: "ALFA NET TELECOM LTDA", cnpj: "11.222.333/0001-81",
  email: "contato@alfa.test", phone: "(92) 99999-0000", city: "Manaus", state: "AM", crmStatus: "ACTIVE", isActive: true,
  segment: null, companySize: null, owner: null, _count: { contacts: 0, deals: 0, contracts: 0, invoices: 0 }, ...o,
});
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

describe("mapK3gCompany", () => {
  it("mapeia razão social, fantasia, documento e contato do cadastro", () => {
    expect(mapK3gCompany(company())).toMatchObject({
      externalId: "0b7c2f0e-1111-4222-8333-444455556666", legalName: "ALFA NET TELECOM LTDA", tradeName: "Alfa Net", document: "11.222.333/0001-81", active: true,
      contacts: [{ name: "Cadastro no CRM", email: "contato@alfa.test", phone: "(92) 99999-0000", isFinancial: false }],
    });
  });
  it("só ACTIVE é cliente; PROSPECT/CHURNED/INACTIVE e isActive=false não são", () => {
    for (const s of ["PROSPECT", "CHURNED", "INACTIVE", "QUALQUER"]) expect(mapK3gCompany(company({ crmStatus: s })).active).toBe(false);
    expect(mapK3gCompany(company({ isActive: false })).active).toBe(false);
    expect(mapK3gCompany(company({ crmStatus: "PROSPECT" }), ["ACTIVE", "PROSPECT"]).active).toBe(true); // configurável
  });
  it("sem razão social usa o nome; sem fantasia diferente não duplica; e-mail inválido é descartado sem invalidar o cliente", () => {
    const m = mapK3gCompany(company({ razaoSocial: "", name: "Só Nome", email: "nao-e-email" }));
    expect(m).toMatchObject({ legalName: "Só Nome", tradeName: undefined });
    expect((m.contacts as { email?: string }[])[0].email).toBeUndefined();
    expect(mapK3gCompany(company({ email: null, phone: null })).contacts).toEqual([]);
  });
});

describe("K3gCrmAdapter + motor", () => {
  const mk = (f: typeof fetch) => new K3gCrmAdapter({ baseUrl: "https://crm.exemplo.test/api", token: "tok-secreto-xyz", fetchImpl: f, sleep: async () => {} });

  it("lê crm/companies uma vez (a API não pagina) e entrega itens canônicos", async () => {
    const f = vi.fn(async () => json({ companies: [company(), company({ id: "2", cnpj: "529.982.247-25" })] }));
    const a = mk(f as unknown as typeof fetch);
    const p = await a.listCustomers({});
    expect(p.items).toHaveLength(2); expect(p.nextCursor).toBeUndefined();
    expect(String((f.mock.calls[0] as unknown as [URL])[0])).toBe("https://crm.exemplo.test/api/crm/companies");
    expect((await a.listCustomers({ cursor: "qualquer" })).items).toEqual([]); // não há segunda página
  });

  it("no plano: 1 ACTIVE vira novo; PROSPECT é ignorado; CHURNED nunca importado é ignorado; sem CNPJ válido é inválido; CNPJ duplicado no CRM vira conflito", () => {
    const raw = [
      company({ id: "a", cnpj: "11.222.333/0001-81" }),
      company({ id: "b", cnpj: "12.ABC.345/01DE-35", crmStatus: "PROSPECT" }),
      company({ id: "c", cnpj: "52998224725", crmStatus: "CHURNED" }),
      company({ id: "d", cnpj: null }),
      company({ id: "e", cnpj: "00.000.000/0000-00" }),
      company({ id: "f", cnpj: "11.222.333/0001-81" }), // mesmo CNPJ do "a"
    ].map((c) => mapK3gCompany(c));
    const plan = buildPlan([], new Set(), raw);
    expect(plan.stats).toMatchObject({ fetched: 6, create: 1, conflict: 1, skipped: 2, invalid: 2 });
  });

  it("403 dá mensagem acionável (token/seções/IP) sem vazar o token", async () => {
    const err = await mk((async () => json({ error: "forbidden" }, 403)) as unknown as typeof fetch).listCustomers({}).catch((e) => e);
    expect(err).toBeInstanceOf(CrmError);
    expect(err.message).toMatch(/403.*IP/);
    expect(err.message).not.toContain("tok-secreto-xyz");
  });

  it("resposta sem a chave `companies` é erro de formato", async () => {
    await expect(mk((async () => json({ outra: [] })) as unknown as typeof fetch).listCustomers({})).rejects.toThrow(/formato/);
  });
});

describe("factory", () => {
  const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;
  it("exige configuração; escolhe K3G por padrão e canônico por CRM_PROVIDER", () => {
    expect(() => getCrmAdapter(env({}))).toThrow(/não configurado/);
    expect(getCrmAdapter(env({ CRM_BASE_URL: "https://x.test/api", CRM_API_TOKEN: "t" }))).toBeInstanceOf(K3gCrmAdapter);
    expect(getCrmAdapter(env({ CRM_BASE_URL: "https://x.test/api", CRM_API_TOKEN: "t", CRM_PROVIDER: "canonical" }))).not.toBeInstanceOf(K3gCrmAdapter);
    expect(() => getCrmAdapter(env({ CRM_BASE_URL: "http://x.test/api", CRM_API_TOKEN: "t" }))).toThrow(/HTTPS/); // http só com opt-in explícito
  });
});
