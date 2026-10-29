import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createWahaClient, sessionNameFor, wahaConfigured, WahaError, CHAT_ID, SESSION_NAME } from "@/modules/providers/waha";
import { chatIdFor, mapWahaStatus, maskMe, maskPhone, parseBrPhone, testText } from "@/modules/whatsapp/domain";

const fx = (n: string) => readFileSync(join(__dirname, "fixtures/waha", n), "utf8");
const KEY = "chave-secreta-de-teste-0123456789";
const ENV = { WAHA_API_KEY: KEY, WAHA_BASE_INTERNAL_URL: "http://waha:3000" };
const NAME = "k3g-0a1b2c3d";
const PNG = (() => { const b = Buffer.alloc(400, 7); Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(b); return b; })();
type Call = { url: string; init: RequestInit };
const mk = (res: (c: Call) => Response | Promise<Response>, env = ENV) => {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => { const c = { url, init }; calls.push(c); return res(c); }) as unknown as typeof fetch;
  return { client: createWahaClient(env, f), calls };
};
const json = (body: unknown, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("W1 WAHA — configuração e travas locais", () => {
  it("sem chave/URL ou com URL fora do permitido: falha de configuração, sem rede", () => {
    expect(wahaConfigured({})).toBe(false);
    expect(wahaConfigured(ENV)).toBe(true);
    for (const env of [{}, { WAHA_API_KEY: KEY }, { WAHA_BASE_INTERNAL_URL: "http://waha:3000" }, { ...ENV, WAHA_BASE_INTERNAL_URL: "https://waha:3000" }, { ...ENV, WAHA_BASE_INTERNAL_URL: "http://evil.com:3000" },
      { ...ENV, WAHA_BASE_INTERNAL_URL: "http://10.0.0.5:3000" }, { ...ENV, WAHA_BASE_INTERNAL_URL: "http://u:p@waha:3000" }, { ...ENV, WAHA_BASE_INTERNAL_URL: "http://waha:3000/api" }, { ...ENV, WAHA_BASE_INTERNAL_URL: "http://waha:8080" }, { ...ENV, WAHA_BASE_INTERNAL_URL: "http://waha" }, { ...ENV, WAHA_BASE_INTERNAL_URL: "lixo" }]) {
      expect(() => createWahaClient(env, (() => { throw new Error("rede"); }) as unknown as typeof fetch)).toThrow(WahaError);
    }
    expect(() => createWahaClient({ ...ENV, WAHA_BASE_INTERNAL_URL: "http://localhost:3000" })).not.toThrow();
  });

  it("a chave vai só no header X-Api-Key (nunca na URL), sem seguir redirecionamento e sem cache", async () => {
    const { client, calls } = mk(() => json(JSON.parse(fx("session-created.json"))));
    const s = await client.createSession(NAME);
    expect(s).toEqual({ name: NAME, status: "STARTING", meId: null, engine: "GOWS" });
    expect(calls[0].url).toBe("http://waha:3000/api/sessions");
    expect((calls[0].init.headers as Record<string, string>)["X-Api-Key"]).toBe(KEY);
    expect(calls[0].url).not.toContain(KEY);
    expect(calls[0].init.redirect).toBe("error");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ name: NAME, start: true });
  });

  it("nome de sessão fora do formato gerado aqui é recusado antes da rede (inclusive 'default' e traversal)", async () => {
    const { client, calls } = mk(() => json({}));
    for (const bad of ["default", "../sessions", "k3g-ZZZZZZZZ", "k3g-0a1b2c3", "k3g-0a1b2c3d/stop", ""]) {
      await expect(client.getSession(bad)).rejects.toMatchObject({ kind: "blocked" });
      await expect(client.createSession(bad)).rejects.toMatchObject({ kind: "blocked" });
    }
    expect(calls).toHaveLength(0);
    expect(SESSION_NAME.test(sessionNameFor("0a1b2c3d-1111-4222-8333-444455556666"))).toBe(true);
  });

  it("getSession: 404 vira null; 200 lê status e telefone; 500 vira erro http sem corpo", async () => {
    expect(await mk(() => json({ statusCode: 404 }, 404)).client.getSession(NAME)).toBeNull();
    expect(await mk(() => json(JSON.parse(fx("session-working.json")))).client.getSession(NAME)).toMatchObject({ status: "WORKING", meId: "5592999990000@c.us" });
    const e = await mk(() => json("corpo secreto 5592999990000", 500)).client.getSession(NAME).catch((x) => x);
    expect(e).toBeInstanceOf(WahaError);
    expect(`${e.message} ${e.code}`).not.toMatch(/secreto|5592/);
  });

  it("QR: só PNG válido; JSON, tamanho absurdo ou assinatura errada são recusados", async () => {
    expect((await mk(() => new Response(PNG, { status: 200, headers: { "content-type": "image/png" } })).client.qr(NAME)).length).toBe(400);
    await expect(mk(() => json({ data: "x" })).client.qr(NAME)).rejects.toMatchObject({ code: "qr_formato_inesperado" });
    await expect(mk(() => new Response(Buffer.alloc(400, 1), { status: 200, headers: { "content-type": "image/png" } })).client.qr(NAME)).rejects.toMatchObject({ code: "qr_invalido" });
    await expect(mk(() => new Response(Buffer.alloc(10), { status: 200, headers: { "content-type": "image/png" } })).client.qr(NAME)).rejects.toMatchObject({ code: "qr_invalido" });
    await expect(mk(() => json(JSON.parse(fx("error-session-not-ready.json")), 422)).client.qr(NAME)).rejects.toMatchObject({ status: 422 });
  });
});

