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
import { cancelStatement, closeMonth, exportStatementCsv, listPartners, listStatements, markPaid, monthView, setContractCommission } from "@/modules/commissions/service";

const enabled = !!process.env.POSTGRES_USER;
const CNPJ1 = "11.222.333/0001-81", CNPJ2 = "12.ABC.345/01DE-35";
const D = "2026-10-01"; // lote: competência 2026-09, vencimento 2026-10-14
const NOV = "2026-11-05"; // "hoje" dos testes de fechamento: outubro já acabou
const terms = (o: Record<string, unknown> = {}) => ({ description: "Monitoramento de redes", monthlyAmount: "2.500,00", startAt: "2026-01-01", endAt: "", dueDay: "14", invoiceJointRequired: false, issueDayOverride: "", ...o });

describe.skipIf(!enabled)("E18 comissões de parceiros (DB de teste)", () => {
  let admin: ReturnType<typeof postgres>, conn: ReturnType<typeof postgres>, db: DB;
  let A: string, B: string, dirA: string, dirB: string, gerA: string, asstA: string, contA: string, techA: string, cli1: string, cli2: string, k1: string, k2: string;

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
    await db.execute(sql`truncate commission_lines, commission_statements, payments, messaging_settings, message_queue, message_template_versions, message_templates, charges, billing_batches, holidays, contract_versions, contracts, integration_conflicts, integration_sync_runs, integration_connections, rate_limits, customer_contacts, vendor_contacts, customers, vendors, audit_log, invitations, memberships, companies, users restart identity cascade`);
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
    const active = async (customer: string, t = terms()) => {
      const c = await createContract(db, asstA, A, customer, t);
      await decideVersion(db, dirA, A, (await getContract(db, dirA, A, c.id))!.versions[0].id, "aprovar");
      return c.id;
    };
    k1 = await active(cli1); k2 = await active(cli2, terms({ monthlyAmount: "1.000,00" }));
    const { batchId } = await generateBatch(db, asstA, A, D);
    await approveBatch(db, dirA, A, batchId, (await getBatch(db, asstA, A, batchId))!.hash);
  });

  const chargeOf = async (customer: string) => (await db.select().from(schema.charges).where(eq(schema.charges.customerId, customer)))[0];
  const pay = async (customer: string, amount: string, paidAt: string) => registerPayment(db, asstA, A, (await chargeOf(customer)).id, { amount, paidAt, method: "pix" }, "2026-11-30");
  const mark = (k: string, percent: string, partner = "Medina") => setContractCommission(db, dirA, A, k, { partner, percent });
  const n = async (q: string) => Number((await db.execute(sql.raw(`select count(*)::int n from ${q}`)))[0].n);

  it("marcar contrato: permissões, validações e auditoria sem dados pessoais", async () => {
    await expect(mark(k1, "30")).resolves.toBeUndefined();
    await expect(setContractCommission(db, asstA, A, k1, { partner: "Medina", percent: "30" })).rejects.toBeInstanceOf(Forbidden);
    await expect(setContractCommission(db, contA, A, k1, { partner: "Medina", percent: "30" })).rejects.toBeInstanceOf(Forbidden);
    await expect(setContractCommission(db, techA, A, k1, { partner: "Medina", percent: "30" })).rejects.toBeInstanceOf(Forbidden);
    await expect(setContractCommission(db, gerA, A, k1, { partner: "Medina", percent: "12,5" })).resolves.toBeUndefined();
    expect((await db.select().from(schema.contracts).where(eq(schema.contracts.id, k1)))[0]).toMatchObject({ commissionPartner: "Medina", commissionBps: 1250 });
    for (const bad of ["0", "101", "abc", "12,555"]) await expect(mark(k1, bad)).rejects.toThrow(/Percentual inválido/);
    await expect(mark(k1, "30", "X")).rejects.toThrow(/2 a 60/);
    await expect(setContractCommission(db, dirB, B, k1, { partner: "Medina", percent: "30" })).rejects.toThrow(/não encontrado/); // contrato de outra empresa
    await mark(k2, "");                                                                                                          // parceiro sem percentual: permitido, fica pendente
    expect((await listPartners(db, contA, A))).toEqual([{ partner: "Medina", contracts: 2, withoutPercent: 1 }]);
    await setContractCommission(db, dirA, A, k2, { partner: "", percent: "50" });                                                // parceiro vazio limpa tudo
    expect((await db.select().from(schema.contracts).where(eq(schema.contracts.id, k2)))[0]).toMatchObject({ commissionPartner: null, commissionBps: null });
    const audits = await db.select().from(schema.auditLog).where(sql`action = 'commission.contract_set'`);
    expect(audits.length).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(audits.map((a) => a.detail))).not.toMatch(/Cliente|Medina/);
  });

  it("prévia: só cobrança QUITADA no mês, pelo valor mensal do contrato; parcial e outro mês ficam de fora", async () => {
    await mark(k1, "30"); await mark(k2, "10");
    expect((await monthView(db, contA, A, "Medina", "2026-10")).pending).toEqual([]);
    await pay(cli1, "1.000,00", "2026-10-10");                                  // parcial
    expect((await monthView(db, contA, A, "Medina", "2026-10")).pending).toEqual([]);
    await pay(cli1, "1.500,00", "2026-11-03");                                                                 // quita em novembro: vale para NOVEMBRO
    expect((await monthView(db, contA, A, "Medina", "2026-10")).pending).toEqual([]);
    const nov = await monthView(db, contA, A, "Medina", "2026-11");
    expect(nov.pending).toMatchObject([{ customerName: "Cliente Um", baseCents: 250000, bps: 3000, commissionCents: 75000, receivedOn: "2026-11-03" }]);
    expect(nov.payDate).toBe("2026-12-16");
    await pay(cli2, "1.000,00", "2026-10-20");
    const out = await monthView(db, contA, A, "Medina", "2026-10");
    expect(out.pending.map((l) => [l.customerName, l.commissionCents])).toEqual([["Cliente Dois", 10000]]);
    expect((await monthView(db, contA, A, "Outro", "2026-10")).pending).toEqual([]);                            // outro parceiro
    await expect(monthView(db, techA, A, "Medina", "2026-10")).rejects.toBeInstanceOf(Forbidden);
    await expect(monthView(db, dirA, A, "Medina", "2026-13")).rejects.toThrow(/Mês inválido/);
    expect((await monthView(db, dirB, B, "Medina", "2026-10")).pending).toEqual([]);                            // isolamento
  });

  it("fechar: bloqueia sem percentual, mês corrente e mês vazio; congela e não duplica", async () => {
    await mark(k1, ""); await mark(k2, "10");
    await pay(cli1, "2.500,00", "2026-10-15"); await pay(cli2, "1.000,00", "2026-10-16");
    const v = await monthView(db, dirA, A, "Medina", "2026-10");
    expect(v.missing.map((m) => m.customerName)).toEqual(["Cliente Um"]);
    await expect(closeMonth(db, dirA, A, "Medina", "2026-10", NOV)).rejects.toThrow(/Defina o percentual de 1 contrato/);
    await mark(k1, "30");
    await expect(closeMonth(db, dirA, A, "Medina", "2026-10", "2026-10-30")).rejects.toThrow(/ainda não terminou/);
    await expect(closeMonth(db, asstA, A, "Medina", "2026-10", NOV)).rejects.toBeInstanceOf(Forbidden);
    await expect(closeMonth(db, dirA, A, "Medina", "2026-09", NOV)).rejects.toThrow(/Nenhuma cobrança/);
    const r = await closeMonth(db, dirA, A, "Medina", "2026-10", NOV);
    expect(r).toMatchObject({ lines: 2, totalCents: 75000 + 10000 });
    await expect(closeMonth(db, dirA, A, "Medina", "2026-10", NOV)).rejects.toThrow(/já foi fechado/);
    // mudar o percentual depois NÃO muda o que foi congelado
    await mark(k1, "50");
    const after = await monthView(db, contA, A, "Medina", "2026-10");
    expect(after.statement).toMatchObject({ status: "fechado", totalCents: 85000 });
    expect(after.closed.map((l) => [l.customerName, l.bps, l.commissionCents])).toEqual([["Cliente Dois", 1000, 10000], ["Cliente Um", 3000, 75000]]);
    expect(after.pending).toEqual([]);
    expect(await n("commission_lines")).toBe(2);
  });

  it("pagar e cancelar: só uma vez, só fechado; cancelar libera as cobranças para novo fechamento", async () => {
    await mark(k1, "30");
    await pay(cli1, "2.500,00", "2026-10-15");
    const { statementId } = await closeMonth(db, dirA, A, "Medina", "2026-10", NOV);
    await expect(markPaid(db, asstA, A, statementId, { paidOn: "2026-11-16" }, "2026-11-16")).rejects.toBeInstanceOf(Forbidden);
    await expect(markPaid(db, dirA, A, statementId, { paidOn: "2026-11-30" }, "2026-11-16")).rejects.toThrow(/futura/);
    await expect(markPaid(db, dirA, A, statementId, { paidOn: "2026-09-30" }, "2026-11-16")).rejects.toThrow(/anterior ao mês/);
    await expect(markPaid(db, dirA, A, statementId, { paidOn: "16/11/2026" }, "2026-11-16")).rejects.toThrow(/inválida/);
    await expect(markPaid(db, dirB, B, statementId, { paidOn: "2026-11-16" }, "2026-11-16")).rejects.toThrow(/não encontrado/); // outra empresa
    await expect(cancelStatement(db, dirA, A, statementId, "x")).rejects.toThrow(/motivo/i);
    await cancelStatement(db, gerA, A, statementId, "percentual errado");
    await expect(cancelStatement(db, gerA, A, statementId, "de novo")).rejects.toThrow(/já cancelado/);
    await expect(markPaid(db, dirA, A, statementId, { paidOn: "2026-11-16" }, "2026-11-16")).rejects.toThrow(/cancelado/);
    expect((await monthView(db, dirA, A, "Medina", "2026-10")).pending).toHaveLength(1);                                         // voltou a ser pendente
    const again = await closeMonth(db, dirA, A, "Medina", "2026-10", NOV);
    await markPaid(db, dirA, A, again.statementId, { paidOn: "2026-11-16", note: "pix" }, "2026-11-16");
    await expect(markPaid(db, dirA, A, again.statementId, { paidOn: "2026-11-16" }, "2026-11-16")).rejects.toThrow(/já foi pago/);
    await expect(cancelStatement(db, dirA, A, again.statementId, "tarde demais")).rejects.toThrow(/pago não pode/);
    expect((await listStatements(db, contA, A, "Medina")).map((h) => [h.status, h.totalCents, h.payDate])).toEqual([["pago", 75000, "2026-11-16"], ["cancelado", 75000, "2026-11-16"]]);
    expect((await monthView(db, contA, A, "Medina", "2026-10")).statement).toMatchObject({ status: "pago", paidOn: "2026-11-16", paidNote: "pix" });
    expect(await n("commission_lines where voided_at is not null")).toBe(1);
  });

  it("baixa estornada depois do fechamento é sinalizada; baixa retroativa tardia aparece como pendente", async () => {
    await mark(k1, "30"); await mark(k2, "10");
    const p1 = await pay(cli1, "2.500,00", "2026-10-15");
    await closeMonth(db, dirA, A, "Medina", "2026-10", NOV);
    await pay(cli2, "1.000,00", "2026-10-28");                                                                                  // lançada depois do fechamento
    const v = await monthView(db, dirA, A, "Medina", "2026-10");
    expect(v.statement!.totalCents).toBe(75000);
    expect(v.pending.map((l) => l.customerName)).toEqual(["Cliente Dois"]);
    await expect(closeMonth(db, dirA, A, "Medina", "2026-10", NOV)).rejects.toThrow(/já foi fechado/);
    await reversePayment(db, gerA, A, p1.paymentId, "baixa lançada no cliente errado");
    const v2 = await monthView(db, dirA, A, "Medina", "2026-10");
    expect(v2.reversedChargeIds).toEqual([(await chargeOf(cli1)).id]);
    expect(v2.statement!.totalCents).toBe(75000);                                                                                // congelado
  });

  it("o banco protege os fechamentos: linhas e fechamentos imutáveis e sem DELETE", async () => {
    await mark(k1, "30");
    await pay(cli1, "2.500,00", "2026-10-15");
    const { statementId } = await closeMonth(db, dirA, A, "Medina", "2026-10", NOV);
    await expect(db.execute(sql`update commission_lines set commission_amount = 1 where statement_id = ${statementId}`)).rejects.toThrow();
    await expect(db.execute(sql`update commission_lines set bps = 1 where statement_id = ${statementId}`)).rejects.toThrow();
    await expect(db.execute(sql`delete from commission_lines where statement_id = ${statementId}`)).rejects.toThrow();
    await expect(db.execute(sql`update commission_statements set total_amount = 1 where id = ${statementId}`)).rejects.toThrow();
    await expect(db.execute(sql`delete from commission_statements where id = ${statementId}`)).rejects.toThrow();
    await expect(db.execute(sql`update contracts set commission_bps = 20000 where id = ${k1}`)).rejects.toThrow();               // CHECK 1..10000
    await expect(db.execute(sql`update contracts set commission_partner = null where id = ${k1}`)).rejects.toThrow();            // percentual sem parceiro
    await markPaid(db, dirA, A, statementId, { paidOn: "2026-11-16" }, "2026-11-16");
    await expect(db.execute(sql`update commission_statements set status = 'fechado', paid_on = null, paid_by = null where id = ${statementId}`)).rejects.toThrow();
  });

  it("não reescreve o que já se qualificou: mudar parceiro/percentual com recebimento fora de fechamento é bloqueado", async () => {
    await mark(k1, "30");
    await pay(cli1, "2.500,00", "2026-10-15");
    await expect(mark(k1, "50")).rejects.toThrow(/ainda não entraram em um fechamento/);
    await expect(mark(k1, "30", "Outro")).rejects.toThrow(/ainda não entraram/);
    await expect(setContractCommission(db, dirA, A, k1, { partner: "", percent: "" })).rejects.toThrow(/ainda não entraram/);
    await expect(mark(k1, "30")).resolves.toBeUndefined();                  // sem mudança: ok
    await mark(k2, "");                                                     // marcar contrato novo (sem regra anterior) é livre
    await pay(cli2, "1.000,00", "2026-10-16");
    await mark(k2, "10");                                                   // completar o percentual que faltava não muda regra existente
    await closeMonth(db, dirA, A, "Medina", "2026-10", NOV);
    await expect(mark(k1, "50")).resolves.toBeUndefined();                  // fechado: pode mudar (vale para os próximos)
  });

  it("fronteiras: quitação dividida em meses vale na data da última baixa; 1º e último dia do mês; estorno e nova quitação", async () => {
    await mark(k1, "30"); await mark(k2, "10");
    await pay(cli1, "1.000,00", "2026-10-31");
    const p2 = await pay(cli1, "1.500,00", "2026-11-01");                  // quitou no 1º dia de novembro
    expect((await monthView(db, dirA, A, "Medina", "2026-10")).pending).toEqual([]);
    expect((await monthView(db, dirA, A, "Medina", "2026-11")).pending.map((l) => l.receivedOn)).toEqual(["2026-11-01"]);
    await reversePayment(db, gerA, A, p2.paymentId, "erro de lançamento");  // deixa de estar quitada
    expect((await monthView(db, dirA, A, "Medina", "2026-11")).pending).toEqual([]);
    await pay(cli1, "1.500,00", "2026-11-30");                              // nova quitação, último dia de novembro
    expect((await monthView(db, dirA, A, "Medina", "2026-11")).pending.map((l) => l.receivedOn)).toEqual(["2026-11-30"]);
    expect((await monthView(db, dirA, A, "Medina", "2026-12")).pending).toEqual([]);
    await pay(cli2, "1.000,00", "2026-10-01");                              // primeiro dia de outubro
    expect((await monthView(db, dirA, A, "Medina", "2026-10")).pending.map((l) => l.receivedOn)).toEqual(["2026-10-01"]);
  });

  it("fechamentos simultâneos geram um só", async () => {
    await mark(k1, "30");
    await pay(cli1, "2.500,00", "2026-10-15");
    const r = await Promise.allSettled([closeMonth(db, dirA, A, "Medina", "2026-10", NOV), closeMonth(db, gerA, A, "Medina", "2026-10", NOV), closeMonth(db, dirA, A, "Medina", "2026-10", NOV)]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(r.filter((x) => x.status === "rejected").every((x) => (x as PromiseRejectedResult).reason instanceof Invalid)).toBe(true);
    expect(await n("commission_statements")).toBe(1); expect(await n("commission_lines")).toBe(1);
  });

  it("banco: anular linha só com o fechamento cancelado; fechamento pago/cancelado é definitivo em todos os campos", async () => {
    await mark(k1, "30");
    await pay(cli1, "2.500,00", "2026-10-15");
    const { statementId } = await closeMonth(db, dirA, A, "Medina", "2026-10", NOV);
    const why = async (q: ReturnType<typeof sql>) => { try { await db.execute(q); return ""; } catch (e) { return (e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message; } };
    expect(await why(sql`update commission_lines set voided_at = now() where statement_id = ${statementId}`)).toMatch(/só se anula linha de fechamento cancelado/);
    await markPaid(db, dirA, A, statementId, { paidOn: "2026-11-16", note: "pix" }, "2026-11-16");
    expect(await why(sql`update commission_statements set paid_note = 'outra' where id = ${statementId}`)).toMatch(/definitivo/);
    expect(await why(sql`update commission_statements set paid_by = ${gerA} where id = ${statementId}`)).toMatch(/definitivo/);
    expect(await why(sql`update commission_lines set voided_at = now() where statement_id = ${statementId}`)).toMatch(/só se anula linha de fechamento cancelado/);
  });

  it("CSV: totais e proteção contra fórmula", async () => {
    await mark(k1, "30");
    await db.update(schema.customers).set({ legalName: "=CMD Cliente" }).where(eq(schema.customers.id, cli1));
    await pay(cli1, "2.500,00", "2026-10-15");
    const csv = await exportStatementCsv(db, contA, A, "Medina", "2026-10");
    expect(csv).toContain("'=CMD Cliente");
    expect(csv).toContain('TOTAL;;;;;"750,00"');
    expect(csv).toContain('"2500,00";30%;"750,00"');
    await expect(exportStatementCsv(db, techA, A, "Medina", "2026-10")).rejects.toBeInstanceOf(Forbidden);
  });
});
