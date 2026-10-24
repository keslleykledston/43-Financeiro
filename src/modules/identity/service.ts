import { createHash, randomBytes } from "node:crypto";
import argon2 from "argon2";
import { and, eq, sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { auditLog, invitations, memberships, users } from "@/lib/db/schema";
import { can, canGrant, type Permission, type Role } from "./permissions";
import { clear, hit } from "@/lib/security/rate-limit";

export class Forbidden extends Error { constructor(m = "Acesso negado") { super(m); } }
export class Invalid extends Error {}

export const INVITE_TTL_MS = 72 * 3600_000;
const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

/** Papel ativo do usuário na empresa, ou null. Fonte única da autorização por tenant. */
export async function activeRole(db: DB, userId: string, companyId: string): Promise<Role | null> {
  const [m] = await db.select({ role: memberships.role }).from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.companyId, companyId), eq(memberships.status, "active")));
  return m?.role ?? null;
}

/** Conta existe e não está desabilitada. Chamado a cada requisição (JWT não é fonte de verdade). */
export async function isUserActive(db: DB, userId: string): Promise<boolean> {
  const [u] = await db.select({ d: users.disabledAt }).from(users).where(eq(users.id, userId));
  return !!u && !u.d;
}

/** Sessão (JWT) ainda vale: conta ativa e versão de sessão igual à do login. Token antigo, sem versão, vale como 0. */
export async function isSessionValid(db: DB, userId: string, sessionVersion: number | undefined): Promise<boolean> {
  const [u] = await db.select({ d: users.disabledAt, v: users.sessionVersion }).from(users).where(eq(users.id, userId));
  return !!u && !u.d && u.v === (sessionVersion ?? 0);
}

/** Encerra TODAS as sessões do usuário (inclusive a atual): sobe a versão; os JWTs emitidos antes deixam de valer. */
export async function revokeSessions(db: DB, userId: string) {
  await db.transaction(async (tx) => {
    await tx.update(users).set({ sessionVersion: sql`${users.sessionVersion} + 1`, updatedAt: new Date() }).where(eq(users.id, userId));
    await tx.insert(auditLog).values({ actorId: userId, action: "auth.sessions_revoked" });
  });
}

export async function requirePerm(db: DB, userId: string, companyId: string, perm: Permission): Promise<Role> {
  const role = await activeRole(db, userId, companyId);
  if (!role || !can(role, perm)) throw new Forbidden();
  return role;
}

export async function listMembers(db: DB, actorId: string, companyId: string) {
  await requirePerm(db, actorId, companyId, "members.read");
  return db.select({ membershipId: memberships.id, userId: users.id, name: users.name, email: users.email, role: memberships.role })
    .from(memberships).innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.companyId, companyId), eq(memberships.status, "active")));
}

export async function inviteMember(db: DB, actorId: string, companyId: string, email: string, role: Role, now = new Date()) {
  const actorRole = await requirePerm(db, actorId, companyId, "members.invite");
  if (!canGrant(actorRole, role)) throw new Forbidden("Papel não pode ser concedido por você");
  const token = randomBytes(32).toString("base64url");
  await db.transaction(async (tx) => {
    await tx.insert(invitations).values({
      companyId, email: email.trim().toLowerCase(), role, tokenHash: hashToken(token),
      expiresAt: new Date(now.getTime() + INVITE_TTL_MS), invitedBy: actorId,
    });
    await tx.insert(auditLog).values({ companyId, actorId, action: "member.invited", detail: { email, role } });
  });
  return token; // exibido uma única vez ao convidante
}

/**
 * Aceite de convite. O e-mail digitado deve bater com o do convite. Conta existente: exige a SENHA ATUAL
 * (o link sozinho não concede acesso a conta de terceiro). Conta nova: cria com a senha informada.
 * Risco residual: sem envio de e-mail, a posse do e-mail novo não é verificada (ver DECISIONS ADR-003).
 */
