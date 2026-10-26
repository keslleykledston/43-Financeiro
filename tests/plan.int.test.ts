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
import { approvePayable, createPayable, registerPayablePayment, submitPayable } from "@/modules/payables/service";
import { createTemplate } from "@/modules/payables/planning";
import { savePartner } from "@/modules/expenses/catalog";
import { createEntry } from "@/modules/expenses/ledger";
import { buildPlan, getProfitSettings, parseBps, saveProfitSettings, setPartnerPlan } from "@/modules/expenses/plan";

const enabled = !!process.env.POSTGRES_USER;
const TODAY = "2026-10-25";
const S = (o: Record<string, unknown> = {}) => ({ delinquency: "3", unplanned: "5", reserveMonths: "2", retention: "20", ...o }) as Parameters<typeof saveProfitSettings>[3];

describe("D4 — parse de percentual", () => {
  it("aceita 0 a 100 com até 2 casas; recusa o resto", () => {
    expect(parseBps("3", "x")).toBe(300); expect(parseBps("12,5%", "x")).toBe(1250); expect(parseBps("0", "x")).toBe(0); expect(parseBps(" 100 ", "x")).toBe(10000);
    for (const bad of ["101", "-1", "abc", "1,234", "", "1e2"]) expect(() => parseBps(bad, "x")).toThrow(/percentual/);
  });
});

