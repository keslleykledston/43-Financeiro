// WAHA FALSA para o sandbox (W1). Reproduz os formatos medidos no spike real (CORE 2026.8.2, GOWS): status STOPPED/STARTING/SCAN_QR_CODE/WORKING, QR em PNG,
// 422 quando a sessão não está WORKING, sendText com id. Só em memória; exige X-Api-Key. Controle do teste em /__test/* (também exige a chave).
import { createServer } from "node:http";
import { deflateSync } from "node:zlib";

const KEY = process.env.FAKE_WAHA_KEY || "sandbox-waha-key";
const sessions = new Map(); // name -> { status, me }
const sent = [];
let sendMode = "ok"; // ok | timeout | error500 | error422
let existsMode = "yes"; // yes | no
const known = new Set(); // números já consultados (o motor real só envia depois de resolver o número: senão 500 "no LID found")

function png() { // PNG 64x64 em tons de cinza com ruído (não comprime demais; só precisa ser um PNG válido)
  const w = 64, raw = Buffer.alloc((w + 1) * w);
  for (let y = 0; y < w; y++) { raw[y * (w + 1)] = 0; for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = (Math.random() * 255) | 0; }
  const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (b) => { let c = -1; for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(w, 4); ihdr[8] = 8; ihdr[9] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const view = (name, s) => ({ name, status: s.status, config: {}, me: s.me, presence: null, timestamps: { activity: null }, engine: { engine: "GOWS", grpc: { client: "READY", stream: "READY" }, gows: { found: true, connected: s.status !== "STOPPED" } } });
const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = chunks.length ? (() => { try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { return {}; } })() : {};
    if (url.pathname === "/ping") return json(res, 200, { message: "pong" });
    if (req.headers["x-api-key"] !== KEY) return json(res, 401, { message: "Unauthorized", statusCode: 401 });
    const p = url.pathname, m = req.method;
    let r;
    if (p === "/__test/connect" && m === "POST") { const s = sessions.get(body.name); if (s) { s.status = "WORKING"; s.me = { id: `${body.phone || "5592999990000"}@c.us`, pushName: "Teste" }; } return json(res, 200, { ok: !!s }); }
    if (p === "/__test/mode" && m === "POST") { sendMode = body.mode || sendMode; existsMode = body.exists || existsMode; return json(res, 200, { sendMode, existsMode }); }
    if (p === "/__test/sent" && m === "GET") return json(res, 200, sent);
    if (p === "/__test/reset" && m === "POST") { sessions.clear(); sent.length = 0; known.clear(); sendMode = "ok"; existsMode = "yes"; return json(res, 200, { ok: true }); }
    if (p === "/api/contacts/check-exists" && m === "GET") {
      const ph = url.searchParams.get("phone") || "";
      if (existsMode === "no") return json(res, 200, { numberExists: false });
      known.add(ph.slice(2, 4) + ph.slice(-8));
      return json(res, 200, { numberExists: true, chatId: `1601${ph.slice(-8)}@lid`, pn: `${ph}@c.us` });
    }
    if (p === "/api/sessions" && m === "GET") return json(res, 200, [...sessions].map(([n, s]) => view(n, s)));
    if (p === "/api/sessions" && m === "POST") {
      const s = { status: body.start === false ? "STOPPED" : "STARTING", me: null }; sessions.set(body.name, s);
      if (s.status === "STARTING") setTimeout(() => { if (s.status === "STARTING") s.status = "SCAN_QR_CODE"; }, 400);
      return json(res, 201, view(body.name, s));
    }
    if ((r = /^\/api\/sessions\/([^/]+)$/.exec(p)) && m === "GET") { const s = sessions.get(r[1]); return s ? json(res, 200, view(r[1], s)) : json(res, 404, { message: `Session '${r[1]}' does not exist`, statusCode: 404 }); }
    if ((r = /^\/api\/sessions\/([^/]+)\/(start|stop|logout)$/.exec(p)) && m === "POST") {
      const s = sessions.get(r[1]); if (!s) return json(res, 404, { statusCode: 404 });
      if (r[2] === "start") { s.status = "STARTING"; setTimeout(() => { if (s.status === "STARTING") s.status = "SCAN_QR_CODE"; }, 400); }
      else if (r[2] === "logout") { if (s.status !== "WORKING") return json(res, 422, { error: "not logged in" }); s.me = null; s.status = "SCAN_QR_CODE"; }
      else { s.status = "STOPPED"; s.me = null; }
      return json(res, 201, view(r[1], s));
    }
    if ((r = /^\/api\/([^/]+)\/auth\/qr$/.exec(p)) && m === "GET") {
      const s = sessions.get(r[1]);
      if (!s || s.status !== "SCAN_QR_CODE") return json(res, 422, { error: "Session status is not as expected. Try again later or restart the session", session: r[1], status: s?.status ?? "STOPPED", expected: ["SCAN_QR_CODE"] });
      res.writeHead(200, { "content-type": "image/png" }); return res.end(png());
    }
    if (p === "/api/sendText" && m === "POST") {
      const s = sessions.get(body.session);
      if (!s || s.status !== "WORKING") return json(res, 422, { error: "Session status is not as expected. Try again later or restart the session", session: body.session, status: s?.status ?? "STOPPED", expected: ["WORKING"] });
      if (!known.has(String(body.chatId).slice(2, 4) + String(body.chatId).split("@")[0].slice(-8))) return json(res, 500, { statusCode: 500, message: "2 UNKNOWN: no LID found" });
      if (sendMode === "timeout") return; // nunca responde: o cliente estoura o tempo
      if (sendMode === "error500") return json(res, 500, { statusCode: 500 });
      if (sendMode === "error422") return json(res, 422, { statusCode: 422 });
      sent.push({ session: body.session, chatId: body.chatId, textLen: String(body.text || "").length, text: body.text });
      return json(res, 201, { id: `true_${body.chatId}_${sent.length}`, timestamp: Math.floor(Date.now() / 1000), from: s.me?.id, to: body.chatId, body: body.text });
    }
    json(res, 404, { message: "not found", statusCode: 404 });
  });
}).listen(3000, "0.0.0.0");
