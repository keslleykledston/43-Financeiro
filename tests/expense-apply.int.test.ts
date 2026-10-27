import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { databaseUrl } from "@/lib/db/url";
import * as schema from "@/lib/db/schema";
import type { DB } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import type { ExpenseRow } from "@/modules/expenses/planilha";
import { importExpenses, removeExpenseImport, sha256 } from "@/modules/expenses/history";
import { analyzeExpenses } from "@/modules/expenses/report";
import { applicationStatus, applyExpenseHistory, buildApplyPlan, isVehicleExpense, previewExpenseApplication, proposeRecurring, reclassifyVehicleWithdrawals, summarize, type StagedRow } from "@/modules/expenses/apply";
import { savePartner, saveCostCenter } from "@/modules/expenses/catalog";
import { partnerBalances } from "@/modules/expenses/ledger";
import { listPayables } from "@/modules/payables/service";
import { listSeries, listTemplates } from "@/modules/payables/planning";

const enabled = !!process.env.POSTGRES_USER;
const TODAY = "2026-10-25";
const R = (o: Partial<ExpenseRow> & Pick<ExpenseRow, "description">): ExpenseRow => ({ sheet: "DESPESAS", row: 1, month: "2026-09", block: "empresa", dueOn: "2026-09-10", amountCents: 10000, paidCents: 10000, paidOn: "2026-09-12", paidRaw: null, installmentNo: null, installmentsTotal: null, ...o });
const S = (r: ExpenseRow, id = "id-" + r.row): StagedRow => ({ ...r, id });

describe("D3b — regras puras de aplicação", () => {
  const rows: StagedRow[] = [
    S(R({ description: "VIVO", row: 1 })),
    S(R({ description: "ENERGIA", row: 2, amountCents: 20000, paidCents: 15000 })), // pago a menos: baixa de 150, observação, sem dívida fantasma
    S(R({ description: "SEM DATA", row: 3, paidOn: null })), // em aberto, valor da conta
    S(R({ description: "SEM DATA E SEM CONTA", row: 4, paidOn: null, amountCents: null, paidCents: 5000 })), // em aberto pelo valor pago
    S(R({ description: "DATA EM TEXTO", row: 5, paidOn: null, paidRaw: "19/09" })), // fora
    S(R({ description: "SEM VALOR", row: 6, amountCents: null, paidCents: null, paidOn: null })), // fora
    S(R({ description: "PAGO NO FUTURO", row: 7, paidOn: "2026-12-01" })), // data futura = em aberto
    S(R({ description: "ÁGUA", row: 8, block: "casa" })), // retirada
    S(R({ description: "MERCADO", row: 9, block: "casa", paidOn: null })), // casa sem data: fora
    S(R({ description: "NUBANK", row: 10, block: "cartao", paidOn: null, paidCents: null })), // fora
    S(R({ description: "Fulano", row: 11, block: "dizimo", paidOn: null, paidCents: null })), // fora
    S(R({ description: "FGTS / CALL", row: 12 })),
  ];
  const p = buildApplyPlan(rows, TODAY);
  it("classifica cada linha", () => {
    const by = (d: string) => p.items.find((i) => i.description === d)!;
    expect(by("VIVO")).toMatchObject({ kind: "conta_paga", amountCents: 10000, paidOn: "2026-09-12", note: null });
    expect(by("ENERGIA")).toMatchObject({ kind: "conta_paga", amountCents: 15000, note: "Planilha: conta R$ 200,00, pago R$ 150,00" });
    expect(by("SEM DATA")).toMatchObject({ kind: "conta_aberta", amountCents: 10000 });
    expect(by("SEM DATA E SEM CONTA")).toMatchObject({ kind: "conta_aberta", amountCents: 5000 });
    expect(by("PAGO NO FUTURO")).toMatchObject({ kind: "conta_aberta" });
    expect(by("ÁGUA")).toMatchObject({ kind: "retirada", occurredOn: "2026-09-12", amountCents: 10000 });
    expect(p.skipped).toMatchObject({ data_em_texto: { n: 1 }, sem_valor: { n: 1 }, casa_sem_data: { n: 1 }, cartao: { n: 1 }, dizimo: { n: 1 } });
    expect(p.callHintN).toBe(1);
  });
  it("resumo", () => {
    const s = summarize(p);
    expect(s.paid).toEqual({ n: 3, cents: 10000 + 15000 + 10000 }); // VIVO, ENERGIA, FGTS / CALL
    expect(s.open.n).toBe(3); expect(s.withdrawals).toEqual({ n: 1, cents: 10000 });
  });
});

