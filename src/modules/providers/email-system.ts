import { and, asc, eq, sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { auditLog, emailSendLog, memberships } from "@/lib/db/schema";
import { activeAuthorization, domainsOf, finishLog, flagOn, liveEmailFor, manausDay } from "./email-live";
import { isAllowed, type SmtpDeps } from "./smtp";

/**
 * E27 — e-mails do SISTEMA (redefinição de senha e convite). Nada a ver com cobrança: sem dados de cliente, um destinatário por mensagem.
 * Passam pelas MESMAS três travas do envio real (chave do servidor, autorização ativa da diretoria, conta SMTP) e pela MESMA lista de
 * destinatários autorizados. Com qualquer trava faltando NÃO sai nada e o chamador recebe o motivo (ele oferece o link manual).
 * Limite diário próprio (não gasta o da cobrança). Nunca lança por "desligado": devolve `sent: false`.
 */
export const SYSTEM_DAILY_LIMIT = 40;
export type SystemKind = "senha" | "convite";
export type SystemMail = { kind: SystemKind; to: string; subject: string; text: string; html: string };
export type SystemReason = "desligado" | "sem_autorizacao" | "sem_conta" | "fora_da_lista" | "limite" | "falhou" | "desconhecido";
export type SystemSendResult = { sent: true } | { sent: false; reason: SystemReason };
export type MailOpts = { env?: Record<string, string | undefined>; deps?: SmtpDeps };

const SAY: Record<SystemReason, string> = {
  desligado: "o envio de e-mail está desligado no servidor", sem_autorizacao: "não há autorização de envio ativa", sem_conta: "a conta de e-mail não está cadastrada ou legível",
  fora_da_lista: "o endereço não está na lista de destinatários autorizados", limite: "o limite diário de e-mails do sistema foi atingido", falhou: "o servidor de e-mail recusou o envio", desconhecido: "o servidor não confirmou o envio",
};
export const reasonText = (r: SystemReason) => SAY[r];

async function systemToday(x: DB, companyId: string): Promise<number> {
  const r = await x.execute(sql`select count(*)::int n from email_send_log where company_id = ${companyId} and kind in ('senha', 'convite') and status in ('enviando', 'enviado', 'desconhecido') and (created_at at time zone 'America/Manaus')::date = ${manausDay()}::date`);
  return Number((r as unknown as { n: number }[])[0].n);
}

/** Por que (ainda) não dá para enviar por esta empresa a este endereço; null = pronto. Não lê a conta em claro além de `liveEmailFor`. */
export async function mailReadiness(db: DB, companyId: string, to: string, o: MailOpts = {}): Promise<SystemReason | null> {
  const env = o.env ?? process.env;
  if (!flagOn(env)) return "desligado";
  if (!(await activeAuthorization(db, companyId))) return "sem_autorizacao";
  const live = await liveEmailFor(db, companyId, env, o.deps);
  if (live.state === "off") return "sem_autorizacao";
  if (live.state === "blocked") return "sem_conta";
  return isAllowed(to, live.allowed) ? null : "fora_da_lista";
}

/** Primeira empresa ATIVA do usuário em que o e-mail do sistema está pronto para este endereço. */
export async function mailRouteForUser(db: DB, userId: string, to: string, o: MailOpts = {}): Promise<{ companyId: string } | { reason: SystemReason }> {
  const ms = await db.select({ companyId: memberships.companyId }).from(memberships).where(and(eq(memberships.userId, userId), eq(memberships.status, "active"))).orderBy(asc(memberships.createdAt));
  let last: SystemReason = "desligado";
  for (const m of ms) {
    const why = await mailReadiness(db, m.companyId, to, o);
    if (!why) return { companyId: m.companyId };
    last = why;
  }
  return { reason: last };
}

export async function sendSystemEmail(db: DB, companyId: string, actorId: string | null, mail: SystemMail, o: MailOpts = {}): Promise<SystemSendResult> {
  const env = o.env ?? process.env;
  const why = await mailReadiness(db, companyId, mail.to, o);
  if (why) return { sent: false, reason: why };
  const live = await liveEmailFor(db, companyId, env, o.deps);
  if (live.state !== "ready") return { sent: false, reason: "sem_conta" };
  const logId = await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await x.execute(sql`select pg_advisory_xact_lock(hashtext(${"email-live:" + companyId}))`); // mesmo lock do envio de cobrança e do teste
    if ((await systemToday(x, companyId)) + 1 > SYSTEM_DAILY_LIMIT) return null;
    const [l] = await x.insert(emailSendLog).values({ companyId, kind: mail.kind, recipientDomains: domainsOf([mail.to]), recipients: 1, actorId }).returning({ id: emailSendLog.id });
    return l.id;
  });
  if (!logId) return { sent: false, reason: "limite" };
  if (!flagOn(env) || (await activeAuthorization(db, companyId))?.id !== live.authorizationId) { // revogado entre reservar e enviar
    await db.transaction(async (tx) => { await finishLog(tx as unknown as DB, logId, { status: "falhou", error: "autorizacao_revogada" }); });
    return { sent: false, reason: "sem_autorizacao" };
  }
  const res = await live.provider.send({ to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html, idempotencyKey: `${mail.kind}-${logId}` })
    .catch(() => ({ ok: false as const, retryable: false, unknown: true, error: "resultado_desconhecido" }));
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await finishLog(x, logId, res.ok ? { status: "enviado", providerRef: res.providerRef } : { status: res.unknown ? "desconhecido" : "falhou", error: res.error });
    await x.insert(auditLog).values({ companyId, actorId, action: res.ok ? "email.system_sent" : "email.system_failed", detail: { logId, kind: mail.kind, ...(res.ok ? {} : { error: res.error.slice(0, 60) }) } });
  });
  return res.ok ? { sent: true } : { sent: false, reason: res.unknown ? "desconhecido" : "falhou" };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function resetMail(to: string, link: string, minutes: number): SystemMail {
  const text = `Você (ou alguém) pediu para redefinir a senha do K3G Finance.\n\nPara criar uma nova senha, abra o link abaixo. Ele vale por ${minutes} minutos e só pode ser usado uma vez:\n\n${link}\n\nSe não foi você, ignore este e-mail: a sua senha continua a mesma.`;
  const html = `<p>Você (ou alguém) pediu para redefinir a senha do K3G Finance.</p><p>Para criar uma nova senha, abra o link abaixo. Ele vale por ${minutes} minutos e só pode ser usado uma vez:</p><p><a href="${esc(link)}">${esc(link)}</a></p><p>Se não foi você, ignore este e-mail: a sua senha continua a mesma.</p>`;
  return { kind: "senha", to, subject: "Redefinição de senha — K3G Finance", text, html };
}

export function inviteMail(to: string, link: string, companyName: string, roleLabel: string, hours: number): SystemMail {
  const text = `Você foi convidado para o K3G Finance (${companyName}) como ${roleLabel}.\n\nPara criar o seu acesso, abra o link abaixo. Ele vale por ${hours} horas e só pode ser usado uma vez:\n\n${link}\n\nSe você não esperava este convite, ignore este e-mail.`;
  const html = `<p>Você foi convidado para o K3G Finance (<strong>${esc(companyName)}</strong>) como <strong>${esc(roleLabel)}</strong>.</p><p>Para criar o seu acesso, abra o link abaixo. Ele vale por ${hours} horas e só pode ser usado uma vez:</p><p><a href="${esc(link)}">${esc(link)}</a></p><p>Se você não esperava este convite, ignore este e-mail.</p>`;
  return { kind: "convite", to, subject: "Convite para o K3G Finance", text, html };
}
