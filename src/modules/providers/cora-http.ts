import { request as httpsRequest } from "node:https";
import { randomUUID } from "node:crypto";
import type { DB } from "@/lib/db";
import { readCoraCredentials } from "./cora-secrets";
import type { CoraEnvironment } from "./cora";

/**
 * E10b — cliente HTTP da Cora (mTLS, "integração direta"). ÚNICO arquivo autorizado a ler os segredos em claro (cora-secrets).
 * Travas estruturais (valem mesmo que alguém chame errado; a regra do dono é: NENHUMA transação financeira):
 *  - Produção é SOMENTE LEITURA: só autenticar (POST /token) e consultar (GET). Emitir boleto (POST /v2/invoices) só existe em homologação (stage); em produção é recusado AQUI,
 *    e liberar exige mudar este arquivo, com revisão e autorização escrita do dono.
 *  - SÓ estas rotas: POST /token, GET /v2/invoices, GET /v2/invoices/{id}, POST /v2/invoices (emitir, só stage). Qualquer outra (pagar, transferir, extrato, saldo, cancelar…) é recusada AQUI.
 *  - Timeout de 30 s (menor que o `STUCK_MS` do motor de emissão), resposta limitada a 2 MB, nada de segredo/token em mensagens de erro ou log.
 */
// Object.freeze: a trava vale em tempo de execução, não só no TypeScript (nenhum outro módulo consegue esvaziar a lista nem trocar o host).
export const CORA_HOSTS: Readonly<Record<CoraEnvironment, string>> = Object.freeze({ homologacao: "matls-clients.api.stage.cora.com.br", producao: "matls-clients.api.cora.com.br" });
/** Ambientes em que o cliente NÃO pode escrever (emitir). Hoje: produção. */
export const READ_ONLY_ENVS: readonly CoraEnvironment[] = Object.freeze(["producao"] as CoraEnvironment[]);
export const CORA_TIMEOUT_MS = 30_000;
const MAX_BODY = 2_000_000;

export class CoraHttpError extends Error {
  /** `code`: identificador curto da Cora (ex.: REC-0006). `field`: campo recusado na validação (ex.: paymentterms_duedate), já em formato seguro para guardar. */
  constructor(public status: number, message: string, public code?: string, public field?: string) { super(message); this.name = "CoraHttpError"; }
}
/** Rede/timeout: o resultado da chamada é DESCONHECIDO (pode ter chegado à Cora). */
export class CoraNetworkError extends Error { constructor(message: string) { super(message); this.name = "CoraNetworkError"; } }

type Method = "GET" | "POST" | "DELETE";
type Route = { method: Method; re: RegExp };
const ROUTES: Route[] = [
  { method: "POST", re: /^\/token$/ },
  { method: "GET", re: /^\/v2\/invoices$/ },
  { method: "GET", re: /^\/v2\/invoices\/inv_[A-Za-z0-9_-]{4,64}$/ },
  { method: "POST", re: /^\/v2\/invoices$/ },
  { method: "DELETE", re: /^\/v2\/invoices\/inv_[A-Za-z0-9_-]{4,64}$/ }, // cancelar boleto (só a diretoria chama, via fluxo E20/E30; bloqueado em produção)
];
export const routeAllowed = (method: string, path: string) => ROUTES.some((r) => r.method === method && r.re.test(path));

export type Creds = { clientId: string; certificate: string; privateKey: string };
export type Raw = { status: number; body: string };
/** Transporte injetável (testes). O real usa https com certificado de cliente. */
export type Transport = (o: { host: string; method: string; path: string; headers: Record<string, string>; body?: string; creds: Creds }) => Promise<Raw>;

export const httpsTransport: Transport = ({ host, method, path, headers, body, creds }) =>
  new Promise((resolve, reject) => {
    const req = httpsRequest({ host, port: 443, method, path, headers, cert: creds.certificate, key: creds.privateKey, timeout: CORA_TIMEOUT_MS, servername: host, minVersion: "TLSv1.2" }, (res) => {
      const chunks: Buffer[] = []; let size = 0;
      res.on("data", (c: Buffer) => { size += c.length; if (size > MAX_BODY) { req.destroy(new Error("resposta grande demais")); return; } chunks.push(c); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", (e) => reject(new CoraNetworkError(e.message)));
    });
    req.on("timeout", () => req.destroy(new Error("tempo esgotado")));
    req.on("error", (e) => reject(new CoraNetworkError(e.message)));
    if (body !== undefined) req.write(body);
    req.end();
  });

const safeMsg = (s: string) => s.replace(/Bearer\s+\S+/gi, "Bearer ***").replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_.-]+/g, "***").slice(0, 300);

