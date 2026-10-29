// E33 — canário de e-mail na empresa FICTÍCIA: cadastra como contato financeiro dos 3 clientes fictícios SÓ os endereços autorizados pela diretoria (lista da autorização ativa),
// reagenda a régua (desbloqueia) e deixa UM e-mail ("lembrete 3 dias antes" do cliente UM) com data de HOJE. Não envia nada.
// Uso: docker compose --profile tools run --rm tools pnpm tsx scripts/ops-e33-contacts.ts
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());
(async () => {
  const { db } = await import("../src/lib/db");
  const { and, eq, sql } = await import("drizzle-orm");
  const s = await import("../src/lib/db/schema");
  const { scheduleQueue, todayManaus } = await import("../src/modules/messaging/service");
  const [co] = await db.select().from(s.companies).where(eq(s.companies.name, "K3G TESTE (fictícia)"));
  const [dir] = await db.select({ userId: s.memberships.userId }).from(s.memberships).where(and(eq(s.memberships.companyId, co.id), eq(s.memberships.role, "diretoria")));
  const [auth] = await db.select().from(s.emailLiveAuthorizations).where(and(eq(s.emailLiveAuthorizations.companyId, co.id), eq(s.emailLiveAuthorizations.active, true)));
  const addrs = (auth.allowed as string[]).filter((a) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a)); // só endereços exatos (domínio inteiro não vira contato)
  console.log("endereços autorizados:", addrs.length);
  const custs = await db.select({ id: s.customers.id, name: s.customers.legalName }).from(s.customers).where(eq(s.customers.companyId, co.id));
  for (const c of custs) for (const a of addrs) {
    const has = (await db.select({ id: s.customerContacts.id }).from(s.customerContacts).where(and(eq(s.customerContacts.companyId, co.id), eq(s.customerContacts.partyId, c.id), eq(s.customerContacts.email, a)))).length > 0;
    if (!has) await db.insert(s.customerContacts).values({ companyId: co.id, partyId: c.id, name: "Contato de teste (canário)", email: a, isFinancial: true });
  }
  console.log("régua:", JSON.stringify(await scheduleQueue(db, dir.userId, co.id)));
  const today = todayManaus();
  const r = (await db.execute(sql`update message_queue q set scheduled_for = ${today}::date, updated_at = now() from charges ch, customers cu where q.company_id = ${co.id} and q.channel = 'email' and q.kind = 'd_menos_3' and q.status = 'pendente' and ch.id = q.charge_id and ch.company_id = q.company_id and cu.id = ch.customer_id and cu.legal_name like '%CLIENTE UM%' returning q.id`)) as unknown as unknown[];
  console.log("e-mail agendado para hoje:", r.length);
  const q = (await db.execute(sql`select kind, status, scheduled_for::text as d, count(*)::int n from message_queue where company_id = ${co.id} and channel = 'email' group by 1,2,3 order by 3,1`)) as unknown as Record<string, unknown>[];
  console.log("fila de e-mail:", JSON.stringify(q));
  process.exit(0);
})().catch((e) => { console.error("falha:", (e as Error).name, (e as Error).message); process.exit(1); });
