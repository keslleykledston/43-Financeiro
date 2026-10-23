import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { databaseUrl } from "@/lib/db/url";
import * as schema from "@/lib/db/schema";
import type { DB } from "@/lib/db";
import { acceptInvite, activeRole, Forbidden, Invalid, inviteMember, listMembers, removeMember, INVITE_TTL_MS } from "@/modules/identity/service";
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
    await db.execute(sql`truncate audit_log, invitations, memberships, companies, users restart identity cascade`);
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

  it("convite: aceita uma vez, expira em 72h, token só como hash", async () => {
    const token = await inviteMember(db, dirA, A, "Novo@T.com", "gerente");
    const [inv] = await db.select().from(schema.invitations);
    expect(inv.tokenHash).not.toContain(token);
    const uid = await acceptInvite(db, token, "Novo", "senha-bem-longa-123");
    expect(await activeRole(db, uid, A)).toBe("gerente");
    expect(await activeRole(db, uid, B)).toBeNull();
    await expect(acceptInvite(db, token, "Novo", "senha-bem-longa-123")).rejects.toBeInstanceOf(Invalid);

    const old = await inviteMember(db, dirA, A, "velho@t.com", "assistente", new Date(Date.now() - INVITE_TTL_MS - 1000));
    await expect(acceptInvite(db, old, "V", "senha-bem-longa-123")).rejects.toBeInstanceOf(Invalid);
    await expect(acceptInvite(db, "token-falso", "V", "senha-bem-longa-123")).rejects.toBeInstanceOf(Invalid);
    await expect(acceptInvite(db, token, "V", "curta")).rejects.toBeInstanceOf(Invalid);
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
