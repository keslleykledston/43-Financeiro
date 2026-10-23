import { CrmError, MAX_BODY_BYTES, MAX_PAGE_ITEMS, type CrmAdapter, type CrmPage } from "./types";

export type HttpOpts = {
  baseUrl: string; token: string; timeoutMs?: number; maxRetries?: number;
  allowInsecureHttp?: boolean; // só sandbox/dev
  fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>;
};

/** Cliente HTTP seguro e somente leitura (GET): HTTPS, token Bearer, timeout, retry com backoff, 429/Retry-After, teto de bytes, sem redirects. */
export class CrmHttp {
  private f: typeof fetch; private sleep: (ms: number) => Promise<void>;
  constructor(private o: HttpOpts) {
    const u = new URL(o.baseUrl);
    if (u.protocol !== "https:" && !o.allowInsecureHttp) throw new CrmError("CRM exige HTTPS");
    if (!o.token) throw new CrmError("Token do CRM não configurado");
    this.f = o.fetchImpl ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async getJson(path: string, params: Record<string, string | undefined> = {}): Promise<Record<string, unknown>> {
    const url = new URL(`${this.o.baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`);
    for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
    const max = this.o.maxRetries ?? 3;
    let last = "falha desconhecida";
    for (let attempt = 0; attempt <= max; attempt++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), this.o.timeoutMs ?? 10_000);
      try {
        const r = await this.f(url, { headers: { authorization: `Bearer ${this.o.token}`, accept: "application/json" }, signal: ctl.signal, redirect: "error" }); // nunca segue redirect (evita SSRF/vazamento do token)
        if (r.status === 429 || r.status >= 500) {
          const ra = Number(r.headers.get("retry-after"));
          last = `CRM respondeu ${r.status}`;
          await this.sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30_000) : backoff(attempt));
          continue;
        }
        if (r.status === 401 || r.status === 403) throw new CrmError(`CRM recusou o acesso (${r.status}). Verifique o token, as seções liberadas ao usuário e se o IP deste servidor está permitido.`);
        if (!r.ok) throw new CrmError(`CRM respondeu ${r.status}`); // outros 4xx: não adianta repetir
        let body: unknown;
        try { body = JSON.parse(await readLimited(r, MAX_BODY_BYTES)); } catch (e) { if (e instanceof CrmError) throw e; throw new CrmError("Resposta do CRM não é um JSON válido"); }
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new CrmError("Resposta do CRM fora do formato esperado");
        return body as Record<string, unknown>;
      } catch (e) {
        if (e instanceof CrmError) throw e;
        last = (e as Error).name === "AbortError" ? "tempo esgotado ao consultar o CRM" : "erro de rede ao consultar o CRM"; // sem detalhes que possam conter segredos
        await this.sleep(backoff(attempt));
      } finally { clearTimeout(timer); }
    }
    throw new CrmError(`${last} (após ${max + 1} tentativas)`, true);
  }
}

export function itemsOf(body: Record<string, unknown>, key = "items"): unknown[] {
  const items = body[key];
  if (!Array.isArray(items)) throw new CrmError("Resposta do CRM fora do formato esperado");
  if (items.length > MAX_PAGE_ITEMS) throw new CrmError(`Página do CRM com mais de ${MAX_PAGE_ITEMS} itens`);
  return items;
}

/** Adaptador para um CRM que já fale o formato canônico (usado no sandbox e como referência). */
export class CanonicalHttpAdapter implements CrmAdapter {
  private http: CrmHttp;
  constructor(o: HttpOpts) { this.http = new CrmHttp(o); }
  async listCustomers({ cursor, updatedSince }: { cursor?: string; updatedSince?: string }): Promise<CrmPage> {
    const body = await this.http.getJson("customers", { cursor, updated_since: updatedSince });
    return { items: itemsOf(body), nextCursor: typeof body.nextCursor === "string" && body.nextCursor ? body.nextCursor : undefined };
  }
}

const backoff = (attempt: number) => Math.min(200 * 2 ** attempt, 5000) + Math.floor(Math.random() * 100);

/** Lê o corpo em streaming e aborta ao passar do limite — antes de materializar/parsear a resposta inteira. */
async function readLimited(r: Response, max: number): Promise<string> {
  const len = Number(r.headers.get("content-length"));
  if (Number.isFinite(len) && len > max) throw new CrmError("Resposta do CRM grande demais");
  if (!r.body) { const t = await r.text(); if (t.length > max) throw new CrmError("Resposta do CRM grande demais"); return t; }
  const reader = r.body.getReader(); const chunks: Uint8Array[] = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { await reader.cancel(); throw new CrmError("Resposta do CRM grande demais"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