describe("D3b — carro, moto e consórcio da aba Casa são despesa da empresa", () => {
  it("reconhece só palavra inteira", () => {
    for (const d of ["CARRO 20/48", "IPVA CARRO / 2026", "MOTO 16/36", "TAXAS MOTO PRETA", "CONSÓRCIO/CARRO 2/84", "Consorcio"]) expect(isVehicleExpense(d)).toBe(true);
    for (const d of ["ALUGUEL / MOTOR", "MOTORISTA", "CARROSSEL", "ÁGUA", "RASTREAMENTO MOTOS"]) expect(isVehicleExpense(d)).toBe(false);
  });
  it("com data vira conta paga; sem data vira conta em aberto; categoria Veículos ou Consórcio", () => {
    const rows: StagedRow[] = [
      S(R({ description: "CARRO 29/48", row: 1, block: "casa" })),
      S(R({ description: "MOTO 25/36", row: 2, block: "casa", paidOn: null, paidCents: null })),
      S(R({ description: "CONSÓRCIO/CARRO 2/84", row: 3, block: "casa" })),
      S(R({ description: "ÁGUA", row: 4, block: "casa" })),
      S(R({ description: "MERCADO", row: 5, block: "casa", paidOn: null })),
    ];
    const p = buildApplyPlan(rows, TODAY);
    const by = (d: string) => p.items.find((i) => i.description === d)!;
    expect(by("CARRO 29/48")).toMatchObject({ kind: "conta_paga", categoryCode: "veiculos" });
    expect(by("MOTO 25/36")).toMatchObject({ kind: "conta_aberta", categoryCode: "veiculos", amountCents: 10000 });
    expect(by("CONSÓRCIO/CARRO 2/84")).toMatchObject({ kind: "conta_paga", categoryCode: "consorcio" });
    expect(by("ÁGUA")).toMatchObject({ kind: "retirada" });
    expect(p.skipped.casa_sem_data.n).toBe(1); // só o MERCADO
  });
  it("o relatório de staging também conta veículo da Casa como Empresa", () => {
    const rep = analyzeExpenses([R({ description: "CARRO 29/48", row: 1, block: "casa", amountCents: 100000, paidCents: 100000 }), R({ description: "ÁGUA", row: 2, block: "casa", amountCents: 5000, paidCents: 5000 })]);
    expect(rep.totals).toMatchObject({ empresaPaidCents: 100000, casaPaidCents: 5000 });
  });
});

