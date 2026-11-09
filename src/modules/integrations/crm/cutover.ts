import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { auditLog, companies, crmOutbox, customers, integrationConflicts, integrationConnections, integrationSyncRuns } from "@/lib/db/schema";
import { lockModeExclusive, readCustomerMode } from "@/modules/crm/service";
import { Invalid, requirePerm } from "@/modules/identity/service";
import { enqueueCrmPush } from "./outbox";
import { writebackConfig } from "./writeback";

/**
 * Corte do CRM (ADR-043): a empresa deixa de LER clientes do CRM e passa a ser a fonte da verdade; situação e clientes novos vão ao CRM pela caixa de saída.
 * Fazer o corte exige a diretoria (gerir integrações + gravar clientes), a frase «CORTE» e um sincronismo recente (ou a confirmação de que mudanças feitas no CRM depois dele serão perdidas).
 */
export const CUTOVER_PHRASE = "CORTE";
export const FRESH_SYNC_MS = 24 * 3_600_000;

export async function cutoverView(db: DB, actorId: string, companyId: string, env: NodeJS.ProcessEnv = process.env) {
  await requirePerm(db, actorId, companyId, "crm.read");
  const [co] = await db.select({ at: companies.crmCutoverAt, mode: companies.customerMode }).from(companies).where(eq(companies.id, companyId));
  const [run] = await db.select({ at: integrationSyncRuns.createdAt }).from(integrationSyncRuns)
    .where(and(eq(integrationSyncRuns.companyId, companyId), eq(integrationSyncRuns.kind, "crm"), eq(integrationSyncRuns.status, "applied"))).orderBy(desc(integrationSyncRuns.createdAt)).limit(1);
  const [conf] = await db.select({ n: count() }).from(integrationConflicts).where(and(eq(integrationConflicts.companyId, companyId), eq(integrationConflicts.status, "open")));
  const [cust] = await db.select({
    linked: sql<number>`count(*) filter (where ${customers.externalId} is not null)::int`,
    unlinked: sql<number>`count(*) filter (where ${customers.externalId} is null)::int`,
  }).from(customers).where(and(eq(customers.companyId, companyId), isNull(customers.archivedAt)));
  const ob = await db.select({ state: crmOutbox.state, n: count() }).from(crmOutbox).where(eq(crmOutbox.companyId, companyId)).groupBy(crmOutbox.state);
  const by = Object.fromEntries(ob.map((r) => [r.state, r.n])) as Record<string, number>;
  const open = await db.select({ id: crmOutbox.id, customerId: crmOutbox.customerId, kind: crmOutbox.kind, state: crmOutbox.state, desiredStatus: crmOutbox.desiredStatus, attempts: crmOutbox.attempts, lastError: crmOutbox.lastError, name: customers.displayName, updatedAt: crmOutbox.updatedAt })
    .from(crmOutbox).innerJoin(customers, and(eq(customers.companyId, crmOutbox.companyId), eq(customers.id, crmOutbox.customerId)))
    .where(and(eq(crmOutbox.companyId, companyId), sql`${crmOutbox.state} in ('pendente', 'falhou')`)).orderBy(desc(crmOutbox.updatedAt)).limit(30);
  return {
    done: !!co?.at, at: co?.at ?? null, mode: co?.mode === "crm" ? "crm" as const : "local" as const,
    lastSyncAt: run?.at ?? null, openConflicts: conf?.n ?? 0, linked: cust?.linked ?? 0, unlinked: cust?.unlinked ?? 0,
    writeback: writebackConfig(env), outbox: { pendente: by.pendente ?? 0, falhou: by.falhou ?? 0, enviado: by.enviado ?? 0 }, open,
  };
}

