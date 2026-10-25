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
import { approvePayable, cancelPayable, getPayable, registerPayablePayment, submitPayable, updatePayable } from "@/modules/payables/service";
import { commitments, createSeries, createTemplate, generateMonth, listSeries, listTemplates, monthPlan, setSeriesActive, setTemplateActive, updateTemplate } from "@/modules/payables/planning";
import { listCategories, listCostCenters } from "@/modules/expenses/catalog";

const enabled = !!process.env.POSTGRES_USER;
const TODAY = "2026-10-25";
const why = (e: unknown) => String((e as { cause?: { message?: string } })?.cause?.message ?? (e as Error)?.message ?? e);

describe.skipIf(!enabled)("D2 — contas recorrentes, parcelas e calendário (DB de teste)", () => {
  let admin: ReturnType<typeof postgres>, conn: ReturnType<typeof postgres>, db: DB;
  let A: string, B: string, dirA: string, dirB: string, gerA: string, asstA: string, ctbA: string, vend: string, vendB: string;

  beforeAll(async () => {
    const base = databaseUrl();
    admin = postgres(base.replace(/\/k3gfinance$/, "/postgres"), { max: 1 });
    if (!(await admin`select 1 from pg_database where datname = 'k3gfinance_test'`).length) await admin.unsafe("create database k3gfinance_test");
    conn = postgres(base.replace(/\/k3gfinance$/, "/k3gfinance_test"), { max: 6 });
    db = drizzle(conn, { schema });
    await migrate(db, { migrationsFolder: "./drizzle" });
  });
  afterAll(async () => { await conn?.end(); await admin?.end(); });

  beforeEach(async () => {
    await db.execute(sql`truncate partner_entries, partners, payable_payments, payables, payable_series, payable_templates, payables_settings, cost_centers, expense_categories, vendor_contacts, vendors, customer_contacts, customers, audit_log, invitations, memberships, companies, users restart identity cascade`);
    const [a, b] = await db.insert(schema.companies).values([{ name: "Empresa A" }, { name: "Empresa B" }]).returning();
    A = a.id; B = b.id;
    const mk = async (e: string) => (await db.insert(schema.users).values({ email: e, name: e, passwordHash: "x" }).returning())[0].id;
    dirA = await mk("dir-a@t.com"); dirB = await mk("dir-b@t.com"); gerA = await mk("ger@t.com"); asstA = await mk("asst@t.com"); ctbA = await mk("ctb@t.com");
    await db.insert(schema.memberships).values([{ userId: dirA, companyId: A, role: "diretoria" }, { userId: dirB, companyId: B, role: "diretoria" }, { userId: gerA, companyId: A, role: "gerente" }, { userId: asstA, companyId: A, role: "assistente" }, { userId: ctbA, companyId: A, role: "contabilidade" }]);
    vend = (await createParty(db, dirA, A, { kind: "fornecedor", legalName: "Fornecedor Um", document: "11.222.333/0001-81" })).id;
    vendB = (await createParty(db, dirB, B, { kind: "fornecedor", legalName: "Fornecedor B", document: "12.ABC.345/01DE-35" })).id;
  });

  const tpl = (o: Record<string, unknown> = {}) => ({ vendorId: vend, description: "Vivo corporativo", amount: "773,56", dueDay: 3, startMonth: "2026-10", ...o }) as Parameters<typeof createTemplate>[3];

  it("modelo recorrente: validações, permissões e isolamento", async () => {
    await expect(createTemplate(db, gerA, A, tpl())).rejects.toBeInstanceOf(Forbidden);
    await expect(createTemplate(db, dirA, A, tpl({ amount: "0" }))).rejects.toThrow(/valor esperado/);
    await expect(createTemplate(db, dirA, A, tpl({ dueDay: 32 }))).rejects.toThrow(/Dia do vencimento/);
    await expect(createTemplate(db, dirA, A, tpl({ startMonth: "2026-13" }))).rejects.toThrow(/mês de início/);
    await expect(createTemplate(db, dirA, A, tpl({ endMonth: "2026-09" }))).rejects.toThrow(/Mês final/);
    await expect(createTemplate(db, dirA, A, tpl({ description: "x" }))).rejects.toThrow(/Descreva/);
    await expect(createTemplate(db, dirA, A, tpl({ vendorId: vendB }))).rejects.toThrow(/Fornecedor não encontrado/); // fornecedor de outra empresa
    const cb = (await listCategories(db, dirB, B)).find((c) => c.code === "energia")!;
    await expect(createTemplate(db, dirA, A, tpl({ categoryId: cb.id }))).rejects.toThrow(/Categoria não encontrada/);
    const id = await createTemplate(db, dirA, A, tpl());
    expect((await listTemplates(db, ctbA, A))).toHaveLength(1);
    await expect(listTemplates(db, dirB, A)).rejects.toBeInstanceOf(Forbidden);
    expect(await listTemplates(db, dirB, B)).toHaveLength(0);
    await expect(updateTemplate(db, dirB, B, id, tpl({ vendorId: vendB }))).rejects.toThrow(/Modelo não encontrado/);
    await expect(setTemplateActive(db, dirB, B, id, false)).rejects.toThrow(/Modelo não encontrado/);
  });

  it("gerar o mês cria rascunhos, é idempotente, respeita início/fim, dia 31 e não recria o que foi cancelado", async () => {
    const energia = (await listCategories(db, dirA, A)).find((c) => c.code === "energia")!;
    const centro = (await listCostCenters(db, dirA, A))[0];
    const t1 = await createTemplate(db, dirA, A, tpl({ categoryId: energia.id, costCenterId: centro.id }));
    await createTemplate(db, dirA, A, tpl({ description: "Aluguel dia 31", dueDay: 31, amount: "1.000,00", startMonth: "2026-10", endMonth: "2027-02" }));
    await createTemplate(db, dirA, A, tpl({ description: "Só a partir de dezembro", startMonth: "2026-12" }));
    const p0 = await monthPlan(db, ctbA, A, "2026-11", TODAY);
    expect(p0.forecasts.map((f) => f.description).sort()).toEqual(["Aluguel dia 31", "Vivo corporativo"]);
    expect(p0.forecasts.find((f) => f.description === "Aluguel dia 31")!.dueDate).toBe("2026-11-30");
    await expect(generateMonth(db, ctbA, A, "2026-11")).rejects.toBeInstanceOf(Forbidden); // contabilidade só lê
    expect(await generateMonth(db, asstA, A, "2026-11")).toEqual({ created: 2, skipped: 0 });
    expect(await generateMonth(db, asstA, A, "2026-11")).toEqual({ created: 0, skipped: 0 }); // nada novo
    const plan = await monthPlan(db, ctbA, A, "2026-11", TODAY);
    expect(plan.forecasts).toHaveLength(0);
    expect(plan.items).toHaveLength(2);
    const viva = plan.items.find((i) => i.description === "Vivo corporativo")!;
    expect(viva).toMatchObject({ status: "rascunho", dueDate: "2026-11-03", categoryName: "Energia", competence: "2026-11-01", amountCents: 77356 });
    expect(plan.totals.itemsCents).toBe(77356 + 100000);
    await expect(generateMonth(db, dirA, A, "2026-13")).rejects.toThrow(/Mês inválido/);
    // cancelado de propósito: não ressuscita
    await cancelPayable(db, dirA, A, viva.id, "não vou pagar este mês");
    expect(await generateMonth(db, dirA, A, "2026-11")).toEqual({ created: 0, skipped: 0 });
    expect((await monthPlan(db, dirA, A, "2026-11", TODAY)).items.some((i) => i.id === viva.id)).toBe(false);
    // fim do modelo e mês anterior ao início
    expect((await monthPlan(db, dirA, A, "2027-03", TODAY)).forecasts.map((f) => f.description)).toEqual(["Só a partir de dezembro", "Vivo corporativo"]);
    expect((await monthPlan(db, dirA, A, "2026-09", TODAY)).forecasts).toHaveLength(0);
    // desativar para de prever
    await setTemplateActive(db, dirA, A, t1, false);
    expect((await monthPlan(db, dirA, A, "2026-12", TODAY)).forecasts.some((f) => f.description === "Vivo corporativo")).toBe(false);
    const acts = (await db.select().from(schema.auditLog)).map((a) => a.action);
    expect(acts).toEqual(expect.arrayContaining(["payable.template_saved", "payable.generated", "payable.template_active"]));
  });

  it("conta gerada: competência fixa (edição não muda; banco também recusa), mas valor e vencimento do rascunho podem ser ajustados", async () => {
    await createTemplate(db, dirA, A, tpl());
    await generateMonth(db, dirA, A, "2026-10");
    const [p] = (await monthPlan(db, dirA, A, "2026-10", TODAY)).items;
    await updatePayable(db, dirA, A, p.id, { vendorId: vend, description: p.description, amount: "800,00", dueDate: "2026-10-04", competence: "2026-09" });
    expect(await getPayable(db, dirA, A, p.id, TODAY)).toMatchObject({ amountCents: 80000, dueDate: "2026-10-04", competence: "2026-10-01" });
    expect(String(await db.execute(sql`update payables set competence = '2026-09-01' where id = ${p.id}`).catch(why))).toMatch(/payable_immutable/);
    expect(String(await db.execute(sql`update payables set template_id = null where id = ${p.id}`).catch(why))).toMatch(/payable_immutable/);
    const [t] = await db.select().from(schema.payableTemplates);
    expect(String(await db.execute(sql`insert into payables (company_id, vendor_id, description, amount, due_date, competence, template_id, created_by) values (${A}, ${vend}, 'dup', 1, '2026-10-10', '2026-10-01', ${t.id}, ${dirA})`).catch(why))).toMatch(/payables_template_month_uq/);
    expect(String(await db.execute(sql`insert into payables (company_id, vendor_id, description, amount, due_date, template_id, created_by) values (${A}, ${vend}, 'sem competencia', 1, '2026-10-10', ${t.id}, ${dirA})`).catch(why))).toMatch(/payables_origin_chk/);
  });

  it("fornecedor inativo: não gera (pula) e volta a prever; gerações simultâneas não duplicam", async () => {
    await createTemplate(db, dirA, A, tpl());
    await db.update(schema.vendors).set({ status: "suspenso" }).where(eq(schema.vendors.id, vend));
    expect(await generateMonth(db, dirA, A, "2026-10")).toEqual({ created: 0, skipped: 1 });
    expect((await monthPlan(db, dirA, A, "2026-10", TODAY)).forecasts).toHaveLength(1);
    await db.update(schema.vendors).set({ status: "ativo" }).where(eq(schema.vendors.id, vend));
    const r = await Promise.all([1, 2, 3, 4].map(() => generateMonth(db, dirA, A, "2026-10")));
    expect(r.reduce((a, x) => a + x.created, 0)).toBe(1);
    expect(await db.select().from(schema.payables)).toHaveLength(1);
  });

  it("parcelamento: validações, geração por mês, progresso (pagas/restantes), encerrar e compromissos", async () => {
    const s = { vendorId: vend, description: "Empréstimo K3G2", installments: 4, firstDue: "2026-10-14", amount: "4.408,93" };
    await expect(createSeries(db, gerA, A, s)).rejects.toBeInstanceOf(Forbidden);
    await expect(createSeries(db, dirA, A, { ...s, installments: 1 })).rejects.toThrow(/de 2 a 120/);
    await expect(createSeries(db, dirA, A, { ...s, installments: 121 })).rejects.toThrow(/de 2 a 120/);
    await expect(createSeries(db, dirA, A, { ...s, firstDue: "2026-02-30" })).rejects.toThrow(/Primeiro vencimento/);
    await expect(createSeries(db, dirA, A, { ...s, amount: "-1" })).rejects.toThrow(/valor de cada parcela/);
    await expect(createSeries(db, dirA, A, { ...s, vendorId: vendB })).rejects.toThrow(/Fornecedor não encontrado/);
    const id = await createSeries(db, dirA, A, s);
    let [row] = await listSeries(db, ctbA, A, TODAY);
    expect(row).toMatchObject({ installments: 4, generated: 0, paid: 0, remaining: 4, remainingCents: 4 * 440893, nextDue: "2026-10-14", lastDue: "2027-01-14" });
    expect(await generateMonth(db, dirA, A, "2026-10")).toEqual({ created: 1, skipped: 0 });
    expect(await generateMonth(db, dirA, A, "2026-11")).toEqual({ created: 1, skipped: 0 });
    const items = (await monthPlan(db, dirA, A, "2026-10", TODAY)).items;
    expect(items[0]).toMatchObject({ description: "Empréstimo K3G2 1/4", dueDate: "2026-10-14", amountCents: 440893 });
    // paga a parcela 1: aprovação por outro usuário + baixa
    await submitPayable(db, dirA, A, items[0].id);
    await approvePayable(db, gerA, A, items[0].id);
    await registerPayablePayment(db, gerA, A, items[0].id, { amount: "4.408,93", paidAt: "2026-10-14", method: "pix" }, TODAY);
    [row] = await listSeries(db, dirA, A, TODAY);
    expect(row).toMatchObject({ generated: 2, paid: 1, remaining: 3, remainingCents: 3 * 440893 });
    expect(await commitments(db, dirA, A, TODAY)).toMatchObject({ installmentsCents: 3 * 440893, installmentsCount: 3, seriesCount: 1 });
    // baixa PARCIAL da parcela 2 (aprovada): o restante conta só o saldo em aberto dela
    const p2 = (await monthPlan(db, dirA, A, "2026-11", TODAY)).items[0];
    await submitPayable(db, dirA, A, p2.id); await approvePayable(db, gerA, A, p2.id);
    await registerPayablePayment(db, gerA, A, p2.id, { amount: "1.000,00", paidAt: "2026-10-20", method: "pix" }, TODAY);
    expect((await listSeries(db, dirA, A, TODAY))[0]).toMatchObject({ paid: 1, remaining: 3, remainingCents: 2 * 440893 + (440893 - 100000) });
    // encerrar: parcelas não geradas somem; a gerada e não paga continua devida
    await setSeriesActive(db, dirA, A, id, false);
    [row] = await listSeries(db, dirA, A, TODAY);
    expect(row).toMatchObject({ active: false, remaining: 1 });
    expect((await monthPlan(db, dirA, A, "2026-12", TODAY)).forecasts).toHaveLength(0);
    await setSeriesActive(db, dirA, A, id, true);
    expect((await monthPlan(db, dirA, A, "2026-12", TODAY)).forecasts).toHaveLength(1);
    await expect(setSeriesActive(db, dirB, B, id, false)).rejects.toThrow(/Parcelamento não encontrado/);
    expect(await listSeries(db, dirB, B, TODAY)).toHaveLength(0);
    // parcela com baixa não pode ser cancelada (regra de contas a pagar); o rascunho sem baixa pode, e não conta como devido nem é recriado
    await expect(cancelPayable(db, dirA, A, p2.id, "renegociado")).rejects.toThrow();
    expect((await listSeries(db, dirA, A, TODAY))[0].remaining).toBe(3);
    expect(await generateMonth(db, dirA, A, "2026-12")).toEqual({ created: 1, skipped: 0 });
    await cancelPayable(db, dirA, A, (await monthPlan(db, dirA, A, "2026-12", TODAY)).items[0].id, "renegociado");
    expect((await listSeries(db, dirA, A, TODAY))[0].remaining).toBe(2);
    expect(await generateMonth(db, dirA, A, "2026-12")).toEqual({ created: 0, skipped: 0 });
  });

  it("recorrentes por mês só conta modelos que já começaram", async () => {
    await createTemplate(db, dirA, A, tpl({ amount: "100,00", startMonth: "2026-10" }));
    await createTemplate(db, dirA, A, tpl({ description: "Começa só em 2027", amount: "900,00", startMonth: "2027-01" }));
    await createTemplate(db, dirA, A, tpl({ description: "Já terminou", amount: "700,00", startMonth: "2026-01", endMonth: "2026-08" }));
    expect((await commitments(db, dirA, A, TODAY)).recurringMonthlyCents).toBe(10000);
  });

  it("gatilho: parcela 2 da mesma série não duplica", async () => {
    const id = await createSeries(db, dirA, A, { vendorId: vend, description: "Consórcio", installments: 3, firstDue: "2026-10-05", amount: "100,00" });
    await generateMonth(db, dirA, A, "2026-10");
    const e = String(await db.execute(sql`insert into payables (company_id, vendor_id, description, amount, due_date, series_id, installment_no, created_by) values (${A}, ${vend}, 'dup', 1, '2026-10-05', ${id}, 1, ${dirA})`).catch(why));
    expect(e).toMatch(/payables_series_no_uq/);
    expect(String(await db.execute(sql`insert into payables (company_id, vendor_id, description, amount, due_date, series_id, created_by) values (${A}, ${vend}, 'sem nº', 1, '2026-10-05', ${id}, ${dirA})`).catch(why))).toMatch(/payables_origin_chk/);
  });
});