describe("W1 WAHA — envio de texto: só individual, e resultado ambíguo nunca vira reenvio", () => {
  const send = (c: ReturnType<typeof mk>["client"], over: Partial<{ session: string; chatId: string; text: string }> = {}) => c.sendText({ session: NAME, chatId: "5592999990000@c.us", text: "Teste", ...over });

  it("destino que não é conversa individual, texto vazio/grande/com controle: recusado SEM chamar a rede", async () => {
    const { client, calls } = mk(() => json({ id: "x" }, 201));
    for (const chatId of ["120363025246125486@g.us", "status@broadcast", "5592999990000@s.whatsapp.net", "92999990000@c.us", "5592999990000", "5592999990000@c.us/../x", "559299999000012345@c.us"]) {
      expect(await send(client, { chatId })).toMatchObject({ ok: false, error: "destino_nao_individual" });
    }
    expect(await send(client, { text: "   " })).toMatchObject({ ok: false, error: "texto_invalido" });
    expect(await send(client, { text: "a".repeat(601) })).toMatchObject({ ok: false, error: "texto_invalido" });
    expect(await send(client, { text: "oi\u0000" })).toMatchObject({ ok: false, error: "texto_invalido" });
    expect(await send(client, { session: "default" })).toMatchObject({ ok: false, error: "nome_de_sessao_invalido" });
    expect(calls).toHaveLength(0);
    expect(CHAT_ID.test("5592999990000@c.us")).toBe(true);
  });

  it("201 → enviado, com a referência da WAHA; o corpo enviado é só {session, chatId, text}", async () => {
    const { client, calls } = mk(() => json({ id: "true_5592999990000@c.us_ABC", timestamp: 1 }, 201));
    expect(await send(client)).toEqual({ ok: true, providerRef: "true_5592999990000@c.us_ABC" });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ session: NAME, chatId: "5592999990000@c.us", text: "Teste" });
    expect(calls[0].url).toBe("http://waha:3000/api/sendText");
  });

  it("422 (sessão não pronta) → falhou, não ambíguo; 500 → DESCONHECIDO; tempo esgotado → DESCONHECIDO", async () => {
    expect(await send(mk(() => json(JSON.parse(fx("error-session-not-ready.json")), 422)).client)).toEqual({ ok: false, retryable: false, error: "sessao_nao_pronta" });
    expect(await send(mk(() => json("x", 500)).client)).toMatchObject({ ok: false, unknown: true });
    expect(await send(mk(() => { const e = new Error("abort"); e.name = "AbortError"; throw e; }).client)).toMatchObject({ ok: false, unknown: true, error: "sem_confirmacao" });
  });

  it("recusa de conexão (nada saiu) é falha segura; queda no meio (ECONNRESET) é DESCONHECIDO", async () => {
    const fail = (code: string) => mk(() => { throw Object.assign(new TypeError("fetch failed"), { cause: { code } }); }).client;
    expect(await send(fail("ECONNREFUSED"))).toMatchObject({ ok: false, retryable: true, error: "waha_inacessivel" });
    expect(await send(fail("ENOTFOUND"))).toMatchObject({ ok: false, error: "waha_inacessivel" });
    expect(await send(fail("ECONNRESET"))).toMatchObject({ ok: false, unknown: true });
    expect(await send(fail("UND_ERR_SOCKET"))).toMatchObject({ ok: false, unknown: true });
  });
});

