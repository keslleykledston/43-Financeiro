/**
 * W1 — adaptador da WAHA (WhatsApp NÃO oficial). ÚNICO arquivo que lê `WAHA_API_KEY` e fala com a WAHA; o navegador nunca a contata e nunca recebe a chave.
 * Contrato validado em spike real (WAHA CORE 2026.8.2, engine GOWS; fixtures em tests/fixtures/waha). Sem `latest`: a imagem é fixada por digest no compose.
 *
 * Travas locais (antes de qualquer rede):
 *  - destino: só o host interno configurado (waha, localhost, 127.0.0.1) por http; nada digitado por pessoa vira URL;
 *  - rotas: allowlist fechada; nome de sessão no formato gerado aqui (`k3g-xxxxxxxx`);
 *  - envio: só conversa INDIVIDUAL (`55DDDNNNNNNNN@c.us`), texto puro (sem grupo, mídia, menção ou lista).
 * Erros nunca carregam corpo de resposta, QR, chave ou telefone: só um código curto.
 * Resultado de envio ambíguo (tempo esgotado, queda depois do pedido, 5xx) = `unknown`: o chamador NUNCA reenvia sozinho.
 */
import type { SendResult } from "./types";

export type WahaEnv = Record<string, string | undefined>;
export type WahaStatus = "STOPPED" | "STARTING" | "SCAN_QR_CODE" | "WORKING" | "FAILED" | string;
export type WahaSession = { name: string; status: WahaStatus; meId: string | null; engine: string | null };

export class WahaError extends Error {
  /** config: sem chave/URL; blocked: a trava local recusou (nada foi enviado); network: não chegou à WAHA; timeout; http: a WAHA respondeu erro */
  readonly code: string;
  constructor(public readonly kind: "config" | "blocked" | "network" | "timeout" | "http", public readonly status = 0, code?: string) {
    super(code ?? kind);
    this.name = "WahaError";
    this.code = code ?? kind;
  }
}

const HOSTS = new Set(["waha", "localhost", "127.0.0.1"]);
export const SESSION_NAME = /^k3g-[a-f0-9]{8}$/;
export const CHAT_ID = /^55\d{10,11}@c\.us$/;
export const MAX_TEXT = 600;
const TIMEOUT_MS = 15_000;
const MAX_BODY = 1_000_000;
const MAX_QR = 200_000;
type Res = { status: number; ok: boolean; type: string; buf: Buffer };
const NOT_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]); // falhou ANTES de o pedido sair

export function wahaConfigured(env: WahaEnv = process.env): boolean {
  return !!env.WAHA_API_KEY && !!env.WAHA_BASE_INTERNAL_URL;
}

type Fetch = typeof fetch;
export interface WahaClient {
  health(): Promise<boolean>;
  createSession(name: string): Promise<WahaSession>;
  getSession(name: string): Promise<WahaSession | null>;
  startSession(name: string): Promise<WahaSession>;
  stopSession(name: string): Promise<void>;
  logoutSession(name: string): Promise<void>;
  /** PNG do QR (só com a sessão em SCAN_QR_CODE). Nunca em log. */
  qr(name: string): Promise<Buffer>;
  /**
   * Consulta (SEM enviar) se o número existe no WhatsApp. O motor GOWS só consegue enviar a um número depois de resolvê-lo (id interno "LID"): sem esta consulta o envio
   * falha com "no LID found". Devolve o id canônico individual (`55…@c.us`) que a WAHA conhece para o número (resolve a diferença do 9º dígito), ou null se não existe.
   */
  checkNumber(session: string, digits: string): Promise<{ exists: boolean; chatId: string | null }>;
  sendText(m: { session: string; chatId: string; text: string }): Promise<SendResult>;
}

export const sessionNameFor = (id: string) => `k3g-${id.replace(/-/g, "").slice(0, 8).toLowerCase()}`;

const parseSession = (j: unknown): WahaSession => {
  const o = (j ?? {}) as { name?: unknown; status?: unknown; me?: { id?: unknown } | null; engine?: { engine?: unknown } | null };
  return { name: String(o.name ?? ""), status: String(o.status ?? "STOPPED"), meId: typeof o.me?.id === "string" ? o.me.id : null, engine: typeof o.engine?.engine === "string" ? o.engine.engine : null };
};

