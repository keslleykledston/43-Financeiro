// Operação auditada (H1): grava a planilha de boletos em STAGING (legacy_billing_rows), uma importação por empresa. NÃO cria cobrança, pagamento, contrato nem cliente.
// Sem OPS_CONFIRM=1 só mostra a prévia (contagens). Idempotente: o mesmo arquivo (hash) não entra duas vezes. Usa a mesma permissão da tela (history.import = diretoria).
// OPS_REPLACE=1 (com OPS_CONFIRM=1): desfaz antes as importações anteriores da empresa (staging, auditado) e importa de novo.
// Uso: OPS_XLSX=/in/Boletos__2026.xlsx OPS_USER_EMAIL=... [OPS_YEAR=2026] [OPS_CONFIRM=1] docker compose --profile tools run --rm -e OPS_XLSX -e OPS_USER_EMAIL -e OPS_YEAR -e OPS_CONFIRM -v /pasta:/in:ro tools pnpm tsx scripts/ops-import-legacy.ts
import { loadEnvConfig } from "@next/env";
import { readFileSync, statSync } from "node:fs";
loadEnvConfig(process.cwd());

const COMPANY_OF_BLOCK = { solutions: "K3G Solutions", call: "K3G Call" } as const;

(async () => {
  const file = process.env.OPS_XLSX, email = process.env.OPS_USER_EMAIL, year = Number(process.env.OPS_YEAR ?? new Date().getFullYear());
  if (!file || !email) throw new Error("Defina OPS_XLSX e OPS_USER_EMAIL");
  if (statSync(file).size > 10_000_000) throw new Error("arquivo maior que 10 MB: recusado");
  const { default: readXlsxFile } = await import("read-excel-file/node");
  const { db } = await import("../src/lib/db");
  const { companies, users } = await import("../src/lib/db/schema");
  const { eq, sql } = await import("drizzle-orm");
  const { readWorkbook } = await import("../src/modules/contracts/planilha");
  const { importLegacy, removeLegacyImport, sha256 } = await import("../src/modules/history/service");
  const { legacyImports } = await import("../src/lib/db/schema");

  const [u] = await db.select().from(users).where(eq(sql`lower(${users.email})`, email.toLowerCase()));
  if (!u) throw new Error("Usuário não encontrado");
  const sheets = (await readXlsxFile(file)).map((s) => ({ name: s.sheet, rows: s.data as never[][] }));
  if (sheets.length > 24 || sheets.some((s) => s.rows.length > 20_000)) throw new Error("mais de 24 abas ou 20.000 linhas numa aba: recusado");
  const entries = readWorkbook(sheets, year);
  const hash = sha256(readFileSync(file));
  console.log(`arquivo ${hash.slice(0, 12)}… · abas lidas ${sheets.length} · linhas de cobrança ${entries.length}`);
  for (const block of ["solutions", "call"] as const) {
    const mine = entries.filter((e) => e.block === block);
    const [c] = await db.select().from(companies).where(eq(companies.name, COMPANY_OF_BLOCK[block]));
    if (!c) { console.log(`${COMPANY_OF_BLOCK[block]}: empresa não encontrada (pulada)`); continue; }
    console.log(`${COMPANY_OF_BLOCK[block]}: ${mine.length} linhas`);
    if (process.env.OPS_CONFIRM !== "1") continue;
    if (process.env.OPS_REPLACE === "1") for (const old of await db.select({ id: legacyImports.id }).from(legacyImports).where(eq(legacyImports.companyId, c.id))) { await removeLegacyImport(db, u.id, c.id, old.id); console.log(`  importação anterior desfeita (${old.id.slice(0, 8)}…)`); }
    const r = await importLegacy(db, u.id, c.id, { fileSha256: hash, fileLabel: "Boletos (planilha)", year, entries: mine });
    console.log(r.already ? `  já importado antes (importação ${r.importId}); nada mudou` : `  importado: ${r.rows} linhas · ligadas a clientes existentes: ${r.linked}`);
  }
  if (process.env.OPS_CONFIRM !== "1") console.log("(só prévia: nada foi gravado; use OPS_CONFIRM=1)");
  process.exit(0);
})().catch((e) => { console.error("falha:", (e as Error).message); process.exit(1); });