function parseJson(raw: Raw): unknown {
  try { return raw.body ? JSON.parse(raw.body) : null; } catch { throw new CoraHttpError(raw.status, "Resposta da Cora não é JSON"); }
}
function fail(raw: Raw): never {
  let code: string | undefined, field: string | undefined, msg = `Cora respondeu ${raw.status}`;
  try {
    const j = JSON.parse(raw.body) as { code?: string; error?: string; message?: string; errors?: { code?: string; message?: string }[] };
    const c = j.code ?? j.error;
    code = typeof c === "string" && /^[A-Za-z0-9_.:-]{1,60}$/.test(c) ? c : undefined; // só um identificador curto; texto livre (que poderia ecoar token) é descartado
    const first = j.errors?.[0];
    const f = typeof first?.code === "string" ? first.code.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) : "";
    field = f || undefined;
    msg = safeMsg([`Cora ${raw.status}`, j.message ?? j.error ?? "", first ? `${first.code ?? ""}: ${first.message ?? ""}` : ""].filter(Boolean).join(" — "));
  } catch { /* corpo não JSON: fica a mensagem padrão */ }
  throw new CoraHttpError(raw.status, msg, code, field);
}

export type InvoiceStatus = "DRAFT" | "OPEN" | "IN_PAYMENT" | "LATE" | "PAID" | "CANCELLED";
export type Invoice = {
  id: string; status: InvoiceStatus | string; code: string | null; totalAmountCents: number; totalPaidCents: number; dueDate: string | null;
  customerName: string | null; digitable: string | null; barcode: string | null; pdfUrl: string | null;
};

/** CPF (11 dígitos) ou CNPJ (14; desde 2026 pode ter letras nas 12 primeiras posições): sem pontuação, em maiúsculas. */
export const docOf = (raw: string) => raw.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const str = (v: unknown) => (typeof v === "string" ? v : null);
const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0);

/** Normaliza a fatura da Cora. A listagem e o detalhe têm formatos parecidos; campos ausentes viram null/0 (nunca inventa valor). */
export function normalizeInvoice(raw: unknown): Invoice {
  const o = asObj(raw), terms = asObj(o.payment_terms), slip = asObj(asObj(o.payment_options).bank_slip), cust = asObj(o.customer);
  return {
    id: String(o.id ?? ""), status: String(o.status ?? ""), code: str(o.code),
    totalAmountCents: int(o.total_amount ?? o.amount), totalPaidCents: int(o.total_paid),
    dueDate: str(terms.due_date) ?? str(o.due_date), customerName: str(cust.name),
    digitable: str(slip.digitable), barcode: str(slip.barcode), pdfUrl: str(slip.url),
  };
}

export class CoraClient {
  private token: { value: string; exp: number } | null = null;
  constructor(private creds: Creds, private env: CoraEnvironment, private transport: Transport = httpsTransport, private now: () => number = Date.now) {
  }

  private async send(method: Method, path: string, o: { headers?: Record<string, string>; body?: string } = {}): Promise<Raw> {
    const bare = path.split("?")[0];
    if (!routeAllowed(method, bare)) throw new CoraHttpError(0, "Rota da Cora não permitida pelo escopo (somente boletos)");
    if (method !== "GET" && bare !== "/token" && READ_ONLY_ENVS.includes(this.env)) throw new CoraHttpError(0, "Emissão/cancelamento de boleto bloqueados em produção (somente leitura)");
    return this.transport({ host: CORA_HOSTS[this.env], method, path, headers: { accept: "application/json", ...o.headers }, body: o.body, creds: this.creds });
  }

  /** Token de 24 h (sem refresh): reaproveitado até 5 min antes de vencer. */
  async accessToken(): Promise<{ expiresInSec: number }> {
    if (this.token && this.token.exp - this.now() > 300_000) return { expiresInSec: Math.floor((this.token.exp - this.now()) / 1000) };
    const body = new URLSearchParams({ grant_type: "client_credentials", client_id: this.creds.clientId }).toString();
    const raw = await this.send("POST", "/token", { headers: { "content-type": "application/x-www-form-urlencoded", "content-length": String(Buffer.byteLength(body)) }, body });
    if (raw.status !== 200) fail(raw);
    const j = asObj(parseJson(raw));
    const t = str(j.access_token), exp = typeof j.expires_in === "number" ? j.expires_in : 0;
    if (!t || exp <= 0) throw new CoraHttpError(raw.status, "Cora não devolveu token válido");
    this.token = { value: t, exp: this.now() + exp * 1000 };
    return { expiresInSec: exp };
  }

