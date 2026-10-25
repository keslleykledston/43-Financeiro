import { createHash, randomBytes } from "node:crypto";
import argon2 from "argon2";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { auditLog, memberships, passwordResets, users } from "@/lib/db/schema";
import { hit } from "@/lib/security/rate-limit";
import { mailRouteForUser, resetMail, sendSystemEmail, type MailOpts, type SystemSendResult } from "@/modules/providers/email-system";
import { canGrant, type Role } from "./permissions";
import { passwordProblem } from "./password";
import { Forbidden, Invalid, activeRole, requirePerm } from "./service";

/**
 * E27 — redefinição de senha. Dois caminhos, o mesmo token (aleatório de 256 bits, só o hash no banco, uso único, vence rápido):
 *  1) "Esqueci minha senha" na tela de entrada: SEMPRE responde igual (existindo ou não o e-mail). Só gera o link e envia se o e-mail do sistema
 *     estiver liberado (as três travas do envio real + lista de destinatários). Com o e-mail desligado nada é criado nem enviado.
 *  2) Quem administra acessos (members.invite) gera o link de um membro e entrega por outro meio (mostrado uma única vez).
 * Concluir a redefinição troca a senha, encerra TODAS as sessões do usuário e invalida os outros links dele.
 */
export const RESET_EMAIL_TTL_MS = 60 * 60_000;
export const RESET_ADMIN_TTL_MS = 24 * 3600_000;
const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]+$/;
const GENERIC = "Link inválido ou expirado. Peça um novo.";

export const maskEmail = (e: string) => { const [l, d] = e.split("@"); return `${l.slice(0, 2)}${"*".repeat(Math.max(1, Math.min(l.length - 2, 6)))}@${d}`; };

/** Serializa a emissão de links do MESMO usuário: dois pedidos simultâneos não deixam dois links válidos (um por vez vale). */
const lockUser = (x: DB, userId: string) => x.execute(sql`select pg_advisory_xact_lock(hashtext(${"pwreset:" + userId}))`);

/** Invalida os links ainda abertos do usuário (um por vez vale). */
const expireOpen = (x: DB, userId: string, now: Date) =>
  x.update(passwordResets).set({ expiresAt: now, updatedAt: now }).where(and(eq(passwordResets.userId, userId), isNull(passwordResets.usedAt), gt(passwordResets.expiresAt, now)));

export type RequestOutcome = { issued: boolean; sent?: SystemSendResult; limited?: boolean };

/** Pedido na tela de entrada. O retorno é só para teste/auditoria: a tela NUNCA mostra se o e-mail existe nem se foi enviado. */
export async function requestPasswordReset(db: DB, emailRaw: string, ip: string, baseUrl: string, o: MailOpts = {}, now = new Date()): Promise<RequestOutcome> {
  const email = String(emailRaw ?? "").trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) return { issued: false };
  if ((await hit(db, `pwreset:email:${email}`, 3, 3600_000, now)) || (await hit(db, `pwreset:ip:${ip}`, 10, 3600_000, now))) return { issued: false, limited: true };
  const [u] = await db.select({ id: users.id, disabledAt: users.disabledAt }).from(users).where(eq(sql`lower(${users.email})`, email));
  if (!u || u.disabledAt) return { issued: false };
  const route = await mailRouteForUser(db, u.id, email, o);
  if (!("companyId" in route)) { // e-mail do sistema indisponível: não cria link dormente
    await db.insert(auditLog).values({ actorId: u.id, action: "auth.reset_requested", detail: { delivered: false, reason: route.reason } });
    return { issued: false };
  }
  const token = randomBytes(32).toString("base64url");
  const resetId = await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await lockUser(x, u.id);
    await expireOpen(x, u.id, now);
    const [r] = await x.insert(passwordResets).values({ userId: u.id, tokenHash: hashToken(token), expiresAt: new Date(now.getTime() + RESET_EMAIL_TTL_MS), channel: "email" }).returning({ id: passwordResets.id });
    await x.insert(auditLog).values({ actorId: u.id, action: "auth.reset_requested", detail: { delivered: true } });
    return r.id;
  });
  const sent = await sendSystemEmail(db, route.companyId, null, resetMail(email, `${baseUrl}/redefinir/${token}`, RESET_EMAIL_TTL_MS / 60_000), o)
    .catch((): SystemSendResult => ({ sent: false, reason: "falhou" }));
  if (!sent.sent) { // sem entrega: o link não fica valendo
    await db.update(passwordResets).set({ expiresAt: now, updatedAt: now }).where(eq(passwordResets.id, resetId));
    await db.insert(auditLog).values({ actorId: u.id, action: "auth.reset_email_failed", detail: { reason: sent.reason } });
  }
  return { issued: true, sent };
}

export type ResetPreview = { valid: false } | { valid: true; emailMasked: string };
export async function previewPasswordReset(db: DB, token: string, now = new Date()): Promise<ResetPreview> {
  if (!token || token.length > 200) return { valid: false };
  const [r] = await db.select({ email: users.email, disabledAt: users.disabledAt, expiresAt: passwordResets.expiresAt, usedAt: passwordResets.usedAt })
    .from(passwordResets).innerJoin(users, eq(users.id, passwordResets.userId)).where(eq(passwordResets.tokenHash, hashToken(token)));
  if (!r || r.usedAt || r.disabledAt || r.expiresAt <= now) return { valid: false };
  return { valid: true, emailMasked: maskEmail(r.email) };
}

