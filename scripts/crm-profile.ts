// Perfil AGREGADO do K3G CRM: só contagens e distribuições de campos de baixa cardinalidade. Nunca imprime nome, documento, e-mail ou token.
// Uso: docker compose --profile tools run --rm tools pnpm crm:profile
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());
import { parseDocument } from "../src/lib/validators/document";

const base = (process.env.CRM_BASE_URL ?? "").replace(/\/+$/, "");
const token = process.env.CRM_API_TOKEN ?? "";
if (!base.startsWith("https://") || !token) { console.error("CRM_BASE_URL (https) e CRM_API_TOKEN são obrigatórios."); process.exit(2); }

async function get(path: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${base}/${path}`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(20_000) });
  let body: any = null; try { body = await r.json(); } catch { /* não-JSON */ }
  return { status: r.status, body };
}
const dist = (vals: unknown[], max = 12) => {
  const m = new Map<string, number>(); for (const v of vals) { const k = String(v); m.set(k, (m.get(k) ?? 0) + 1); }
  if (m.size > max) return `${m.size} valores distintos (alta cardinalidade, omitido)`;
  return [...m].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k.length > 24 ? "(longo)" : k}=${n}`).join(", ");
};

(async () => {
  const { status, body } = await get("crm/companies");
  const list: any[] = body?.companies ?? [];
  console.log(`GET /crm/companies → HTTP ${status}; ${list.length} registros`);
  console.log("isActive:", dist(list.map((c) => c.isActive)));
  console.log("crmStatus:", dist(list.map((c) => c.crmStatus)));
  console.log("UF:", dist(list.map((c) => c.state)));
  console.log("segment:", dist(list.map((c) => c.segment)));
  console.log("companySize:", dist(list.map((c) => c.companySize)));

  const docs = list.map((c) => (typeof c.cnpj === "string" ? parseDocument(c.cnpj) : null));
  const present = list.filter((c) => typeof c.cnpj === "string" && c.cnpj.trim()).length;
  const valid = docs.filter(Boolean).length;
  const digits = docs.filter(Boolean).map((d) => d!.digits);
  console.log(`documento: com valor=${present}, válido=${valid}, inválido/ausente=${list.length - valid}, tipo=${dist(docs.filter(Boolean).map((d) => d!.type))}, duplicados no CRM=${digits.length - new Set(digits).size}`);
  const ids = list.map((c) => c.id);
  console.log(`ids: únicos=${new Set(ids).size}/${ids.length}`);

  const keys = ["contacts", "deals", "contracts", "invoices"];
  for (const k of keys) {
    const vals = list.map((c) => Number(c?._count?.[k] ?? 0));
    console.log(`_count.${k}: total=${vals.reduce((a, b) => a + b, 0)}, empresas com >0=${vals.filter((v) => v > 0).length}`);
  }
  console.log(`email preenchido: ${list.filter((c) => c.email).length}; telefone preenchido: ${list.filter((c) => c.phone).length}`);
  console.log(`razaoSocial ≠ name: ${list.filter((c) => c.razaoSocial && c.razaoSocial !== c.name).length}`);

  // contratos: testa variações sem imprimir conteúdo
  const withContracts = list.find((c) => Number(c?._count?.contracts ?? 0) > 0);
  const tries = ["crm/contracts", "crm/contracts?pageSize=100", ...(withContracts ? [`crm/contracts?companyId=${withContracts.id}`] : []), "crm/invoices", "crm/contacts?pageSize=100"];
  for (const t of tries) {
    const r = await get(t);
    const arr = r.body && typeof r.body === "object" ? Object.entries(r.body).find(([, v]) => Array.isArray(v)) : undefined;
    console.log(`GET /${t.replace(/companyId=[^&]+/, "companyId=<id>")} → HTTP ${r.status}; ${arr ? `${arr[0]}: ${(arr[1] as unknown[]).length} itens` : "sem lista"}`);
  }
})().catch((e) => { console.error("falha:", (e as Error).name); process.exit(1); });
