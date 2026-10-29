import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { auditLog, coraWebhookEvents, coraWebhooks, issuanceRequests } from "@/lib/db/schema";
import { hit } from "@/lib/security/rate-limit";
import { Invalid, requirePerm } from "@/modules/identity/service";
import { coraClientFor, type Transport } from "@/modules/providers/cora-http";
import type { CoraEnvironment } from "@/modules/providers/cora";
import { ensureCoraSystemUser, syncCore } from "./sync";

/**
 * E10b-5 — WEBHOOKS da Cora (boleto pago / cancelado).
 * A Cora não assina o aviso e não manda corpo (só `webhook-event-type` e `webhook-resource-id`). Logo o aviso NUNCA é fonte de verdade: ele só diz "olhe o boleto X".
 *  1) O receptor valida o segredo da rota (hash), o formato dos dois cabeçalhos e o limite de frequência, grava um evento `pendente` e responde 200 na hora (a Cora espera ~2 s).
 *  2) O agendador processa os pendentes: acha a solicitação de emissão com aquele id e RECONSULTA a Cora (mTLS, GET) pelo mesmo núcleo da atualização de situação (`syncCore`).
 *  Evento falso/atrasado/duplicado é inofensivo: no pior caso gera uma consulta a mais. Ninguém consegue baixar pagamento só chamando a URL.
 * O segredo vai no caminho da URL cadastrada na Cora; no banco só fica o hash. Girar o segredo = cadastrar de novo (remove os endpoints antigos).
 */
export const WEBHOOK_TRIGGERS = ["paid", "canceled"] as const;
export const MAX_EVENT_ATTEMPTS = 5;
export const MAX_PENDING = 1000; // avisos pendentes por empresa
export const EVENT_RETENTION_DAYS = 30;
const MODE_OF: Record<CoraEnvironment, string> = { homologacao: "cora_homologacao", producao: "cora_producao" };
const hashOf = (secret: string) => createHash("sha256").update(secret).digest("hex");
const audit = (x: DB, companyId: string, actorId: string | null, action: string, detail: Record<string, unknown>) => x.insert(auditLog).values({ companyId, actorId, action, detail });
/** Ambientes em que o webhook pode ser cadastrado. Produção entra só na fase de emissão em produção (E10b-6). */
export const WEBHOOK_ENVIRONMENTS: CoraEnvironment[] = ["homologacao"];

export type WebhookStatus = { environment: CoraEnvironment; active: boolean; triggers: number; since: Date | null; pending: number };
export async function webhookStatus(db: DB, actorId: string, companyId: string): Promise<WebhookStatus[]> {
  await requirePerm(db, actorId, companyId, "providers.credentials");
  const hooks = await db.select().from(coraWebhooks).where(eq(coraWebhooks.companyId, companyId));
  const [{ pending }] = (await db.execute(sql`select count(*)::int pending from cora_webhook_events where company_id = ${companyId} and status = 'pendente'`)) as unknown as { pending: number }[];
  return WEBHOOK_ENVIRONMENTS.map((environment) => { const h = hooks.find((x) => x.environment === environment); return { environment, active: !!h, triggers: h ? (h.endpointIds as string[]).length : 0, since: h?.createdAt ?? null, pending }; });
}

