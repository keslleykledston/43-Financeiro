// Operação auditada (D3b): aplica o histórico de despesas já importado em staging ao sistema (contas a pagar pagas/em aberto, retiradas da Casa no sócio Keslley)
// e, com OPS_RECURRING=1, cria modelos recorrentes e parcelamentos ativos a partir do que a planilha ainda mostra nos últimos meses.
// Sem OPS_CONFIRM=1 só mostra a PRÉVIA. Exige AUTORIZAÇÃO ESCRITA do dono e backup feito antes (bash scripts/backup.sh). Idempotente: cada linha é aplicada uma vez.
// Uso: OPS_USER_EMAIL=... [OPS_COMPANY="K3G Solutions"] [OPS_CONFIRM=1] [OPS_RECURRING=1] docker compose --profile tools run --rm -e OPS_USER_EMAIL -e OPS_COMPANY -e OPS_CONFIRM -e OPS_RECURRING tools pnpm tsx scripts/ops-apply-expenses.ts
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

(async () => {
  const email = process.env.OPS_USER_EMAIL, companyName = process.env.OPS_COMPANY ?? "K3G Solutions";
  if (!email) throw new Error("Defina OPS_USER_EMAIL");
  const { db } = await import("../src/lib/db");
  const { companies, users } = await import("../src/lib/db/schema");
  const { eq, sql } = await import("drizzle-orm");
  const { applyExpenseHistory, previewExpenseApplication, proposeRecurring, SKIP_LABEL } = await import("../src/modules/expenses/apply");
  const [u] = await db.select().from(users).where(eq(sql`lower(${users.email})`, email.toLowerCase()));
  if (!u) throw new Error("Usuário não encontrado");
  const found = await db.select().from(companies).where(eq(companies.name, companyName));
  if (found.length !== 1) throw new Error(`Empresa "${companyName}": ${found.length === 0 ? "não encontrada" : "nome repetido, ambíguo"}`);
  const c = found[0];
  const money = (v: number) => (v / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const show = (s: Awaited<ReturnType<typeof previewExpenseApplication>>) => {
    console.log(`  contas pagas:      ${s.paid.n} · ${money(s.paid.cents)}`);
    console.log(`  contas em aberto:  ${s.open.n} · ${money(s.open.cents)}`);
    console.log(`  retiradas (Casa):  ${s.withdrawals.n} · ${money(s.withdrawals.cents)}`);
    for (const [k, v] of Object.entries(s.skipped)) if (v.n) console.log(`  fora: ${SKIP_LABEL[k as keyof typeof SKIP_LABEL]}: ${v.n} · ${money(v.cents)}`);
    console.log(`  (parecem ser da K3G Call, ficam na ${companyName}: ${s.callHint.n} · ${money(s.callHint.cents)})`);
  };
  const prev = await previewExpenseApplication(db, u.id, c.id);
  console.log(`empresa ${companyName} · linhas já aplicadas antes: ${prev.alreadyApplied}`);
  show(prev);
  if (process.env.OPS_CONFIRM !== "1") { console.log("(só prévia: nada foi gravado; use OPS_CONFIRM=1 — exige autorização escrita do dono e backup)"); process.exit(0); }
  const r = await applyExpenseHistory(db, u.id, c.id);
  console.log(`aplicado: ${r.applied} linhas`);
  if (process.env.OPS_RECURRING === "1") {
    const rc = await proposeRecurring(db, u.id, c.id);
    console.log(`recorrentes criados: ${rc.templates} · parcelamentos criados: ${rc.series} (sem restar ≥ 2 parcelas, ignorados: ${rc.skippedSeries})`);
  }
  process.exit(0);
})().catch((e) => { console.error("falha:", (e as Error).message); process.exit(1); });
