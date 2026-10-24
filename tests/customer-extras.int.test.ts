import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { eq, sql } from "drizzle-orm";
import { databaseUrl } from "@/lib/db/url";
import * as schema from "@/lib/db/schema";
import type { DB } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import { createParty, getParty, updateParty } from "@/modules/crm/service";
import { parseExtras, updateCustomerExtras } from "@/modules/crm/extras";

const enabled = !!process.env.POSTGRES_USER;
const why = (e: unknown) => String((e as { cause?: { message?: string } })?.cause?.message ?? (e as Error)?.message ?? e);

describe("E26 — parseExtras (puro)", () => {
  it("normaliza endereço e valida formatos", () => {
    expect(parseExtras({ cep: "69000-000", uf: "am", cityIbge: "1302603", street: "  Av.  Exemplo ", streetNumber: "", nfText: "  Texto  " })).toEqual({ cep: "69000000", uf: "AM", cityIbge: "1302603", street: "Av. Exemplo", streetNumber: null, nfText: "Texto" });
    expect(parseExtras({ boletoText: "" })).toEqual({ boletoText: null });
    expect(parseExtras({ foo: "x", street: "Rua" })).toEqual({ street: "Rua" }); // chaves desconhecidas são ignoradas
    const bad = (o: Record<string, unknown>, re: RegExp) => expect(() => parseExtras(o)).toThrow(re);
    bad({ cep: "123" }, /CEP deve ter 8/); bad({ cep: "6900x000" }, /só números/); bad({ cityIbge: "12" }, /IBGE deve ter 7/); bad({ uf: "AMA" }, /máximo 2/); bad({ uf: "1a" }, /UF inválida/);
    bad({ street: "x".repeat(161) }, /máximo 160/); bad({ nfText: "x".repeat(1001) }, /máximo 1000/); bad({ boletoText: "x".repeat(401) }, /máximo 400/);
    bad({ nfText: "Olá {{senha}}" }, /Campo desconhecido/); bad({ nfText: "<b>oi</b>" }, /HTML/); bad({ boletoText: "Oi {{cliente" }, /mal formadas/);
  });
});

