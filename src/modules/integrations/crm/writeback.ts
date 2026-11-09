import { and, asc, eq, lte, sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { auditLog, crmOutbox, customerContacts, customers } from "@/lib/db/schema";
import { CrmError } from "./types";
import { CrmHttp, itemsOf, type HttpOpts } from "./http";
import { DEFAULT_STATUS_MAP, parseStatusMap, type Situacao } from "./k3g";

/**
 * Envio ao CRM (ADR-043). O CRM é DESTINO: o K3G Finance decide a situação do cliente (ativo/suspenso/cancelado) e cria clientes novos; aqui isso é empurrado ao CRM.
 * Tudo atrás de chaves: CRM_WRITEBACK_ENABLED=true E token de escrita (CRM_WRITE_TOKEN, separado do token de leitura). Sem elas, a fila só acumula (nada sai).
 * O formato que o CRM aceita para escrita NÃO está documentado (corpos sem schema na OpenAPI): o que está aqui segue o formato de leitura e deve ser homologado com a equipe do CRM
 * antes de ligar a chave (docs/CORTE_CRM.md). A criação só funciona quando a rota é informada em CRM_CREATE_PATH.
 */
export type CreateInput = { legalName: string; tradeName: string | null; document: string; email: string | null; phone: string | null; status: Situacao };
export type RemoteCompany = { externalId: string; crmStatus: string };

export interface CrmWriter {
  /** Procura a empresa pelo CNPJ/CPF (evita duplicar ao criar). */
  findByDocument(document: string): Promise<RemoteCompany | null>;
  setStatus(externalId: string, status: Situacao): Promise<void>;
  createCompany(input: CreateInput): Promise<{ externalId: string }>;
}

/** O CRM ainda não informou algo necessário (ex.: rota de criação). Não é falha do cliente: a fila espera. */
export class CrmPending extends Error { constructor(message: string) { super(message); this.name = "CrmPending"; } }

const alnum = (s: string) => s.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
const trunc = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Situação do Finance → valor do CRM (inverso de CRM_STATUS_MAP; padrão ativo→ACTIVE, suspenso→INACTIVE, cancelado→CHURNED). */
export function crmStatusFor(status: Situacao, map: Record<string, Situacao> = DEFAULT_STATUS_MAP): string {
  const hit = Object.entries(map).find(([, v]) => v === status);
  if (!hit) throw new CrmPending(`CRM_STATUS_MAP não tem valor do CRM para a situação «${status}»`);
  return hit[0];
}

export function writebackConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    enabled: env.CRM_WRITEBACK_ENABLED === "true",
    hasWriteToken: !!env.CRM_WRITE_TOKEN,
    hasBaseUrl: !!env.CRM_BASE_URL,
    createPath: (env.CRM_CREATE_PATH ?? "").trim().replace(/^\/+|\/+$/g, "") || null,
  };
}
export const writebackReady = (env: NodeJS.ProcessEnv = process.env) => { const c = writebackConfig(env); return c.enabled && c.hasWriteToken && c.hasBaseUrl; };

export class K3gCrmWriter implements CrmWriter {
  private http: CrmHttp; private map: Record<string, Situacao>; private createPath: string | null;
  private cache: Map<string, RemoteCompany> | null = null;
  private ambiguous = new Set<string>();
  constructor(o: HttpOpts & { statusMap?: Record<string, Situacao>; createPath?: string | null }) { this.http = new CrmHttp(o); this.map = o.statusMap ?? DEFAULT_STATUS_MAP; this.createPath = o.createPath ?? null; }

  async findByDocument(document: string): Promise<RemoteCompany | null> {
    if (!this.cache) { // a API do CRM devolve tudo de uma vez; uma consulta por rodada basta
      const body = await this.http.getJson("crm/companies");
      this.cache = new Map(); this.ambiguous = new Set();
      for (const c of itemsOf(body, "companies")) {
        if (!c || typeof c !== "object") continue;
        const r = c as Record<string, unknown>;
        const doc = typeof r.cnpj === "string" ? alnum(r.cnpj) : "";
        if (!doc || typeof r.id !== "string") continue;
        if (this.cache.has(doc)) this.ambiguous.add(doc); // o mesmo documento em mais de uma empresa do CRM
        else this.cache.set(doc, { externalId: r.id, crmStatus: typeof r.crmStatus === "string" ? r.crmStatus : "" });
      }
    }
    const key = alnum(document);
    if (this.ambiguous.has(key)) throw new CrmError("CNPJ/CPF repetido no CRM (mais de uma empresa): resolva lá; nada foi alterado"); // sem escrita automática em registro que pode ser o errado
    return this.cache.get(key) ?? null;
  }

