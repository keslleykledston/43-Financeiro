// E10b-6 — prepara o CANÁRIO 0 de PRODUÇÃO na empresa FICTÍCIA ("K3G TESTE (fictícia)"): copia a credencial de PRODUÇÃO (re-cifrada para a empresa de teste),
// cancela os boletos ativos da Cora de TESTES das cobranças fictícias (para liberar a emissão) e deixa a empresa PAUSADA com limite diário 1.
// NÃO emite nada e NÃO arma a produção: armar (frase digitada) e processar (confirmação) continuam sendo atos da diretoria na tela.
// Uso: docker compose --profile tools run --rm tools pnpm tsx scripts/ops-cora-demo-prod.ts
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

const NAME = "K3G TESTE (fictícia)";
(async () => {
  const { db } = await import("../src/lib/db");
  const { and, eq, sql } = await import("drizzle-orm");
  const s = await import("../src/lib/db/schema");
  const { readCoraCredentials } = await import("../src/modules/providers/cora-secrets");
  const { saveCoraCredentials } = await import("../src/modules/providers/cora-config");
  const { cancelBoleto } = await import("../src/modules/issuance/cancel");
  const { getIssuanceSettings, saveIssuanceSettings } = await import("../src/modules/issuance/service");

  const [co] = await db.select().from(s.companies).where(eq(s.companies.name, NAME));
  if (!co) throw new Error("Empresa fictícia não encontrada");
  const [dir] = await db.select({ userId: s.memberships.userId }).from(s.memberships).where(and(eq(s.memberships.companyId, co.id), eq(s.memberships.role, "diretoria"), eq(s.memberships.status, "active")));
  const src = (await db.execute(sql`select company_id as id from provider_credentials where provider = 'cora' and environment = 'producao' and company_id <> ${co.id} limit 1`)) as unknown as { id: string }[];
  if (!dir || !src.length) throw new Error("Falta diretoria na empresa de teste ou credencial de produção na origem");

  const has = (await db.select({ id: s.providerCredentials.id }).from(s.providerCredentials).where(and(eq(s.providerCredentials.companyId, co.id), eq(s.providerCredentials.provider, "cora"), eq(s.providerCredentials.environment, "producao")))).length > 0;
  if (!has) {
    const c = (await readCoraCredentials(db, src[0].id, "producao"))!;
    await saveCoraCredentials(db, dir.userId, co.id, { environment: "producao", label: "Cora produção (cópia p/ canário 0)", clientId: c.clientId, certificate: c.certificate, privateKey: c.privateKey });
    console.log("1) credencial de PRODUÇÃO copiada (cifrada para a empresa de teste)");
  } else console.log("1) credencial de produção já existe");

  const active = (await db.execute(sql`select r.charge_id::text as id from issuance_requests r where r.company_id = ${co.id} and r.kind = 'boleto' and r.status = 'emitido' and r.mode = 'cora_homologacao'`)) as unknown as { id: string }[];
  for (const a of active) { const r = await cancelBoleto(db, dir.userId, co.id, { chargeId: a.id, reason: "preparo do canário de produção (boleto de teste)", confirm: true }); console.log("2) boleto de TESTES cancelado:", r.status); }

  const st = await getIssuanceSettings(db, dir.userId, co.id);
  await saveIssuanceSettings(db, dir.userId, co.id, { paused: true, dailyLimit: 1, boletoProvider: st.boletoProvider });
  const f = await getIssuanceSettings(db, dir.userId, co.id);
  console.log("3) configuração:", JSON.stringify({ provider: f.boletoProvider, paused: f.paused, dailyLimit: f.dailyLimit, canary: f.liveCanary, autorizadoProducao: !!f.liveAuthorizedAt }));
  process.exit(0);
})().catch((e) => { console.error("falha:", (e as Error).name, (e as Error).message); process.exit(1); });
