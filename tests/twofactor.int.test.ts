import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import argon2 from "argon2";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { eq, sql } from "drizzle-orm";
import { databaseUrl } from "@/lib/db/url";
import * as schema from "@/lib/db/schema";
import type { DB } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import { adminResetTwoFactor, beginEnroll, confirmEnroll, disableTwoFactor, regenerateRecoveryCodes, resetTwoFactorForOps, twoFactorStatus, verifySecondFactor } from "@/modules/identity/twofactor";
import { hotp, stepOf } from "@/lib/security/totp";

const enabled = !!process.env.POSTGRES_USER;
const PW = "senha-original-do-usuario-1";
const T0 = new Date("2026-10-27T12:00:00Z");
const at = (s: number) => new Date(T0.getTime() + s * 1000);
const codeAt = (secret: string, d: Date, shift = 0) => hotp(secret.replace(/\s/g, ""), stepOf(d) + shift);

describe.skipIf(!enabled)("E28 — verificação em duas etapas (DB de teste)", () => {
  let admin: ReturnType<typeof postgres>, conn: ReturnType<typeof postgres>, db: DB;
  let A: string, B: string, dirA: string, dirB: string, gerA: string, admA: string, multi: string, mA: string, mDir: string;
  const user = async (id: string) => (await db.select().from(schema.users).where(eq(schema.users.id, id)))[0];
  const actions = async () => (await db.select().from(schema.auditLog)).map((a) => a.action);

  beforeAll(async () => {
    process.env.K3G_CREDENTIALS_KEY = "k".repeat(40);
    const base = databaseUrl();
    admin = postgres(base.replace(/\/k3gfinance$/, "/postgres"), { max: 1 });
    if (!(await admin`select 1 from pg_database where datname = 'k3gfinance_test'`).length) await admin.unsafe("create database k3gfinance_test");
    conn = postgres(base.replace(/\/k3gfinance$/, "/k3gfinance_test"), { max: 4 });
    db = drizzle(conn, { schema });
    await migrate(db, { migrationsFolder: "./drizzle" });
  });
  afterAll(async () => { await conn?.end(); await admin?.end(); });

  beforeEach(async () => {
    await db.execute(sql`truncate user_recovery_codes, rate_limits, audit_log, invitations, memberships, companies, users restart identity cascade`);
    const [a, b] = await db.insert(schema.companies).values([{ name: "Empresa A" }, { name: "Empresa B" }]).returning();
    A = a.id; B = b.id;
    const hash = await argon2.hash(PW, { type: argon2.argon2id });
    const mk = async (e: string) => (await db.insert(schema.users).values({ email: e, name: e, passwordHash: hash }).returning())[0].id;
    dirA = await mk("dir-a@t.com"); dirB = await mk("dir-b@t.com"); gerA = await mk("ger@t.com"); admA = await mk("adm@t.com"); multi = await mk("multi@t.com");
    const ms = await db.insert(schema.memberships).values([
      { userId: dirA, companyId: A, role: "diretoria" }, { userId: dirB, companyId: B, role: "diretoria" }, { userId: gerA, companyId: A, role: "gerente" },
      { userId: admA, companyId: A, role: "admin_tecnico" }, { userId: multi, companyId: A, role: "gerente" }, { userId: multi, companyId: B, role: "diretoria" },
    ]).returning();
    mA = ms.find((m) => m.userId === gerA)!.id; mDir = ms.find((m) => m.userId === dirA)!.id;
  });

  const enroll = async (id: string, now = T0) => {
    const b = await beginEnroll(db, id, PW);
    const r = await confirmEnroll(db, id, codeAt(b.secret, now), now);
    return { secret: b.secret.replace(/\s/g, ""), codes: r.recoveryCodes };
  };

  it("ativar: pede a senha, só vale com código certo, devolve 10 códigos e guarda segredo CIFRADO", async () => {
    await expect(beginEnroll(db, gerA, "senha-errada-123456")).rejects.toThrow(/Senha incorreta/);
    const b = await beginEnroll(db, gerA, PW);
    expect(b.uri).toMatch(/^otpauth:\/\/totp\/K3G%20Finance:ger%40t\.com\?secret=/);
    expect((await user(gerA)).totpPending).toBeTruthy();
    expect((await user(gerA)).totpPending).not.toContain(b.secret.replace(/\s/g, "")); // cifrado
    await expect(confirmEnroll(db, gerA, "000000", T0)).rejects.toThrow(/Código incorreto/);
    expect((await twoFactorStatus(db, gerA)).enabled).toBe(false);
    const r = await confirmEnroll(db, gerA, codeAt(b.secret, T0), T0);
    expect(r.recoveryCodes).toHaveLength(10); expect(new Set(r.recoveryCodes).size).toBe(10);
    const u = await user(gerA);
    expect(u.totpEnabledAt).toBeTruthy(); expect(u.totpPending).toBeNull(); expect(u.totpSecret).not.toContain(b.secret.replace(/\s/g, ""));
    expect(await twoFactorStatus(db, gerA)).toMatchObject({ enabled: true, recoveryLeft: 10 });
    const stored = await db.select().from(schema.userRecoveryCodes);
    expect(stored.every((c) => !r.recoveryCodes.some((p) => c.codeHash.includes(p.replace("-", ""))))).toBe(true); // só hash
    await expect(beginEnroll(db, gerA, PW)).rejects.toThrow(/já está ativa/);
    expect(await actions()).toContain("auth.2fa_enabled");
  });

  it("login: código vale uma vez (reuso recusado), próximo passo vale, janela ±1, fora disso não", async () => {
    const { secret } = await enroll(gerA);
    expect(await verifySecondFactor(db, gerA, codeAt(secret, T0), T0)).toBe(false); // o passo do cadastro já foi usado
    expect(await verifySecondFactor(db, gerA, codeAt(secret, at(30), 0), at(30))).toBe(true);
    expect(await verifySecondFactor(db, gerA, codeAt(secret, at(30), 0), at(30))).toBe(false); // reuso
    expect(await verifySecondFactor(db, gerA, codeAt(secret, at(150), 0), at(150))).toBe(true);
    expect(await verifySecondFactor(db, gerA, codeAt(secret, at(150), -1), at(150))).toBe(false); // passo anterior ao último aceito
    expect(await verifySecondFactor(db, gerA, codeAt(secret, at(400), 3), at(400))).toBe(false); // fora da janela
    expect(await verifySecondFactor(db, dirA, "123456", T0)).toBe(false); // quem não tem 2FA nunca passa por aqui
  });

  it("uso simultâneo do MESMO código: só um passa", async () => {
    const { secret } = await enroll(gerA);
    const c = codeAt(secret, at(60));
    const r = await Promise.all([verifySecondFactor(db, gerA, c, at(60)), verifySecondFactor(db, gerA, c, at(60)), verifySecondFactor(db, gerA, c, at(60))]);
    expect(r.filter(Boolean)).toHaveLength(1);
  });

  it("trava depois de 5 erros e volta ao acertar antes disso", async () => {
    const { secret } = await enroll(gerA);
    for (let i = 0; i < 4; i++) expect(await verifySecondFactor(db, gerA, "000000", at(60))).toBe(false);
    expect(await verifySecondFactor(db, gerA, codeAt(secret, at(60)), at(60))).toBe(true); // acertou: zera a contagem
    for (let i = 0; i < 5; i++) await verifySecondFactor(db, gerA, "000000", at(90));
    expect(await verifySecondFactor(db, gerA, codeAt(secret, at(120)), at(120))).toBe(false); // travado, mesmo com o código certo
  });

  it("código de recuperação vale uma vez, em qualquer caixa/formato", async () => {
    const { codes } = await enroll(gerA);
    expect(await verifySecondFactor(db, gerA, codes[0].toLowerCase(), T0)).toBe(true);
    expect(await verifySecondFactor(db, gerA, codes[0], T0)).toBe(false);
    expect(await verifySecondFactor(db, gerA, codes[1].replace("-", " "), T0)).toBe(true);
    expect(await twoFactorStatus(db, gerA)).toMatchObject({ recoveryLeft: 8 });
    expect(await actions()).toContain("auth.2fa_recovery_used");
  });

  it("novos códigos: exigem código do aplicativo (não de recuperação) e invalidam os antigos", async () => {
    const { secret, codes } = await enroll(gerA);
    await expect(regenerateRecoveryCodes(db, gerA, codes[0], at(30))).rejects.toThrow(/6 dígitos/);
    const r = await regenerateRecoveryCodes(db, gerA, codeAt(secret, at(30)), at(30));
    expect(r.recoveryCodes).toHaveLength(10);
    expect(await verifySecondFactor(db, gerA, codes[2], at(30))).toBe(false); // antigo morreu
    expect(await verifySecondFactor(db, gerA, r.recoveryCodes[0], at(30))).toBe(true);
  });

  it("desligar: exige senha E código; apaga tudo", async () => {
    const { secret } = await enroll(gerA);
    await expect(disableTwoFactor(db, gerA, "errada-errada-123", codeAt(secret, at(30)), at(30))).rejects.toThrow(/Senha incorreta/);
    await expect(disableTwoFactor(db, gerA, PW, "000000", at(30))).rejects.toThrow(/Código incorreto/);
    expect((await twoFactorStatus(db, gerA)).enabled).toBe(true);
    await disableTwoFactor(db, gerA, PW, codeAt(secret, at(60)), at(60));
    const u = await user(gerA);
    expect(u.totpSecret).toBeNull(); expect(u.totpEnabledAt).toBeNull(); expect(u.totpLastStep).toBeNull();
    expect(await db.select().from(schema.userRecoveryCodes)).toHaveLength(0);
    await expect(disableTwoFactor(db, gerA, PW, "123456", at(90))).rejects.toThrow(/não está ativa/);
  });

  it("remoção pelo administrador: mesmas regras do link de senha; derruba sessões; auditada", async () => {
    await enroll(gerA);
    const sv = (await user(gerA)).sessionVersion;
    await expect(adminResetTwoFactor(db, gerA, A, mA)).rejects.toBeInstanceOf(Forbidden); // gerente não administra acessos
    await expect(adminResetTwoFactor(db, admA, A, mDir)).rejects.toBeInstanceOf(Forbidden); // admin técnico não mexe na diretoria
    await expect(adminResetTwoFactor(db, dirB, A, mA)).rejects.toBeInstanceOf(Forbidden); // outra empresa
    await adminResetTwoFactor(db, dirA, A, mA);
    const u = await user(gerA);
    expect(u.totpEnabledAt).toBeNull(); expect(u.sessionVersion).toBe(sv + 1);
    expect(await actions()).toContain("member.2fa_reset");
    await expect(adminResetTwoFactor(db, dirA, A, mA)).rejects.toThrow(/não usa verificação/);
  });

  it("administrador não remove o 2FA de quem também administra outra empresa onde ele não pode", async () => {
    await enroll(multi);
    const [mm] = await db.select().from(schema.memberships).where(sql`${schema.memberships.userId} = ${multi} and ${schema.memberships.companyId} = ${A}`);
    await expect(adminResetTwoFactor(db, admA, A, mm.id)).rejects.toBeInstanceOf(Forbidden);
    expect((await twoFactorStatus(db, multi)).enabled).toBe(true);
  });

  it("script de operação remove o 2FA e derruba as sessões", async () => {
    await enroll(dirA);
    const sv = (await user(dirA)).sessionVersion;
    await resetTwoFactorForOps(db, "DIR-A@t.com");
    expect((await twoFactorStatus(db, dirA)).enabled).toBe(false); expect((await user(dirA)).sessionVersion).toBe(sv + 1);
    await expect(resetTwoFactorForOps(db, "dir-a@t.com")).rejects.toThrow(Invalid);
    await expect(resetTwoFactorForOps(db, "nao@existe.com")).rejects.toThrow(/não encontrado/);
  });

  it("segredo copiado para outro usuário não decifra (cofre ligado ao usuário)", async () => {
    await enroll(gerA);
    const s = (await user(gerA)).totpSecret!;
    await db.execute(sql`update users set totp_secret = ${s}, totp_enabled_at = now() where id = ${admA}`);
    expect(await verifySecondFactor(db, admA, "123456", T0)).toBe(false);
  });
});