  async setStatus(externalId: string, status: Situacao): Promise<void> {
    await this.http.sendJson("PATCH", `crm/companies/${encodeURIComponent(externalId)}`, { crmStatus: crmStatusFor(status, this.map) }, { retry: true });
  }

  async createCompany(i: CreateInput): Promise<{ externalId: string }> {
    if (!this.createPath) throw new CrmPending("Aguardando a equipe do CRM informar a rota de criação de cliente (CRM_CREATE_PATH)");
    const body = await this.http.sendJson("POST", this.createPath, {
      name: i.tradeName || i.legalName, razaoSocial: i.legalName, cnpj: i.document, ...(i.email ? { email: i.email } : {}), ...(i.phone ? { phone: i.phone } : {}), crmStatus: crmStatusFor(i.status, this.map),
    }, { retry: false }); // criar não se repete sozinho: a duplicidade é evitada pela busca por CNPJ antes
    this.cache = null;
    let id = idOf(body);
    if (!id) id = (await this.findByDocument(i.document))?.externalId ?? null; // criou mas não devolveu o id: acha pelo CNPJ em vez de arriscar criar de novo
    if (!id) throw new CrmError("O CRM criou a empresa mas não devolveu o identificador", true);
    return { externalId: id };
  }
}

/** O id pode vir na raiz ou dentro de `company`/`data`. */
function idOf(body: Record<string, unknown>): string | null {
  for (const v of [body, body.company, body.data]) if (v && typeof v === "object" && typeof (v as Record<string, unknown>).id === "string") return (v as Record<string, string>).id;
  return null;
}

export function getCrmWriter(env: NodeJS.ProcessEnv = process.env): CrmWriter {
  const c = writebackConfig(env);
  if (!c.hasBaseUrl || !c.hasWriteToken) throw new CrmPending("CRM sem token de escrita (CRM_WRITE_TOKEN) neste servidor");
  return new K3gCrmWriter({
    baseUrl: env.CRM_BASE_URL!, token: env.CRM_WRITE_TOKEN!, allowInsecureHttp: env.CRM_ALLOW_INSECURE_HTTP === "true",
    allowedHosts: (env.CRM_ALLOWED_HOSTS ?? "api.k3gsolutions.com.br").split(",").map((h) => h.trim()).filter(Boolean),
    statusMap: parseStatusMap(env.CRM_STATUS_MAP), createPath: c.createPath,
  });
}

// ---------- processamento da fila ----------
export const MAX_ATTEMPTS = 8;
export const UNCERTAIN_CREATE_MS = 15 * 60_000;
const BATCH = 20;
/** 2, 4, 8… minutos, no máximo 6 h. */
export const backoffMs = (attempts: number) => Math.min(2 * 60_000 * 2 ** Math.max(0, attempts - 1), 6 * 3_600_000);

export type OutboxResult = { skipped?: string; sent: number; failed: number; retry: number; waiting: number };

