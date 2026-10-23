// Descoberta SOMENTE de estrutura do K3G CRM: imprime nomes de campos e TIPOS, nunca valores (sem PII, sem token).
// Uso: docker compose --profile tools run --rm tools pnpm crm:discover
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

const base = (process.env.CRM_BASE_URL ?? "").replace(/\/+$/, "");
const token = process.env.CRM_API_TOKEN ?? "";
if (!base || !token) { console.error("CRM_BASE_URL e CRM_API_TOKEN não estão definidos neste ambiente."); process.exit(2); }
if (!base.startsWith("https://")) { console.error("A URL do CRM deve ser https."); process.exit(2); }

const NUM_OK = new Set(["page", "pageSize", "total", "totalPages", "hasMore", "limit", "offset", "count"]); // contadores de paginação: não são dado pessoal

function shape(v: unknown, key = "", depth = 0): unknown {
  if (v === null) return "null";
  if (Array.isArray(v)) return depth > 5 ? "[…]" : `[${v.length} item(ns)] ${v.length ? JSON.stringify(shape(v[0], key, depth + 1)) : ""}`.trim();
  if (typeof v === "object") {
    if (depth > 5) return "{…}";
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, shape(x, k, depth + 1)]));
  }
  if (typeof v === "number" || typeof v === "boolean") return NUM_OK.has(key) ? `${typeof v}=${v}` : typeof v;
  if (typeof v === "string") {
    const hint = /^\d{4}-\d{2}-\d{2}T/.test(v) ? "ISO-datetime" : /^\d{4}-\d{2}-\d{2}$/.test(v) ? "ISO-date" : /@/.test(v) ? "email-like" : /^[0-9.\-\/]{11,18}$/.test(v) ? "doc-like" : /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(v) ? "uuid" : "";
    return `string(len=${v.length}${hint ? "," + hint : ""})`;
  }
  return typeof v;
}

const paths = (process.argv[2] ? process.argv.slice(2) : ["crm/companies", "crm/contacts", "crm/contracts", "companies"]);
(async () => {
  for (const p of paths) {
    const url = `${base}/${p.replace(/^\/+/, "")}${p.includes("?") ? "" : "?page=1&pageSize=1"}`;
    try {
      const r = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(15_000) });
      const ct = r.headers.get("content-type") ?? "";
      console.log(`\n=== GET /${p}  →  HTTP ${r.status}  (${ct.split(";")[0]})`);
      const text = await r.text();
      if (text.length > 3_000_000) { console.log("(resposta grande demais, ignorada)"); continue; }
      if (!ct.includes("json")) { console.log(`(corpo não-JSON, ${text.length} bytes)`); continue; }
      const body = JSON.parse(text);
      if (r.status >= 400) {
        const m = typeof body?.message === "string" ? body.message : typeof body?.error === "string" ? body.error : "";
        console.log(`erro: ${m.slice(0, 160)}${r.status === 403 ? "  [dica: o token pode ter IP allowlist — libere o IP deste servidor no CRM]" : ""}`);
        continue;
      }
      console.log(JSON.stringify(shape(body), null, 2));
    } catch (e) { console.log(`\n=== GET /${p}  →  falha: ${(e as Error).name}`); }
  }
})();
