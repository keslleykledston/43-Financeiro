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
import { approvePayable, cancelPayable, createPayable, exportPayables, executionQueue, getPayable, getPayablesSettings, listActiveVendors, listPayables, payablesSummary, registerPayablePayment, rejectPayable, reversePayablePayment, savePayablesSettings, submitPayable, updatePayable } from "@/modules/payables/service";

const enabled = !!process.env.POSTGRES_USER;
const CNPJ1 = "11.222.333/0001-81", CNPJ2 = "12.ABC.345/01DE-35";
// competência 2026-09, vencimento 2026-10-14, emissão 2026-10-01. Régua: 10-01, 10-11, 10-14, 10-17, 10-21 (+ revisão 10-29).
const D = "2026-10-01";
const terms = (o: Record<string, unknown> = {}) => ({ description: "Monitoramento de redes", monthlyAmount: "2.500,00", startAt: "2026-01-01", endAt: "", dueDay: "14", invoiceJointRequired: false, issueDayOverride: "", ...o });

describe.skipIf(!enabled)("E11 contas a pagar: fluxo, alçada, duplicidade, baixa manual e isolamento (DB de teste)", () => {
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

  const n = async (q: string) => Number((await db.execute(sql.raw(`select count(*)::int n from ${q}`)))[0].n);

  let vendA: string, vendB: string;
  beforeEach(async () => {
    vendA = (await createParty(db, dirA, A, { kind: "fornecedor", legalName: "Fornecedor Alfa", document: CNPJ2 })).id;
    vendB = (await createParty(db, dirB, B, { kind: "fornecedor", legalName: "Fornecedor Beta", document: CNPJ1 })).id;
  });
  const TODAY = "2026-10-20";
  const base = (o: Record<string, unknown> = {}) => ({ vendorId: vendA, description: "Link de internet outubro", documentNumber: "NF-100", amount: "1.200,00", dueDate: "2026-10-25", category: "Infra", ...o });
  const row = async (id: string) => (await db.select().from(schema.payables).where(eq(schema.payables.id, id)))[0];
  /** cria, envia e aprova (por diretoria, criada por assistente) */
  const approved = async (o: Record<string, unknown> = {}) => { const id = await createPayable(db, asstA, A, base(o)); await submitPayable(db, asstA, A, id); await approvePayable(db, dirA, A, id); return id; };
  const pay = (id: string, amount: string, o: Record<string, string> = {}, by = dirA) => registerPayablePayment(db, by, A, id, { amount, paidAt: "2026-10-19", method: "pix", ...o }, TODAY);

  it("alçada e segregação nascem conservadoras; só a diretoria altera", async () => {
    expect(await getPayablesSettings(db, contA, A)).toEqual({ managerLimitCents: 500000, directorSelfApproval: false });
    await expect(savePayablesSettings(db, gerA, A, { managerLimit: "10.000,00", directorSelfApproval: false })).rejects.toThrow(Forbidden);
    await expect(savePayablesSettings(db, dirA, A, { managerLimit: "abc", directorSelfApproval: false })).rejects.toThrow(/Limite/);
    await savePayablesSettings(db, dirA, A, { managerLimit: "10.000,00", directorSelfApproval: true });
    expect(await getPayablesSettings(db, asstA, A)).toEqual({ managerLimitCents: 1000000, directorSelfApproval: true });
    expect(await getPayablesSettings(db, dirB, B)).toEqual({ managerLimitCents: 500000, directorSelfApproval: false }); // outra empresa
    await expect(getPayablesSettings(db, techA, A)).rejects.toThrow(Forbidden);
  });

  it("lançar: permissão, validações, fornecedor ativo da MESMA empresa, nº de documento único e duplicidade provável", async () => {
    await expect(createPayable(db, contA, A, base())).rejects.toThrow(Forbidden);
    await expect(createPayable(db, asstA, A, base({ vendorId: "x" }))).rejects.toThrow(/fornecedor/);
    await expect(createPayable(db, asstA, A, base({ description: "a" }))).rejects.toThrow(/Descreva/);
    await expect(createPayable(db, asstA, A, base({ amount: "0" }))).rejects.toThrow(/valor válido/);
    await expect(createPayable(db, asstA, A, base({ dueDate: "2026-02-31" }))).rejects.toThrow(/Vencimento inválido/);
    await expect(createPayable(db, asstA, A, base({ vendorId: vendB }))).rejects.toThrow(/Fornecedor não encontrado/); // fornecedor de outra empresa
    const id = await createPayable(db, asstA, A, base());
    expect(await row(id)).toMatchObject({ status: "rascunho", createdBy: asstA, documentNumber: "NF-100" });
    await expect(createPayable(db, asstA, A, base({ amount: "999,00" }))).rejects.toThrow(/mesmo número de documento|número de documento/); // mesmo nº, mesmo fornecedor
    await expect(createPayable(db, asstA, A, base({ documentNumber: "NF-101" }))).rejects.toThrow(/POSSIVEL_DUPLICIDADE/); // mesmo valor e vencimento
    const forced = await createPayable(db, asstA, A, base({ documentNumber: "NF-101", force: true }));
    expect(forced).not.toBe(id);
    // o nº do documento não diferencia caixa nem espaços
    await expect(createPayable(db, asstA, A, base({ documentNumber: " nf-100 ", amount: "7,00", dueDate: "2026-11-02" }))).rejects.toThrow(/número de documento/);
    await expect(createPayable(db, asstA, A, base({ documentNumber: "NF   -100", amount: "8,00", dueDate: "2026-11-03" }))).resolves.toBeTruthy(); // espaço no meio normaliza para "NF -100": outro documento
    // outro fornecedor com o mesmo nº de documento é permitido
    const v2 = (await createParty(db, dirA, A, { kind: "fornecedor", legalName: "Fornecedor Gama", document: CNPJ1 })).id;
    await createPayable(db, asstA, A, base({ vendorId: v2 }));
    // cancelar libera o número do documento
    await cancelPayable(db, asstA, A, id, "lançada por engano");
    await createPayable(db, asstA, A, base({ amount: "5,00", dueDate: "2026-11-30" }));
    // fornecedor suspenso não recebe lançamentos
    await db.execute(sql`update vendors set status = 'suspenso' where id = ${v2}`);
    await expect(createPayable(db, asstA, A, base({ vendorId: v2, documentNumber: "Z", amount: "7,00" }))).rejects.toThrow(/inativo/);
    expect((await listActiveVendors(db, contA, A)).map((v) => v.name)).toEqual(["Fornecedor Alfa"]);
  });

  it("duplicidade provável simultânea: dois lançamentos iguais ao mesmo tempo → só um passa sem confirmação", async () => {
    const mk = (doc: string) => createPayable(db, asstA, A, base({ documentNumber: doc, amount: "321,00", dueDate: "2026-11-09" }));
    const r = await Promise.allSettled([mk("D-1"), mk("D-2"), mk("D-3")]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(r.filter((x) => x.status === "rejected").every((x) => /POSSIVEL_DUPLICIDADE/.test((x as PromiseRejectedResult).reason.message))).toBe(true);
  });

  it("rascunho: edita quem criou (ou a gerência); depois de enviar é imutável", async () => {
    const id = await createPayable(db, asstA, A, base());
    await expect(updatePayable(db, contA, A, id, base())).rejects.toThrow(Forbidden);
    const other = (await db.insert(schema.users).values({ email: "asst2@t.com", name: "a2", passwordHash: "x" }).returning())[0].id;
    await db.insert(schema.memberships).values({ userId: other, companyId: A, role: "assistente" });
    await expect(updatePayable(db, other, A, id, base({ amount: "1,00" }))).rejects.toThrow(/Só quem criou/);
    await updatePayable(db, asstA, A, id, base({ amount: "1.500,00", description: "Link corrigido" }));
    expect(await row(id)).toMatchObject({ amount: "1500.00", description: "Link corrigido" });
    await submitPayable(db, asstA, A, id);
    await expect(updatePayable(db, asstA, A, id, base())).rejects.toThrow(/Só é possível editar um rascunho/);
    await expect(submitPayable(db, asstA, A, id)).rejects.toThrow(/rascunho pode ser enviado/);
    await expect(db.execute(sql`update payables set amount = 1 where id = ${id}`)).rejects.toThrow(); // trigger
  });

  it("aprovação: alçada do gerente, segregação, diretoria sem teto, auto-aprovação só se permitida", async () => {
    const small = await createPayable(db, asstA, A, base({ documentNumber: "S1", amount: "5.000,00" }));
    const big = await createPayable(db, asstA, A, base({ documentNumber: "B1", amount: "5.000,01", dueDate: "2026-10-26" }));
    await submitPayable(db, asstA, A, small); await submitPayable(db, asstA, A, big);
    await expect(approvePayable(db, asstA, A, small)).rejects.toThrow(Forbidden);
    await expect(approvePayable(db, contA, A, small)).rejects.toThrow(Forbidden);
    await approvePayable(db, gerA, A, small, "ok"); // exatamente no limite
    await expect(approvePayable(db, gerA, A, big)).rejects.toThrow(/acima da alçada do gerente \(R\$ 5\.000,00\)/);
    await approvePayable(db, dirA, A, big);
    expect(await row(big)).toMatchObject({ status: "aprovado", decidedBy: dirA });
    await expect(approvePayable(db, dirA, A, big)).rejects.toThrow(/aguardando aprovação/);
    // segregação: quem lançou não aprova
    const mine = await createPayable(db, gerA, A, base({ documentNumber: "M1", amount: "10,00", dueDate: "2026-10-27" }));
    await submitPayable(db, gerA, A, mine);
    await expect(approvePayable(db, gerA, A, mine)).rejects.toThrow(/Quem lançou/);
    const dmine = await createPayable(db, dirA, A, base({ documentNumber: "D1", amount: "10,00", dueDate: "2026-10-28" }));
    await submitPayable(db, dirA, A, dmine);
    await expect(approvePayable(db, dirA, A, dmine)).rejects.toThrow(/Quem lançou/); // nem a diretoria, por padrão
    await savePayablesSettings(db, dirA, A, { managerLimit: "5.000,00", directorSelfApproval: true });
    await approvePayable(db, dirA, A, dmine);
    const log = await db.select().from(schema.auditLog).where(sql`${schema.auditLog.action} = 'payable.approved'`);
    expect(log.some((l) => (l.detail as { selfApproved: boolean }).selfApproved)).toBe(true); // auto-aprovação fica registrada
    // gerente continua sem poder aprovar o próprio, mesmo com a diretoria liberada
    await expect(approvePayable(db, gerA, A, mine)).rejects.toThrow(/Quem lançou/);
  });

  it("rejeitar exige motivo e encerra; rejeitada/cancelada são imutáveis e liberam o nº do documento", async () => {
    const id = await createPayable(db, asstA, A, base()); await submitPayable(db, asstA, A, id);
    await expect(rejectPayable(db, gerA, A, id, "x")).rejects.toThrow(/motivo/);
    await expect(rejectPayable(db, asstA, A, id, "não tem nota fiscal")).rejects.toThrow(Forbidden);
    await rejectPayable(db, gerA, A, id, "não tem nota fiscal");
    expect(await row(id)).toMatchObject({ status: "rejeitado", decisionNote: "não tem nota fiscal" });
    await expect(approvePayable(db, dirA, A, id)).rejects.toThrow(/aguardando aprovação/);
    await expect(cancelPayable(db, dirA, A, id, "tentando cancelar")).rejects.toThrow(/já está encerrada/);
    await expect(pay(id, "10,00")).rejects.toThrow(/aprovada/);
    await expect(db.execute(sql`update payables set status = 'aprovado' where id = ${id}`)).rejects.toThrow();
    await createPayable(db, asstA, A, base()); // mesmo documento/valor/vencimento: a rejeitada não conta
  });

  it("baixa manual: só em conta aprovada; parcial/total; nunca passa do saldo; idempotente; estorno; situação derivada", async () => {
    const id = await approved();
    const draft = await createPayable(db, asstA, A, base({ documentNumber: "X", amount: "3,00", dueDate: "2026-12-01" }));
    await expect(pay(draft, "1,00")).rejects.toThrow(/aprovada/);
    await expect(pay(id, "100,00", {}, asstA)).rejects.toThrow(Forbidden);
    await expect(pay(id, "100,00", {}, contA)).rejects.toThrow(Forbidden);
    await expect(pay(id, "0")).rejects.toThrow(/valor válido/);
    await expect(pay(id, "100,00", { method: "cheque" })).rejects.toThrow(/Forma/);
    await expect(pay(id, "100,00", { paidAt: "2026-10-21" })).rejects.toThrow(/futura/);
    await expect(pay(id, "100,00", { paidAt: "2026-02-31" })).rejects.toThrow(/inválida/);
    const r = await pay(id, "200,00", { reference: "PROTOCOLO 123", note: "pago no Cora", requestKey: "pagar-0001" });
    expect(r).toMatchObject({ duplicate: false, settled: false });
    expect(await pay(id, "200,00", { requestKey: "pagar-0001" })).toMatchObject({ duplicate: true, paymentId: r.paymentId });
    let d = (await getPayable(db, contA, A, id, TODAY))!;
    expect(d).toMatchObject({ paidCents: 20000, openCents: 100000, situation: "parcial" });
    await expect(pay(id, "1.000,01")).rejects.toThrow(/saldo em aberto \(R\$ 1\.000,00\)/);
    expect((await pay(id, "1.000,00")).settled).toBe(true);
    d = (await getPayable(db, contA, A, id, TODAY))!;
    expect(d).toMatchObject({ openCents: 0, situation: "paga" });
    await expect(pay(id, "0,01")).rejects.toThrow(/saldo em aberto/);
    expect(d.payments[0]).toMatchObject({ method: "pix", reference: "PROTOCOLO 123", note: "pago no Cora" });
    // estorno: só gerente/diretoria, com motivo; histórico fica
    await expect(reversePayablePayment(db, asstA, A, d.payments[0].id, "baixa no valor errado")).rejects.toThrow(Forbidden);
    await expect(reversePayablePayment(db, gerA, A, d.payments[0].id, "ruim")).rejects.toThrow(/motivo/);
    await reversePayablePayment(db, gerA, A, d.payments[0].id, "baixa no valor errado");
    await expect(reversePayablePayment(db, gerA, A, d.payments[0].id, "baixa no valor errado")).rejects.toThrow(/já foi estornada/);
    d = (await getPayable(db, contA, A, id, TODAY))!;
    expect(d).toMatchObject({ paidCents: 100000, openCents: 20000, situation: "parcial" });
    expect(d.payments.map((p) => p.status)).toEqual(["estornado", "ativo"]);
    expect(d.events.map((e) => e.text.split(" ")[0])).toEqual(expect.arrayContaining(["Lançada", "Enviada", "Aprovada", "Baixa"]));
    // vencida (vencimento 25/10) a partir de 26/10
    const late = (await getPayable(db, contA, A, id, "2026-10-30"))!;
    expect(late.overdueDays).toBe(5); expect(late.situation).toBe("parcial");
    const none = await approved({ documentNumber: "V2", amount: "50,00", dueDate: "2026-10-25" });
    expect((await getPayable(db, contA, A, none, "2026-10-25"))!.situation).toBe("a_vencer"); // vence hoje
    expect((await getPayable(db, contA, A, none, "2026-10-26"))!.situation).toBe("vencida");
  });

  it("cancelar: rascunho (criador ou gerência), enviada/aprovada (aprovador); com baixa registrada NÃO cancela", async () => {
    const a = await createPayable(db, asstA, A, base({ documentNumber: "C1" })); await submitPayable(db, asstA, A, a);
    await expect(cancelPayable(db, asstA, A, a, "motivo qualquer")).rejects.toThrow(Forbidden); // enviada: só quem aprova
    await expect(cancelPayable(db, gerA, A, a, "ruim")).rejects.toThrow(/motivo/);
    await cancelPayable(db, gerA, A, a, "duplicada com outra conta");
    expect(await row(a)).toMatchObject({ status: "cancelado", cancelReason: "duplicada com outra conta", cancelledBy: gerA });
    const b = await approved({ documentNumber: "C2", amount: "100,00" });
    await pay(b, "10,00");
    await expect(cancelPayable(db, dirA, A, b, "tentando cancelar")).rejects.toThrow(/baixas registradas/);
    const rev = (await getPayable(db, contA, A, b, TODAY))!.payments[0].id;
    await reversePayablePayment(db, dirA, A, rev, "estornando para cancelar");
    await expect(cancelPayable(db, dirA, A, b, "tentando cancelar")).rejects.toThrow(/baixas registradas/); // mesmo estornada, o histórico existe
    const c = await approved({ documentNumber: "C3", amount: "33,00" });
    await cancelPayable(db, dirA, A, c, "fornecedor cancelou o serviço");
    await expect(pay(c, "1,00")).rejects.toThrow(/aprovada/);
  });

  it("banco: máquina de estados, nada se apaga, baixa só em conta aprovada, estornada é imutável", async () => {
    const id = await createPayable(db, asstA, A, base());
    await expect(db.execute(sql`update payables set status = 'aprovado', decided_by = ${dirA}, decided_at = now() where id = ${id}`)).rejects.toThrow(); // rascunho não vai direto a aprovado
    await expect(db.execute(sql`delete from payables where id = ${id}`)).rejects.toThrow();
    const ins = (payableId: string, amount: string) => db.insert(schema.payablePayments).values({ companyId: A, payableId, amount, paidAt: "2026-10-19", method: "pix", registeredBy: dirA });
    await expect(ins(id, "1.00")).rejects.toThrow(); // rascunho não recebe baixa
    await submitPayable(db, asstA, A, id);
    await expect(db.execute(sql`update payables set status = 'rascunho' where id = ${id}`)).rejects.toThrow(); // não volta
    await expect(ins(id, "1.00")).rejects.toThrow(); // aguardando não recebe baixa
    const ok = await approved({ documentNumber: "T1", amount: "50,00" });
    await ins(ok, "30.00");
    await expect(ins(ok, "20.01")).rejects.toThrow(); // acima do saldo
    await expect(db.execute(sql`update payable_payments set amount = 1 where payable_id = ${ok}`)).rejects.toThrow();
    await expect(db.execute(sql`delete from payable_payments`)).rejects.toThrow();
    await expect(db.execute(sql`update payable_payments set status = 'estornado' where payable_id = ${ok}`)).rejects.toThrow(); // sem quem/quando/motivo
    await expect(db.insert(schema.payablePayments).values({ companyId: B, payableId: ok, amount: "1", paidAt: "2026-10-19", method: "pix", registeredBy: dirB })).rejects.toThrow(); // FK composta: outra empresa
    await expect(db.execute(sql`update payables set status = 'cancelado', cancelled_by = ${dirA}, cancelled_at = now(), cancel_reason = 'x' where id = ${ok}`)).rejects.toThrow(); // tem baixa
  });

  it("concorrência: duas baixas simultâneas que juntas passam do saldo → só uma entra", async () => {
    const id = await approved({ amount: "1.000,00" });
    const res = await Promise.allSettled([pay(id, "700,00"), pay(id, "700,00"), pay(id, "700,00")]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((res.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.message).toMatch(/saldo em aberto/);
    expect((await getPayable(db, contA, A, id, TODAY))!.paidCents).toBe(70000);
  });

  it("listas, filtros, indicadores e fila de execução", async () => {
    const a = await approved({ documentNumber: "L1", amount: "100,00", dueDate: "2026-10-10", description: "Aluguel" }); // vencida
    const b = await approved({ documentNumber: "L2", amount: "200,00", dueDate: "2026-10-22", description: "Energia" }); // a vencer em 2 dias
    const c = await approved({ documentNumber: "L3", amount: "300,00", dueDate: "2026-11-15", description: "Software" });
    const d = await createPayable(db, asstA, A, base({ documentNumber: "L4", amount: "400,00", dueDate: "2026-10-18", description: "Marketing" })); await submitPayable(db, asstA, A, d);
    await createPayable(db, asstA, A, base({ documentNumber: "L5", amount: "500,00", dueDate: "2026-12-01", description: "Rascunho" }));
    await pay(c, "300,00", { paidAt: "2026-10-05" }); // paga
    await pay(b, "50,00"); // parcial
    const names = async (f: Record<string, string> = {}) => (await listPayables(db, contA, A, f, TODAY)).map((r) => r.description);
    expect(await names()).toEqual(["Aluguel", "Marketing", "Energia"]); // em aberto (aprovadas não pagas + aguardando), por vencimento
    expect(await names({ status: "vencidas" })).toEqual(["Aluguel", "Marketing"]);
    expect(await names({ status: "aprovadas" })).toEqual(["Aluguel", "Energia"]);
    expect(await names({ status: "aguardando" })).toEqual(["Marketing"]);
    expect(await names({ status: "pagas" })).toEqual(["Software"]);
    expect(await names({ status: "rascunhos" })).toEqual(["Rascunho"]);
    expect(await names({ status: "todas" })).toHaveLength(5);
    expect(await names({ status: "todas", q: "alfa" })).toHaveLength(5); expect(await names({ status: "todas", q: "ener" })).toEqual(["Energia"]);
    expect(await names({ status: "todas", q: "%" })).toEqual([]); expect(await names({ status: "todas", dueFrom: "2026-10-18", dueTo: "2026-10-22" })).toEqual(["Marketing", "Energia"]);
    expect(await names({ status: "lixo", dueFrom: "2026-02-31" })).toHaveLength(3); // filtros inválidos viram o padrão
    const s = await payablesSummary(db, contA, A, TODAY);
    expect(s).toEqual({ approvedOpenCents: 10000 + 15000, overdueCents: 10000, overdueCount: 1, pendingCents: 40000, pendingCount: 1, dueSoonCount: 1, paidMonthCents: 30000 + 5000 });
    expect((await executionQueue(db, contA, A, TODAY)).map((r) => [r.description, r.openCents])).toEqual([["Aluguel", 10000], ["Energia", 15000]]); // só aprovadas em aberto
    expect(await listPayables(db, dirB, B, { status: "todas" }, TODAY)).toEqual([]);
    expect((await payablesSummary(db, dirB, B, TODAY)).approvedOpenCents).toBe(0);
    await expect(listPayables(db, techA, A)).rejects.toThrow(Forbidden);
    void a; void d;
  });

  it("exportação CSV: permissão, proteção contra fórmula, só a empresa ativa, fila de execução, auditoria sem dados", async () => {
    await approved({ description: "=HYPERLINK(\"http://x\")", documentNumber: "E1", amount: "1.234,56", dueDate: "2026-10-28" });
    await expect(exportPayables(db, asstA, A, {}, false, TODAY)).rejects.toThrow(Forbidden);
    const csv = await exportPayables(db, contA, A, { status: "todas" }, false, TODAY);
    expect(csv.split("\r\n")[0]).toBe("\uFEFFFornecedor;Descrição;Documento;Categoria;Vencimento;Valor;Pago;Saldo;Situação;Dias de atraso;Centro de custo;Competência");
    expect(csv).toContain("'=HYPERLINK"); expect(csv).not.toMatch(/(^|;)=HYPERLINK/m);
    expect(csv).toContain('"1234,56";"0,00";"1234,56";Aprovada · a vencer;0');
    expect((await exportPayables(db, dirA, A, {}, true, TODAY)).split("\r\n").filter(Boolean)).toHaveLength(2);
    expect((await exportPayables(db, dirB, B, {}, false, TODAY)).split("\r\n").filter(Boolean)).toHaveLength(1);
    const logs = await db.select().from(schema.auditLog).where(sql`${schema.auditLog.action} like 'payable.%' or ${schema.auditLog.action} like 'payables.%'`);
    const txt = JSON.stringify(logs.map((l) => l.detail));
    for (const bad of ["HYPERLINK", "1234", "1.234", "Fornecedor Alfa", "NF-", "Link de internet"]) expect(txt).not.toContain(bad);
  });

  it("isolamento: outra empresa não vê, aprova, baixa nem estorna", async () => {
    const id = await approved();
    expect(await getPayable(db, dirB, B, id, TODAY)).toBeNull();
    await expect(approvePayable(db, dirB, B, id)).rejects.toThrow(/não encontrada/);
    await expect(registerPayablePayment(db, dirB, B, id, { amount: "1,00", paidAt: "2026-10-19", method: "pix" }, TODAY)).rejects.toThrow(/não encontrada/);
    await expect(cancelPayable(db, dirB, B, id, "tentando de outra empresa")).rejects.toThrow(/não encontrada/);
    await expect(getPayable(db, dirB, A, id, TODAY)).rejects.toThrow(Forbidden);
    const paymentId = (await pay(id, "10,00")).paymentId;
    await expect(reversePayablePayment(db, dirB, B, paymentId, "tentando de outra empresa")).rejects.toThrow(/não encontrada/);
    expect(await getPayable(db, contA, A, "não-uuid", TODAY)).toBeNull();
  });
});