describe("W1 WAHA — corpo da resposta lido dentro do prazo e do limite", () => {
  const stalled = (init: RequestInit) => new Response(new ReadableStream({ start(c) { init.signal!.addEventListener("abort", () => c.error(Object.assign(new Error("aborted"), { name: "AbortError" }))); } }), { status: 201, headers: { "content-type": "application/json" } });
  const withTimeout = (res: (init: RequestInit) => Response) => createWahaClient(ENV, (async (_u: string, init: RequestInit) => res(init)) as unknown as typeof fetch, 60);

  it("QR maior que o limite é cortado durante a leitura (não carrega o corpo todo)", async () => {
    const big = new Response(Buffer.alloc(900_000, 1), { status: 200, headers: { "content-type": "image/png" } });
    await expect(mk(() => big).client.qr(NAME)).rejects.toMatchObject({ code: "corpo_grande_demais" });
  });
  it("corpo que trava depois dos cabeçalhos estoura o prazo: leitura vira timeout; envio vira DESCONHECIDO (o pedido já saiu)", async () => {
    await expect(withTimeout(stalled).getSession(NAME)).rejects.toMatchObject({ kind: "timeout" });
    expect(await withTimeout(stalled).sendText({ session: NAME, chatId: "5592999990000@c.us", text: "oi" })).toMatchObject({ ok: false, unknown: true });
  });
  it("id do envio aceita string, {_serialized} e _data; sem id vira marcador", async () => {
    const t = (b: unknown) => mk(() => json(b, 201)).client.sendText({ session: NAME, chatId: "5592999990000@c.us", text: "oi" });
    expect(await t({ id: "abc" })).toEqual({ ok: true, providerRef: "abc" });
    expect(await t({ id: { _serialized: "def" } })).toEqual({ ok: true, providerRef: "def" });
    expect(await t({ _data: { id: { _serialized: "ghi" } } })).toEqual({ ok: true, providerRef: "ghi" });
    expect(await t({})).toEqual({ ok: true, providerRef: "waha-sem-id" });
  });
});

describe("W1 WhatsApp — domínio puro", () => {
  it("estados da WAHA → estados nossos; o desconhecido nunca vira 'conectada'", () => {
    expect(mapWahaStatus("WORKING")).toBe("CONNECTED");
    expect(mapWahaStatus("SCAN_QR_CODE")).toBe("QR_REQUIRED");
    expect(mapWahaStatus("STARTING")).toBe("STARTING");
    expect(mapWahaStatus("STOPPED")).toBe("DISCONNECTED");
    expect(mapWahaStatus("FAILED")).toBe("DEGRADED");
    expect(mapWahaStatus("ALGO_NOVO")).toBe("DEGRADED");
  });
  it("telefone BR: aceita máscara/+55/sem DDI; recusa curto, letras, DDD inválido e celular sem 9", () => {
    expect(parseBrPhone("(92) 99999-0000")).toBe("5592999990000");
    expect(parseBrPhone("+55 92 99999-0000")).toBe("5592999990000");
    expect(parseBrPhone("5592999990000")).toBe("5592999990000");
    expect(parseBrPhone("92 3234-5678")).toBe("559232345678");
    for (const bad of ["", "abc", "9999-0000", "00 99999-0000", "92 89999-0000", "5592", "55 92 99999-00001", "+1 415 555 0000"]) expect(parseBrPhone(bad)).toBeNull();
    expect(chatIdFor("5592999990000")).toBe("5592999990000@c.us");
  });
  it("máscara não revela o meio do número; o próprio número vem do me.id", () => {
    expect(maskPhone("5592999991234")).toBe("+55 92 •••••-1234");
    expect(maskPhone("123")).toBe("•••••");
    expect(maskMe("5592999991234@c.us")).toBe("+55 92 •••••-1234");
    expect(maskMe("5592999991234:7@c.us")).toBe("+55 92 •••••-1234");
    expect(maskMe(null)).toBeNull();
    expect(maskMe("lixo")).toBeNull();
  });
  it("texto de teste é fixo: identifica quem escreve e não promete 'responda PARAR' nem leva link", () => {
    const t = testText("  Financeiro K3G Solutions ");
    expect(t).toContain("Financeiro K3G Solutions");
    expect(t).not.toMatch(/PARAR|https?:|www\./i);
    expect(t.length).toBeLessThan(600);
  });
});

describe("W1 WhatsApp — a chave da WAHA não vaza (A22)", () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : []; });
  const root = join(__dirname, "..", "src");
  const src = () => walk(root).map((f) => ({ rel: f.slice(root.length + 1), text: readFileSync(f, "utf8") })); // uma leitura por arquivo (o servidor de teste pode estar lento)
  it("WAHA_API_KEY só aparece no adaptador e na checagem de prontidão (presença), nunca em componente de cliente", () => {
    const files = src();
    expect(files.filter((f) => f.text.includes("WAHA_API_KEY")).map((f) => f.rel).sort()).toEqual(["modules/providers/readiness.ts", "modules/providers/waha.ts"]);
    for (const f of files) if (f.text.startsWith('"use client"')) expect(f.text, f.rel).not.toMatch(/WAHA_|process\.env/);
  }, 30_000);
  it("só waha.ts fala com a WAHA (nenhum outro arquivo monta URL /api/sendText ou /api/sessions)", () => {
    expect(src().filter((f) => /\/api\/sendText|["'`]\/api\/sessions/.test(f.text)).map((f) => f.rel)).toEqual(["modules/providers/waha.ts"]);
  }, 30_000);
});
