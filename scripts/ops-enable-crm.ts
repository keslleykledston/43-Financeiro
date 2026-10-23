// Operação auditada: coloca UMA empresa no modo CRM e ativa a conexão. NÃO sincroniza nada (a prévia/confirmação é da diretoria na tela).
// Uso: OPS_COMPANY="K3G Solutions" OPS_USER_EMAIL=... docker compose --profile tools run --rm -e OPS_COMPANY -e OPS_USER_EMAIL tools pnpm ops:enable-crm
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

(async () => {
  const company = process.env.OPS_COMPANY, email = process.env.OPS_USER_EMAIL;
  if (!company || !email) throw new Error("Defina OPS_COMPANY e OPS_USER_EMAIL");
  const { db } = await import("../src/lib/db");
  const { auditLog, companies, users } = await import("../src/lib/db/schema");
  const { eq, sql } = await import("drizzle-orm");
  const { readCustomerMode, setCustomerMode } = await import("../src/modules/crm/service");
  const { getConnection, saveConnection } = await import("../src/modules/integrations/crm/sync");

  const [c] = await db.select().from(companies).where(eq(companies.name, company));
  const [u] = await db.select().from(users).where(eq(sql`lower(${users.email})`, email.toLowerCase()));
  if (!c || !u) throw new Error("Empresa ou usuário não encontrado");

  const before = { mode: await readCustomerMode(db, c.id), enabled: (await getConnection(db, c.id))?.enabled ?? false };
  await setCustomerMode(db, u.id, c.id, "crm");        // exige integrations.manage + crm.write (diretoria): a regra de permissão vale também aqui
  await saveConnection(db, u.id, c.id, { enabled: true });
  await db.insert(auditLog).values({ companyId: c.id, actorId: u.id, action: "ops.crm_enabled_by_assistant", detail: { from: before, via: "assistente (Claude Code), a pedido do usuário" } });
  const after = { mode: await readCustomerMode(db, c.id), enabled: (await getConnection(db, c.id))?.enabled ?? false };
  console.log(`${company}: antes=${JSON.stringify(before)} depois=${JSON.stringify(after)}`);
  process.exit(0);
})().catch((e) => { console.error("falha:", (e as Error).message); process.exit(1); });
