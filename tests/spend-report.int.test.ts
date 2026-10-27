import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { databaseUrl } from "@/lib/db/url";
import * as schema from "@/lib/db/schema";
import type { DB } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import { createParty } from "@/modules/crm/service";
import { approvePayable, cancelPayable, createPayable, registerPayablePayment, reversePayablePayment, submitPayable } from "@/modules/payables/service";
import { saveCostCenter } from "@/modules/expenses/catalog";
import { exportSpendReport, reportRange, spendReport } from "@/modules/payables/report";

const enabled = !!process.env.POSTGRES_USER;
const TODAY = "2026-10-25";

describe("relatório de despesas — período", () => {
  it("padrão = últimos 6 meses; valida ordem e limite de 24 meses", () => {
    expect(reportRange(undefined, undefined, TODAY)).toMatchObject({ from: "2026-05", to: "2026-10" });
    expect(() => reportRange("2026-10", "2026-01", TODAY)).toThrow(Invalid);
    expect(() => reportRange("2023-01", "2026-10", TODAY)).toThrow(/24 meses/);
    expect(reportRange("2026-01", "2026-01", TODAY).months).toEqual(["2026-01"]);
    expect(reportRange("", "", TODAY).to).toBe("2026-10"); // vazio = padrão
    expect(() => reportRange("2026-13", undefined, TODAY)).toThrow(/inválido/); // preenchido e errado = recusa, nunca troca em silêncio
    expect(() => reportRange("abc", "2026-10", TODAY)).toThrow(/inválido/);
  });
});

