import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { databaseUrl } from "@/lib/db/url";
import * as schema from "@/lib/db/schema";
import type { DB } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import { getCoraStatus, hasCoraCredentials, removeCoraCredentials, saveCoraCredentials } from "@/modules/providers/cora-config";
import { readCoraCredentials } from "@/modules/providers/cora-secrets";
import { readiness } from "@/modules/providers/readiness";
import { OTHER_KEY, TEST_CERT, TEST_KEY } from "./fixtures/cora-teste";

const enabled = !!process.env.POSTGRES_USER;
const CLIENT_ID = "int-SEGREDO-client-123";
const form = (o: Record<string, string> = {}) => ({ environment: "homologacao", label: "Conta Solutions", clientId: CLIENT_ID, certificate: TEST_CERT, privateKey: TEST_KEY, ...o });

describe.skipIf(!enabled)("E19 credenciais da Cora (DB de teste)", () => {
  let admin: ReturnType<typeof postgres>, conn: ReturnType<typeof postgres>, db: DB;
  let A: string, B: string, dirA: string, dirB: string, gerA: string, techA: string, contA: string;

  beforeAll(async () => {
    process.env.K3G_CREDENTIALS_KEY = "chave-de-teste-0123456789abcdef-0123456789";
    const base = databaseUrl();
    admin = postgres(base.replace(/\/k3gfinance$/, "/postgres"), { max: 1 });
    if (!(await admin`select 1 from pg_database where datname = 'k3gfinance_test'`).length) await admin.unsafe("create database k3gfinance_test");
    conn = postgres(base.replace(/\/k3gfinance$/, "/k3gfinance_test"), { max: 4 });
    db = drizzle(conn, { schema });
    await migrate(db, { migrationsFolder: "./drizzle" });
  });
  afterAll(async () => { await conn?.end(); await admin?.end(); });

  beforeEach(async () => {
    await db.execute(sql`truncate provider_credentials, audit_log, invitations, memberships, companies, users restart identity cascade`);
    const [a, b] = await db.insert(schema.companies).values([{ name: "A" }, { name: "B" }]).returning();
    A = a.id; B = b.id;
    const mk = async (e: string) => (await db.insert(schema.users).values({ email: e, name: e, passwordHash: "x" }).returning())[0].id;
    dirA = await mk("dir-a@t.com"); dirB = await mk("dir-b@t.com"); gerA = await mk("ger@t.com"); techA = await mk("tech@t.com"); contA = await mk("cont@t.com");
    await db.insert(schema.memberships).values([
      { userId: dirA, companyId: A, role: "diretoria" }, { userId: dirB, companyId: B, role: "diretoria" }, { userId: gerA, companyId: A, role: "gerente" },
      { userId: techA, companyId: A, role: "admin_tecnico" }, { userId: contA, companyId: A, role: "contabilidade" },
    ]);
  });

  it("só a diretoria guarda, vê o status e remove", async () => {
    for (const u of [gerA, techA, contA]) {
      await expect(saveCoraCredentials(db, u, A, form())).rejects.toBeInstanceOf(Forbidden);
      await expect(getCoraStatus(db, u, A)).rejects.toBeInstanceOf(Forbidden);
      await expect(removeCoraCredentials(db, u, A, "homologacao")).rejects.toBeInstanceOf(Forbidden);
    }
    await expect(saveCoraCredentials(db, dirB, A, form())).rejects.toBeInstanceOf(Forbidden); // diretoria de OUTRA empresa
  });

  it("guarda CIFRADO: nada em texto puro no banco; status sem segredos; leitura interna devolve o original", async () => {
    const r = await saveCoraCredentials(db, dirA, A, form());
    expect(r.notAfter > "2030-01-01").toBe(true);
    const raw = JSON.stringify(await db.select().from(schema.providerCredentials));
    expect(raw).not.toContain("BEGIN"); expect(raw).not.toContain("SEGREDO"); expect(raw).not.toContain("descartavel");
    const st = await getCoraStatus(db, dirA, A);
    expect(JSON.stringify(st)).not.toMatch(/BEGIN|SEGREDO/);
    expect(st.map((s) => [s.environment, s.configured])).toEqual([["homologacao", true], ["producao", false]]);
    expect(st[0]).toMatchObject({ label: "Conta Solutions" });
    expect(st[0].fingerprint).toHaveLength(16); expect(st[0].daysLeft!).toBeGreaterThan(300);
    const back = await readCoraCredentials(db, A, "homologacao");
    expect(back).toEqual({ clientId: CLIENT_ID, certificate: TEST_CERT.trim(), privateKey: TEST_KEY.trim() });
    expect(await readCoraCredentials(db, A, "producao")).toBeNull();
    expect(await readCoraCredentials(db, B, "homologacao")).toBeNull(); // isolamento
    expect(await hasCoraCredentials(db, dirA, A)).toBe(true); expect(await hasCoraCredentials(db, dirB, B)).toBe(false);
    await expect(hasCoraCredentials(db, gerA, A)).rejects.toBeInstanceOf(Forbidden); await expect(hasCoraCredentials(db, dirB, A)).rejects.toBeInstanceOf(Forbidden);
  });

  it("um valor copiado para outra empresa ou ambiente não decifra", async () => {
    await saveCoraCredentials(db, dirA, A, form());
    await db.execute(sql`update provider_credentials set company_id = ${B}`);
    await expect(readCoraCredentials(db, B, "homologacao")).rejects.toThrow(/ilegível/);
    await db.execute(sql`update provider_credentials set company_id = ${A}, environment = 'producao'`);
    await expect(readCoraCredentials(db, A, "producao")).rejects.toThrow(/ilegível/);
  });

  it("validações: ambiente, certificado, chave que não combina e campos vazios; nada é gravado", async () => {
    await expect(saveCoraCredentials(db, dirA, A, form({ environment: "teste" }))).rejects.toThrow(/Ambiente inválido/);
    await expect(saveCoraCredentials(db, dirA, A, form({ clientId: "x" }))).rejects.toBeInstanceOf(Invalid);
    await expect(saveCoraCredentials(db, dirA, A, form({ certificate: "" }))).rejects.toThrow(/Informe o certificado/);
    await expect(saveCoraCredentials(db, dirA, A, form({ privateKey: OTHER_KEY }))).rejects.toThrow(/não combina/);
    await expect(saveCoraCredentials(db, dirA, A, form(), new Date("2040-01-01T00:00:00Z"))).rejects.toThrow(/vencido/);
    expect(await hasCoraCredentials(db, dirA, A)).toBe(false);
  });

  it("salvar de novo substitui (um por empresa/ambiente); remover apaga de verdade", async () => {
    await saveCoraCredentials(db, dirA, A, form());
    await saveCoraCredentials(db, dirA, A, form({ label: "Outra", clientId: "int-novo-456789" }));
    await saveCoraCredentials(db, dirA, A, form({ environment: "producao" }));
    expect(Number((await db.execute(sql`select count(*)::int n from provider_credentials`))[0].n)).toBe(2);
    expect((await readCoraCredentials(db, A, "homologacao"))!.clientId).toBe("int-novo-456789");
    await removeCoraCredentials(db, dirA, A, "homologacao");
    expect(await readCoraCredentials(db, A, "homologacao")).toBeNull();
    await expect(removeCoraCredentials(db, dirA, A, "homologacao")).rejects.toThrow(/Não há credenciais/);
    await expect(removeCoraCredentials(db, dirB, B, "producao")).rejects.toThrow(/Não há credenciais/); // não toca na outra empresa
    expect(await hasCoraCredentials(db, dirA, A)).toBe(true);
  });

  it("o banco recusa segredo em texto puro", async () => {
    const [{ id }] = await db.select({ id: schema.companies.id }).from(schema.companies).limit(1);
    await expect(db.execute(sql`insert into provider_credentials (company_id, provider, environment, client_id_enc, cert_enc, key_enc, cert_fingerprint, cert_not_after, updated_by)
      values (${id}, 'cora', 'homologacao', 'em-claro', 'v1.a.b.c', 'v1.a.b.c', ${"a".repeat(64)}, '2030-01-01', ${dirA})`)).rejects.toThrow();
  });

  it("auditoria só com ambiente e impressão digital curta; checklist reconhece as credenciais cadastradas", async () => {
    await saveCoraCredentials(db, dirA, A, form());
    await removeCoraCredentials(db, dirA, A, "homologacao");
    const rows = await db.select().from(schema.auditLog).where(sql`action like 'provider.credentials_%'`);
    expect(rows.map((r) => r.action).sort()).toEqual(["provider.credentials_removed", "provider.credentials_saved"]);
    expect(JSON.stringify(rows.map((r) => r.detail))).not.toMatch(/BEGIN|SEGREDO|Solutions|clientId/);
    const item = (inDb: boolean) => readiness({}, { coraInDb: inDb }).find((i) => i.key === "cora-creds")!;
    expect(item(false).state).toBe("pendente"); expect(item(true).state).toBe("ok");
    expect(readiness({}, { coraInDb: true }).find((i) => i.key === "authorization")!.state).toBe("pendente"); // ter credenciais não libera a emissão real
  });
});
