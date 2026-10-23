import { createHash, randomBytes } from "node:crypto";
import argon2 from "argon2";
import { and, eq, sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { auditLog, invitations, memberships, users } from "@/lib/db/schema";
import { can, canGrant, type Permission, type Role } from "./permissions";

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

export async function acceptInvite(db: DB, token: string, name: string, password: string, now = new Date()) {
  if (password.length < 12) throw new Invalid("Senha deve ter ao menos 12 caracteres");
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  return db.transaction(async (tx) => {
    const [inv] = await tx.select().from(invitations).where(eq(invitations.tokenHash, hashToken(token))).for("update");
    if (!inv || inv.acceptedAt || inv.expiresAt < now) throw new Invalid("Convite inválido ou expirado");
    let [u] = await tx.select().from(users).where(eq(sql`lower(${users.email})`, inv.email));
    // usuário existente mantém a senha atual: o link não permite trocá-la
    if (!u) [u] = await tx.insert(users).values({ email: inv.email, name: name.trim() || inv.email, passwordHash }).returning();
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
