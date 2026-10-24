// Operação auditada: importa o CSV de contratos (gerado por planilha-para-csv) para UMA empresa, como RASCUNHO. Mesmas regras e permissões da tela
// "Contratos → Importar". Sem OPS_CONFIRM=1 só mostra a prévia (contagens). Linhas não importadas vão para um arquivo privado (0600), nunca para o log.
// Uso: OPS_COMPANY="K3G Call" OPS_USER_EMAIL=... OPS_CSV=/in/contratos-call.csv OPS_PENDING=/out/pendentes-call.csv [OPS_CONFIRM=1] docker compose --profile tools run --rm -e ... -v ... tools pnpm tsx scripts/ops-import-contracts.ts
import { loadEnvConfig } from "@next/env";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
loadEnvConfig(process.cwd());

(async () => {
  const company = process.env.OPS_COMPANY, email = process.env.OPS_USER_EMAIL, csv = process.env.OPS_CSV, pending = process.env.OPS_PENDING;
  if (!company || !email || !csv) throw new Error("Defina OPS_COMPANY, OPS_USER_EMAIL e OPS_CSV");
  const { db } = await import("../src/lib/db");
  const { auditLog, companies, users } = await import("../src/lib/db/schema");
  const { eq, sql } = await import("drizzle-orm");
  const { importContracts, previewContractImport } = await import("../src/modules/contracts/import");
  const { toCsv } = await import("../src/lib/csv");

  const [c] = await db.select().from(companies).where(eq(companies.name, company));
  const [u] = await db.select().from(users).where(eq(sql`lower(${users.email})`, email.toLowerCase()));
  if (!c || !u) throw new Error("Empresa ou usuário não encontrado");
  const text = readFileSync(csv, "utf8").replace(/^﻿/, "");

  const { rows, summary } = await previewContractImport(db, u.id, c.id, text);
  console.log(`${company}: prévia ${JSON.stringify(summary)} · avisos de cliente não ativo: ${rows.filter((r) => r.warning).length}`);
  if (pending) {
    const out = rows.filter((r) => r.status !== "ok" && r.status !== "novo_cliente");
    writeFileSync(pending, toCsv([["linha", "situacao", "razao_social", "documento", "motivo"], ...out.map((r) => [String(r.line), r.status, r.name, r.document ?? "", r.message ?? ""])]), { mode: 0o600 });
    chmodSync(pending, 0o600);
    console.log(`pendências gravadas em arquivo privado: ${out.length}`);
  }
  if (process.env.OPS_CONFIRM !== "1") { console.log("(só prévia: nada foi gravado; use OPS_CONFIRM=1 para importar)"); process.exit(0); }

  const r = await importContracts(db, u.id, c.id, text);
  await db.insert(auditLog).values({ companyId: c.id, actorId: u.id, action: "ops.contracts_imported_by_assistant", detail: { importId: r.importId, contracts: r.contracts, customersCreated: r.customersCreated, via: "assistente (Claude Code), com autorização escrita do usuário" } });
  console.log(`importado: lote ${r.importId} · contratos em rascunho ${r.contracts} · clientes locais criados ${r.customersCreated} · não importados ${r.skipped}`);
  process.exit(0);
})().catch((e) => { console.error("falha:", (e as Error).message); process.exit(1); });
