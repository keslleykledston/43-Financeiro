// E10b-5 — operação dos AVISOS (webhook) da Cora de TESTES para uma empresa, pelo nome. Não movimenta dinheiro.
// Uso: OPS_COMPANY="K3G TESTE (fictícia)" OPS_ACTION=enable|disable|status [OPS_ENV=homologacao|producao] docker compose --profile tools run --rm -e OPS_COMPANY -e OPS_ACTION -e OPS_ENV tools pnpm tsx scripts/ops-cora-webhook.ts
// Em PRODUÇÃO exige a chave do servidor e a empresa armada (as mesmas travas da tela).
// `enable` usa a diretoria da empresa como autora (auditado) e o endereço público AUTH_URL.
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

(async () => {
  const name = process.env.OPS_COMPANY, action = process.env.OPS_ACTION, env = process.env.OPS_ENV ?? "homologacao";
  if (!name || !["enable", "disable", "status"].includes(action ?? "")) throw new Error("Defina OPS_COMPANY e OPS_ACTION (enable|disable|status)");
  const { db } = await import("../src/lib/db");
  const { and, eq } = await import("drizzle-orm");
  const s = await import("../src/lib/db/schema");
  const { enableCoraWebhook, disableCoraWebhook, webhookStatus } = await import("../src/modules/issuance/webhooks");
  const [co] = await db.select().from(s.companies).where(eq(s.companies.name, name));
  if (!co) throw new Error("Empresa não encontrada");
  const [dir] = await db.select({ userId: s.memberships.userId }).from(s.memberships).where(and(eq(s.memberships.companyId, co.id), eq(s.memberships.role, "diretoria"), eq(s.memberships.status, "active")));
  if (!dir) throw new Error("A empresa não tem diretoria ativa");
  if (action === "enable") console.log("enable:", JSON.stringify(await enableCoraWebhook(db, dir.userId, co.id, env, process.env.AUTH_URL ?? "")));
  if (action === "disable") console.log("disable:", JSON.stringify(await disableCoraWebhook(db, dir.userId, co.id, env)));
  console.log("status:", JSON.stringify(await webhookStatus(db, dir.userId, co.id)));
  process.exit(0);
})().catch((e) => { console.error("falha:", (e as Error).name, (e as Error).message); process.exit(1); });