/** Conclui: valida a senha pela política, troca, encerra sessões, usa o link e invalida os demais. Mensagem única para qualquer link ruim. */
export async function completePasswordReset(db: DB, token: string, password: string, ip: string, now = new Date()): Promise<{ userId: string }> {
  if (await hit(db, `pwreset-use:ip:${ip}`, 20, 15 * 60_000, now)) throw new Invalid("Muitas tentativas. Aguarde alguns minutos.");
  const th = hashToken(String(token ?? ""));
  const [pre] = await db.select({ email: users.email, passwordHash: users.passwordHash }).from(passwordResets).innerJoin(users, eq(users.id, passwordResets.userId)).where(eq(passwordResets.tokenHash, th));
  if (!pre) throw new Invalid(GENERIC);
  const problem = passwordProblem(String(password ?? ""), { email: pre.email });
  if (problem) throw new Invalid(problem);
  if (await argon2.verify(pre.passwordHash, password).catch(() => false)) throw new Invalid("Use uma senha diferente da atual");
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  return db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    const [r] = await x.select().from(passwordResets).where(eq(passwordResets.tokenHash, th)).for("update");
    if (!r || r.usedAt || r.expiresAt <= now) throw new Invalid(GENERIC);
    const [u] = await x.select().from(users).where(eq(users.id, r.userId)).for("update");
    if (!u || u.disabledAt) throw new Invalid(GENERIC);
    await x.update(users).set({ passwordHash, sessionVersion: sql`${users.sessionVersion} + 1`, updatedAt: now }).where(eq(users.id, u.id)); // derruba toda sessão aberta
    await x.update(passwordResets).set({ usedAt: now, updatedAt: now }).where(eq(passwordResets.id, r.id));
    await expireOpen(x, u.id, now);
    await x.execute(sql`delete from rate_limits where key like 'login:%' and position(${u.email.toLowerCase()} in key) > 0`); // quem ficou travado por tentativas errôneas volta a entrar
    await x.insert(auditLog).values({ actorId: u.id, action: "auth.password_reset", detail: { channel: r.channel } });
    return { userId: u.id };
  });
}

/**
 * Link gerado por quem administra acessos. Regras: papel que o ator pode conceder; não para si mesmo (use "Minha conta");
 * admin técnico não redefine diretoria (senão assumiria a conta e os dados financeiros); se a pessoa também tem acesso a OUTRA empresa,
 * o ator precisa poder conceder o papel dela lá também (senão o link serviria para assumir um acesso que ele não administra).
 */
export async function issueResetLink(db: DB, actorId: string, companyId: string, membershipId: string, baseUrl: string, now = new Date()) {
  const actorRole = await requirePerm(db, actorId, companyId, "members.invite");
  const [m] = await db.select().from(memberships).where(and(eq(memberships.id, membershipId), eq(memberships.companyId, companyId), eq(memberships.status, "active")));
  if (!m) throw new Invalid("Membro não encontrado");
  if (m.userId === actorId) throw new Invalid("Para trocar a sua própria senha, use Minha conta");
  if (!canGrant(actorRole, m.role) || (m.role === "diretoria" && actorRole !== "diretoria")) throw new Forbidden("Você não pode redefinir a senha deste papel");
  const others = await db.select({ companyId: memberships.companyId, role: memberships.role }).from(memberships).where(and(eq(memberships.userId, m.userId), eq(memberships.status, "active")));
  for (const o of others) {
    if (o.companyId === companyId) continue;
    const mine: Role | null = await activeRole(db, actorId, o.companyId);
    if (!mine || !can2(mine, o.role)) throw new Forbidden("Esta pessoa também acessa outra empresa, onde você não administra acessos");
  }
  const [u] = await db.select({ id: users.id, disabledAt: users.disabledAt }).from(users).where(eq(users.id, m.userId));
  if (!u || u.disabledAt) throw new Invalid("Usuário desativado");
  const token = randomBytes(32).toString("base64url");
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await lockUser(x, u.id);
    await expireOpen(x, u.id, now);
    await x.insert(passwordResets).values({ userId: u.id, tokenHash: hashToken(token), expiresAt: new Date(now.getTime() + RESET_ADMIN_TTL_MS), channel: "admin", createdBy: actorId });
    await x.insert(auditLog).values({ companyId, actorId, action: "member.reset_link_issued", detail: { userId: u.id } });
  });
  return { link: `${baseUrl}/redefinir/${token}`, hours: RESET_ADMIN_TTL_MS / 3600_000 };
}

const can2 = (actor: Role, target: Role) => canGrant(actor, target) && (target !== "diretoria" || actor === "diretoria");

/** Usado só por scripts de operação (servidor): link para quem ficou sem acesso e ninguém pode gerar. */
export async function issueResetLinkForOps(db: DB, email: string, baseUrl: string, now = new Date()) {
  const [u] = await db.select({ id: users.id, disabledAt: users.disabledAt }).from(users).where(eq(sql`lower(${users.email})`, email.trim().toLowerCase()));
  if (!u || u.disabledAt) throw new Invalid("Usuário não encontrado ou desativado");
  const token = randomBytes(32).toString("base64url");
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await lockUser(x, u.id);
    await expireOpen(x, u.id, now);
    await x.insert(passwordResets).values({ userId: u.id, tokenHash: hashToken(token), expiresAt: new Date(now.getTime() + 2 * 3600_000), channel: "admin" });
    await x.insert(auditLog).values({ actorId: u.id, action: "auth.reset_link_ops", detail: {} });
  });
  return `${baseUrl}/redefinir/${token}`;
}