describe.skipIf(!enabled)("E26 — ajustes do cliente (DB de teste)", () => {
  let admin: ReturnType<typeof postgres>, conn: ReturnType<typeof postgres>, db: DB;
  let A: string, B: string, dirA: string, dirB: string, asstA: string, contA: string, techA: string, cli: string, crm: string;
  beforeAll(async () => {
    const base = databaseUrl();
    admin = postgres(base.replace(/\/k3gfinance$/, "/postgres"), { max: 1 });
    if (!(await admin`select 1 from pg_database where datname = 'k3gfinance_test'`).length) await admin.unsafe("create database k3gfinance_test");
    conn = postgres(base.replace(/\/k3gfinance$/, "/k3gfinance_test"), { max: 4 });
    db = drizzle(conn, { schema });
    await migrate(db, { migrationsFolder: "./drizzle" });
  });
  afterAll(async () => { await conn?.end(); await admin?.end(); });
  beforeEach(async () => {
    await db.execute(sql`truncate customer_contacts, customers, vendors, audit_log, memberships, companies, users restart identity cascade`);
    const [a, b] = await db.insert(schema.companies).values([{ name: "Empresa A", customerMode: "crm" }, { name: "Empresa B" }]).returning(); A = a.id; B = b.id;
    const mk = async (e: string) => (await db.insert(schema.users).values({ email: e, name: e, passwordHash: "x" }).returning())[0].id;
    dirA = await mk("dir-a@t.com"); dirB = await mk("dir-b@t.com"); asstA = await mk("asst@t.com"); contA = await mk("cont@t.com"); techA = await mk("tech@t.com");
    await db.insert(schema.memberships).values([{ userId: dirA, companyId: A, role: "diretoria" }, { userId: dirB, companyId: B, role: "diretoria" }, { userId: asstA, companyId: A, role: "assistente" }, { userId: contA, companyId: A, role: "contabilidade" }, { userId: techA, companyId: A, role: "admin_tecnico" }]);
    cli = (await db.insert(schema.customers).values({ companyId: A, legalName: "Cliente Local", docType: "cnpj", document: "11222333000181", source: "manual" }).returning())[0].id;
    crm = (await db.insert(schema.customers).values({ companyId: A, legalName: "19.534.417 LTDA", tradeName: "GR PLUS SOLUTIONS", docType: "cnpj", document: "19534417000162", source: "crm", externalId: "x1" }).returning())[0].id;
  });

  it("endereço e textos: quem escreve cadastro (assistente, diretoria) edita; contabilidade e admin técnico não; outra empresa não", async () => {
    for (const u of [contA, techA]) await expect(updateCustomerExtras(db, u, A, cli, { street: "x" })).rejects.toBeInstanceOf(Forbidden);
    await expect(updateCustomerExtras(db, dirB, A, cli, { street: "x" })).rejects.toBeInstanceOf(Forbidden);
    await expect(updateCustomerExtras(db, dirB, B, cli, { street: "x" })).rejects.toThrow(/Cliente não encontrado/); // id de outra empresa
    await expect(updateCustomerExtras(db, asstA, A, cli, {})).rejects.toThrow(/Nada para salvar/);
    const r = await updateCustomerExtras(db, asstA, A, cli, { cep: "69000-000", street: "Av. Exemplo", streetNumber: "100", cityName: "Manaus", cityIbge: "1302603", uf: "am" });
    expect(r.changed).toEqual(["CEP", "logradouro", "número", "município", "código IBGE", "UF"]);
    const p = await getParty(db, dirA, A, cli) as unknown as Record<string, unknown>;
    expect(p).toMatchObject({ cep: "69000000", street: "Av. Exemplo", streetNumber: "100", cityName: "Manaus", cityIbge: "1302603", uf: "AM" });
    expect((await updateCustomerExtras(db, asstA, A, cli, { cep: "69000-000" })).changed).toEqual([]); // sem mudança: sem evento novo
  });

  it("atualização PARCIAL: o formulário de textos não apaga o endereço (e vice-versa)", async () => {
    await updateCustomerExtras(db, dirA, A, cli, { street: "Rua A", cep: "69000000" });
    await updateCustomerExtras(db, dirA, A, cli, { nfText: "Serviços — {{competencia}}", boletoText: "Não receber após o vencimento" });
    const [r] = await db.select().from(schema.customers).where(eq(schema.customers.id, cli));
    expect(r).toMatchObject({ street: "Rua A", cep: "69000000", nfText: "Serviços — {{competencia}}", boletoText: "Não receber após o vencimento" });
    await updateCustomerExtras(db, dirA, A, cli, { nfText: "" });
    expect((await db.select().from(schema.customers).where(eq(schema.customers.id, cli)))[0]).toMatchObject({ nfText: null, boletoText: "Não receber após o vencimento", street: "Rua A" });
  });

  it("cliente vindo do CRM: identificação segue somente leitura, mas endereço e textos são editáveis e a sincronização não os apaga", async () => {
    await expect(updateParty(db, dirA, A, crm, { kind: "cliente", legalName: "Outro", document: "19534417000162" })).rejects.toThrow(/CRM/);
    await updateCustomerExtras(db, dirA, A, crm, { street: "Rua do CRM", nfText: "Texto GR" });
    // o que a sincronização grava (mesmas colunas de sync.ts) não toca nos ajustes
    await db.update(schema.customers).set({ legalName: "19.534.417 LTDA", tradeName: "GR PLUS SOLUTIONS", status: "ativo", updatedAt: new Date() }).where(eq(schema.customers.id, crm));
    expect((await db.select().from(schema.customers).where(eq(schema.customers.id, crm)))[0]).toMatchObject({ street: "Rua do CRM", nfText: "Texto GR", displayName: "GR PLUS SOLUTIONS" });
  });

  it("arquivado não edita; auditoria só com nomes dos campos; o banco recusa formatos inválidos", async () => {
    await db.update(schema.customers).set({ archivedAt: new Date() }).where(eq(schema.customers.id, cli));
    await expect(updateCustomerExtras(db, dirA, A, cli, { street: "x" })).rejects.toBeInstanceOf(Invalid);
    await db.update(schema.customers).set({ archivedAt: null }).where(eq(schema.customers.id, cli));
    await updateCustomerExtras(db, dirA, A, cli, { street: "Rua Sigilosa 123", nfText: "Texto sigiloso" });
    const log = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "party.extras_updated"));
    expect(log).toHaveLength(1); expect(JSON.stringify(log)).not.toMatch(/Sigilosa|sigiloso/); expect(log[0].detail).toMatchObject({ partyId: cli, changed: "logradouro, texto da nota fiscal" });
    const f = (q: ReturnType<typeof sql>) => db.execute(q).catch((e) => { throw new Error(why(e)); });
    await expect(f(sql`update customers set cep = '123' where id = ${cli}`)).rejects.toThrow(/customers_extras_chk/);
    await expect(f(sql`update customers set uf = 'am' where id = ${cli}`)).rejects.toThrow(/customers_extras_chk/);
  });
});
