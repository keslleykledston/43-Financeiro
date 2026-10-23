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
import { approveBatch, cancelBatch, generateBatch, getBatch, reopenBatch } from "@/modules/billing/batches";
import { ensureDefaultTemplates, listQueue, processQueue, scheduleQueue } from "@/modules/messaging/service";
import { exportReceivables, getReceivable, listReceivables, receivablesSummary, registerPayment, reversePayment } from "@/modules/receivables/service";

const enabled = !!process.env.POSTGRES_USER;
const CNPJ1 = "11.222.333/0001-81", CNPJ2 = "12.ABC.345/01DE-35";
// competência 2026-09, vencimento 2026-10-14, emissão 2026-10-01. Régua: 10-01, 10-11, 10-14, 10-17, 10-21 (+ revisão 10-29).
const D = "2026-10-01";
const terms = (o: Record<string, unknown> = {}) => ({ description: "Monitoramento de redes", monthlyAmount: "2.500,00", startAt: "2026-01-01", endAt: "", dueDay: "14", invoiceJointRequired: false, issueDayOverride: "", ...o });

describe.skipIf(!enabled)("E07 contas a receber: baixa manual, saldo, estorno, isolamento (DB de teste)", () => {
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
    await db.execute(sql`truncate payments, messaging_settings, message_queue, message_template_versions, message_templates, charges, billing_batches, holidays, contract_versions, contracts, integration_conflicts, integration_sync_runs, integration_connections, rate_limits, customer_contacts, vendor_contacts, customers, vendors, audit_log, invitations, memberships, companies, users restart identity cascade`);
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
  const pay = (id: string, amount: string, o: Record<string, string> = {}, by = asstA, today = "2026-10-20") => registerPayment(db, by, A, id, { amount, paidAt: "2026-10-15", method: "pix", ...o }, today);
  const TODAY = "2026-10-20"; // cobranças vencem 14/10: 6 dias de atraso

  it("lista só cobranças APROVADAS, com saldo calculado e situação correta", async () => {
    await activeContract(cli1); await activeContract(cli2, terms({ dueDay: "20", monthlyAmount: "1.000,00" }));
    const { batchId } = await generateBatch(db, asstA, A, D);
    expect(await listReceivables(db, contA, A, { status: "todas" }, TODAY)).toHaveLength(0); // prévia ainda não é título
    await approveBatch(db, dirA, A, batchId, (await getBatch(db, asstA, A, batchId))!.hash);
    const all = await listReceivables(db, contA, A, { status: "todas" }, TODAY);
    expect(all.map((r) => [r.customerName, r.situation, r.amountCents, r.openCents, r.overdueDays])).toEqual([
      ["Cliente Um", "vencida", 250000, 250000, 6],
    ]);
    // vence hoje não é atraso; antes de vencer é "a vencer"
    expect((await listReceivables(db, contA, A, { status: "todas" }, "2026-10-14"))[0]).toMatchObject({ situation: "a_vencer", overdueDays: 0 });
    expect((await listReceivables(db, contA, A, { status: "vencidas" }, "2026-10-14"))).toHaveLength(0);
    expect((await listReceivables(db, contA, A, { status: "vencidas" }, "2026-10-15"))).toHaveLength(1);
    await expect(listReceivables(db, techA, A)).rejects.toThrow(Forbidden);
    expect(await listReceivables(db, dirB, B, { status: "todas" }, TODAY)).toHaveLength(0);
  });

  it("pagamento parcial → parcial; completar → quitada; nunca passa do saldo", async () => {
    const batchId = await approvedBatch(); void batchId;
    const c = await chargeOf(cli1);
    await expect(pay(c.id, "0")).rejects.toThrow(/valor válido/);
    await expect(pay(c.id, "abc")).rejects.toThrow(/valor válido/);
    await expect(pay(c.id, "100,00", { method: "cheque" })).rejects.toThrow(/Forma de pagamento/);
    await expect(pay(c.id, "100,00", { paidAt: "2026-10-21" })).rejects.toThrow(/futura/);
    await expect(pay(c.id, "100,00", { paidAt: "2026-09-30" })).rejects.toThrow(/anterior à emissão/);
    await expect(pay(c.id, "100,00", { paidAt: "31/10/2026" })).rejects.toThrow(/inválida/);
    await expect(pay(c.id, "100,00", { note: "x".repeat(201) })).rejects.toThrow(/200/);
    await expect(pay(c.id, "100,00", {}, contA)).rejects.toThrow(Forbidden);
    await expect(pay(c.id, "100,00", {}, techA)).rejects.toThrow(Forbidden);
    const p1 = await pay(c.id, "1.000,00");
    expect(p1).toMatchObject({ duplicate: false, settled: false });
    let r = (await getReceivable(db, contA, A, c.id, TODAY))!;
    expect(r).toMatchObject({ paidCents: 100000, openCents: 150000, situation: "parcial" });
    expect((await listReceivables(db, contA, A, { status: "parciais" }, TODAY))).toHaveLength(1);
    expect((await listReceivables(db, contA, A, { status: "quitadas" }, TODAY))).toHaveLength(0);
    await expect(pay(c.id, "1.500,01")).rejects.toThrow(/saldo em aberto \(R\$ 1\.500,00\)/);
    expect(await pay(c.id, "1.500,00")).toMatchObject({ settled: true });
    r = (await getReceivable(db, contA, A, c.id, TODAY))!;
    expect(r).toMatchObject({ paidCents: 250000, openCents: 0, situation: "quitada", overdueDays: 0 });
    await expect(pay(c.id, "0,01")).rejects.toThrow(/saldo em aberto \(R\$ 0,00\)/);
    expect((await listReceivables(db, contA, A, { status: "abertas" }, TODAY)).map((x) => x.customerName)).toEqual(["Cliente Dois"]);
    expect((await listReceivables(db, contA, A, { status: "quitadas" }, TODAY)).map((x) => x.customerName)).toEqual(["Cliente Um"]);
  });

  it("banco: trigger barra soma acima do valor e pagamento em cobrança não aprovada, mesmo sem passar pelo serviço", async () => {
    await approvedBatch();
    const c = await chargeOf(cli1);
    const ins = (amount: string) => db.insert(schema.payments).values({ companyId: A, chargeId: c.id, amount, paidAt: "2026-10-15", method: "pix", registeredBy: asstA });
    await ins("2000.00");
    await expect(ins("500.01")).rejects.toThrow(); // 2000 + 500,01 > 2500
    await ins("500.00");
    await expect(ins("0.01")).rejects.toThrow();
    await db.execute(sql`update charges set status = 'previa' where id = ${c.id}`);
    await expect(ins("0.01")).rejects.toThrow();
    await expect(db.insert(schema.payments).values({ companyId: A, chargeId: c.id, amount: "0", paidAt: "2026-10-15", method: "pix", registeredBy: asstA })).rejects.toThrow();
    await expect(db.insert(schema.payments).values({ companyId: A, chargeId: c.id, amount: "1", paidAt: "2026-10-15", method: "cheque", registeredBy: asstA })).rejects.toThrow();
    await expect(db.insert(schema.payments).values({ companyId: B, chargeId: c.id, amount: "1", paidAt: "2026-10-15", method: "pix", registeredBy: asstA })).rejects.toThrow(); // FK composta: outra empresa
    await expect(db.update(schema.payments).set({ status: "estornado" })).rejects.toThrow(); // estorno exige quem/quando/motivo
  });

  it("concorrência: dois pagamentos simultâneos que juntos passam do saldo → só um entra", async () => {
    await approvedBatch();
    const c = await chargeOf(cli1);
    const res = await Promise.allSettled([pay(c.id, "1.500,00"), pay(c.id, "1.500,00"), pay(c.id, "1.500,00")]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(res.filter((r) => r.status === "rejected").every((r) => /saldo em aberto/.test((r as PromiseRejectedResult).reason.message))).toBe(true);
    expect((await getReceivable(db, contA, A, c.id, TODAY))!.paidCents).toBe(150000);
  });

  it("idempotência: o mesmo envio do formulário não registra duas vezes", async () => {
    await approvedBatch();
    const c = await chargeOf(cli1), c2 = await chargeOf(cli2);
    const k = "form-token-0001";
    const a = await pay(c.id, "500,00", { requestKey: k });
    const b = await pay(c.id, "500,00", { requestKey: k });
    expect(b).toMatchObject({ duplicate: true, paymentId: a.paymentId });
    expect((await getReceivable(db, contA, A, c.id, TODAY))!.paidCents).toBe(50000);
    await expect(pay(c2.id, "500,00", { requestKey: k })).rejects.toThrow(/já usada/);
    await expect(pay(c.id, "500,00", { requestKey: "x" })).rejects.toThrow(/inválida/);
    const dupes = await Promise.all([pay(c.id, "100,00", { requestKey: "form-token-0002" }), pay(c.id, "100,00", { requestKey: "form-token-0002" })].map((p) => p.catch((e) => e)));
    expect((await getReceivable(db, contA, A, c.id, TODAY))!.paidCents).toBe(60000);
    void dupes;
  });

  it("estorno: só gerente/diretoria, com motivo; o histórico fica e o saldo volta; nunca apaga", async () => {
    await approvedBatch();
    const c = await chargeOf(cli1);
    const { paymentId } = await pay(c.id, "2.500,00");
    expect((await getReceivable(db, contA, A, c.id, TODAY))!.situation).toBe("quitada");
    await expect(reversePayment(db, asstA, A, paymentId, "lançado no cliente errado")).rejects.toThrow(Forbidden);
    await expect(reversePayment(db, gerA, A, paymentId, "ruim")).rejects.toThrow(/motivo/);
    await expect(reversePayment(db, dirB, B, paymentId, "tentando de outra empresa")).rejects.toThrow(/não encontrado/);
    await reversePayment(db, gerA, A, paymentId, "lançado no cliente errado");
    await expect(reversePayment(db, gerA, A, paymentId, "lançado no cliente errado")).rejects.toThrow(/já foi estornado/);
    const r = (await getReceivable(db, contA, A, c.id, TODAY))!;
    expect(r).toMatchObject({ paidCents: 0, openCents: 250000, situation: "vencida" });
    expect(r.payments).toHaveLength(1);
    expect(r.payments[0]).toMatchObject({ status: "estornado", reverseReason: "lançado no cliente errado" });
    expect(r.events.map((e) => e.kind)).toEqual(["aprovada", "pagamento", "estorno"]);
    expect(await n("payments")).toBe(1);
    await pay(c.id, "2.500,00"); // pode pagar de novo depois do estorno
    expect((await getReceivable(db, contA, A, c.id, TODAY))!.situation).toBe("quitada");
  });

  it("quitar para a régua de mensagens (itens abertos cancelados, não reprograma); estorno + reprogramar volta", async () => {
    await approvedBatch(); await ensureDefaultTemplates(db, dirA, A);
    await scheduleQueue(db, asstA, A, D);
    const c = await chargeOf(cli1);
    const before = await n(`message_queue where customer_id = '${cli1}' and status = 'pendente'`);
    expect(before).toBeGreaterThan(0);
    await pay(c.id, "1.000,00"); // parcial: a régua continua
    expect(await n(`message_queue where customer_id = '${cli1}' and status = 'pendente'`)).toBe(before);
    const { paymentId } = await pay(c.id, "1.500,00"); // quitou
    expect(await n(`message_queue where customer_id = '${cli1}' and status = 'pendente'`)).toBe(0);
    expect(await n(`message_queue where customer_id = '${cli1}' and status = 'cancelado'`)).toBe(before);
    await scheduleQueue(db, asstA, A, D);
    expect(await n(`message_queue where customer_id = '${cli1}' and status = 'pendente'`)).toBe(0); // quitada não recebe régua
    expect((await listQueue(db, contA, A)).items.some((i) => i.customerName === "Cliente Um")).toBe(false);
    // se sobrar item aberto de cobrança quitada (ex.: baixa feita por fora), o processamento cancela em vez de enviar
    await reversePayment(db, gerA, A, paymentId, "baixa feita com valor errado");
    await scheduleQueue(db, asstA, A, D);
    expect(await n(`message_queue where customer_id = '${cli1}' and status = 'pendente'`)).toBeGreaterThan(0);
    await db.insert(schema.payments).values({ companyId: A, chargeId: c.id, amount: "1500.00", paidAt: "2026-10-15", method: "pix", registeredBy: asstA });
    expect((await processQueue(db, asstA, A, D)).cancelled).toBeGreaterThan(0);
    expect(await n(`message_queue where customer_id = '${cli1}' and status = 'simulado'`)).toBe(0);
  });

  it("lote com pagamento (ou estorno) não pode ser reaberto nem cancelado", async () => {
    const batchId = await approvedBatch();
    const c = await chargeOf(cli1);
    const { paymentId } = await pay(c.id, "100,00");
    await expect(reopenBatch(db, gerA, A, batchId, "preciso mudar o valor")).rejects.toThrow(/pagamentos/);
    await reversePayment(db, gerA, A, paymentId, "valor lançado errado");
    await expect(reopenBatch(db, gerA, A, batchId, "preciso mudar o valor")).rejects.toThrow(/pagamentos/); // o estorno também é histórico
    await expect(cancelBatch(db, asstA, A, batchId)).rejects.toThrow(/prévia/);
    expect(await n("charges")).toBe(2);
  });

  it("indicadores: em aberto, vencido, recebido no mês, envelhecimento e maiores devedores", async () => {
    await activeContract(cli1); await activeContract(cli2, terms({ dueDay: "16", monthlyAmount: "1.000,00" }));
    const { batchId } = await generateBatch(db, asstA, A, D);
    await approveBatch(db, dirA, A, batchId, (await getBatch(db, asstA, A, batchId))!.hash);
    const c1 = await chargeOf(cli1);
    await pay(c1.id, "500,00", { paidAt: "2026-10-10" });
    await pay((await chargeOf(cli2)).id, "1.000,00", { paidAt: "2026-09-30".replace("09-30", "10-02") });
    const s = await receivablesSummary(db, contA, A, TODAY);
    expect(s).toMatchObject({ openCents: 200000, openCount: 1, overdueCents: 200000, overdueCount: 1, receivedMonthCents: 150000, receivedMonthCount: 2 });
    expect(s.aging.map((b) => [b.key, b.cents, b.count])).toEqual([["1-15", 200000, 1], ["16-30", 0, 0], ["31-60", 0, 0], ["61+", 0, 0]]);
    expect(s.topDebtors).toEqual([{ customerId: cli1, name: "Cliente Um", overdueCents: 200000, oldestDays: 6, count: 1 }]);
    expect((await receivablesSummary(db, dirB, B, TODAY))).toMatchObject({ openCents: 0, overdueCents: 0, receivedMonthCents: 0 });
    // no mês seguinte o recebido do mês zera e o atraso envelhece
    const nov = await receivablesSummary(db, contA, A, "2026-11-20");
    expect(nov.receivedMonthCents).toBe(0); expect(nov.aging.find((b) => b.key === "31-60")!.cents).toBe(200000);
  });

  it("filtros: cliente, vencimento e competência; texto de busca não injeta SQL", async () => {
    await approvedBatch();
    expect((await listReceivables(db, contA, A, { status: "todas", q: "dois" }, TODAY)).map((r) => r.customerName)).toEqual(["Cliente Dois"]);
    expect(await listReceivables(db, contA, A, { status: "todas", q: "%" }, TODAY)).toHaveLength(0);
    expect(await listReceivables(db, contA, A, { status: "todas", q: "'; drop table charges; --" }, TODAY)).toHaveLength(0);
    expect(await n("charges")).toBe(2);
    expect(await listReceivables(db, contA, A, { status: "todas", dueFrom: "2026-10-15" }, TODAY)).toHaveLength(0);
    expect(await listReceivables(db, contA, A, { status: "todas", dueFrom: "2026-10-14", dueTo: "2026-10-14" }, TODAY)).toHaveLength(2);
    expect(await listReceivables(db, contA, A, { status: "todas", competence: "2026-09" }, TODAY)).toHaveLength(2);
    expect(await listReceivables(db, contA, A, { status: "todas", competence: "2026-08" }, TODAY)).toHaveLength(0);
    expect(await listReceivables(db, contA, A, { status: "nada", competence: "lixo", dueFrom: "x" }, TODAY)).toHaveLength(2); // padrão: em aberto
  });

  it("exportação CSV: permissão, proteção contra fórmula, só a empresa ativa, auditada sem dados", async () => {
    await db.update(schema.customers).set({ legalName: "=HYPERLINK(\"http://x\")" }).where(eq(schema.customers.id, cli1));
    await approvedBatch();
    await expect(exportReceivables(db, asstA, A, {}, TODAY)).rejects.toThrow(Forbidden);
    await expect(exportReceivables(db, techA, A, {}, TODAY)).rejects.toThrow(Forbidden);
    const csv = await exportReceivables(db, contA, A, { status: "todas" }, TODAY);
    expect(csv.split("\r\n")[0]).toBe("\uFEFFCliente;Descrição;Competência;Emissão;Vencimento;Valor;Pago;Saldo;Situação;Dias de atraso");
    expect(csv).toContain("'=HYPERLINK"); expect(csv).not.toMatch(/(^|;)=HYPERLINK/m);
    expect(csv).toContain('"2500,00";"0,00";"2500,00";Vencida;6');
    expect(csv).not.toContain("Empresa B");
    expect((await exportReceivables(db, dirB, B, {}, TODAY)).split("\r\n").filter(Boolean)).toHaveLength(1); // só o cabeçalho
    const logs = await db.select().from(schema.auditLog).where(sql`${schema.auditLog.action} like 'receivable.%'`);
    expect(JSON.stringify(logs.map((l) => l.detail))).not.toContain("HYPERLINK");
  });

  it("auditoria dos pagamentos só com ids e indicadores (sem valores, nomes ou observação)", async () => {
    await approvedBatch();
    const c = await chargeOf(cli1);
    const { paymentId } = await pay(c.id, "1.234,56", { note: "pago pelo sócio João" });
    await reversePayment(db, gerA, A, paymentId, "motivo com nome Maria");
    const logs = await db.select().from(schema.auditLog).where(sql`${schema.auditLog.action} like 'receivable.%'`);
    expect(logs.map((l) => l.action).sort()).toEqual(["receivable.payment_registered", "receivable.payment_reversed"]);
    const txt = JSON.stringify(logs.map((l) => l.detail));
    for (const bad of ["1234", "1.234", "João", "Maria", "Cliente"]) expect(txt).not.toContain(bad);
    expect(logs.find((l) => l.action === "receivable.payment_registered")!.detail).toMatchObject({ chargeId: c.id, paymentId, method: "pix", settled: false });
  });

  it("isolamento: outra empresa não vê, paga nem estorna", async () => {
    await approvedBatch();
    const c = await chargeOf(cli1);
    expect(await getReceivable(db, dirB, B, c.id, TODAY)).toBeNull();
    await expect(registerPayment(db, dirB, B, c.id, { amount: "1,00", paidAt: "2026-10-15", method: "pix" }, TODAY)).rejects.toThrow(/não encontrada/);
    await expect(registerPayment(db, dirB, A, c.id, { amount: "1,00", paidAt: "2026-10-15", method: "pix" }, TODAY)).rejects.toThrow(Forbidden);
    const { paymentId } = await pay(c.id, "10,00");
    await expect(reversePayment(db, dirB, B, paymentId, "tentando estornar de outra")).rejects.toThrow(/não encontrado/);
    expect(await getReceivable(db, contA, A, "não-é-uuid", TODAY)).toBeNull();
  });
});
