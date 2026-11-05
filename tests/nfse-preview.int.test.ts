import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { eq, sql } from "drizzle-orm";
import { databaseUrl } from "@/lib/db/url";
import * as schema from "@/lib/db/schema";
import type { DB } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import { createParty } from "@/modules/crm/service";
import { createContract, decideVersion, getContract } from "@/modules/contracts/service";
import { generateBatch } from "@/modules/billing/batches";
import { updateFiscalProfile } from "@/modules/companies/fiscal";
import { previewNfse } from "@/modules/nfse/preview";

const enabled = !!process.env.POSTGRES_USER;
const NOW = new Date("2026-11-04T15:00:00Z");
const fiscal = (o: Record<string, unknown> = {}) => ({ taxRegime: "simples", municipalRegistration: "123456", cnae: "6190601", serviceCode: "1.07", tribNacCode: "01.07.01", issRate: "2,5", cityName: "Manaus", cityIbge: "1302603", uf: "AM", cep: "69000-000", street: "Av. Exemplo", streetNumber: "100", district: "Centro", ...o });

describe.skipIf(!enabled)("N2a — prévia da NFS-e (DB de teste)", () => {
  let admin: ReturnType<typeof postgres>, conn: ReturnType<typeof postgres>, db: DB;
  let A: string, B: string, dirA: string, dirB: string, asstA: string, contabA: string, chA: string;

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
    await db.execute(sql`truncate charge_invoices, message_queue, message_template_versions, message_templates, charges, billing_batches, holidays, contract_versions, contracts, customer_contacts, customers, audit_log, memberships, companies, users restart identity cascade`);
    const [a, b] = await db.insert(schema.companies).values([{ name: "Empresa A" }, { name: "Empresa B" }]).returning();
    A = a.id; B = b.id;
    const mk = async (e: string) => (await db.insert(schema.users).values({ email: e, name: e, passwordHash: "x" }).returning())[0].id;
    dirA = await mk("dir-a@t.com"); dirB = await mk("dir-b@t.com"); asstA = await mk("asst@t.com"); contabA = await mk("contab@t.com");
    await db.insert(schema.memberships).values([{ userId: dirA, companyId: A, role: "diretoria" }, { userId: dirB, companyId: B, role: "diretoria" }, { userId: asstA, companyId: A, role: "assistente" }, { userId: contabA, companyId: A, role: "contabilidade" }]);
    const cli = (await createParty(db, dirA, A, { kind: "cliente", legalName: "Cliente Um", document: "11.222.333/0001-81" })).id;
    const k = await createContract(db, asstA, A, cli, { description: "Monitoramento", monthlyAmount: "2.500,00", startAt: "2026-01-01", endAt: "", dueDay: "14", invoiceJointRequired: true, issueDayOverride: "" });
    await decideVersion(db, dirA, A, (await getContract(db, dirA, A, k.id))!.versions[0].id, "aprovar");
    const { batchId } = await generateBatch(db, asstA, A, "2026-10-01");
    chA = (await db.select().from(schema.charges).where(eq(schema.charges.batchId, batchId)))[0].id;
  });

  it("sem dados fiscais: lista o que falta, em português, e não monta XML", async () => {
    const p = (await previewNfse(db, asstA, A, chA, NOW))!;
    expect(p.ready).toBe(false); expect(p.xml).toBeNull(); expect(p.dpsId).toBeNull();
    const t = p.problems.join(" | ");
    for (const w of ["CNPJ da empresa", "regime tributário", "IBGE", "tributação nacional"]) expect(t).toContain(w);
    expect(p.summary).toMatchObject({ customer: "Cliente Um", amountCents: 250000, competence: "2026-09" });
  });

  it("com tudo preenchido: monta a DPS de homologação com os dados certos e só lê (não grava nada)", async () => {
    await db.update(schema.companies).set({ cnpj: "11222333000181" }).where(eq(schema.companies.id, A));
    await updateFiscalProfile(db, dirA, A, fiscal());
    const [{ n: before }] = await db.execute(sql`select count(*)::int n from audit_log`) as unknown as { n: number }[];
    const p = (await previewNfse(db, asstA, A, chA, NOW))!;
    expect(p.problems).toEqual([]); expect(p.ready).toBe(true);
    expect(p.xml).toContain("<tpAmb>2</tpAmb>"); expect(p.xml).toContain("<CNPJ>11222333000181</CNPJ>"); expect(p.xml).toContain("<xNome>Cliente Um</xNome>"); expect(p.xml).toContain("<toma><CNPJ>11222333000181</CNPJ>"); // o cliente de teste tem o mesmo CNPJ do prestador (apenas fixture)
    expect(p.xml).toContain("<vServ>2500.00</vServ>"); expect(p.xml).toContain("<cTribNac>010701</cTribNac>"); expect(p.xml).toContain("<dCompet>2026-09-01</dCompet>"); expect(p.xml).toContain("<cLocEmi>1302603</cLocEmi>");
    expect(p.dpsId).toHaveLength(45);
    expect(p.warnings.join(" ")).toMatch(/Endereço do cliente incompleto/); // o cliente de teste não tem endereço
    const [{ n: after }] = await db.execute(sql`select count(*)::int n from audit_log`) as unknown as { n: number }[];
    expect(after).toBe(before);
  });

  it("competência no futuro é recusada; ISS de lucro presumido sem alíquota também", async () => {
    await db.update(schema.companies).set({ cnpj: "11222333000181" }).where(eq(schema.companies.id, A));
    await updateFiscalProfile(db, dirA, A, fiscal({ taxRegime: "presumido", issRate: "" }));
    const p = (await previewNfse(db, asstA, A, chA, new Date("2026-08-15T15:00:00Z")))!;
    expect(p.problems.join("|")).toContain("alíquota do ISS"); expect(p.problems.join("|")).toContain("competência no futuro");
  });

  it("isolamento: outra empresa não vê a cobrança; id inválido devolve nada", async () => {
    expect(await previewNfse(db, dirB, B, chA, NOW)).toBeNull();
    expect(await previewNfse(db, dirA, A, "nao-e-uuid", NOW)).toBeNull();
    await expect(previewNfse(db, dirB, A, chA, NOW)).rejects.toThrow(); // sem vínculo com a empresa A
  });
});