export async function acceptInvite(db: DB, token: string, email: string, name: string, password: string, now = new Date()) {
  if (password.length < 12) throw new Invalid("Senha deve ter ao menos 12 caracteres");
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  return db.transaction(async (tx) => {
    const [inv] = await tx.select().from(invitations).where(eq(invitations.tokenHash, hashToken(token))).for("update");
    if (!inv || inv.acceptedAt || inv.expiresAt < now || inv.email !== email.trim().toLowerCase()) throw new Invalid("Convite inválido ou expirado");
    let [u] = await tx.select().from(users).where(eq(sql`lower(${users.email})`, inv.email));
    if (u) {
      if (u.disabledAt || !(await argon2.verify(u.passwordHash, password).catch(() => false))) throw new Invalid("Convite inválido ou expirado");
    } else {
      [u] = await tx.insert(users).values({ email: inv.email, name: name.trim() || inv.email, passwordHash }).returning();
    }
    await tx.insert(memberships).values({ userId: u.id, companyId: inv.companyId, role: inv.role, status: "active" })
      .onConflictDoUpdate({ target: [memberships.userId, memberships.companyId], set: { role: inv.role, status: "active", updatedAt: now } });
    await tx.update(invitations).set({ acceptedAt: now }).where(eq(invitations.id, inv.id));
    await tx.insert(auditLog).values({ companyId: inv.companyId, actorId: u.id, action: "member.joined", detail: { role: inv.role } });
    return u.id;
  });
}

export async function removeMember(db: DB, actorId: string, companyId: string, membershipId: string) {
  await requirePerm(db, actorId, companyId, "members.remove");
  // o filtro por company_id impede remover vínculo de outra empresa
  const [m] = await db.select().from(memberships).where(and(eq(memberships.id, membershipId), eq(memberships.companyId, companyId)));
  if (!m) throw new Invalid("Vínculo não encontrado");
  if (m.userId === actorId) throw new Invalid("Você não pode remover o próprio acesso");
  const actorRole = (await activeRole(db, actorId, companyId))!;
  if (!canGrant(actorRole, m.role)) throw new Forbidden();
  await db.transaction(async (tx) => {
    await tx.update(memberships).set({ status: "removed", updatedAt: new Date() }).where(eq(memberships.id, m.id));
    await tx.insert(auditLog).values({ companyId, actorId, action: "member.removed", detail: { userId: m.userId } });
  });
}

export const MIN_PASSWORD = 12;
/** Troca de senha pelo próprio usuário: exige a senha atual (sessão sozinha não basta), limita tentativas e audita (sem valores). */
export async function changePassword(db: DB, userId: string, current: string, next: string) {
  if (next.length < MIN_PASSWORD) throw new Invalid(`A nova senha deve ter ao menos ${MIN_PASSWORD} caracteres`);
  if (next.length > 256) throw new Invalid("Senha longa demais");
  if (next === current) throw new Invalid("A nova senha deve ser diferente da atual");
  if (await hit(db, `pwchange:${userId}`, 5, 15 * 60_000)) throw new Invalid("Muitas tentativas. Aguarde 15 minutos.");
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u || u.disabledAt) throw new Forbidden();
  if (!(await argon2.verify(u.passwordHash, current).catch(() => false))) {
    await db.insert(auditLog).values({ actorId: userId, action: "auth.password_change.failed" });
    throw new Invalid("Senha atual incorreta");
  }
  const passwordHash = await argon2.hash(next, { type: argon2.argon2id });
  await db.transaction(async (tx) => {
    await tx.update(users).set({ passwordHash, sessionVersion: sql`${users.sessionVersion} + 1`, updatedAt: new Date() }).where(eq(users.id, userId)); // sessões abertas (inclusive roubadas) caem
    await tx.insert(auditLog).values({ actorId: userId, action: "auth.password_changed" });
  });
  await clear(db, `pwchange:${userId}`);
}