/** Cadastra os avisos na Cora para esta empresa/ambiente e guarda o hash do segredo. Refazer gira o segredo (remove os antigos primeiro). `baseUrl` = endereço público do site. */
export async function enableCoraWebhook(db: DB, actorId: string, companyId: string, environment: string, baseUrl: string, transport?: Transport) {
  await requirePerm(db, actorId, companyId, "providers.credentials");
  if (!(WEBHOOK_ENVIRONMENTS as string[]).includes(environment)) throw new Invalid("Webhook ainda não disponível para este ambiente");
  const env = environment as CoraEnvironment;
  let origin: URL;
  try { origin = new URL(baseUrl); } catch { throw new Invalid("Endereço público do site inválido (precisa ser https)"); }
  if (origin.protocol !== "https:" || origin.port !== "" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash || !/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(origin.hostname)) throw new Invalid("Endereço público do site inválido (precisa ser https, sem porta nem caminho)");
  baseUrl = origin.origin;
  let client;
  try { client = await coraClientFor(db, companyId, env, transport); } catch { throw new Invalid("Cadastre antes as credenciais da Cora deste ambiente"); }
  const [prev] = await db.select().from(coraWebhooks).where(and(eq(coraWebhooks.companyId, companyId), eq(coraWebhooks.environment, env)));
  const secret = randomBytes(32).toString("base64url");
  const url = `${baseUrl}/api/v1/webhooks/cora/${secret}`;
  const ids: string[] = [];
  try { for (const trigger of WEBHOOK_TRIGGERS) ids.push((await client.createEndpoint({ idempotencyKey: randomUUID(), url, trigger })).id); }
  catch (e) { for (const id of ids) { try { await client.deleteEndpoint(id); } catch { /* melhor esforço */ } } throw new Invalid(`A Cora recusou o cadastro do webhook (${(e as { status?: number }).status ?? "erro"}). Nada foi ativado`); }
  // Os NOVOS avisos já existem na Cora; só então troca o segredo no banco e, por último, remove os antigos (melhor esforço): uma falha no meio nunca deixa a empresa sem segredo válido.
  try {
    await db.transaction(async (tx) => {
      const x = tx as unknown as DB;
      await x.insert(coraWebhooks).values({ companyId, environment: env, secretHash: hashOf(secret), endpointIds: ids, createdBy: actorId })
        .onConflictDoUpdate({ target: [coraWebhooks.companyId, coraWebhooks.environment], set: { secretHash: hashOf(secret), endpointIds: ids, createdBy: actorId, updatedAt: new Date() } });
      await audit(x, companyId, actorId, "webhook.enabled", { provider: "cora", environment: env, triggers: ids.length, rotated: !!prev });
    });
  } catch (e) { for (const id of ids) { try { await client.deleteEndpoint(id); } catch { /* melhor esforço */ } } throw e; }
  if (prev) for (const id of prev.endpointIds as string[]) { try { await client.deleteEndpoint(id); } catch { /* já removido lá: segue */ } }
  return { triggers: ids.length };
}

export async function disableCoraWebhook(db: DB, actorId: string, companyId: string, environment: string, transport?: Transport) {
  await requirePerm(db, actorId, companyId, "providers.credentials");
  if (!(WEBHOOK_ENVIRONMENTS as string[]).includes(environment)) throw new Invalid("Ambiente inválido");
  const env = environment as CoraEnvironment;
  const [h] = await db.select().from(coraWebhooks).where(and(eq(coraWebhooks.companyId, companyId), eq(coraWebhooks.environment, env)));
  if (!h) return { removed: 0 };
  const client = await coraClientFor(db, companyId, env, transport).catch(() => null);
  if (client) for (const id of h.endpointIds as string[]) { try { await client.deleteEndpoint(id); } catch { /* já removido lá */ } }
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await x.delete(coraWebhooks).where(eq(coraWebhooks.id, h.id));
    await audit(x, companyId, actorId, "webhook.disabled", { provider: "cora", environment: env });
  });
  return { removed: (h.endpointIds as string[]).length };
}

