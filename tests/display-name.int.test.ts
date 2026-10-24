import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { eq, sql } from "drizzle-orm";
import { databaseUrl } from "@/lib/db/url";
import * as schema from "@/lib/db/schema";
import type { DB } from "@/lib/db";
import { listParties } from "@/modules/crm/service";
import { createContract, getContract, listContracts, customerOptions } from "@/modules/contracts/service";

const enabled = !!process.env.POSTGRES_USER;
const terms = { description: "Link", monthlyAmount: "1.000,00", startAt: "2026-01-01", endAt: "", dueDay: "10", invoiceJointRequired: false, issueDayOverride: "" };

describe("nome para mostrar × razão social (pedido do dono)", () => {
  it("boleto e NFS-e continuam com a RAZÃO SOCIAL (legal_name) do cliente", () => {
    const src = readFileSync("src/modules/issuance/service.ts", "utf8");
    const issue = src.slice(src.indexOf("const [d] = (await db.execute"), src.indexOf("await prov.nfse.issue") + 400);
    expect(issue).toContain("cu.legal_name"); expect(issue).not.toContain("display_name");
  });
});

describe.skipIf(!enabled)("nome para mostrar (coluna gerada display_name; DB de teste)", () => {
  let admin: ReturnType<typeof postgres>, conn: ReturnType<typeof postgres>, db: DB;
  let A: string, dir: string;
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
    await db.execute(sql`truncate contract_versions, contracts, customer_contacts, customers, audit_log, memberships, companies, users restart identity cascade`);
    const [a] = await db.insert(schema.companies).values([{ name: "Empresa A" }]).returning(); A = a.id;
    dir = (await db.insert(schema.users).values({ email: "d@t.com", name: "d", passwordHash: "x" }).returning())[0].id;
    await db.insert(schema.memberships).values({ userId: dir, companyId: A, role: "diretoria" });
  });
  const mk = async (legalName: string, tradeName: string | null, document: string) => (await db.insert(schema.customers).values({ companyId: A, legalName, tradeName, docType: "cnpj", document, source: "crm" }).returning())[0];

  it("razão social que é só o número do CNPJ + fantasia → mostra a fantasia; o resto não muda", async () => {
    const cases: [string, string | null, string][] = [
      ["19.534.417 LTDA", "GR PLUS SOLUTIONS", "GR PLUS SOLUTIONS"], ["19534417 LTDA", "  Fantasia X  ", "Fantasia X"], ["19.534.417", "Fantasia Y", "Fantasia Y"], ["19.534.417 S/A", "Fantasia Z", "Fantasia Z"], ["19.534.417 ltda.", "Fantasia W", "Fantasia W"],
      ["19.534.417/0001-62", "Fantasia CNPJ", "Fantasia CNPJ"], ["19534417000162 LTDA", "Fantasia C2", "Fantasia C2"], ["19.534.417 S.A.", "Fantasia SA", "Fantasia SA"], ["19.534.417 LTDA", null, "19.534.417 LTDA"], ["19.534.417 LTDA", "   ", "19.534.417 LTDA"],
      ["Alfa Redes Ltda", "ALFA", "Alfa Redes Ltda"], ["19.534.417 Comércio LTDA", "XPTO", "19.534.417 Comércio LTDA"], ["K3G 19.534.417 LTDA", "XPTO", "K3G 19.534.417 LTDA"],
    ];
    let i = 0;
    for (const [legal, trade, want] of cases) { const c = await mk(legal, trade, String(11111111000100 + i++).padStart(14, "0")); const [r] = await db.select().from(schema.customers).where(eq(schema.customers.id, c.id)); expect([legal, r.displayName]).toEqual([legal, want]); expect(r.legalName).toBe(legal); }
  });

  it("aparece nas listas e no contrato; a razão social continua guardada e pesquisável", async () => {
    const c = await mk("19.534.417 LTDA", "GR PLUS SOLUTIONS", "19534417000162");
    const k = await createContract(db, dir, A, c.id, terms);
    const list = await listParties(db, dir, A, {});
    expect(list.items[0]).toMatchObject({ displayName: "GR PLUS SOLUTIONS", legalName: "19.534.417 LTDA" });
    expect((await listContracts(db, dir, A, {})).items[0].customerName).toBe("GR PLUS SOLUTIONS");
    expect((await listContracts(db, dir, A, { q: "19.534.417" })).total).toBe(1); // acha pela razão social
    expect((await listContracts(db, dir, A, { q: "GR PLUS" })).total).toBe(1);
    expect((await listParties(db, dir, A, { q: "19.534.417" })).total).toBe(1);
    const full = (await getContract(db, dir, A, k.id))!;
    expect(full.customer).toMatchObject({ displayName: "GR PLUS SOLUTIONS", legalName: "19.534.417 LTDA" });
    expect((await customerOptions(db, dir, A))[0].name).toBe("GR PLUS SOLUTIONS");
  });

  it("a coluna é gerada: o banco não aceita gravar nela", async () => {
    const c = await mk("Alfa", null, "11222333000181");
    await expect(db.execute(sql`update customers set display_name = 'x' where id = ${c.id}`)).rejects.toThrow();
  });
});
