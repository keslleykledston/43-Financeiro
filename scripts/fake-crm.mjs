// CRM FALSO para o sandbox (nunca usar fora dele). Formato K3G: GET /crm/companies (tudo de uma vez). Formato canônico: GET /customers?cursor=&updated_since=
// Controle de teste: POST /__set {items?:[...], failStatus?:number, pageSize?:number}
import http from "node:http";
const TOKEN = process.env.FAKE_CRM_TOKEN ?? "sandbox-crm-token";
let state = { items: [], failStatus: 0, pageSize: 2 };

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const send = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.method === "GET" && url.pathname === "/health") return send(200, { ok: true });
  if (req.method === "POST" && url.pathname === "/__set") {
    let b = ""; req.on("data", (c) => (b += c));
    return req.on("end", () => { state = { ...state, ...JSON.parse(b || "{}") }; send(200, { ok: true, items: state.items.length }); });
  }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: "unauthorized" });
  if (url.pathname === "/crm/companies") { // imita o K3G CRM real: devolve TODAS as empresas e ignora paginação
    if (state.failStatus) return send(state.failStatus, { error: "falha simulada" });
    return send(200, { companies: state.items });
  }
  if (url.pathname === "/customers") { // formato canônico (referência)
    if (state.failStatus) return send(state.failStatus, { error: "falha simulada" });
    const start = Number(url.searchParams.get("cursor") ?? 0), next = start + state.pageSize;
    return send(200, { items: state.items.slice(start, next), nextCursor: next < state.items.length ? String(next) : undefined });
  }
  send(404, { error: "not found" });
}).listen(4000, () => console.log("fake crm :4000"));