export async function processOutbox(db: DB, now = new Date(), deps: { writer?: CrmWriter; env?: NodeJS.ProcessEnv } = {}): Promise<OutboxResult> {
  const env = deps.env ?? process.env;
  const out: OutboxResult = { sent: 0, failed: 0, retry: 0, waiting: 0 };
  if (!deps.writer && !writebackReady(env)) return { ...out, skipped: "envio ao CRM desligado neste servidor" };
  const due = await db.select({ id: crmOutbox.id }).from(crmOutbox)
    .where(and(eq(crmOutbox.state, "pendente"), lte(crmOutbox.nextAttemptAt, now)))
    .orderBy(sql`case when ${crmOutbox.kind} = 'create' then 0 else 1 end`, asc(crmOutbox.createdAt)).limit(BATCH);
  if (due.length === 0) return out;
  let writer: CrmWriter;
  try { writer = deps.writer ?? getCrmWriter(env); } catch (e) { return { ...out, skipped: e instanceof Error ? e.message : "sem credencial de escrita" }; }

  for (const { id } of due) {
    let attempted = false; // já chamou o CRM para CRIAR (resultado pode ser incerto)
    // reserva a linha (outro processo não pega a mesma) e já agenda uma nova tentativa caso este processo morra no meio
    const [row] = await db.update(crmOutbox).set({ attempts: sql`${crmOutbox.attempts} + 1`, nextAttemptAt: new Date(now.getTime() + 10 * 60_000), updatedAt: now })
      .where(and(eq(crmOutbox.id, id), eq(crmOutbox.state, "pendente"), lte(crmOutbox.nextAttemptAt, now))).returning();
    if (!row) continue;
    // só a tentativa que reservou a linha pode concluí-la (um «Tentar de novo» no meio zera as tentativas e anula uma tentativa antiga)
    const settle = (set: Record<string, unknown>) => db.update(crmOutbox).set(set).where(and(eq(crmOutbox.id, id), eq(crmOutbox.state, "pendente"), eq(crmOutbox.attempts, row.attempts)));
    try {
      const [cust] = await db.select().from(customers).where(and(eq(customers.id, row.customerId), eq(customers.companyId, row.companyId)));
      if (!cust) throw new CrmError("Cliente não encontrado");
      const status = cust.status as Situacao; // vale a situação ATUAL (o pedido pode ter ficado velho)
      let externalId = cust.externalId;
      let createdNow = false;
      if (!externalId) {
        const found = await writer.findByDocument(cust.document);
        if (found) externalId = found.externalId;
        else {
          const [ct] = await db.select({ email: customerContacts.email, phone: customerContacts.phone }).from(customerContacts)
            .where(and(eq(customerContacts.companyId, row.companyId), eq(customerContacts.partyId, cust.id))).orderBy(sql`${customerContacts.isFinancial} desc`, asc(customerContacts.createdAt)).limit(1);
          attempted = true;
          externalId = (await writer.createCompany({ legalName: cust.legalName, tradeName: cust.tradeName, document: cust.document, email: ct?.email ?? null, phone: ct?.phone ?? null, status })).externalId;
          createdNow = true;
        }
        await db.update(customers).set({ externalId, externalSyncedAt: now, updatedAt: now }).where(and(eq(customers.id, cust.id), eq(customers.companyId, row.companyId)));
      }
      if (row.kind === "status" && !createdNow) await writer.setStatus(externalId, status);
      const done = await settle({ state: "enviado", sentAt: now, lastError: null, updatedAt: now }).returning({ id: crmOutbox.id });
      if (done.length === 0) continue; // outra tentativa assumiu a linha
      await db.insert(auditLog).values({ companyId: row.companyId, actorId: null, action: "crm.writeback.sent", detail: { customerId: cust.id, kind: row.kind, status, created: createdNow } });
      out.sent++;
    } catch (e) {
      if (e instanceof CrmPending) { // espera da equipe do CRM: não conta como tentativa e não vira falha
        await settle({ attempts: sql`greatest(${crmOutbox.attempts} - 1, 0)`, nextAttemptAt: new Date(now.getTime() + 3_600_000), lastError: trunc(e.message), updatedAt: now });
        out.waiting++; continue;
      }
      const message = trunc(e instanceof Error ? e.message : "falha desconhecida");
      const retryable = e instanceof CrmError ? e.retryable : true;
      if (retryable && row.attempts < MAX_ATTEMPTS) {
        // depois de um POST de criação com resultado incerto, espera mais (o CRM pode ter criado e demorar a listar) antes de verificar de novo pelo CNPJ
        const wait = attempted ? Math.max(backoffMs(row.attempts), UNCERTAIN_CREATE_MS) : backoffMs(row.attempts);
        const upd = await settle({ nextAttemptAt: new Date(now.getTime() + wait), lastError: message, updatedAt: now }).returning({ id: crmOutbox.id });
        if (upd.length) out.retry++;
      } else {
        const upd = await settle({ state: "falhou", lastError: message, updatedAt: now }).returning({ id: crmOutbox.id });
        if (upd.length) {
          await db.insert(auditLog).values({ companyId: row.companyId, actorId: null, action: "crm.writeback.failed", detail: { customerId: row.customerId, kind: row.kind } });
          out.failed++;
        }
      }
    }
  }
  return out;
}