export type ReceiveResult = { status: 200 | 404 | 429; environment?: string };
/** Receptor (rota pública). Nunca lê o corpo nem confia em nada além do segredo + formato. Resposta idêntica para qualquer evento aceito. */
export async function receiveCoraWebhook(db: DB, secret: string, headers: { type: string | null; resourceId: string | null; eventId: string | null }, now = new Date()): Promise<ReceiveResult> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret ?? "")) return { status: 404 };
  const [h] = await db.select().from(coraWebhooks).where(eq(coraWebhooks.secretHash, hashOf(secret)));
  if (!h) return { status: 404 };
  if (await hit(db, `cora-webhook:${h.id}`, 600, 60_000, now)) return { status: 429, environment: h.environment };
  const type = (headers.type ?? "").trim().toLowerCase(), rid = (headers.resourceId ?? "").trim(), eid = (headers.eventId ?? "").trim().slice(0, 100) || null;
  if (!/^[a-z_]{2,20}\.[a-z_*]{2,20}$/.test(type) || !/^inv_[A-Za-z0-9_-]{4,64}$/.test(rid)) return { status: 200, environment: h.environment }; // aviso de outro tipo/recurso: aceito e ignorado (a Cora não deve ficar reenviando)
  if (!type.startsWith("invoice.")) return { status: 200, environment: h.environment };
  // Teto de fila: com muitos pendentes não grava mais (o agendador complementa por consulta periódica); o aviso é só um gatilho, perder um não perde dinheiro.
  const [{ pending }] = (await db.execute(sql`select count(*)::int pending from cora_webhook_events where company_id = ${h.companyId} and status = 'pendente'`)) as unknown as { pending: number }[];
  if (pending >= MAX_PENDING) return { status: 200, environment: h.environment };
  // Duplicado (reenvio ou chamadas simultâneas): índices únicos + ON CONFLICT; sem id, no máximo um pendente igual por boleto/tipo.
  await db.insert(coraWebhookEvents).values({ companyId: h.companyId, environment: h.environment, eventType: type, resourceId: rid, eventId: eid }).onConflictDoNothing();
  return { status: 200, environment: h.environment };
}

export type ProcessSummary = { processed: number; ignored: number; errors: number };
/** Agendador: processa os avisos pendentes (reconsulta o boleto). Qualquer erro deixa o evento para nova tentativa (até MAX_EVENT_ATTEMPTS). */
export async function processWebhookEvents(db: DB, now = new Date(), limit = 50): Promise<ProcessSummary> {
  const sum: ProcessSummary = { processed: 0, ignored: 0, errors: 0 };
  const batch = await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    const rows = await x.select().from(coraWebhookEvents).where(eq(coraWebhookEvents.status, "pendente")).orderBy(asc(coraWebhookEvents.createdAt)).limit(limit).for("update", { skipLocked: true });
    for (const r of rows) await x.update(coraWebhookEvents).set({ attempts: r.attempts + 1, updatedAt: now }).where(eq(coraWebhookEvents.id, r.id));
    return rows.map((r) => ({ ...r, attempts: r.attempts + 1 }));
  });
  await db.delete(coraWebhookEvents).where(and(inArray(coraWebhookEvents.status, ["processado", "ignorado", "erro"]), sql`${coraWebhookEvents.processedAt} < ${new Date(now.getTime() - EVENT_RETENTION_DAYS * 86_400_000).toISOString()}::timestamptz`)); // expurgo
  if (batch.length === 0) return sum;
  const sys = await ensureCoraSystemUser(db);
  const finish = (id: string, status: "processado" | "ignorado" | "erro" | "pendente", outcome: string) => db.update(coraWebhookEvents).set({ status, outcome, processedAt: status === "pendente" ? null : now, updatedAt: now }).where(eq(coraWebhookEvents.id, id));
  for (const ev of batch) {
    try {
      const [req] = await db.select({ id: issuanceRequests.id }).from(issuanceRequests)
        .where(and(eq(issuanceRequests.companyId, ev.companyId), eq(issuanceRequests.externalRef, ev.resourceId), eq(issuanceRequests.kind, "boleto"), eq(issuanceRequests.mode, MODE_OF[ev.environment as CoraEnvironment])));
      if (!req) { await finish(ev.id, "ignorado", "boleto_desconhecido"); sum.ignored++; continue; }
      const o = await syncCore(db, ev.companyId, sys, now, { requestId: req.id });
      if (o.skipped || (o.failed > 0 && o.checked === 0)) throw new Error("consulta_indisponivel"); // Cora limitou/credencial/erro: tenta de novo
      await finish(ev.id, "processado", o.settled ? "baixado" : o.paid ? "pago" : o.cancelled ? "cancelado" : "sem_mudanca"); sum.processed++;
    } catch {
      sum.errors++;
      await finish(ev.id, ev.attempts >= MAX_EVENT_ATTEMPTS ? "erro" : "pendente", "falha_na_consulta");
    }
  }
  return sum;
}
