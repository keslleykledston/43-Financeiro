import { CrmHttp, itemsOf, type HttpOpts } from "./http";
import type { CrmAdapter, CrmPage } from "./types";

/**
 * Adaptador do K3G CRM (https://api.k3gsolutions.com.br/api, OpenAPI em /openapi.json).
 * Verificado contra a API real em 2026-10-23 (somente estrutura; sem dados pessoais nos logs):
 *  - GET crm/companies devolve TODAS as empresas em `{ companies: [...] }` e ignora paginação.
 *  - `crmStatus` ∈ PROSPECT | ACTIVE | CHURNED | INACTIVE; `cnpj` já vem formatado (pode faltar/ser inválido).
 *  - Contratos, contatos e faturas: endpoints existem, mas hoje vêm VAZIOS (_count = 0) — contratos não estão neste CRM.
 * Regra: só `ACTIVE` é cliente. CHURNED/INACTIVE entram como inativos (arquivam). PROSPECT nunca é cliente (tratado como inativo → ignorado).
 */
export type K3gOpts = HttpOpts & { activeStatuses?: string[] };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Converte uma empresa do K3G CRM para o formato canônico. Pura e testável. Itens sem dados mínimos seguem como estão (o motor os conta como inválidos). */
export function mapK3gCompany(c: Record<string, unknown>, activeStatuses: string[] = ["ACTIVE"]): Record<string, unknown> {
  const razao = str(c.razaoSocial), name = str(c.name);
  const email = str(c.email), phone = str(c.phone);
  const contact = email || phone
    ? [{ name: "Cadastro no CRM", email: EMAIL.test(email) ? email : undefined, phone: phone ? phone.slice(0, 40) : undefined, isFinancial: false }]
    : [];
  return {
    externalId: str(c.id),
    legalName: razao || name,
    tradeName: name && name !== (razao || name) ? name : undefined,
    document: str(c.cnpj),
    active: activeStatuses.includes(str(c.crmStatus)) && c.isActive !== false,
    contacts: contact,
    updatedAt: str(c.updatedAt) || undefined,
  };
}

export class K3gCrmAdapter implements CrmAdapter {
  private http: CrmHttp; private active: string[];
  constructor(o: K3gOpts) { this.http = new CrmHttp(o); this.active = o.activeStatuses ?? ["ACTIVE"]; }

  async listCustomers({ cursor }: { cursor?: string; updatedSince?: string }): Promise<CrmPage> {
    if (cursor) return { items: [] }; // a API não pagina: a primeira resposta já traz tudo
    const body = await this.http.getJson("crm/companies");
    const items = itemsOf(body, "companies").map((c) => (c && typeof c === "object" ? mapK3gCompany(c as Record<string, unknown>, this.active) : c));
    return { items };
  }
}
