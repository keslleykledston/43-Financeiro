import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { databaseUrl } from "@/lib/db/url";
import * as schema from "@/lib/db/schema";
import type { DB } from "@/lib/db";
import { hit, loginBlocked } from "@/lib/security/rate-limit";
import argon2 from "argon2";
import { acceptInvite, activeRole, changePassword, isUserActive, Forbidden, Invalid, inviteMember, listMembers, removeMember, INVITE_TTL_MS } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";

const enabled = !!process.env.POSTGRES_USER;
const TEST_DB = "k3gfinance_test";

describe.skipIf(!enabled)("identidade: isolamento multiempresa e RBAC (DB de teste)", () => {
  let admin: ReturnType<typeof postgres>, conn: ReturnType<typeof postgres>, db: DB;
  let A: string, B: string, dirA: string, dirB: string, asstA: string;

  beforeAll(async () => {
    const base = databaseUrl();
    admin = postgres(base.replace(/\/k3gfinance$/, "/postgres"), { max: 1 });
    const ex = await admin`select 1 from pg_database where datname = ${TEST_DB}`;
    if (!ex.length) await admin.unsafe(`create database ${TEST_DB}`);
    conn = postgres(base.replace(/\/k3gfinance$/, `/${TEST_DB}`), { max: 3 });
    db = drizzle(conn, { schema });
    await migrate(db, { migrationsFolder: "./drizzle" });
  });
  afterAll(async () => { await conn?.end(); await admin?.end(); });

  beforeEach(async () => {
    await db.execute(sql`truncate rate_limits, audit_log, invitations, memberships, companies, users restart identity cascade`);
    const [a, b] = await db.insert(schema.companies).values([{ name: "A" }, { name: "B" }]).returning();
    A = a.id; B = b.id;
    const mk = async (email: string) => (await db.insert(schema.users).values({ email, name: email, passwordHash: "x" }).returning())[0].id;
    dirA = await mk("dir-a@t.com"); dirB = await mk("dir-b@t.com"); asstA = await mk("asst-a@t.com");
    await db.insert(schema.memberships).values([
      { userId: dirA, companyId: A, role: "diretoria" },
      { userId: dirB, companyId: B, role: "diretoria" },
      { userId: asstA, companyId: A, role: "assistente" },
    ]);
  });

  it("empresa A não enxerga B (listar, convidar, remover)", async () => {
    await expect(listMembers(db, dirA, B)).rejects.toBeInstanceOf(Forbidden);
    await expect(inviteMember(db, dirA, B, "x@t.com", "gerente")).rejects.toBeInstanceOf(Forbidden);
    const [mB] = await db.select().from(schema.memberships).where(sql`company_id = ${B}`);
    // ID de vínculo de B usado com contexto da empresa A: não pode afetar B
    await expect(removeMember(db, dirA, A, mB.id)).rejects.toBeInstanceOf(Invalid);
    expect(await activeRole(db, dirB, B)).toBe("diretoria");
  });

  it("papéis: assistente não convida; diretoria não cria admin técnico", async () => {
    await expect(inviteMember(db, asstA, A, "x@t.com", "gerente")).rejects.toBeInstanceOf(Forbidden);
    await expect(inviteMember(db, dirA, A, "x@t.com", "admin_tecnico")).rejects.toBeInstanceOf(Forbidden);
    await expect(listMembers(db, asstA, A)).rejects.toBeInstanceOf(Forbidden);
    expect(await listMembers(db, dirA, A)).toHaveLength(2);
  });

  it("convite: aceita uma vez, expira em 72h, token só como hash, e-mail deve bater", async () => {
    const token = await inviteMember(db, dirA, A, "Novo@T.com", "gerente");
    const [inv] = await db.select().from(schema.invitations);
    expect(inv.tokenHash).not.toContain(token);
    const SENHA = "senha-bem-longa-123";
    await expect(acceptInvite(db, token, "outro@t.com", "Novo", SENHA)).rejects.toBeInstanceOf(Invalid);
    const uid = await acceptInvite(db, token, "novo@t.com", "Novo", SENHA);
    expect(await activeRole(db, uid, A)).toBe("gerente");
    expect(await activeRole(db, uid, B)).toBeNull();
    await expect(acceptInvite(db, token, "novo@t.com", "Novo", SENHA)).rejects.toBeInstanceOf(Invalid);

    const old = await inviteMember(db, dirA, A, "velho@t.com", "assistente", new Date(Date.now() - INVITE_TTL_MS - 1000));
    await expect(acceptInvite(db, old, "velho@t.com", "V", SENHA)).rejects.toBeInstanceOf(Invalid);
    await expect(acceptInvite(db, "token-falso", "x@t.com", "V", SENHA)).rejects.toBeInstanceOf(Invalid);
    const t2 = await inviteMember(db, dirA, A, "curta@t.com", "assistente");
    await expect(acceptInvite(db, t2, "curta@t.com", "V", "curta")).rejects.toBeInstanceOf(Invalid);
  });

  it("P1: convite para conta existente exige a senha atual (link não basta)", async () => {
    const real = "senha-real-da-conta-1";
    await db.update(schema.users).set({ passwordHash: await argon2.hash(real) }).where(sql`id = ${dirB}`);
    const token = await inviteMember(db, dirA, A, "dir-b@t.com", "gerente");
    await expect(acceptInvite(db, token, "dir-b@t.com", "X", "outra-senha-qualquer-9")).rejects.toBeInstanceOf(Invalid);
    expect(await activeRole(db, dirB, A)).toBeNull();
    await acceptInvite(db, token, "dir-b@t.com", "X", real);
    expect(await activeRole(db, dirB, A)).toBe("gerente");
    const [u] = await db.select().from(schema.users).where(sql`id = ${dirB}`);
    expect(await argon2.verify(u.passwordHash, real)).toBe(true); // senha não foi trocada pelo link
  });

  it("troca de senha: exige a atual, mínimo 12, diferente da atual, audita sem valores e limita tentativas", async () => {
    const atual = "senha-atual-do-usuario-1", nova = "senha-nova-do-usuario-22";
    await db.update(schema.users).set({ passwordHash: await argon2.hash(atual) }).where(sql`id = ${asstA}`);
    await expect(changePassword(db, asstA, "errada-errada-errada", nova)).rejects.toThrow(/atual incorreta/);
    await expect(changePassword(db, asstA, atual, "curta")).rejects.toThrow(/12 caracteres/);
    await expect(changePassword(db, asstA, atual, atual)).rejects.toThrow(/diferente/);
    const [u0] = await db.select().from(schema.users).where(sql`id = ${asstA}`);
    expect(await argon2.verify(u0.passwordHash, atual)).toBe(true); // nada mudou nas recusas
    await changePassword(db, asstA, atual, nova);
    const [u1] = await db.select().from(schema.users).where(sql`id = ${asstA}`);
    expect(await argon2.verify(u1.passwordHash, nova)).toBe(true); expect(await argon2.verify(u1.passwordHash, atual)).toBe(false);
    const audits = await db.select().from(schema.auditLog).where(sql`actor_id = ${asstA} and action like 'auth.password%'`);
    expect(audits.map((a) => a.action).sort()).toEqual(["auth.password_change.failed", "auth.password_changed"]);
    expect(JSON.stringify(audits)).not.toContain(nova); expect(JSON.stringify(audits)).not.toContain(atual);
    // força bruta com a sessão roubada: 5 tentativas erradas e bloqueia, mesmo com a senha certa
    for (let i = 0; i < 5; i++) await changePassword(db, asstA, "errada-errada-errada", "outra-senha-nova-33").catch(() => {});
    await expect(changePassword(db, asstA, nova, "outra-senha-nova-33")).rejects.toThrow(/Muitas tentativas/);
    // outro usuário não é afetado pelo bloqueio
    await db.update(schema.users).set({ passwordHash: await argon2.hash(atual) }).where(sql`id = ${dirA}`);
    await changePassword(db, dirA, atual, nova);
  });

  it("P1: conta desabilitada deixa de ser ativa", async () => {
    expect(await isUserActive(db, asstA)).toBe(true);
    await db.update(schema.users).set({ disabledAt: new Date() }).where(sql`id = ${asstA}`);
    expect(await isUserActive(db, asstA)).toBe(false);
    expect(await isUserActive(db, "00000000-0000-0000-0000-000000000000")).toBe(false);
  });

  it("P1: rate limit compartilhado no DB; IP isolado não trava a conta de outro IP", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    for (let i = 0; i < 3; i++) expect(await hit(db, "k", 3, 1000, now)).toBe(false);
    expect(await hit(db, "k", 3, 1000, now)).toBe(true);
    expect(await hit(db, "k", 3, 1000, new Date(now.getTime() + 2000))).toBe(false); // janela expirou
    for (let i = 0; i < 6; i++) await loginBlocked(db, "vitima@t.com", "1.1.1.1", now); // atacante, 1 IP
    expect(await loginBlocked(db, "vitima@t.com", "1.1.1.1", now)).toBe(true);
    expect(await loginBlocked(db, "vitima@t.com", "2.2.2.2", now)).toBe(false); // dono legítimo, outro IP
  });

  it("usuário removido perde acesso; não remove a si mesmo; gera auditoria", async () => {
    const [m] = await db.select().from(schema.memberships).where(sql`user_id = ${asstA}`);
    await removeMember(db, dirA, A, m.id);
    expect(await activeRole(db, asstA, A)).toBeNull();
    await expect(listMembers(db, asstA, A)).rejects.toBeInstanceOf(Forbidden);
    const [self] = await db.select().from(schema.memberships).where(sql`user_id = ${dirA}`);
    await expect(removeMember(db, dirA, A, self.id)).rejects.toBeInstanceOf(Invalid);
    const log = await db.select().from(schema.auditLog).where(sql`action = 'member.removed'`);
    expect(log).toHaveLength(1);
  });
});

describe("permissões", () => {
  it("admin técnico gere acessos mas não lê dados financeiros", () => {
    expect(can("admin_tecnico", "members.invite")).toBe(true);
    expect(can("admin_tecnico", "finance.read")).toBe(false);
    expect(can("contabilidade", "members.read")).toBe(false);
  });
});