describe.skipIf(!enabled)("relatório de despesas por categoria/mês/centro (DB de teste)", () => {
  let admin: ReturnType<typeof postgres>, conn: ReturnType<typeof postgres>, db: DB;
  let A: string, B: string, dirA: string, dirB: string, gerA: string, assA: string, vend: string, cc: string;

  beforeAll(async () => {
    const base = databaseUrl();
    admin = postgres(base.replace(/\/k3gfinance$/, "/postgres"), { max: 1 });
    if (!(await admin`select 1 from pg_database where datname = 'k3gfinance_test'`).length) await admin.unsafe("create database k3gfinance_test");
    conn = postgres(base.replace(/\/k3gfinance$/, "/k3gfinance_test"), { max: 5 });
    db = drizzle(conn, { schema });
    await migrate(db, { migrationsFolder: "./drizzle" });
  });
  afterAll(async () => { await conn?.end(); await admin?.end(); });

  beforeEach(async () => {
    await db.execute(sql`truncate payable_payments, payables, payable_series, payable_templates, payables_settings, cost_centers, expense_categories, vendor_contacts, vendors, audit_log, invitations, memberships, companies, users restart identity cascade`);
    const [a, b] = await db.insert(schema.companies).values([{ name: "Empresa A" }, { name: "Empresa B" }]).returning();
    A = a.id; B = b.id;
    const mk = async (e: string) => (await db.insert(schema.users).values({ email: e, name: e, passwordHash: "x" }).returning())[0].id;
    dirA = await mk("dir-a@t.com"); dirB = await mk("dir-b@t.com"); gerA = await mk("ger@t.com"); assA = await mk("ass@t.com");
    await db.insert(schema.memberships).values([{ userId: dirA, companyId: A, role: "diretoria" }, { userId: dirB, companyId: B, role: "diretoria" }, { userId: gerA, companyId: A, role: "gerente" }, { userId: assA, companyId: A, role: "assistente" }]);
    vend = (await createParty(db, dirA, A, { kind: "fornecedor", legalName: "Fornecedor Um", document: "12.ABC.345/01DE-35" })).id;
    cc = await saveCostCenter(db, dirA, A, { name: "Operação" });
  });

  const pay = async (desc: string, amount: string, due: string, paidAt: string | null, extra: Record<string, unknown> = {}) => {
    const id = await createPayable(db, dirA, A, { vendorId: vend, description: desc, amount, dueDate: due, ...extra });
    await submitPayable(db, dirA, A, id); await approvePayable(db, gerA, A, id);
    if (paidAt) await registerPayablePayment(db, gerA, A, id, { amount, paidAt, method: "pix" }, TODAY);
    return id;
  };

  it("base 'pago': agrupa por categoria, centro e mês do pagamento; ignora estorno, cancelada e não aprovadas", async () => {
    const [c1] = await db.select().from(schema.expenseCategories).where(sql`${schema.expenseCategories.companyId} = ${A} and ${schema.expenseCategories.code} = 'aluguel'`);
    await pay("Aluguel set", "1.000,00", "2026-09-10", "2026-09-10", { categoryId: c1.id, costCenterId: cc });
    await pay("Aluguel out", "1.100,00", "2026-10-10", "2026-10-09", { categoryId: c1.id, costCenterId: cc });
    await pay("Sem classe", "200,00", "2026-10-12", "2026-10-12");
    const est = await pay("Estornada", "300,00", "2026-10-13", "2026-10-13", { categoryId: c1.id });
    const [pp] = await db.select().from(schema.payablePayments).where(sql`${schema.payablePayments.payableId} = ${est}`);
    await reversePayablePayment(db, gerA, A, pp.id, "erro de lançamento");
    const canc = await createPayable(db, dirA, A, { vendorId: vend, description: "Cancelada", amount: "999,00", dueDate: "2026-10-14" }); await cancelPayable(db, dirA, A, canc, "teste");
    await createPayable(db, dirA, A, { vendorId: vend, description: "Rascunho", amount: "888,00", dueDate: "2026-10-15" });
    await pay("Aberta", "777,00", "2026-10-20", null, { categoryId: c1.id });
    const r = await spendReport(db, dirA, A, { from: "2026-09", to: "2026-10" }, TODAY);
    expect(r.months).toEqual(["2026-09", "2026-10"]);
    expect(r.categories.map((l) => [l.name, l.byMonth, l.totalCents])).toEqual([["Aluguel e locações", [100000, 110000], 210000], ["Sem categoria", [0, 20000], 20000]]);
    expect(r.centers.map((l) => [l.name, l.totalCents])).toEqual([["Operação", 210000], ["Sem centro de custo", 20000]]);
    expect(r.totalByMonth).toEqual([100000, 130000]); expect(r.totalCents).toBe(230000);
    // período que exclui setembro
    expect((await spendReport(db, dirA, A, { from: "2026-10", to: "2026-10" }, TODAY)).totalCents).toBe(130000);
  });

  it("base 'competência': contas aprovadas pelo valor, no mês de competência (ou vencimento); paga ou não", async () => {
    await pay("Com competência", "500,00", "2026-10-05", "2026-10-05", { competence: "2026-09" });
    await pay("Sem competência, aberta", "400,00", "2026-10-20", null);
    const r = await spendReport(db, dirA, A, { from: "2026-09", to: "2026-10", basis: "competencia" }, TODAY);
    expect(r.basis).toBe("competencia");
    expect(r.totalByMonth).toEqual([50000, 40000]);
  });

  it("permissão, isolamento e exportação auditada", async () => {
    await pay("Conta", "100,00", "2026-10-05", "2026-10-05");
    await expect(spendReport(db, dirB, A, {}, TODAY)).rejects.toBeInstanceOf(Forbidden);
    expect((await spendReport(db, dirB, B, {}, TODAY)).totalCents).toBe(0);
    expect((await spendReport(db, assA, A, {}, TODAY)).totalCents).toBe(10000); // assistente lê
    await expect(exportSpendReport(db, assA, A, {}, TODAY)).rejects.toBeInstanceOf(Forbidden); // mas não exporta
    const csv = await exportSpendReport(db, gerA, A, { from: "2026-10", to: "2026-10" }, TODAY);
    expect(csv).toContain("Sem categoria"); expect(csv).toContain("100,00");
    expect((await db.select().from(schema.auditLog)).map((a) => a.action)).toContain("payable.report_exported");
    await expect(spendReport(db, dirA, A, { from: "2026-10", to: "2026-01" }, TODAY)).rejects.toBeInstanceOf(Invalid);
    await expect(spendReport(db, dirA, A, { basis: "x" }, TODAY)).rejects.toThrow(/Base inválida/);
  });
});
