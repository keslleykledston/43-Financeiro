import { CrmHttp, itemsOf, type HttpOpts } from "./http";
import type { CrmAdapter, CrmPage } from "./types";

/**
 * Adaptador do K3G CRM (https://api.k3gsolutions.com.br/api, OpenAPI em /openapi.json).
 * Verificado contra a API real em 2026-10-23 (somente estrutura; sem dados pessoais nos logs):
 *  - GET crm/companies devolve TODAS as empresas em `{ companies: [...] }` e ignora paginação.
 *  - `crmStatus` ∈ PROSPECT | ACTIVE | CHURNED | INACTIVE; `cnpj` já vem formatado (pode faltar/ser inválido).
 *  - Contratos, contatos e faturas: endpoints existem, mas hoje vêm VAZIOS (_count = 0) — contratos não estão neste CRM.
 * Regra (confirmada pelo dono em 2026-10-23): só `ACTIVE` é faturável, mas cancelados e suspensos CONTINUAM clientes (podem ter dívidas antigas):
 *   ACTIVE → ativo · INACTIVE → suspenso · CHURNED → cancelado · PROSPECT (e desconhecidos) → não é cliente (nunca importado).
 */
export type Situacao = "ativo" | "suspenso" | "cancelado";
export const DEFAULT_STATUS_MAP: Record<string, Situacao> = { ACTIVE: "ativo", INACTIVE: "suspenso", CHURNED: "cancelado" };
export type K3gOpts = HttpOpts & { statusMap?: Record<string, Situacao> };

/** Lê "ACTIVE:ativo,INACTIVE:suspenso,CHURNED:cancelado" (variável CRM_STATUS_MAP). Entradas inválidas são ignoradas. */
export function parseStatusMap(raw?: string): Record<string, Situacao> {
  if (!raw) return DEFAULT_STATUS_MAP;
  const out: Record<string, Situacao> = {};
  for (const pair of raw.split(",")) { const [k, v] = pair.split(":").map((x) => x.trim()); if (k && (v === "ativo" || v === "suspenso" || v === "cancelado")) out[k] = v; }
  return Object.keys(out).length ? out : DEFAULT_STATUS_MAP;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Converte uma empresa do K3G CRM para o formato canônico. Pura e testável. Itens sem dados mínimos seguem como estão (o motor os conta como inválidos). */
export function mapK3gCompany(c: Record<string, unknown>, statusMap: Record<string, Situacao> = DEFAULT_STATUS_MAP): Record<string, unknown> {
  const razao = str(c.razaoSocial), name = str(c.name);
  const email = str(c.email), phone = str(c.phone);
  const contact = email || phone
    ? [{ name: "Cadastro no CRM", email: EMAIL.test(email) ? email : undefined, phone: phone ? phone.slice(0, 40) : undefined, isFinancial: false }]
    : [];
  const situacao = statusMap[str(c.crmStatus)];
  return {
    externalId: str(c.id),
    legalName: razao || name,
    tradeName: name && name !== (razao || name) ? name : undefined,
    document: str(c.cnpj),
    active: situacao !== undefined, // PROSPECT e desconhecidos: não são clientes
    status: situacao ?? "ativo",
    contacts: contact,
    updatedAt: str(c.updatedAt) || undefined,
  };
}

export class K3gCrmAdapter implements CrmAdapter {
  private http: CrmHttp; private map: Record<string, Situacao>;
  constructor(o: K3gOpts) { this.http = new CrmHttp(o); this.map = o.statusMap ?? DEFAULT_STATUS_MAP; }

  async listCustomers({ cursor }: { cursor?: string; updatedSince?: string }): Promise<CrmPage> {
    if (cursor) return { items: [] }; // a API não pagina: a primeira resposta já traz tudo
    const body = await this.http.getJson("crm/companies");
    const items = itemsOf(body, "companies").map((c) => (c && typeof c === "object" ? mapK3gCompany(c as Record<string, unknown>, this.map) : c));
    return { items };
  }
}