export async function performCutover(db: DB, actorId: string, companyId: string, input: { phrase: string; acceptStale: boolean }, now = new Date()) {
  await requirePerm(db, actorId, companyId, "integrations.manage");
  await requirePerm(db, actorId, companyId, "crm.write");
  if (input.phrase.trim() !== CUTOVER_PHRASE) throw new Invalid(`Digite ${CUTOVER_PHRASE} para confirmar o corte`);
  return db.transaction(async (tx) => {
    const t = tx as unknown as DB;
    await lockModeExclusive(t, companyId); // espera sincronização/edições em curso; novas esperam o corte
    const [co] = await t.select({ at: companies.crmCutoverAt }).from(companies).where(eq(companies.id, companyId)).for("update");
    if (!co) throw new Invalid("Empresa não encontrada");
    if (co.at) throw new Invalid("O corte já foi feito nesta empresa");
    if ((await readCustomerMode(t, companyId)) !== "crm") throw new Invalid("Esta empresa não lê clientes do CRM: não há o que cortar");
    const [conf] = await t.select({ n: count() }).from(integrationConflicts).where(and(eq(integrationConflicts.companyId, companyId), eq(integrationConflicts.status, "open")));
    if ((conf?.n ?? 0) > 0) throw new Invalid(`Há ${conf!.n} conflito(s) de sincronização em aberto: resolva em Integrações antes do corte`);
    const [run] = await t.select({ at: integrationSyncRuns.createdAt }).from(integrationSyncRuns)
      .where(and(eq(integrationSyncRuns.companyId, companyId), eq(integrationSyncRuns.kind, "crm"), eq(integrationSyncRuns.status, "applied"))).orderBy(desc(integrationSyncRuns.createdAt)).limit(1);
    if ((!run || now.getTime() - run.at.getTime() > FRESH_SYNC_MS) && !input.acceptStale)
      throw new Invalid("A última sincronização com o CRM tem mais de 24 horas. Sincronize de novo antes do corte, ou confirme que mudanças feitas no CRM depois dela serão perdidas");
    await t.update(companies).set({ customerMode: "local", crmCutoverAt: now, crmCutoverBy: actorId, updatedAt: now }).where(eq(companies.id, companyId));
    await t.update(integrationConnections).set({ enabled: false, updatedAt: now }).where(and(eq(integrationConnections.companyId, companyId), eq(integrationConnections.kind, "crm")));
    await t.update(customers).set({ statusLocked: false }).where(eq(customers.companyId, companyId)); // a trava da situação só existia por causa da leitura do CRM
    await t.insert(auditLog).values({ companyId, actorId, action: "crm.cutover", detail: { lastSync: run?.at?.toISOString() ?? null, acceptedStale: input.acceptStale } });
    return { at: now };
  });
}

/** Cria na fila o envio ao CRM de todos os clientes que ainda não existem lá (sem vínculo). Só depois do corte. */
export async function queueUnlinkedCustomers(db: DB, actorId: string, companyId: string) {
  await requirePerm(db, actorId, companyId, "integrations.manage");
  await requirePerm(db, actorId, companyId, "crm.write");
  return db.transaction(async (tx) => {
    const t = tx as unknown as DB;
    const [co] = await t.select({ at: companies.crmCutoverAt }).from(companies).where(eq(companies.id, companyId));
    if (!co?.at) throw new Invalid("Faça o corte antes de enviar clientes ao CRM");
    const rows = await t.select({ id: customers.id, status: customers.status }).from(customers).where(and(eq(customers.companyId, companyId), isNull(customers.archivedAt), isNull(customers.externalId))).limit(500);
    for (const r of rows) await enqueueCrmPush(t, companyId, r.id, "create", r.status);
    await t.insert(auditLog).values({ companyId, actorId, action: "crm.writeback.queued_unlinked", detail: { count: rows.length } });
    return { queued: rows.length };
  });
}

/** Recoloca na fila os pedidos que falharam (depois de corrigir token, rota ou dado). */
export async function retryFailedPushes(db: DB, actorId: string, companyId: string) {
  await requirePerm(db, actorId, companyId, "integrations.manage");
  await requirePerm(db, actorId, companyId, "crm.write");
  const now = new Date();
  const r = await db.update(crmOutbox).set({ state: "pendente", attempts: 0, nextAttemptAt: now, lastError: null, updatedAt: now })
    .where(and(eq(crmOutbox.companyId, companyId), eq(crmOutbox.state, "falhou"), sql`not exists (select 1 from crm_outbox o2 where o2.company_id = ${crmOutbox.companyId} and o2.customer_id = ${crmOutbox.customerId} and o2.kind = ${crmOutbox.kind} and o2.state = 'pendente')`)).returning({ id: crmOutbox.id });
  await db.insert(auditLog).values({ companyId, actorId, action: "crm.writeback.retry", detail: { count: r.length } });
  return { retried: r.length };
}

/** Situação do envio ao CRM de UM cliente (último pedido), para a ficha do cliente. */
export async function customerPushState(db: DB, companyId: string, customerId: string) {
  const [r] = await db.select({ kind: crmOutbox.kind, state: crmOutbox.state, lastError: crmOutbox.lastError, at: crmOutbox.updatedAt }).from(crmOutbox)
    .where(and(eq(crmOutbox.companyId, companyId), eq(crmOutbox.customerId, customerId))).orderBy(desc(crmOutbox.createdAt)).limit(1);
  return r ?? null;
}
