// Operação auditada (D3): grava a planilha de DESPESAS em STAGING (expense_import_rows), uma importação por empresa. NÃO cria conta a pagar, sócio, lançamento, fornecedor nem categoria.
// Sem OPS_CONFIRM=1 só mostra a prévia (contagens). Idempotente: o mesmo arquivo (hash) não entra duas vezes. Mesma permissão da tela (history.import = diretoria).
// A planilha tem a aba "Casa" (gasto pessoal dos sócios): só entra com autorização escrita do dono e fica visível só para a diretoria.
// OPS_REPLACE=1 (com OPS_CONFIRM=1): troca as importações anteriores da empresa pela nova, de forma atômica (staging, auditado).
// Uso: OPS_XLSX=/in/Despesas__2026.xlsx OPS_USER_EMAIL=... [OPS_COMPANY="K3G Solutions"] [OPS_YEAR=2026] [OPS_CONFIRM=1] docker compose --profile tools run --rm -e OPS_XLSX -e OPS_USER_EMAIL -e OPS_COMPANY -e OPS_YEAR -e OPS_CONFIRM -v /pasta:/in:ro tools pnpm tsx scripts/ops-import-expenses.ts
import { loadEnvConfig } from "@next/env";
import { readFileSync, statSync } from "node:fs";
loadEnvConfig(process.cwd());

(async () => {
  const file = process.env.OPS_XLSX, email = process.env.OPS_USER_EMAIL, year = Number(process.env.OPS_YEAR ?? new Date().getFullYear());
  const companyName = process.env.OPS_COMPANY ?? "K3G Solutions";
  if (!file || !email) throw new Error("Defina OPS_XLSX e OPS_USER_EMAIL");
  if (statSync(file).size > 10_000_000) throw new Error("arquivo maior que 10 MB: recusado");
  const { default: readXlsxFile } = await import("read-excel-file/node");
  const { db } = await import("../src/lib/db");
  const { companies, users } = await import("../src/lib/db/schema");
  const { eq, sql } = await import("drizzle-orm");
  const { readExpenseWorkbook } = await import("../src/modules/expenses/planilha");
  const { analyzeExpenses } = await import("../src/modules/expenses/report");
  const { importExpenses, sha256 } = await import("../src/modules/expenses/history");

  const [u] = await db.select().from(users).where(eq(sql`lower(${users.email})`, email.toLowerCase()));
  if (!u) throw new Error("Usuário não encontrado");
  const found = await db.select().from(companies).where(eq(companies.name, companyName));
  if (found.length !== 1) throw new Error(`Empresa "${companyName}": ${found.length === 0 ? "não encontrada" : "nome repetido, ambíguo"}`);
  const c = found[0];
  const sheets = (await readXlsxFile(file)).map((s) => ({ name: s.sheet, rows: s.data as never[][] }));
  if (sheets.length > 24 || sheets.some((s) => s.rows.length > 20_000 || s.rows.some((r) => r.length > 60))) throw new Error("mais de 24 abas, 20.000 linhas numa aba ou 60 colunas: recusado");
  const rows = readExpenseWorkbook(sheets, year);
  const hash = sha256(readFileSync(file));
  const rep = analyzeExpenses(rows);
  console.log(`arquivo ${hash.slice(0, 12)}… · abas lidas ${sheets.length} · linhas ${rows.length} (${Object.entries(rep.byBlock).map(([k, v]) => `${k} ${v}`).join(", ")}) · empresa ${companyName}`);
  if (process.env.OPS_CONFIRM !== "1") { console.log("(só prévia: nada foi gravado; use OPS_CONFIRM=1 — exige autorização escrita do dono)"); process.exit(0); }
  // OPS_REPLACE=1: a troca é ATÔMICA (mesma transação): se a nova importação falhar, a anterior continua; o mesmo arquivo (hash) não apaga nada
  const r = await importExpenses(db, u.id, c.id, { fileSha256: hash, fileLabel: "Despesas (planilha)", year, rows, replace: process.env.OPS_REPLACE === "1" });
  console.log(r.already ? `  já importado antes (importação ${r.importId}); nada mudou` : `  importado: ${r.rows} linhas`);
  process.exit(0);
})().catch((e) => { console.error("falha:", (e as Error).message); process.exit(1); });
