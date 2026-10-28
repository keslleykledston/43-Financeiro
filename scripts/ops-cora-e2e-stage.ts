// E10b-1 — teste PONTA A PONTA do motor de emissão contra a Cora de TESTES (stage), com dados 100% FICTÍCIOS e um banco DESCARTÁVEL (k3g_cora_e2e, apagado no fim).
// Nunca toca nos dados reais nem na produção da Cora. Usa a credencial de homologação do banco real apenas para copiá-la (re-cifrada) ao banco descartável.
// Uso: docker compose --profile tools run --rm tools pnpm tsx scripts/ops-cora-e2e-stage.ts
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());
import postgres from "postgres";

const DB = "k3g_cora_e2e";
const ok = (c: boolean, m: string) => { console.log(`${c ? "  OK " : "  FALHA"} ${m}`); if (!c) process.exitCode = 1; };

(async () => {
  const { databaseUrl } = await import("../src/lib/db/url");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  const { eq, sql } = await import("drizzle-orm");
  const schema = await import("../src/lib/db/schema");
  const { db: prodDb } = await import("../src/lib/db");
  const { readCoraCredentials } = await import("../src/modules/providers/cora-secrets");
  const { saveCoraCredentials } = await import("../src/modules/providers/cora-config");
  const { createParty } = await import("../src/modules/crm/service");
  const { createContract, decideVersion, getContract } = await import("../src/modules/contracts/service");
  const { approveBatch, generateBatch, getBatch } = await import("../src/modules/billing/batches");
  const { listIssuance, processIssuance, requestBatchIssuance, saveIssuanceSettings } = await import("../src/modules/issuance/service");
  const { cancelBoleto } = await import("../src/modules/issuance/cancel");
  const { coraClientFor } = await import("../src/modules/providers/cora-http");

  // credencial de testes (do banco real) → memória
  const src = (await prodDb.execute(sql`select company_id as id from provider_credentials where provider = 'cora' and environment = 'homologacao' limit 1`)) as unknown as { id: string }[];
  if (!src.length) throw new Error("Sem credencial Cora de homologação no banco real");
  const creds = (await readCoraCredentials(prodDb, src[0].id, "homologacao"))!;

  const base = databaseUrl();
  const admin = postgres(base.replace(/\/[^/]+$/, "/postgres"), { max: 1 });
  await admin.unsafe(`drop database if exists ${DB}`); await admin.unsafe(`create database ${DB}`);
  const conn = postgres(base.replace(/\/[^/]+$/, `/${DB}`), { max: 4 });
  const db = drizzle(conn, { schema }) as unknown as import("../src/lib/db").DB;
  try {
    await migrate(db as never, { migrationsFolder: "./drizzle" });
    const [co] = await db.insert(schema.companies).values({ name: "Empresa Fictícia E2E" }).returning();
    const mk = async (e: string) => (await db.insert(schema.users).values({ email: e, name: e, passwordHash: "x" }).returning())[0].id;
    const dir = await mk("dir@e2e.invalid"), ger = await mk("ger@e2e.invalid"), asst = await mk("asst@e2e.invalid");
    await db.insert(schema.memberships).values([{ userId: dir, companyId: co.id, role: "diretoria" }, { userId: ger, companyId: co.id, role: "gerente" }, { userId: asst, companyId: co.id, role: "assistente" }]);
    process.env.K3G_CREDENTIALS_KEY ??= process.env.AUTH_SECRET;
    await saveCoraCredentials(db, dir, co.id, { environment: "homologacao", label: "e2e", clientId: creds.clientId, certificate: creds.certificate, privateKey: creds.privateKey });

    const c1 = await createParty(db, dir, co.id, { kind: "cliente", legalName: "CLIENTE FICTICIO UM LTDA", document: "11.222.333/0001-81" });
    const c2 = await createParty(db, dir, co.id, { kind: "cliente", legalName: "CLIENTE FICTICIO DOIS LTDA", document: "12.ABC.345/01DE-35" }); // CNPJ alfanumérico
    for (const [cust, val] of [[c1.id, "50,00"], [c2.id, "73,45"]] as const) {
      const c = await createContract(db, asst, co.id, cust, { description: "Teste E2E homologacao", monthlyAmount: val, startAt: "2026-01-01", endAt: "", dueDay: "12", invoiceJointRequired: false, issueDayOverride: "" });
      await decideVersion(db, dir, co.id, (await getContract(db, dir, co.id, c.id))!.versions[0].id, "aprovar");
    }
    const { batchId } = await generateBatch(db, asst, co.id, "2026-10-25"); // vencimento 12/11/2026
    await approveBatch(db, dir, co.id, batchId, (await getBatch(db, asst, co.id, batchId))!.hash);
    console.log("1) dados fictícios prontos (2 cobranças, vencimento 2026-11-12)");

    process.env.CORA_STAGE_ENABLED = "true";
    await saveIssuanceSettings(db, dir, co.id, { paused: false, dailyLimit: 20, boletoProvider: "cora_homologacao" });
    await requestBatchIssuance(db, ger, co.id, batchId, "boleto");
    const now = new Date(Date.now() + 5 * 60_000);
    const r1 = await processIssuance(db, ger, co.id, now);
    console.log("2) rodada de emissão (Cora de testes de verdade):", JSON.stringify(r1));
    ok(r1.issued === 2 && r1.failed === 0, "2 boletos emitidos, 0 falhas");
    const rows = await db.select().from(schema.issuanceRequests);
    ok(rows.every((r) => r.mode === "cora_homologacao" && r.status === "emitido" && /^inv_/.test(r.externalRef ?? "")), "linhas em modo cora_homologacao, emitidas, com id inv_…");
    rows.forEach((r) => console.log(`     ${r.idempotencyKey.slice(0, 20)}… → ${r.externalRef} (${r.externalStatus}) ${r.lastError ?? ""}`));

    const cli = await coraClientFor(db, co.id, "homologacao");
    const charges = await db.select().from(schema.charges);
    for (const r of rows) {
      const inv = await cli.getInvoice(r.externalRef!);
      const ch = charges.find((c) => c.id === r.chargeId)!;
      ok(inv.status === "OPEN" && inv.totalAmountCents === Math.round(Number(ch.amount) * 100) && inv.dueDate === "2026-11-12" && inv.code === `k3g:${r.idempotencyKey}`, `Cora confirma ${r.externalRef}: OPEN, R$ ${(inv.totalAmountCents / 100).toFixed(2)}, venc ${inv.dueDate}, code ${inv.code?.slice(0, 16)}…`);
      ok(!!inv.digitable && !!inv.pdfUrl, "linha digitável e PDF presentes");
    }

    // resposta perdida: volta uma linha para 'desconhecido' (como se a resposta tivesse se perdido) → deve ACHAR na Cora (lista + code), sem criar outro
    const before = (await cli.listInvoices({ perPage: 200 })).totalItems;
    const target = rows[0];
    await db.execute(sql`update issuance_requests set status = 'desconhecido', next_attempt_at = now() where id = ${target.id}`);
    const r2 = await processIssuance(db, ger, co.id, new Date(Date.now() + 10 * 60_000));
    const after = (await cli.listInvoices({ perPage: 200 })).totalItems;
    const t2 = (await db.select().from(schema.issuanceRequests).where(eq(schema.issuanceRequests.id, target.id)))[0];
    console.log("3) reconsulta após 'resposta perdida':", JSON.stringify(r2));
    ok(t2.status === "emitido" && t2.externalRef === target.externalRef, "reconsulta ACHOU o mesmo boleto na Cora (busca por documento + vencimento + code)");
    ok(before === after, `nenhum boleto novo criado na Cora (${before} → ${after})`);

    // cancelamento real no stage
    const ch0 = charges.find((c) => c.id === target.chargeId)!;
    const c = await cancelBoleto(db, dir, co.id, { chargeId: ch0.id, reason: "teste e2e homologacao", confirm: true });
    const gone = await cli.getInvoice(target.externalRef!);
    console.log("4) cancelamento:", JSON.stringify(c));
    ok(c.status === "cancelado" && gone.status === "CANCELLED", "boleto CANCELADO na Cora de testes (DELETE)");

    // nova emissão da mesma cobrança → chave g1 → outro boleto
    await requestBatchIssuance(db, ger, co.id, batchId, "boleto");
    const r3 = await processIssuance(db, ger, co.id, new Date(Date.now() + 15 * 60_000));
    const again = (await db.select().from(schema.issuanceRequests).where(eq(schema.issuanceRequests.chargeId, ch0.id))).find((r) => r.status === "emitido")!;
    console.log("5) reemissão após cancelar:", JSON.stringify(r3));
    ok(again.idempotencyKey.endsWith(":g1") && again.externalRef !== target.externalRef, `novo boleto ${again.externalRef} (chave g1)`);
    const l = await listIssuance(db, dir, co.id);
    console.log(`6) painel: ${l.items.length} solicitações; modos: ${[...new Set(l.items.map((i) => i.mode))].join(",")}`);

    // limpeza na Cora de testes: cancela o que sobrou (ambiente de testes; evita acumular)
    for (const r of await db.select().from(schema.issuanceRequests)) if (r.status === "emitido" && r.externalRef) { try { await cli.cancelInvoice(r.externalRef); } catch { /* já cancelado */ } }
    console.log(process.exitCode ? "\nRESULTADO: FALHOU" : "\nRESULTADO: PASSOU (tudo contra a Cora de TESTES; nada real)");
  } finally {
    await conn.end(); await admin.unsafe(`drop database if exists ${DB}`); await admin.end();
  }
  process.exit(process.exitCode ?? 0);
})().catch((e) => { console.error("falha:", (e as Error).name, (e as Error).message); process.exit(1); });
