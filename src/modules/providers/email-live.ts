import { and, desc, eq, sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { auditLog, emailLiveAuthorizations, emailSendLog } from "@/lib/db/schema";
import { SecretBoxCorrupt, SecretBoxUnavailable } from "@/lib/security/secretbox";
import { Invalid, requirePerm } from "@/modules/identity/service";
import { readEmailCredentials } from "./email-secrets";
import { parseEmailAddress } from "./email";
import { createSmtpEmailProvider, isAllowed, type SmtpDeps } from "./smtp";
import type { EmailProvider } from "./types";

/**
 * E23 — resolve o envio REAL de e-mail de UMA empresa. Três travas, todas obrigatórias (qualquer uma faltando = nada sai):
 *   1) chave do servidor EMAIL_EXTERNAL_ENABLED=true (quem opera o servidor liga);  2) autorização ATIVA registrada pela diretoria
 *   (referência da autorização escrita, lista de destinatários permitidos, limite diário);  3) conta SMTP cadastrada e legível neste processo.
 * `off` = o fluxo continua SIMULADO. `blocked` = a chave e a autorização existem, mas algo impede de enviar agora (a fila NÃO é consumida).
 * Este arquivo e a configuração são os ÚNICOS que podem ler a conta em claro (guardado por teste).
 */
export type LiveState =
  | { state: "off" }
  | { state: "blocked"; reason: string }
  | { state: "ready"; provider: EmailProvider; allowed: string[]; dailyLimit: number; authorizationId: string; env: Record<string, string | undefined> };

export const manausDay = (d = new Date()) => d.toLocaleDateString("sv-SE", { timeZone: "America/Manaus" });
export const flagOn = (env: Record<string, string | undefined> = process.env) => env.EMAIL_EXTERNAL_ENABLED === "true";

export async function activeAuthorization(x: DB, companyId: string) {
  const [a] = await x.select().from(emailLiveAuthorizations).where(and(eq(emailLiveAuthorizations.companyId, companyId), eq(emailLiveAuthorizations.active, true)));
  return a ?? null;
}

/** Mensagens reais de hoje (dia de Manaus) que contam para o limite diário de COBRANÇA (fila e teste): em andamento, enviadas e de resultado desconhecido.
 *  E-mails do sistema (senha, convite) têm limite próprio em email-system.ts e não gastam o da cobrança. */
export async function sentToday(x: DB, companyId: string, today = manausDay()): Promise<number> {
  const r = await x.execute(sql`select count(*)::int n from email_send_log where company_id = ${companyId} and kind in ('fila', 'teste') and status in ('enviando', 'enviado', 'desconhecido') and (created_at at time zone 'America/Manaus')::date = ${today}::date`);
  return Number((r as unknown as { n: number }[])[0].n);
}

/** Para o aviso do topo: o e-mail REAL está liberado (chave do servidor + autorização ativa) para esta empresa? Sem dados sensíveis. */
export async function emailLiveActive(x: DB, companyId: string, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  return flagOn(env) && !!(await activeAuthorization(x, companyId));
}

export async function liveEmailFor(x: DB, companyId: string, env: Record<string, string | undefined> = process.env, deps?: SmtpDeps): Promise<LiveState> {
  if (!flagOn(env)) return { state: "off" };
  const auth = await activeAuthorization(x, companyId);
  if (!auth) return { state: "off" };
  let cfg;
  try { cfg = await readEmailCredentials(x, companyId); }
  catch (e) { if (e instanceof SecretBoxUnavailable || e instanceof SecretBoxCorrupt) return { state: "blocked", reason: "Cofre de credenciais indisponível ou ilegível neste processo" }; throw e; }
  if (!cfg) return { state: "blocked", reason: "Conta de e-mail não cadastrada" };
  return { state: "ready", provider: createSmtpEmailProvider(cfg, auth.allowed, deps), allowed: auth.allowed, dailyLimit: auth.dailyLimit, authorizationId: auth.id, env };
}

export const domainsOf = (to: string[]) => [...new Set(to.map((a) => a.slice(a.lastIndexOf("@") + 1).toLowerCase()))].join(",").slice(0, 300);

/** Fecha uma tentativa do registro (só sai de "enviando" uma vez; o trigger garante). */
export async function finishLog(x: DB, id: string, r: { status: "enviado" | "falhou" | "desconhecido"; providerRef?: string | null; error?: string | null }) {
  await x.update(emailSendLog).set({ status: r.status, providerRef: r.providerRef ?? null, error: r.error ? r.error.slice(0, 120) : null, finishedAt: new Date(), updatedAt: new Date() }).where(and(eq(emailSendLog.id, id), eq(emailSendLog.status, "enviando")));
}

/**
 * Envia UM e-mail de teste a um endereço da lista autorizada (canário). Conta no limite diário. Nada de dados de cliente no texto.
 * Reservar (registro "enviando") → enviar fora de transação → registrar. Sem as três travas, recusa com a razão.
 */
export async function sendTestEmail(db: DB, actorId: string, companyId: string, toRaw: string, env: Record<string, string | undefined> = process.env, deps?: SmtpDeps) {
  await requirePerm(db, actorId, companyId, "providers.credentials");
  const to = parseEmailAddress(toRaw ?? "", "o e-mail de destino")!;
  if (!flagOn(env)) throw new Invalid("O envio real está desligado no servidor (EMAIL_EXTERNAL_ENABLED). Nada foi enviado");
  const live = await liveEmailFor(db, companyId, env, deps);
  if (live.state === "off") throw new Invalid("Não há autorização de envio real ativa para esta empresa. Nada foi enviado");
  if (live.state === "blocked") throw new Invalid(`${live.reason}. Nada foi enviado`);
  if (!isAllowed(to, live.allowed)) throw new Invalid("Este endereço não está na lista de destinatários autorizados. Nada foi enviado");
  const logId = await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await x.execute(sql`select pg_advisory_xact_lock(hashtext(${"email-live:" + companyId}))`); // limite diário sem corrida
    if ((await sentToday(x, companyId)) + 1 > live.dailyLimit) throw new Invalid("Limite diário de envios reais atingido");
    const [l] = await x.insert(emailSendLog).values({ companyId, kind: "teste", recipientDomains: domainsOf([to]), recipients: 1, actorId }).returning({ id: emailSendLog.id });
    return l.id;
  });
  const key = `teste-${logId}`;
  if (!flagOn(env) || (await activeAuthorization(db, companyId))?.id !== live.authorizationId) { // revogado entre reservar e enviar
    await db.transaction(async (tx) => { await finishLog(tx as unknown as DB, logId, { status: "falhou", error: "autorizacao_revogada" }); });
    throw new Invalid("A autorização foi revogada. Nada foi enviado");
  }
  const res = await live.provider.send({ to: [to], subject: "Teste de e-mail do K3G Finance", text: "Este é um e-mail de teste do K3G Finance, enviado pela diretoria para conferir a conta de e-mail. Nenhuma cobrança está envolvida. Pode ignorar.", html: "<p>Este é um e-mail de teste do K3G Finance, enviado pela diretoria para conferir a conta de e-mail. Nenhuma cobrança está envolvida. Pode ignorar.</p>", idempotencyKey: key }).catch(() => ({ ok: false as const, retryable: false, unknown: true, error: "resultado_desconhecido" }));
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await finishLog(x, logId, res.ok ? { status: "enviado", providerRef: res.providerRef } : { status: res.unknown ? "desconhecido" : "falhou", error: res.error });
    await x.insert(auditLog).values({ companyId, actorId, action: res.ok ? "email.test_sent" : "email.test_failed", detail: { logId, ...(res.ok ? {} : { error: res.error.slice(0, 60) }) } });
  });
  if (!res.ok) throw new Invalid(res.unknown ? "O servidor não confirmou o envio (pode ter chegado): confira a caixa de destino antes de tentar de novo" : `O servidor recusou o envio (${res.error}). Confira servidor, porta, usuário e senha`);
  return { logId };
}

export async function listSendLog(db: DB, actorId: string, companyId: string, limit = 10) {
  await requirePerm(db, actorId, companyId, "providers.credentials");
  return db.select({ id: emailSendLog.id, at: emailSendLog.createdAt, kind: emailSendLog.kind, domains: emailSendLog.recipientDomains, status: emailSendLog.status, error: emailSendLog.error }).from(emailSendLog).where(eq(emailSendLog.companyId, companyId)).orderBy(desc(emailSendLog.createdAt)).limit(limit);
}
