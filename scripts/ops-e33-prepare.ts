// E33 — prepara o CANÁRIO DE E-MAIL com boleto na empresa FICTÍCIA: volta para a Cora de TESTES (boleto de teste, não real), emite os 3 boletos de teste,
// cria os modelos padrão (com o boleto) e agenda a régua. NÃO envia e-mail e NÃO cadastra destinatários (isso depende dos endereços autorizados pela diretoria).
// Uso: docker compose --profile tools run --rm tools pnpm tsx scripts/ops-e33-prepare.ts
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());
(async () => {
  const { db } = await import("../src/lib/db");
  const { and, eq, sql } = await import("drizzle-orm");
  const s = await import("../src/lib/db/schema");
  const { getIssuanceSettings, processIssuance, requestBatchIssuance, saveIssuanceSettings } = await import("../src/modules/issuance/service");
  const { ensureDefaultTemplates, scheduleQueue } = await import("../src/modules/messaging/service");
  const [co] = await db.select().from(s.companies).where(eq(s.companies.name, "K3G TESTE (fictícia)"));
  const [dir] = await db.select({ userId: s.memberships.userId }).from(s.memberships).where(and(eq(s.memberships.companyId, co.id), eq(s.memberships.role, "diretoria")));
  const st = await getIssuanceSettings(db, dir.userId, co.id);
  console.log("antes:", JSON.stringify({ provider: st.boletoProvider, paused: st.paused }));
  await saveIssuanceSettings(db, dir.userId, co.id, { paused: false, dailyLimit: 10, boletoProvider: "cora_homologacao" });
  const [b] = await db.select({ id: s.billingBatches.id }).from(s.billingBatches).where(and(eq(s.billingBatches.companyId, co.id), eq(s.billingBatches.status, "aprovado")));
  console.log("solicitar:", JSON.stringify(await requestBatchIssuance(db, dir.userId, co.id, b.id, "boleto")));
  console.log("processar (Cora de TESTES):", JSON.stringify(await processIssuance(db, dir.userId, co.id)));
  await saveIssuanceSettings(db, dir.userId, co.id, { paused: true, dailyLimit: 10 });
  await ensureDefaultTemplates(db, dir.userId, co.id);
  console.log("régua:", JSON.stringify(await scheduleQueue(db, dir.userId, co.id)));
  const q = (await db.execute(sql`select kind, channel, status, scheduled_for::text as d, count(*)::int as n from message_queue where company_id = ${co.id} group by 1,2,3,4 order by 4,1,2`)) as unknown as Record<string, unknown>[];
  console.log("fila:", JSON.stringify(q));
  process.exit(0);
})().catch((e) => { console.error("falha:", (e as Error).name, (e as Error).message); process.exit(1); });