describe.skipIf(!enabled)("D3b — aplicar o histórico de despesas (DB de teste)", () => {
  let admin: ReturnType<typeof postgres>, conn: ReturnType<typeof postgres>, db: DB;
  let A: string, B: string, dirA: string, gerA: string;
  let keslley: string, ana: string;

  beforeAll(async () => {
    const base = databaseUrl();
    admin = postgres(base.replace(/\/k3gfinance$/, "/postgres"), { max: 1 });
    if (!(await admin`select 1 from pg_database where datname = 'k3gfinance_test'`).length) await admin.unsafe("create database k3gfinance_test");
    conn = postgres(base.replace(/\/k3gfinance$/, "/k3gfinance_test"), { max: 5 });
    db = drizzle(conn, { schema });
    await migrate(db, { migrationsFolder: "./drizzle" });
  });
  afterAll(async () => { await conn?.end(); await admin?.end(); });

  const ROWS: ExpenseRow[] = [
    R({ description: "VIVO", row: 1, amountCents: 77356, paidCents: 77356 }),
    R({ description: "EMPRESTIMO / K3G2 / 19/36", row: 2, amountCents: 440893, paidCents: 440893, installmentNo: 19, installmentsTotal: 36 }),
    R({ description: "SEM DATA", row: 3, paidOn: null, amountCents: 30000, paidCents: null }),
    R({ description: "ÁGUA", row: 4, block: "casa", amountCents: 22419, paidCents: 22419 }),
    R({ description: "MERCADO", row: 5, block: "casa", paidOn: null }),
    R({ description: "NUBANK", row: 6, block: "cartao", paidOn: null, paidCents: null }),
    // três meses de VIVO e de empréstimo para virar recorrente e parcelamento
    ...["2026-07", "2026-08"].flatMap((m, i) => [
      R({ description: "VIVO", row: 10 + i, month: m, dueOn: `${m}-10`, paidOn: `${m}-12`, amountCents: 77356, paidCents: 77356 }),
      R({ description: `EMPRESTIMO / K3G2 / ${17 + i}/36`, row: 20 + i, month: m, dueOn: `${m}-10`, paidOn: `${m}-12`, amountCents: 440893, paidCents: 440893, installmentNo: 17 + i, installmentsTotal: 36 }),
    ]),
  ];

  beforeEach(async () => {
    await db.execute(sql`truncate expense_applications, expense_import_rows, expense_imports, partner_entries, partners, payable_payments, payable_series, payable_templates, payables, vendors, cost_centers, expense_categories, audit_log, invitations, memberships, companies, users restart identity cascade`);
    const [a, b] = await db.insert(schema.companies).values([{ name: "Empresa A" }, { name: "Empresa B" }]).returning();
    A = a.id; B = b.id;
    const mk = async (e: string) => (await db.insert(schema.users).values({ email: e, name: e, passwordHash: "x" }).returning())[0].id;
    dirA = await mk("dir-a@t.com"); gerA = await mk("ger@t.com");
    await db.insert(schema.memberships).values([{ userId: dirA, companyId: A, role: "diretoria" }, { userId: gerA, companyId: A, role: "gerente" }]);
    keslley = await savePartner(db, dirA, A, { name: "Keslley Kledston Silva Santos" });
    ana = await savePartner(db, dirA, A, { name: "Ana Kelly Costa Santos" });
    await saveCostCenter(db, dirA, A, { name: "K3G 2 — imóvel de expansão" });
    await importExpenses(db, dirA, A, { fileSha256: sha256("x"), fileLabel: "Despesas", year: 2026, rows: ROWS });
  });

  it("prévia não grava; aplicar cria contas pagas, em aberto e retiradas só no Keslley", async () => {
    const prev = await previewExpenseApplication(db, dirA, A, TODAY);
    expect(prev).toMatchObject({ paid: { n: 6 }, open: { n: 1, cents: 30000 }, withdrawals: { n: 1, cents: 22419 }, alreadyApplied: 0 });
    expect((await db.select().from(schema.payables)).length).toBe(0);
    const r = await applyExpenseHistory(db, dirA, A, TODAY);
    expect(r.applied).toBe(8);
    const pays = await db.select().from(schema.payables);
    expect(pays).toHaveLength(7);
    expect(pays.every((p) => p.status === "aprovado" && p.decidedBy === dirA)).toBe(true);
    const list = await listPayables(db, dirA, A, { status: "todas" }, TODAY);
    expect(list.filter((p) => p.situation === "paga")).toHaveLength(6);
    const open = list.find((p) => p.description === "SEM DATA")!;
    expect(open).toMatchObject({ openCents: 30000, paidCents: 0, competence: "2026-09-01" });
    expect(open.vendorName).toMatch(/Histórico da planilha/);
    // K3G 2 no centro de custo; categoria sugerida
    expect(list.find((p) => p.description.startsWith("EMPRESTIMO"))!.costCenterName).toMatch(/K3G 2/);
    const bal = await partnerBalances(db, dirA, A, TODAY);
    expect(bal.find((b) => b.partnerId === keslley)!.balanceCents).toBe(-22419);
    expect(bal.find((b) => b.partnerId === ana)!.balanceCents).toBe(0);
    expect(await applicationStatus(db, dirA, A)).toEqual({ paid: 6, open: 1, withdrawals: 1, reclassified: 0, total: 8 });
    expect((await db.select().from(schema.auditLog)).map((a) => a.action)).toContain("expenses.history_applied");
  });

  it("é idempotente: aplicar de novo não duplica nada", async () => {
    await applyExpenseHistory(db, dirA, A, TODAY);
    const again = await applyExpenseHistory(db, dirA, A, TODAY);
    expect(again.applied).toBe(0);
    expect((await db.select().from(schema.payables))).toHaveLength(7);
    expect((await db.select().from(schema.partnerEntries))).toHaveLength(1);
  });

  it("concorrência: duas aplicações simultâneas não duplicam", async () => {
    await Promise.allSettled([applyExpenseHistory(db, dirA, A, TODAY), applyExpenseHistory(db, dirA, A, TODAY)]);
    expect((await db.select().from(schema.payables))).toHaveLength(7);
    expect((await db.select().from(schema.expenseApplications))).toHaveLength(8);
  });

  it("permissão e isolamento: gerente não aplica; outra empresa não vê", async () => {
    await expect(applyExpenseHistory(db, gerA, A, TODAY)).rejects.toBeInstanceOf(Forbidden);
    await expect(previewExpenseApplication(db, gerA, A, TODAY)).rejects.toBeInstanceOf(Forbidden);
    const dirB = (await db.insert(schema.users).values({ email: "dir-b@t.com", name: "b", passwordHash: "x" }).returning())[0].id;
    await db.insert(schema.memberships).values({ userId: dirB, companyId: B, role: "diretoria" });
    await expect(applyExpenseHistory(db, dirB, B, TODAY)).rejects.toBeInstanceOf(Invalid); // B não importou nada
    expect((await db.select().from(schema.payables))).toHaveLength(0);
  });

  it("sem o sócio Keslley cadastrado, recusa e não grava nada (tudo ou nada)", async () => {
    await db.execute(sql`update partners set name = 'Outro' where id = ${keslley}`);
    await expect(applyExpenseHistory(db, dirA, A, TODAY)).rejects.toThrow(/Keslley/);
    expect((await db.select().from(schema.payables))).toHaveLength(0);
    expect((await db.select().from(schema.vendors))).toHaveLength(0);
  });

  it("depois de aplicar, a importação não pode ser desfeita e o vínculo é imutável", async () => {
    await applyExpenseHistory(db, dirA, A, TODAY);
    const [imp] = await db.select().from(schema.expenseImports);
    await expect(removeExpenseImport(db, dirA, A, imp.id)).rejects.toThrow(/já foi aplicada/);
    await expect(db.execute(sql`delete from expense_applications`)).rejects.toThrow();
    await expect(db.execute(sql`update expense_applications set kind = 'retirada'`)).rejects.toThrow();
  });

  it("recorrentes e parcelamentos: cria ativos, sem duplicar, e a série aponta as parcelas que restam", async () => {
    await applyExpenseHistory(db, dirA, A, TODAY);
    const r = await proposeRecurring(db, dirA, A, TODAY);
    expect(r).toMatchObject({ templates: 1, series: 1 });
    expect(await proposeRecurring(db, dirA, A, TODAY)).toMatchObject({ templates: 0, series: 0 });
    const t = await listTemplates(db, dirA, A);
    expect(t).toHaveLength(1); expect(t[0]).toMatchObject({ description: "VIVO", amountCents: 77356, dueDay: 10, startMonth: "2026-11" });
    const s = await listSeries(db, dirA, A, TODAY);
    expect(s).toHaveLength(1); expect(s[0]).toMatchObject({ installments: 17, amountCents: 440893 });
    expect(s[0].description).toMatch(/restantes após 19\/36/);
    await expect(proposeRecurring(db, gerA, A, TODAY)).rejects.toBeInstanceOf(Forbidden);
  });

  it("reclassifica: retirada de carro/moto/consórcio já aplicada é estornada e vira conta paga da empresa (uma vez só)", async () => {
    // estado antigo: as linhas de veículo da Casa já tinham virado retirada no Keslley
    const [imp0] = await db.select().from(schema.expenseImports);
    await removeExpenseImport(db, dirA, A, imp0.id);
    const veh = [
      R({ description: "CARRO 29/48", row: 40, block: "casa", amountCents: 261779, paidCents: 261779, paidOn: "2026-10-05", month: "2026-10" }),
      R({ description: "MOTO 24/36", row: 41, block: "casa", amountCents: 72081, paidCents: 72081, paidOn: "2026-09-08", month: "2026-09" }),
    ];
    await importExpenses(db, dirA, A, { fileSha256: sha256("y"), fileLabel: "Despesas", year: 2026, rows: [...ROWS, ...veh] });
    const rowsDb = await db.select().from(schema.expenseImportRows);
    for (const r of rowsDb.filter((x) => /^(CARRO|MOTO)/.test(x.description))) {
      const [e] = await db.insert(schema.partnerEntries).values({ companyId: A, partnerId: keslley, kind: "retirada", amount: r.paidAmount!, occurredOn: r.paidOn!, description: r.description, requestKey: `d3b:${r.id}`, createdBy: dirA }).returning();
      await db.insert(schema.expenseApplications).values({ companyId: A, rowId: r.id, kind: "retirada", entryId: e.id, appliedBy: dirA });
    }
    await applyExpenseHistory(db, dirA, A, TODAY); // o resto da planilha entra normalmente
    expect((await (await partnerBalances(db, dirA, A, TODAY)).find((b) => b.partnerId === keslley)!.balanceCents)).toBe(-(261779 + 72081 + 22419));
    const r1 = await reclassifyVehicleWithdrawals(db, dirA, A);
    expect(r1).toEqual({ reclassified: 2, cents: 261779 + 72081 });
    expect((await (await partnerBalances(db, dirA, A, TODAY)).find((b) => b.partnerId === keslley)!.balanceCents)).toBe(-22419); // só a água segue como retirada
    const list = await listPayables(db, dirA, A, { status: "todas" }, TODAY);
    expect(list.find((p) => p.description === "CARRO 29/48")).toMatchObject({ situation: "paga", paidCents: 261779, categoryName: expect.stringMatching(/Veículos/) });
    expect(list.find((p) => p.description === "MOTO 24/36")).toMatchObject({ situation: "paga", paidCents: 72081 });
    const entries = await db.select().from(schema.partnerEntries);
    expect(entries.filter((e) => e.status === "estornado")).toHaveLength(2);
    expect(entries.find((e) => e.status === "estornado")!.reverseReason).toMatch(/despesa da empresa/);
    expect(await applicationStatus(db, dirA, A)).toMatchObject({ paid: 8, reclassified: 2, withdrawals: 1 + 0 });
    // segunda vez: nada a fazer
    expect(await reclassifyVehicleWithdrawals(db, dirA, A)).toEqual({ reclassified: 0, cents: 0 });
    expect((await db.select().from(schema.payables)).length).toBe(7 + 2);
    await expect(reclassifyVehicleWithdrawals(db, gerA, A)).rejects.toBeInstanceOf(Forbidden);
    expect((await db.select().from(schema.auditLog)).map((a) => a.action)).toContain("expenses.history_reclassified");
  });
});