export function createWahaClient(env: WahaEnv = process.env, fetchImpl: Fetch = fetch, timeoutMs = TIMEOUT_MS): WahaClient {
  const key = env.WAHA_API_KEY, rawBase = env.WAHA_BASE_INTERNAL_URL;
  const base = (() => {
    if (!key || !rawBase) throw new WahaError("config", 0, "waha_nao_configurada");
    let u: URL;
    try { u = new URL(rawBase); } catch { throw new WahaError("config", 0, "url_invalida"); }
    if (u.protocol !== "http:" || !HOSTS.has(u.hostname) || u.port !== "3000" || u.username || u.password || (u.pathname !== "/" && u.pathname !== "")) throw new WahaError("config", 0, "url_nao_permitida");
    return u.origin;
  })();

  /** Faz o pedido e LÊ o corpo inteiro dentro do mesmo prazo e do limite de bytes (nada de corpo enorme ou lento fora do controle). */
  async function call(method: "GET" | "POST" | "DELETE", path: string, body?: unknown, accept = "application/json", maxBytes = MAX_BODY): Promise<Res> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let r: Response;
    try {
      r = await fetchImpl(`${base}${path}`, { method, headers: { "X-Api-Key": key!, Accept: accept, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal, redirect: "error", cache: "no-store" });
    } catch (e) {
      clearTimeout(timer);
      const cause = (e as { cause?: { code?: string } }).cause?.code ?? "";
      if ((e as Error).name === "AbortError") throw new WahaError("timeout");
      throw new WahaError("network", 0, NOT_SENT.has(cause) ? "nao_enviado" : "queda_de_conexao");
    }
    try {
      const chunks: Buffer[] = []; let total = 0;
      const reader = r.body?.getReader();
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) { ctrl.abort(); throw new WahaError("http", 502, "corpo_grande_demais"); }
        chunks.push(Buffer.from(value));
      }
      return { status: r.status, ok: r.ok, type: r.headers.get("content-type") ?? "", buf: Buffer.concat(chunks) };
    } catch (e) {
      if (e instanceof WahaError) throw e;
      throw new WahaError((e as Error).name === "AbortError" ? "timeout" : "network", 0, (e as Error).name === "AbortError" ? "timeout" : "queda_de_conexao"); // o pedido JÁ saiu: nunca "nao_enviado"
    } finally { clearTimeout(timer); }
  }
  const asJson = (r: Res): unknown => { try { return JSON.parse(r.buf.toString("utf8")); } catch { return {}; } };
  const must = (name: string) => { if (!SESSION_NAME.test(name)) throw new WahaError("blocked", 0, "nome_de_sessao_invalido"); return name; };
  const ok = (r: Res) => { if (!r.ok) throw new WahaError("http", r.status, `http_${r.status}`); return r; };

  return {
    async health() {
      try { return (await call("GET", "/ping")).ok; } catch { return false; }
    },
    async createSession(name) { return parseSession(asJson(ok(await call("POST", "/api/sessions", { name: must(name), start: true })))); },
    async getSession(name) {
      const r = await call("GET", `/api/sessions/${must(name)}`);
      if (r.status === 404) return null;
      return parseSession(asJson(ok(r)));
    },
    async startSession(name) { return parseSession(asJson(ok(await call("POST", `/api/sessions/${must(name)}/start`)))); },
    async stopSession(name) { ok(await call("POST", `/api/sessions/${must(name)}/stop`)); },
    async logoutSession(name) { ok(await call("POST", `/api/sessions/${must(name)}/logout`)); },
    async qr(name) {
      const r = ok(await call("GET", `/api/${must(name)}/auth/qr`, undefined, "image/png", MAX_QR));
      if (!r.type.startsWith("image/png")) throw new WahaError("http", 502, "qr_formato_inesperado");
      if (r.buf.length < 100 || r.buf.subarray(1, 4).toString() !== "PNG") throw new WahaError("http", 502, "qr_invalido");
      return r.buf;
    },
    async checkNumber(session, digits) {
      if (!/^55\d{10,11}$/.test(digits)) throw new WahaError("blocked", 0, "numero_invalido");
      const r = ok(await call("GET", `/api/contacts/check-exists?phone=${digits}&session=${must(session)}`));
      const j = asJson(r) as { numberExists?: unknown; pn?: unknown };
      if (j.numberExists !== true) return { exists: false, chatId: null };
      return { exists: true, chatId: typeof j.pn === "string" && CHAT_ID.test(j.pn) ? j.pn : null }; // pn fora do formato individual = não usar
    },
    async sendText(m) {
      if (!SESSION_NAME.test(m.session)) return { ok: false, retryable: false, error: "nome_de_sessao_invalido" };
      if (!CHAT_ID.test(m.chatId)) return { ok: false, retryable: false, error: "destino_nao_individual" }; // grupo, lista e transmissão nunca
      const text = m.text;
      if (!text.trim() || text.length > MAX_TEXT || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return { ok: false, retryable: false, error: "texto_invalido" };
      let r: Res;
      try { r = await call("POST", "/api/sendText", { session: m.session, chatId: m.chatId, text }); }
      catch (e) {
        if (e instanceof WahaError && e.kind === "network" && e.code === "nao_enviado") return { ok: false, retryable: true, error: "waha_inacessivel" }; // nada saiu
        return { ok: false, retryable: false, unknown: true, error: "sem_confirmacao" }; // tempo esgotado ou queda (inclusive no meio da resposta): PODE ter enviado
      }
      if (r.status >= 500) return { ok: false, retryable: false, unknown: true, error: "sem_confirmacao" };
      if (!r.ok) return { ok: false, retryable: false, error: r.status === 422 ? "sessao_nao_pronta" : `http_${r.status}` };
      const j = asJson(r) as { id?: unknown; _data?: { id?: { _serialized?: unknown } } };
      const idObj = j.id as { _serialized?: unknown } | undefined;
      const id = typeof j.id === "string" ? j.id : typeof idObj?._serialized === "string" ? idObj._serialized : typeof j._data?.id?._serialized === "string" ? j._data.id._serialized : "";
      return { ok: true, providerRef: (id || "waha-sem-id").slice(0, 120) };
    },
  };
}
