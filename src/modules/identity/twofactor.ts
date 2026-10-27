import argon2 from "argon2";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { auditLog, userRecoveryCodes, users } from "@/lib/db/schema";
import { hit } from "@/lib/security/rate-limit";
import { open, seal } from "@/lib/security/secretbox";
import { RECOVERY_COUNT, generateRecoveryCode, generateSecret, groupSecret, hashRecovery, looksLikeRecovery, otpauthUri, verifyTotp } from "@/lib/security/totp";
import { Invalid } from "./service";
import { adminTarget } from "./recovery";

/**
 * E28 — verificação em duas etapas (TOTP) + códigos de recuperação.
 *  - Opcional para todos; recomendada (e lembrada na tela) para diretoria e admin técnico.
 *  - O segredo fica CIFRADO no banco, ligado ao usuário. O código de 6 dígitos só vale uma vez (guardamos o último passo aceito).
 *  - Errar o código trava a conta por alguns minutos (5 erros em 15 min). Códigos de recuperação valem uma vez; o hash é o que fica no banco.
 *  - Ativar, desligar e gerar novos códigos pedem a senha e/ou um código atual: uma sessão roubada sozinha não desliga o 2FA.
 *  - Quem perdeu o aparelho e os códigos: a diretoria (ou o admin técnico para papéis abaixo) remove o 2FA do membro, ou o servidor (script de operação).
 */
export const ISSUER = "K3G Finance";
const WINDOW = 15 * 60_000;
const ctxOf = (userId: string) => `user|${userId}|totp`;
const audit = (x: DB, actorId: string | null, action: string, detail: Record<string, unknown> = {}) => x.insert(auditLog).values({ actorId, action, detail });

export type TwoFactorStatus = { enabled: boolean; enabledAt: Date | null; recoveryLeft: number };
export async function twoFactorStatus(db: DB, userId: string): Promise<TwoFactorStatus> {
  const [u] = await db.select({ at: users.totpEnabledAt }).from(users).where(eq(users.id, userId));
  if (!u) throw new Invalid("Usuário não encontrado");
  const [c] = await db.select({ n: sql<number>`count(*)::int` }).from(userRecoveryCodes).where(and(eq(userRecoveryCodes.userId, userId), isNull(userRecoveryCodes.usedAt)));
  return { enabled: !!u.at, enabledAt: u.at, recoveryLeft: u.at ? c.n : 0 };
}

async function checkPassword(db: DB, userId: string, password: string): Promise<{ email: string }> {
  if (await hit(db, `2fa-pw:${userId}`, 5, WINDOW)) throw new Invalid("Muitas tentativas. Aguarde alguns minutos.");
  const [u] = await db.select({ email: users.email, hash: users.passwordHash, disabledAt: users.disabledAt }).from(users).where(eq(users.id, userId));
  if (!u || u.disabledAt || !(await argon2.verify(u.hash, String(password ?? "")).catch(() => false))) throw new Invalid("Senha incorreta");
  return { email: u.email };
}

/** Passo 1 da ativação: confere a senha e gera um segredo NOVO (ainda não vale). Repetir gera outro e descarta o anterior. */
export async function beginEnroll(db: DB, userId: string, password: string) {
  const { email } = await checkPassword(db, userId, password);
  const [u] = await db.select({ at: users.totpEnabledAt }).from(users).where(eq(users.id, userId));
  if (u?.at) throw new Invalid("A verificação em duas etapas já está ativa");
  const secret = generateSecret();
  await db.update(users).set({ totpPending: seal(secret, ctxOf(userId)), updatedAt: new Date() }).where(eq(users.id, userId));
  return { secret, grouped: groupSecret(secret), uri: otpauthUri(ISSUER, email, secret) };
}

const newCodes = () => Array.from({ length: RECOVERY_COUNT }, generateRecoveryCode);
async function storeCodes(x: DB, userId: string, codes: string[]) {
  await x.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId));
  await x.insert(userRecoveryCodes).values(codes.map((c) => ({ userId, codeHash: hashRecovery(c) })));
}

/** Passo 2: o código do aplicativo confirma que o segredo foi guardado. Só então liga e devolve os códigos de recuperação (mostrados UMA vez). */
export async function confirmEnroll(db: DB, userId: string, code: string, now = new Date()): Promise<{ recoveryCodes: string[] }> {
  if (await hit(db, `2fa-confirm:${userId}`, 8, WINDOW, now)) throw new Invalid("Muitas tentativas. Aguarde alguns minutos.");
  return db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    const [u] = await x.select().from(users).where(eq(users.id, userId)).for("update");
    if (!u) throw new Invalid("Usuário não encontrado");
    if (u.totpEnabledAt) throw new Invalid("A verificação em duas etapas já está ativa");
    if (!u.totpPending) throw new Invalid("Comece a ativação de novo (informe a senha)");
    const secret = open(u.totpPending, ctxOf(userId));
    const step = verifyTotp(secret, code, now, null);
    if (step === null) throw new Invalid("Código incorreto. Confira o aplicativo e a hora do celular.");
    const codes = newCodes();
    await x.update(users).set({ totpSecret: seal(secret, ctxOf(userId)), totpPending: null, totpEnabledAt: now, totpLastStep: step, updatedAt: now }).where(eq(users.id, userId));
    await storeCodes(x, userId, codes);
    await audit(x, userId, "auth.2fa_enabled");
    return { recoveryCodes: codes };
  });
}