  private async authed(method: Method, path: string, o: { headers?: Record<string, string>; json?: unknown } = {}): Promise<unknown> {
    await this.accessToken();
    const body = o.json === undefined ? undefined : JSON.stringify(o.json);
    const headers: Record<string, string> = { authorization: `Bearer ${this.token!.value}`, ...o.headers };
    if (body !== undefined) { headers["content-type"] = "application/json"; headers["content-length"] = String(Buffer.byteLength(body)); }
    const raw = await this.send(method, path, { headers, body });
    if (raw.status === 401) this.token = null; // token recusado: a próxima chamada pede outro
    if (raw.status < 200 || raw.status >= 300) fail(raw);
    return parseJson(raw);
  }

  /** Coleta (somente leitura). Filtros opcionais por vencimento (AAAA-MM-DD) e situação. */
  async listInvoices(f: { start?: string; end?: string; state?: string; search?: string; page?: number; perPage?: number } = {}): Promise<{ items: Invoice[]; totalItems: number | null }> {
    const q = new URLSearchParams();
    if (f.start) q.set("start", f.start);
    if (f.end) q.set("end", f.end);
    if (f.state) q.set("state", f.state);
    if (f.search) q.set("search", docOf(f.search)); // a Cora filtra por CPF/CNPJ do cliente
    q.set("page", String(f.page ?? 1));
    q.set("perPage", String(Math.min(200, f.perPage ?? 20)));
    const j = asObj(await this.authed("GET", `/v2/invoices?${q}`));
    const items = (Array.isArray(j.items) ? j.items : []).map(normalizeInvoice);
    return { items, totalItems: typeof j.totalItems === "number" ? j.totalItems : null };
  }

  async getInvoice(id: string): Promise<Invoice> {
    return normalizeInvoice(await this.authed("GET", `/v2/invoices/${id}`));
  }

  /** Cancela um boleto ainda não pago (204 sem corpo). Só homologação; erro REC-0006 = já pago. */
  async cancelInvoice(id: string): Promise<void> {
    await this.authed("DELETE", `/v2/invoices/${id}`);
  }

  /** Emite UM boleto. `idempotencyKey` deve ser UUID (a Cora usa para não duplicar se a resposta se perder). */
  async createInvoice(i: { idempotencyKey: string; code: string; amountCents: number; dueDate: string; customerName: string; customerDocument: string; description: string }): Promise<Invoice> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(i.idempotencyKey)) throw new RangeError("Idempotency-Key deve ser UUID");
    if (!Number.isSafeInteger(i.amountCents) || i.amountCents < 500) throw new RangeError("Boleto mínimo: R$ 5,00");
    const digits = docOf(i.customerDocument);
    if (!(digits.length === 11 && /^\d+$/.test(digits)) && !(digits.length === 14 && /^[0-9A-Z]{12}\d{2}$/.test(digits))) throw new RangeError("Documento do cliente inválido");
    const body = {
      code: i.code,
      customer: { name: i.customerName, document: { identity: digits, type: digits.length === 11 ? "CPF" : "CNPJ" } },
      services: [{ name: i.description.slice(0, 100), description: i.description.slice(0, 250), amount: i.amountCents }],
      payment_terms: { due_date: i.dueDate },
      payment_forms: ["BANK_SLIP"],
    };
    return normalizeInvoice(await this.authed("POST", "/v2/invoices", { headers: { "Idempotency-Key": i.idempotencyKey }, json: body }));
  }
}

/** Cria o cliente a partir das credenciais cifradas da empresa. Lança se não houver credencial cadastrada para o ambiente. */
export async function coraClientFor(db: DB, companyId: string, env: CoraEnvironment, transport?: Transport): Promise<CoraClient> {
  const creds = await readCoraCredentials(db, companyId, env);
  if (!creds) throw new CoraHttpError(0, "Credenciais da Cora não cadastradas para este ambiente");
  return new CoraClient(creds, env, transport);
}

export const newIdempotencyKey = () => randomUUID();
