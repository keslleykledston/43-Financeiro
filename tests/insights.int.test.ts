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
import { approveBatch, generateBatch, getBatch } from "@/modules/billing/batches";
import { registerPayment, reversePayment } from "@/modules/receivables/service";
import { confirmImport, createAccount, listTransactions, markTransaction, previewImport } from "@/modules/banking/service";
import { getGroupOverview, getOverview, listReceipts } from "@/modules/insights/service";
import { approvePayable, createPayable, registerPayablePayment, submitPayable } from "@/modules/payables/service";

const enabled = !!process.env.POSTGRES_USER;
const CNPJ1 = "11.222.333/0001-81", CNPJ2 = "12.ABC.345/01DE-35";
// competência 2026-09, vencimento 2026-10-14, emissão 2026-10-01. Régua: 10-01, 10-11, 10-14, 10-17, 10-21 (+ revisão 10-29).
const D = "2026-10-01";
const terms = (o: Record<string, unknown> = {}) => ({ description: "Monitoramento de redes", monthlyAmount: "2.500,00", startAt: "2026-01-01", endAt: "", dueDay: "14", invoiceJointRequired: false, issueDayOverride: "", ...o });

describe.skipIf(!enabled)("E12 painel executivo: números reais, previsão, alertas, grupo e rastreabilidade (DB de teste)", () => {
  let admin: ReturnType<typeof postgres>, conn: ReturnType<typeof postgres>, db: DB;
  let A: string, B: string, dirA: string, dirB: string, gerA: string, asstA: string, contA: string, techA: string, cli1: string, cli2: string;

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
    await db.execute(sql`truncate charge_adjustments, payable_payments, payables_settings, payables, issuance_requests, issuance_settings, bank_transaction_marks, bank_allocations, bank_transactions, bank_import_rows, bank_import_batches, bank_accounts, payments, messaging_settings, message_queue, message_template_versions, message_templates, charges, billing_batches, holidays, contract_versions, contracts, integration_conflicts, integration_sync_runs, integration_connections, rate_limits, customer_contacts, vendor_contacts, customers, vendors, audit_log, invitations, memberships, companies, users restart identity cascade`);
    const [a, b] = await db.insert(schema.companies).values([{ name: "Empresa A" }, { name: "Empresa B" }]).returning();
    A = a.id; B = b.id;
    const mk = async (e: string) => (await db.insert(schema.users).values({ email: e, name: e, passwordHash: "x" }).returning())[0].id;
    dirA = await mk("dir-a@t.com"); dirB = await mk("dir-b@t.com"); gerA = await mk("ger@t.com"); asstA = await mk("asst@t.com"); contA = await mk("cont@t.com"); techA = await mk("tech@t.com");
    await db.insert(schema.memberships).values([
      { userId: dirA, companyId: A, role: "diretoria" }, { userId: dirB, companyId: B, role: "diretoria" }, { userId: gerA, companyId: A, role: "gerente" },
      { userId: asstA, companyId: A, role: "assistente" }, { userId: contA, companyId: A, role: "contabilidade" }, { userId: techA, companyId: A, role: "admin_tecnico" },
    ]);
    cli1 = (await createParty(db, dirA, A, { kind: "cliente", legalName: "Cliente Um", document: CNPJ1 })).id;
    cli2 = (await createParty(db, dirA, A, { kind: "cliente", legalName: "Cliente Dois", document: CNPJ2 })).id;
    // Cliente Um: contato financeiro com e-mail e telefone. Cliente Dois: só e-mail.
    await db.insert(schema.customerContacts).values([
      { companyId: A, partyId: cli1, name: "Fin Um", email: "fin1@exemplo.com", phone: "92999990001", isFinancial: true },
      { companyId: A, partyId: cli2, name: "Fin Dois", email: "fin2@exemplo.com", isFinancial: true },
    ]);
  });

  const activeContract = async (customer: string, t = terms()) => {
    const c = await createContract(db, asstA, A, customer, t);
    await decideVersion(db, dirA, A, (await getContract(db, dirA, A, c.id))!.versions[0].id, "aprovar");
    return c.id;
  };
  const approvedBatch = async () => {
    await activeContract(cli1); await activeContract(cli2, terms({ dueDay: "14" }));
    const { batchId } = await generateBatch(db, asstA, A, D);
    const g = (await getBatch(db, asstA, A, batchId))!;
    await approveBatch(db, dirA, A, batchId, g.hash);
    return batchId;
  };
  const n = async (q: string) => Number((await db.execute(sql.raw(`select count(*)::int n from ${q}`)))[0].n);

  const chargeOf = async (customer: string) => (await db.select().from(schema.charges).where(eq(schema.charges.customerId, customer)))[0];
  const TODAY = "2026-10-20"; // cobranças de 14/10 estão vencidas há 6 dias
  const enc = (s: string) => new TextEncoder().encode(s);
  const csv = (lines: string[]) => enc("Data;Descrição;Valor;Id\r\n" + lines.join("\r\n") + "\r\n");
  const bankImport = async (by: string, co: string, accountId: string, lines: string[]) => { const { batchId } = await previewImport(db, by, co, accountId, "x.csv", csv(lines)); await confirmImport(db, by, co, batchId); };
  const day = (d: string) => d.split("/").reverse().join("-");
  void day;

  it("números reais: a receber, vencido, recebido no mês, emitido no mês, séries de 6 meses", async () => {
    await approvedBatch(); // 2 cobranças de R$ 2.500,00, emissão 01/10, vencimento 14/10
    const c1 = await chargeOf(cli1);
    await registerPayment(db, asstA, A, c1.id, { amount: "1.000,00", paidAt: "2026-10-15", method: "pix" }, TODAY);
    const o = await getOverview(db, contA, A, TODAY);
    expect(o.receivables).toMatchObject({ openCents: 400000, openCount: 2, overdueCents: 400000, overdueCount: 2, over30Cents: 0 });
    expect(o.receivables!.delinquencyRatio).toBe(1);
    expect(o.billed).toEqual({ monthCents: 500000, monthCount: 2 });
    expect(o.received).toEqual({ monthCents: 100000, monthCount: 1 });
    expect(o.series.map((p) => p.month)).toEqual(["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
    expect(o.series[5]).toEqual({ month: "2026-10", billedCents: 500000, receivedCents: 100000 });
    expect(o.series.slice(0, 5).every((p) => p.billedCents === 0 && p.receivedCents === 0)).toBe(true);
    expect(o.alerts[0]).toMatchObject({ key: "overdue", severity: "critical", href: "/contas-a-receber?status=vencidas" });
    // estorno tira do recebido (rastreável)
    const pid = (await db.select().from(schema.payments))[0].id;
    await reversePayment(db, gerA, A, pid, "lançamento duplicado de teste");
    expect((await getOverview(db, contA, A, TODAY)).received).toEqual({ monthCents: 0, monthCount: 0 });
    // o que compõe o número: pagamentos do mês (ativos e estornados), com total só dos ativos
    const r = await listReceipts(db, contA, A, "2026-10");
    expect(r.items).toHaveLength(1); expect(r.items[0]).toMatchObject({ status: "estornado", customerName: "Cliente Um", method: "pix", amountCents: 100000 }); expect(r.totalCents).toBe(0);
    expect((await listReceipts(db, contA, A, "lixo")).items).toEqual([]);
    expect(r.truncated).toBe(false);
    expect((await listReceipts(db, dirB, B, "2026-10")).items).toEqual([]);
    await expect(listReceipts(db, techA, A, "2026-10")).rejects.toThrow(Forbidden);
  });

  it("previsão de 13 semanas: contrato sem cobrança entra como PREVISTO; depois de aprovar o lote vira CONFIRMADO (nunca em dobro)", async () => {
    await activeContract(cli1, terms({ dueDay: "28", monthlyAmount: "3.000,00" })); // vence dia 28 → emite dia 15 do mês do vencimento
    const t = "2026-10-01"; // quinta; semana começa em 28/09; horizonte até 27/12
    let o = await getOverview(db, contA, A, t);
    expect(o.forecast!.end).toBe("2026-12-27");
    expect(o.forecast!.weeks).toHaveLength(13);
    expect(o.forecast!.weeks[4]).toMatchObject({ start: "2026-10-26", confirmedCents: 0, plannedCents: 300000 }); // vence 28/10
    expect(o.forecast!.weeks[8]).toMatchObject({ start: "2026-11-23", plannedCents: 300000 }); // vence 28/11
    expect(o.forecast!.totals).toEqual({ confirmedCents: 0, plannedCents: 600000 }); // 28/12 já está fora do horizonte
    expect(o.forecast!.plannedOverdueCount).toBe(2); // competências de jul e ago (vencimentos de 28/08 e 28/09) sem cobrança emitida
    expect(o.alerts.find((a) => a.key === "missing-charges")).toMatchObject({ severity: "warning", href: "/faturamento/lotes" });
    // gera só a PRÉVIA do lote de 15/10: continua PREVISTO (ainda não é confirmado) — não pode sumir da projeção
    const { batchId } = await generateBatch(db, asstA, A, "2026-10-15");
    o = await getOverview(db, contA, A, t);
    expect(o.forecast!.weeks[4]).toMatchObject({ confirmedCents: 0, plannedCents: 300000 });
    expect(o.forecast!.totals).toEqual({ confirmedCents: 0, plannedCents: 600000 });
    // aprova o lote de 15/10: a cobrança de 28/10 deixa de ser "prevista" e passa a "confirmada" — sem duplicar
    await approveBatch(db, dirA, A, batchId, (await getBatch(db, asstA, A, batchId))!.hash);
    o = await getOverview(db, contA, A, t);
    expect(o.forecast!.weeks[4]).toMatchObject({ confirmedCents: 300000, plannedCents: 0 });
    expect(o.forecast!.weeks[8]).toMatchObject({ confirmedCents: 0, plannedCents: 300000 });
    expect(o.forecast!.totals).toEqual({ confirmedCents: 300000, plannedCents: 300000 });
    // pagamento parcial reduz o confirmado pelo saldo
    await registerPayment(db, asstA, A, (await chargeOf(cli1)).id, { amount: "1.000,00", paidAt: "2026-10-16", method: "pix" }, "2026-10-20");
    expect((await getOverview(db, contA, A, "2026-10-20")).forecast!.totals.confirmedCents).toBe(200000);
  });

  it("vencido não vira entrada projetada: fica à parte (sem inventar probabilidade)", async () => {
    await approvedBatch();
    const o = await getOverview(db, contA, A, TODAY);
    expect(o.forecast!.overdueCents).toBe(500000);
    expect(o.forecast!.totals.confirmedCents).toBe(0);
    expect(o.forecast!.weeks.every((w) => w.confirmedCents === 0)).toBe(true);
    // conservação: confirmado + vencido + além do horizonte = em aberto
    const f = o.forecast!;
    expect(f.totals.confirmedCents + f.overdueCents + f.beyondCents).toBe(o.receivables!.openCents);
  });

  it("recebimentos: o total vem do banco (sem o limite da lista) e bate com o KPI do painel", async () => {
    await approvedBatch();
    const c1 = await chargeOf(cli1);
    for (let i = 0; i < 3; i++) await registerPayment(db, asstA, A, c1.id, { amount: "100,00", paidAt: "2026-10-15", method: "pix" }, TODAY);
    const r = await listReceipts(db, contA, A, "2026-10");
    const o = await getOverview(db, contA, A, TODAY);
    expect(r.totalCents).toBe(30000); expect(o.received!.monthCents).toBe(r.totalCents);
  });

  it("banco: saldo pelo extrato, créditos a conciliar, extrato desatualizado e transferência entre contas do grupo FORA do recebido", async () => {
    await approvedBatch();
    expect((await getOverview(db, contA, A, TODAY)).bank).toMatchObject({ accounts: 0, balanceCents: 0 });
    expect((await getOverview(db, contA, A, TODAY)).notes.join(" ")).toMatch(/Nenhuma conta bancária cadastrada/);
    const accA = await createAccount(db, gerA, A, { name: "Cora A", bank: "Cora", openingBalance: "1.000,00", openingDate: "2026-01-01" });
    await bankImport(gerA, A, accA, ["16/10/2026;PIX CLIENTE;1.500,00;K1", "17/10/2026;TARIFA;-39,90;K2", "18/10/2026;TRANSF PARA K3G CALL;-500,00;K3"]);
    const tr = (await listTransactions(db, contA, A, accA, "todas")).items.find((t) => t.description.startsWith("TRANSF"))!;
    await markTransaction(db, gerA, A, tr.id, "transferencia_grupo", "");
    const o = await getOverview(db, contA, A, TODAY);
    expect(o.bank).toEqual({ accounts: 1, balanceCents: 196010, pendingCredits: 1, pendingCents: 150000, lastTxDate: "2026-10-18", internalInCents: 0, internalOutCents: 50000 });
    expect(o.received).toEqual({ monthCents: 0, monthCount: 0 }); // extrato e transferência NÃO são recebimento
    expect(o.alerts.some((a) => a.key === "reconcile")).toBe(true);
    expect(o.alerts.some((a) => a.key === "stale-statement")).toBe(false);
    expect((await getOverview(db, contA, A, "2026-11-01")).alerts.find((a) => a.key === "stale-statement")).toMatchObject({ severity: "warning", detail: expect.stringContaining("14 dias") });
  });

  it("alertas de operação: lote em prévia, clientes sem contrato, bloqueios; sem permissão o bloco some", async () => {
    await activeContract(cli1, terms({ dueDay: "28" })); await activeContract(cli1, terms({ dueDay: "27" }));
    const { batchId } = await generateBatch(db, asstA, A, "2026-10-15"); void batchId; // prévia, não aprovada
    expect((await getOverview(db, contA, A, "2026-10-14")).alerts.find((a) => a.key === `batch-${batchId}`)).toMatchObject({ severity: "warning", href: `/faturamento/lotes/${batchId}` });
    expect((await getOverview(db, contA, A, "2026-10-20")).alerts.find((a) => a.key === `batch-${batchId}`)).toMatchObject({ severity: "critical" });
    const o = await getOverview(db, contA, A, "2026-10-14");
    expect(o.alerts.find((a) => a.key === "no-contract")).toMatchObject({ severity: "info", title: expect.stringContaining("1 cliente ativo sem contrato") }); // só o cliente 2
    expect(o.alerts.find((a) => a.key === "no-contact")).toBeUndefined(); // os dois têm contato financeiro com e-mail
    await db.delete(schema.customerContacts).where(eq(schema.customerContacts.partyId, cli2));
    expect((await getOverview(db, contA, A, "2026-10-14")).alerts.find((a) => a.key === "no-contact")).toMatchObject({ title: expect.stringContaining("1 cliente ativo") });
    expect((await getOverview(db, contA, A, "2026-10-14")).notes.join(" ")).not.toMatch(/Contas a pagar ainda não existem/); // agora existem (E11)
  });

  it("grupo: soma empresa por empresa com a autorização do usuário em cada uma; sem duplicar transferência interna", async () => {
    await approvedBatch();
    await registerPayment(db, asstA, A, (await chargeOf(cli1)).id, { amount: "1.000,00", paidAt: "2026-10-15", method: "pix" }, TODAY);
    const accA = await createAccount(db, gerA, A, { name: "Cora A", bank: "Cora", openingBalance: "1.000,00", openingDate: "2026-01-01" });
    await bankImport(gerA, A, accA, ["18/10/2026;TRANSF PARA K3G CALL;-500,00;K3"]);
    await markTransaction(db, gerA, A, (await listTransactions(db, contA, A, accA, "todas")).items[0].id, "transferencia_grupo", "");
    const accB = await createAccount(db, dirB, B, { name: "Cora B", bank: "Cora", openingBalance: "0", openingDate: "2026-01-01" });
    await bankImport(dirB, B, accB, ["18/10/2026;TRANSF DE K3G SOLUTIONS;500,00;K3"]);
    await markTransaction(db, dirB, B, (await listTransactions(db, dirB, B, accB, "todas")).items[0].id, "transferencia_grupo", "");
    const both = (await db.insert(schema.users).values({ email: "grupo@t.com", name: "grupo", passwordHash: "x" }).returning())[0].id;
    await db.insert(schema.memberships).values([{ userId: both, companyId: A, role: "diretoria" }, { userId: both, companyId: B, role: "contabilidade" }]);
    const g = await getGroupOverview(db, both, [{ id: A, name: "Empresa A" }, { id: B, name: "Empresa B" }], TODAY);
    expect(g.companies.map((c) => c.company.name)).toEqual(["Empresa A", "Empresa B"]);
    expect(g.skipped).toEqual([]);
    // A: 1.000 − 500 = 500; B: 0 + 500 = 500 → 1.000 consolidado; a transferência aparece como entrada E saída internas, não como receita
    expect(g.total).toMatchObject({ receivedMonthCents: 100000, balanceCents: 100000, internalInCents: 50000, internalOutCents: 50000 });
    // transferência interna não infla o recebido nem a receita; saldo consolidado é a soma das contas (entrada e saída se anulam)
    const a = g.companies[0], b = g.companies[1];
    expect(g.total.openCents).toBe((a.receivables?.openCents ?? 0) + (b.receivables?.openCents ?? 0));
    expect(g.total.billedMonthCents).toBe((a.billed?.monthCents ?? 0) + (b.billed?.monthCents ?? 0));
    expect(g.series[5].receivedCents).toBe(a.series[5].receivedCents + b.series[5].receivedCents);
    expect(g.weeks).toHaveLength(13);
    expect(g.weeks.reduce((s, w) => s + w.confirmedCents, 0)).toBe(a.forecast!.totals.confirmedCents + b.forecast!.totals.confirmedCents);
    // usuário só da empresa A: B é omitida (e listada), nunca lida
    const only = await getGroupOverview(db, dirA, [{ id: A, name: "Empresa A" }, { id: B, name: "Empresa B" }], TODAY);
    expect(only.companies.map((c) => c.company.name)).toEqual(["Empresa A"]); expect(only.skipped).toEqual(["Empresa B"]);
    expect(only.total.openCents).toBe(a.receivables!.openCents);
    // admin técnico não vê números financeiros
    await expect(getGroupOverview(db, techA, [{ id: A, name: "Empresa A" }], TODAY).then((x) => x.companies.length)).resolves.toBe(0);
  });

  it("contas a pagar no painel: saídas aprovadas × aguardando por semana, vencidas à parte, alertas e resultado só do confirmado", async () => {
    const vend = (await createParty(db, dirA, A, { kind: "fornecedor", legalName: "Fornecedor Alfa", document: CNPJ2 })).id;
    const mk = async (doc: string, amount: string, due: string, approve: boolean) => {
      const id = await createPayable(db, asstA, A, { vendorId: vend, description: `Conta ${doc}`, documentNumber: doc, amount, dueDate: due });
      await submitPayable(db, asstA, A, id); if (approve) await approvePayable(db, dirA, A, id); return id;
    };
    const t = "2026-10-21"; // quarta; semana começa em 19/10
    await mk("P1", "1.000,00", "2026-10-10", true); // vencida aprovada
    await mk("P2", "2.000,00", "2026-10-22", true); // semana 0, aprovada (vence em 1 dia)
    const p3 = await mk("P3", "3.000,00", "2026-10-28", true); // semana 1
    await mk("P4", "4.000,00", "2026-10-29", false); // semana 1, aguardando aprovação
    await mk("P5", "5.000,00", "2027-03-01", true); // além do horizonte
    await registerPayablePayment(db, dirA, A, p3, { amount: "500,00", paidAt: "2026-10-20", method: "pix" }, t); // baixa parcial reduz o saldo
    const o = await getOverview(db, contA, A, t);
    expect(o.payables).toMatchObject({ approvedOpenCents: 100000 + 200000 + 250000 + 500000, overdueCents: 100000, overdueCount: 1, pendingCents: 400000, pendingCount: 1, dueSoonCount: 1, paidMonthCents: 50000 });
    expect(o.outflow!.weeks[0]).toMatchObject({ start: "2026-10-19", approvedCents: 200000, pendingCents: 0 });
    expect(o.outflow!.weeks[1]).toMatchObject({ start: "2026-10-26", approvedCents: 250000, pendingCents: 400000 });
    expect(o.outflow).toMatchObject({ overdueApprovedCents: 100000, beyondCents: 500000, totals: { approvedCents: 450000, pendingCents: 400000 } });
    // conservação: aprovadas (semanas + vencida + além) = a pagar aprovado
    expect(o.outflow!.totals.approvedCents + o.outflow!.overdueApprovedCents + o.outflow!.beyondCents - 0).toBe(o.payables!.approvedOpenCents);
    const keys = o.alerts.map((a) => a.key);
    expect(keys).toEqual(expect.arrayContaining(["payables-overdue", "payables-pending", "payables-soon"]));
    expect(o.alerts.find((a) => a.key === "payables-overdue")).toMatchObject({ severity: "critical", href: "/contas-a-pagar?status=vencidas" });
    expect(o.notes.join(" ")).not.toMatch(/Seu papel não vê contas a pagar/);
    // outra empresa não vê nada disso
    const b = await getOverview(db, dirB, B, t);
    expect(b.payables).toMatchObject({ approvedOpenCents: 0, pendingCount: 0 });
    // consolidado soma as saídas das empresas autorizadas
    const g = await getGroupOverview(db, dirA, [{ id: A, name: "Empresa A" }], t);
    expect(g.total.payableApprovedCents).toBe(o.payables!.approvedOpenCents); expect(g.total.payableOverdueCents).toBe(100000); expect(g.total.payablePendingCents).toBe(400000);
    expect(g.outWeeks[1]).toMatchObject({ approvedCents: 250000, pendingCents: 400000 });
  });

  it("isolamento: a empresa B nunca enxerga números da A; admin técnico é barrado", async () => {
    await approvedBatch();
    const o = await getOverview(db, dirB, B, TODAY);
    expect(o.receivables).toMatchObject({ openCents: 0, overdueCents: 0 });
    expect(o.billed).toEqual({ monthCents: 0, monthCount: 0 });
    expect(o.alerts.some((a) => a.key === "overdue")).toBe(false);
    await expect(getOverview(db, techA, A, TODAY)).rejects.toThrow(Forbidden);
    await expect(getOverview(db, dirB, A, TODAY)).rejects.toThrow(Forbidden);
  });
});