describe.skipIf(!enabled)("D4 — plano de retiradas e previsão de lucro (DB de teste)", () => {
  let admin: ReturnType<typeof postgres>, conn: ReturnType<typeof postgres>, db: DB;
  let A: string, B: string, dirA: string, dirB: string, gerA: string, cust: string, vend: string, keslley: string, ana: string;

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
    await db.execute(sql`truncate profit_settings, partner_entries, partners, payable_payments, payables, payable_series, payable_templates, payables_settings, cost_centers, expense_categories, contracts, vendor_contacts, vendors, customer_contacts, customers, audit_log, invitations, memberships, companies, users restart identity cascade`);
    const [a, b] = await db.insert(schema.companies).values([{ name: "Empresa A" }, { name: "Empresa B" }]).returning();
    A = a.id; B = b.id;
    const mk = async (e: string) => (await db.insert(schema.users).values({ email: e, name: e, passwordHash: "x" }).returning())[0].id;
    dirA = await mk("dir-a@t.com"); dirB = await mk("dir-b@t.com"); gerA = await mk("ger@t.com");
    await db.insert(schema.memberships).values([{ userId: dirA, companyId: A, role: "diretoria" }, { userId: dirB, companyId: B, role: "diretoria" }, { userId: gerA, companyId: A, role: "gerente" }]);
    cust = (await createParty(db, dirA, A, { kind: "cliente", legalName: "Cliente Um", document: "11.222.333/0001-81" })).id;
    vend = (await createParty(db, dirA, A, { kind: "fornecedor", legalName: "Fornecedor Um", document: "12.ABC.345/01DE-35" })).id;
    keslley = await savePartner(db, dirA, A, { name: "Sócio Um" }); ana = await savePartner(db, dirA, A, { name: "Sócia Dois" });
  });

  const contract = (o: Record<string, unknown>) => db.insert(schema.contracts).values({ companyId: A, customerId: cust, description: "Serviço", monthlyAmount: "10000.00", startAt: "2026-01-01", status: "ativo", dueDay: 10, ...o } as typeof schema.contracts.$inferInsert);

  it("premissas: padrão, validação, salvar (com caixa e data), permissões e isolamento", async () => {
    expect(await getProfitSettings(db, dirA, A)).toMatchObject({ isDefault: true, delinquencyBps: 300, unplannedBps: 500, reserveMonths: 2, retentionBps: 2000, cashNowCents: null });
    await expect(getProfitSettings(db, gerA, A)).rejects.toBeInstanceOf(Forbidden);
    await expect(saveProfitSettings(db, gerA, A, S(), TODAY)).rejects.toBeInstanceOf(Forbidden);
    await expect(saveProfitSettings(db, dirA, A, S({ delinquency: "101" }), TODAY)).rejects.toThrow(/Inadimplência/);
    await expect(saveProfitSettings(db, dirA, A, S({ reserveMonths: "25" }), TODAY)).rejects.toThrow(/Reserva/);
    await expect(saveProfitSettings(db, dirA, A, S({ cashNow: "abc" }), TODAY)).rejects.toThrow(/Caixa/);
    await expect(saveProfitSettings(db, dirA, A, S({ cashNow: "100,00", cashAsOf: "2026-10-26" }), TODAY)).rejects.toThrow(/Data do caixa/);
    await saveProfitSettings(db, dirA, A, S({ delinquency: "5,5", cashNow: "-1.500,25" }), TODAY);
    expect(await getProfitSettings(db, dirA, A)).toMatchObject({ isDefault: false, delinquencyBps: 550, cashNowCents: -150025, cashAsOf: TODAY });
    await saveProfitSettings(db, dirA, A, S({ cashNow: "" }), TODAY); // limpar o caixa
    expect(await getProfitSettings(db, dirA, A)).toMatchObject({ cashNowCents: null, cashAsOf: null });
    expect((await getProfitSettings(db, dirB, B)).isDefault).toBe(true); // outra empresa não herda
    expect((await db.select().from(schema.auditLog)).map((a) => a.action)).toContain("plan.settings_saved");
  });

  it("retirada planejada por sócio: valida, isola e sócio inativo fica fora do total", async () => {
    await setPartnerPlan(db, dirA, A, keslley, "8.000,00");
    await setPartnerPlan(db, dirA, A, ana, "2.000,00");
    await expect(setPartnerPlan(db, dirA, A, keslley, "abc")).rejects.toBeInstanceOf(Invalid);
    await expect(setPartnerPlan(db, dirB, B, keslley, "1,00")).rejects.toThrow(/Sócio não encontrado/);
    await expect(setPartnerPlan(db, gerA, A, keslley, "1,00")).rejects.toBeInstanceOf(Forbidden);
    expect((await buildPlan(db, dirA, A, TODAY)).plannedTotalCents).toBe(1000000);
    await db.execute(sql`update partners set active = false where id = ${ana}`);
    const v = await buildPlan(db, dirA, A, TODAY);
    expect(v.plannedTotalCents).toBe(800000);
    expect(v.partners.find((p) => p.partnerId === ana)).toMatchObject({ plannedCents: 200000, active: false });
    await setPartnerPlan(db, dirA, A, keslley, "0");
    expect((await buildPlan(db, dirA, A, TODAY)).plannedTotalCents).toBe(0);
  });

  it("previsão: contratos ativos, contas lançadas e previstas, comissão, retiradas e caixa batem com o cálculo", async () => {
    await contract({ commissionPartner: "Parceiro", commissionBps: 3000 });
    await contract({ monthlyAmount: "5000.00", status: "rascunho" });
    await contract({ monthlyAmount: "2000.00", status: "suspenso" });
    await createPayable(db, dirA, A, { vendorId: vend, description: "Conta de novembro", amount: "1.000,00", dueDate: "2026-11-05" });
    await createTemplate(db, dirA, A, { vendorId: vend, description: "Vivo", amount: "773,56", dueDay: 3, startMonth: "2026-11" });
    await setPartnerPlan(db, dirA, A, keslley, "3.000,00");
    await saveProfitSettings(db, dirA, A, S({ cashNow: "20.000,00", cashAsOf: TODAY }), TODAY);
    const v = await buildPlan(db, dirA, A, TODAY);
    expect(v.contracts).toMatchObject({ activeCount: 1, activeMonthlyCents: 1000000, draftCount: 1, draftMonthlyCents: 500000, suspendedCount: 1 });
    const [oct, nov] = v.plan.months;
    expect(oct.month).toBe("2026-10"); expect(nov.month).toBe("2026-11");
    expect(oct.base).toMatchObject({ receiptsCents: 970000, commissionCents: 291000, expensesCents: 291000, operatingCents: 679000, afterWithdrawalsCents: 379000, cashEndCents: 2000000 + 379000 });
    // nov: conta 1.000,00 + Vivo prevista 773,56 = 1.773,56 (+5% = 88,68) + comissão 2.910,00
    expect(nov.knownExpensesCents).toBe(177356);
    expect(nov.base).toMatchObject({ receiptsCents: 970000, expensesCents: 177356 + 8868 + 291000, operatingCents: 970000 - 477224 });
    expect(v.plan.months).toHaveLength(12);
    expect(v.warnings.join("|")).toMatch(/1 contrato\(s\) em rascunho/);
    expect(v.warnings.join("|")).not.toMatch(/Nenhum contrato ativo/);
    expect(v.warnings.join("|")).not.toMatch(/passaram da data de término/);
    expect(v.plan.suggestedMonthlyCents).toBeGreaterThan(0);
  });

  it("contrato ativo vencido conta como renovado e gera aviso", async () => {
    await contract({ monthlyAmount: "1000.00", startAt: "2025-01-01", endAt: "2025-12-31" });
    const v = await buildPlan(db, dirA, A, TODAY);
    expect(v.plan.months[0].base.receiptsCents).toBe(Math.round(100000 * 0.97)); // renovação automática: segue entrando
    expect(v.warnings.join("|")).toMatch(/1 contrato\(s\) ativo\(s\) já passaram da data de término/);
  });

  it("sem contratos ativos avisa; planejado acima do sugerido avisa; caixa negativo avisa o mês", async () => {
    await setPartnerPlan(db, dirA, A, keslley, "50.000,00");
    await saveProfitSettings(db, dirA, A, S({ cashNow: "1.000,00", cashAsOf: TODAY }), TODAY);
    await createPayable(db, dirA, A, { vendorId: vend, description: "Despesa grande", amount: "9.000,00", dueDate: "2026-11-20" });
    const v = await buildPlan(db, dirA, A, TODAY);
    const w = v.warnings.join("|");
    expect(w).toMatch(/Nenhum contrato ativo/); expect(w).toMatch(/passa do limite sugerido/); expect(w).toMatch(/caixa fica negativo em 10\/2026/);
    expect(v.plan.suggestedMonthlyCents).toBe(0);
  });

  it("realizado: baixas de contas a pagar e retiradas do sócio entram por mês e no ano; permissões e isolamento", async () => {
    const id = await createPayable(db, dirA, A, { vendorId: vend, description: "Paga em outubro", amount: "500,00", dueDate: "2026-10-10" });
    await submitPayable(db, dirA, A, id); await approvePayable(db, gerA, A, id);
    await registerPayablePayment(db, gerA, A, id, { amount: "500,00", paidAt: "2026-10-12", method: "pix" }, TODAY);
    await createEntry(db, dirA, A, { partnerId: keslley, kind: "retirada", amount: "1.200,00", occurredOn: "2026-10-05", description: "Cartão pessoal" }, TODAY);
    await createEntry(db, dirA, A, { partnerId: keslley, kind: "retirada", amount: "300,00", occurredOn: "2026-03-05", description: "Mais antiga" }, TODAY);
    const v = await buildPlan(db, dirA, A, TODAY);
    expect(v.realized).toHaveLength(6);
    expect(v.realized.at(-1)).toMatchObject({ month: "2026-10", paidExpensesCents: 50000, withdrawalsCents: 120000, receiptsCents: 0 });
    expect(v.ytd).toMatchObject({ paidExpensesCents: 50000, withdrawalsCents: 150000, receiptsCents: 0, resultCents: -50000 });
    await expect(buildPlan(db, gerA, A, TODAY)).rejects.toBeInstanceOf(Forbidden);
    await expect(buildPlan(db, dirB, A, TODAY)).rejects.toBeInstanceOf(Forbidden);
    const b = await buildPlan(db, dirB, B, TODAY);
    expect(b.partners).toHaveLength(0); expect(b.ytd.paidExpensesCents).toBe(0);
  });
});