/**
 * Segundo fator do login e de ações sensíveis: código do aplicativo OU código de recuperação. true = vale (e foi consumido).
 * Nunca revela o motivo da recusa. Trava por usuário (5 erros em 15 min).
 */
export async function verifySecondFactor(db: DB, userId: string, code: string, now = new Date()): Promise<boolean> {
  if (await hit(db, `2fa-login:${userId}`, 5, WINDOW, now)) return false;
  const [u] = await db.select({ secret: users.totpSecret, last: users.totpLastStep }).from(users).where(eq(users.id, userId));
  if (!u?.secret) return false;
  let ok = false;
  if (looksLikeRecovery(code)) {
    const r = await db.update(userRecoveryCodes).set({ usedAt: now, updatedAt: now }).where(and(eq(userRecoveryCodes.userId, userId), eq(userRecoveryCodes.codeHash, hashRecovery(code)), isNull(userRecoveryCodes.usedAt))).returning({ id: userRecoveryCodes.id });
    ok = r.length === 1;
    if (ok) await audit(db, userId, "auth.2fa_recovery_used");
  } else {
    let secret: string;
    try { secret = open(u.secret, ctxOf(userId)); } catch { return false; }
    const step = verifyTotp(secret, code, now, u.last);
    if (step !== null) { // grava o passo só se ninguém usou um igual ou maior nesse meio-tempo (uso simultâneo do mesmo código)
      const r = await db.update(users).set({ totpLastStep: step }).where(and(eq(users.id, userId), sql`(${users.totpLastStep} is null or ${users.totpLastStep} < ${step})`)).returning({ id: users.id });
      ok = r.length === 1;
    }
  }
  if (ok) await db.execute(sql`delete from rate_limits where key = ${`2fa-login:${userId}`}`);
  return ok;
}

/** Desliga: exige a senha E um código atual (ou de recuperação). Apaga o segredo e os códigos. */
export async function disableTwoFactor(db: DB, userId: string, password: string, code: string, now = new Date()) {
  await checkPassword(db, userId, password);
  const st = await twoFactorStatus(db, userId);
  if (!st.enabled) throw new Invalid("A verificação em duas etapas não está ativa");
  if (!(await verifySecondFactor(db, userId, code, now))) throw new Invalid("Código incorreto");
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await x.update(users).set({ totpSecret: null, totpPending: null, totpEnabledAt: null, totpLastStep: null, updatedAt: now }).where(eq(users.id, userId));
    await x.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId));
    await audit(x, userId, "auth.2fa_disabled");
  });
}

/** Novos códigos de recuperação (os antigos deixam de valer). Exige um código atual do aplicativo. */
export async function regenerateRecoveryCodes(db: DB, userId: string, code: string, now = new Date()): Promise<{ recoveryCodes: string[] }> {
  const st = await twoFactorStatus(db, userId);
  if (!st.enabled) throw new Invalid("A verificação em duas etapas não está ativa");
  if (looksLikeRecovery(code) || !(await verifySecondFactor(db, userId, code, now))) throw new Invalid("Informe o código de 6 dígitos do aplicativo");
  const codes = newCodes();
  await db.transaction(async (tx) => { const x = tx as unknown as DB; await storeCodes(x, userId, codes); await audit(x, userId, "auth.2fa_recovery_regenerated"); });
  return { recoveryCodes: codes };
}

async function wipe(x: DB, userId: string, now: Date) {
  await x.update(users).set({ totpSecret: null, totpPending: null, totpEnabledAt: null, totpLastStep: null, sessionVersion: sql`${users.sessionVersion} + 1`, updatedAt: now }).where(eq(users.id, userId)); // derruba as sessões abertas
  await x.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId));
  await x.execute(sql`delete from rate_limits where key = ${`2fa-login:${userId}`}`);
}

/** Quem administra acessos remove o 2FA de um membro que perdeu o aparelho (mesmas regras do link de senha). A pessoa entra só com a senha e deve ativar de novo. */
export async function adminResetTwoFactor(db: DB, actorId: string, companyId: string, membershipId: string, now = new Date()) {
  const m = await adminTarget(db, actorId, companyId, membershipId, "remover o 2FA");
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    const [u] = await x.select({ at: users.totpEnabledAt }).from(users).where(eq(users.id, m.userId)).for("update");
    if (!u?.at) throw new Invalid("Este membro não usa verificação em duas etapas");
    await wipe(x, m.userId, now);
    await x.insert(auditLog).values({ companyId, actorId, action: "member.2fa_reset", detail: { userId: m.userId } });
  });
}

/** Só scripts de operação no servidor (alguém ficou sem acesso e ninguém pode remover). */
export async function resetTwoFactorForOps(db: DB, email: string, now = new Date()) {
  const [u] = await db.select({ id: users.id, at: users.totpEnabledAt }).from(users).where(eq(sql`lower(${users.email})`, email.trim().toLowerCase()));
  if (!u) throw new Invalid("Usuário não encontrado");
  if (!u.at) throw new Invalid("Este usuário não usa verificação em duas etapas");
  await db.transaction(async (tx) => { const x = tx as unknown as DB; await wipe(x, u.id, now); await audit(x, u.id, "auth.2fa_reset_ops"); });
}
