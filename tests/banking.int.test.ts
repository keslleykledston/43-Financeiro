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
import { getReceivable, registerPayment, reversePayment } from "@/modules/receivables/service";
import { docInText } from "@/modules/banking/service";
import { allocate, cancelImport, confirmImport, createAccount, getImport, getTransaction, listAccounts, listImports, listTransactions, markTransaction, previewImport, undoAllocation, undoImport, unmarkTransaction } from "@/modules/banking/service";

const enabled = !!process.env.POSTGRES_USER;
const CNPJ1 = "11.222.333/0001-81", CNPJ2 = "12.ABC.345/01DE-35";
// competência 2026-09, vencimento 2026-10-14, emissão 2026-10-01. Régua: 10-01, 10-11, 10-14, 10-17, 10-21 (+ revisão 10-29).
const D = "2026-10-01";
const terms = (o: Record<string, unknown> = {}) => ({ description: "Monitoramento de redes", monthlyAmount: "2.500,00", startAt: "2026-01-01", endAt: "", dueDay: "14", invoiceJointRequired: false, issueDayOverride: "", ...o });

describe.skipIf(!enabled)("E08 conciliação bancária: importação, dedup, sugestões, vínculo e isolamento (DB de teste)", () => {
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
    await db.execute(sql`truncate bank_transaction_marks, bank_allocations, bank_transactions, bank_import_rows, bank_import_batches, bank_accounts, payments, messaging_settings, message_queue, message_template_versions, message_templates, charges, billing_batches, holidays, contract_versions, contracts, integration_conflicts, integration_sync_runs, integration_connections, rate_limits, customer_contacts, vendor_contacts, customers, vendors, audit_log, invitations, memberships, companies, users restart identity cascade`);
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

  const enc = (s: string) => new TextEncoder().encode(s);
  type R = { id?: string; date: string; amt: string; memo: string };
  const ofx = (rows: R[], bal?: { amt: string; date: string }, acct = "99887766") =>
    enc(`OFXHEADER:100\nDATA:OFXSGML\n\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKACCTFROM><ACCTID>${acct}</BANKACCTFROM><BANKTRANLIST>\n` +
      rows.map((r, i) => `<STMTTRN><TRNTYPE>X<DTPOSTED>${r.date}<TRNAMT>${r.amt}<FITID>${r.id ?? `F${r.date}${i}${r.amt}`}<MEMO>${r.memo}\n`).join("") + `</BANKTRANLIST>${bal ? `<LEDGERBAL><BALAMT>${bal.amt}<DTASOF>${bal.date}</LEDGERBAL>` : ""}</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`);
  const csv = (lines: string[]) => enc("Data;Descrição;Valor\r\n" + lines.join("\r\n") + "\r\n");
  const acct = (o: Partial<{ name: string; last4: string; openingBalance: string; openingDate: string }> = {}) => createAccount(db, gerA, A, { name: "Conta Cora", bank: "Cora", openingBalance: "1.000,00", openingDate: "2026-01-01", last4: "7766", ...o });
  const imp = async (accountId: string, bytes: Uint8Array, by = gerA, name = "extrato.ofx", ack = false) => { const { batchId } = await previewImport(db, by, A, accountId, name, bytes); const r = await confirmImport(db, by, A, batchId, ack); return { batchId, ...r }; };
  const chargeOf = async (customer: string) => (await db.select().from(schema.charges).where(eq(schema.charges.customerId, customer)))[0];
  const txs = async (accountId: string, f = "todas") => (await listTransactions(db, contA, A, accountId, f)).items;
  const TODAY = "2026-10-20";
  // documento normalizado dos clientes (sem pontuação) como aparece em histórico bancário
  const D1 = CNPJ1.replace(/\D/g, ""), D2 = CNPJ2.replace(/[^0-9A-Z]/g, "");

  it("contas: permissão, validação, nome único, isolamento; saldo inicial é o saldo", async () => {
    await expect(createAccount(db, asstA, A, { name: "X1", bank: "Cora", openingBalance: "0", openingDate: "2026-01-01" })).rejects.toThrow(Forbidden);
    await acct();
    await expect(createAccount(db, gerA, A, { name: "A", bank: "Cora", openingBalance: "0", openingDate: "2026-01-01" })).rejects.toThrow(/nome da conta/);
    await expect(createAccount(db, gerA, A, { name: "Outra", bank: "Cora", last4: "12345678", openingBalance: "0", openingDate: "2026-01-01" })).rejects.toThrow(/4 dígitos/);
    await expect(createAccount(db, gerA, A, { name: "Outra", bank: "Cora", openingBalance: "abc", openingDate: "2026-01-01" })).rejects.toThrow(/Saldo inicial/);
    await expect(createAccount(db, gerA, A, { name: "Outra", bank: "Cora", openingBalance: "0", openingDate: "2026-02-31" })).rejects.toThrow(/Data/);
    await expect(acct()).rejects.toThrow(/Já existe/);
    const [a] = await listAccounts(db, contA, A);
    expect(a).toMatchObject({ name: "Conta Cora", balanceCents: 100000, txCount: 0, pendingCount: 0 });
    expect(await listAccounts(db, dirB, B)).toHaveLength(0);
    await expect(listAccounts(db, techA, A)).rejects.toThrow(Forbidden);
    await createAccount(db, gerA, A, { name: "Devedora", bank: "Cora", openingBalance: "-50,25", openingDate: "2026-01-01" });
    expect((await listAccounts(db, contA, A)).find((x) => x.name === "Devedora")!.balanceCents).toBe(-5025);
  });

  it("prévia NÃO grava transações; confirmar grava; saldo = saldo inicial + movimentos; mesmo arquivo não entra de novo", async () => {
    const id = await acct();
    const file = ofx([{ id: "A1", date: "20261005", amt: "2500.00", memo: "PIX CLIENTE" }, { id: "A2", date: "20261006", amt: "-39.90", memo: "TARIFA" }]);
    await expect(previewImport(db, asstA, A, id, "x.ofx", file)).rejects.toThrow(Forbidden); // importar: diretoria/gerente
    const { batchId } = await previewImport(db, gerA, A, id, "../../etc/pass wd.ofx", file);
    expect(await n("bank_transactions")).toBe(0);
    const v = (await getImport(db, contA, A, batchId))!;
    expect(v.batch).toMatchObject({ status: "previa", rowCount: 2, newCount: 2, dupCount: 0, periodStart: "2026-10-05", periodEnd: "2026-10-06", format: "ofx" });
    expect(v.batch.fileName).toBe("pass wd.ofx"); expect(v.rows).toHaveLength(2);
    await expect(previewImport(db, gerA, A, id, "x.ofx", file)).rejects.toThrow(/já está em análise/);
    await cancelImport(db, gerA, A, batchId);
    expect((await getImport(db, contA, A, batchId))!.batch.status).toBe("cancelado");
    expect(await n("bank_import_rows")).toBe(0);
    await expect(confirmImport(db, gerA, A, batchId)).rejects.toThrow(/não está mais em análise/);
    const r = await imp(id, file);
    expect(r).toMatchObject({ imported: 2, duplicates: 0 });
    expect((await listAccounts(db, contA, A))[0]).toMatchObject({ balanceCents: 100000 + 250000 - 3990, txCount: 2, pendingCount: 1, pendingCents: 250000 });
    await expect(previewImport(db, gerA, A, id, "x.ofx", file)).rejects.toThrow(/já foi importado/);
    expect(await n("bank_import_rows")).toBe(0);
  });

  it("dedup: arquivo que se sobrepõe só importa o novo (OFX por FITID; CSV por hash+ocorrência); dois Pix iguais no mesmo arquivo são dois", async () => {
    const id = await acct();
    await imp(id, ofx([{ id: "A1", date: "20261005", amt: "100.00", memo: "P1" }, { id: "A2", date: "20261006", amt: "200.00", memo: "P2" }]));
    const r = await imp(id, ofx([{ id: "A2", date: "20261006", amt: "200.00", memo: "P2" }, { id: "A3", date: "20261007", amt: "300.00", memo: "P3" }]));
    expect(r).toMatchObject({ imported: 1, duplicates: 1 });
    expect(await n("bank_transactions")).toBe(3);
    // CSV sem identificador: duas linhas idênticas no mesmo arquivo = 2 transações
    const c1 = csv(["08/10/2026;PIX FULANO;50,00", "08/10/2026;PIX FULANO;50,00", "09/10/2026;PIX BELTRANO;70,00"]);
    expect(await imp(id, c1, gerA, "a.csv")).toMatchObject({ imported: 3, duplicates: 0 });
    // mesmo conteúdo em outro arquivo (bytes diferentes): tudo duplicado → nada a importar
    const c2 = csv(["09/10/2026;PIX BELTRANO;70,00", "08/10/2026;PIX FULANO;50,00", "08/10/2026;PIX FULANO;50,00"]);
    const { batchId } = await previewImport(db, gerA, A, id, "b.csv", c2);
    const v = (await getImport(db, contA, A, batchId))!;
    expect(v.batch).toMatchObject({ newCount: 0, dupCount: 3 }); expect(v.warnings.join(" ")).toMatch(/Nenhuma transação nova/);
    await expect(confirmImport(db, gerA, A, batchId)).rejects.toThrow(/Nenhuma transação nova/);
    // terceiro Pix igual em outro arquivo: é novo (ocorrência 3)
    const c3 = csv(["08/10/2026;PIX FULANO;50,00", "08/10/2026;PIX FULANO;50,00", "08/10/2026;PIX FULANO;50,00"]);
    await cancelImport(db, gerA, A, batchId);
    // 3 idênticos quando já havia 2: o sistema não sabe se o 3º é novo → exige conferência explícita
    const amb = await previewImport(db, gerA, A, id, "c.csv", c3);
    expect((await getImport(db, contA, A, amb.batchId))!).toMatchObject({ ambiguous: 1 });
    expect((await getImport(db, contA, A, amb.batchId))!.rows.some((r) => r.ambiguous)).toBe(true);
    await expect(confirmImport(db, gerA, A, amb.batchId)).rejects.toThrow(/marque a confirmação/);
    expect(await confirmImport(db, gerA, A, amb.batchId, true)).toMatchObject({ imported: 1, duplicates: 2 });
    expect(await n("bank_transactions")).toBe(7);
    expect(await n("audit_log where action = 'bank.import.applied' and detail->>'ambiguousAcknowledged' = 'true'")).toBe(1);
  });

  it("dedup sem identificador: quantidade diferente da já importada (menos OU mais) é ambígua; igual não", async () => {
    const id = await acct();
    await imp(id, csv(["08/10/2026;PIX IGUAL;50,00", "08/10/2026;PIX IGUAL;50,00", "09/10/2026;OUTRO;10,00"]), gerA, "a.csv");
    // arquivo parcial: só 1 dos 2 idênticos + 1 novo diferente
    const parcial = await previewImport(db, gerA, A, id, "b.csv", csv(["08/10/2026;PIX IGUAL;50,00", "10/10/2026;NOVO;20,00"]));
    expect((await getImport(db, contA, A, parcial.batchId))!.ambiguous).toBe(1);
    await expect(confirmImport(db, gerA, A, parcial.batchId)).rejects.toThrow(/marque a confirmação/);
    await cancelImport(db, gerA, A, parcial.batchId);
    // mesma contagem (2 = 2) e linha única: sem ambiguidade
    const igual = await previewImport(db, gerA, A, id, "c.csv", csv(["08/10/2026;PIX IGUAL;50,00", "08/10/2026;PIX IGUAL;50,00", "09/10/2026;OUTRO;10,00", "11/10/2026;NOVO2;5,00"]));
    expect((await getImport(db, contA, A, igual.batchId))!.ambiguous).toBe(0);
    expect(await confirmImport(db, gerA, A, igual.batchId)).toMatchObject({ imported: 1, duplicates: 3 });
    // com identificador do banco nunca há ambiguidade
    const ofx1 = await previewImport(db, gerA, A, id, "d.ofx", ofx([{ id: "Z1", date: "20261012", amt: "9.00", memo: "X" }]));
    expect((await getImport(db, contA, A, ofx1.batchId))!.ambiguous).toBe(0);
  });

  it("sugestão: documento só vale com fronteira (CPF dentro de CNPJ, número maior ou de terceiros não contam); documento formatado vale", async () => {
    expect(docInText(`PIX ${D1}`, D1)).toBe(true);
    expect(docInText("PIX 11.222.333/0001-81 FULANO", D1)).toBe(true);
    expect(docInText(`PIX ${D1}JOAO`, D1)).toBe(true); // letras coladas são comuns em histórico
    expect(docInText(`PIX 9${D1}`, D1)).toBe(false); // dígito colado antes
    expect(docInText(`PIX ${D1}7`, D1)).toBe(false); // dígito colado depois
    expect(docInText(`PIX ${D1}`, D1.slice(0, 11))).toBe(false); // CPF "dentro" de um CNPJ
    expect(docInText(`PIX ${D1}`, "123")).toBe(false); // documento curto demais
    expect(docInText("PIX SEM DOC", D1)).toBe(false);
  });

  it("conferência do saldo do banco (OFX): avisa divergência; sem aviso quando bate", async () => {
    const id = await acct();
    const bad = await previewImport(db, gerA, A, id, "x.ofx", ofx([{ id: "A1", date: "20261005", amt: "100.00", memo: "P1" }], { amt: "9999.00", date: "20261031" }));
    expect((await getImport(db, contA, A, bad.batchId))!.warnings.join(" ")).toMatch(/difere do saldo calculado/);
    await cancelImport(db, gerA, A, bad.batchId);
    const ok = await previewImport(db, gerA, A, id, "y.ofx", ofx([{ id: "A1", date: "20261005", amt: "100.00", memo: "P1" }], { amt: "1100.00", date: "20261031" })); // 1000 inicial + 100
    expect((await getImport(db, contA, A, ok.batchId))!.warnings).toEqual([]);
  });

  it("arquivos recusados: outra conta, anterior ao saldo inicial, binário, vazio, sem transações, valor zero", async () => {
    const id = await acct();
    await expect(previewImport(db, gerA, A, id, "x.ofx", ofx([{ date: "20261005", amt: "1.00", memo: "x" }], undefined, "11110000"))).rejects.toThrow(/outra conta \(final 0000\)/);
    await expect(previewImport(db, gerA, A, id, "x.ofx", ofx([{ date: "20251231", amt: "1.00", memo: "x" }]))).rejects.toThrow(/anteriores à data do saldo inicial/);
    await expect(previewImport(db, gerA, A, id, "x.bin", new Uint8Array([1, 0, 2]))).rejects.toThrow(/binário/);
    await expect(previewImport(db, gerA, A, id, "x.csv", new Uint8Array(0))).rejects.toThrow(/vazio/);
    await expect(previewImport(db, gerA, A, id, "x.ofx", enc("<OFX></OFX>"))).rejects.toThrow(/Nenhuma transação/);
    await expect(previewImport(db, gerA, A, id, "x.csv", csv(["05/10/2026;x;0,00"]))).rejects.toThrow(/valor inválido/);
    await expect(previewImport(db, gerA, A, "não-uuid", "x.csv", csv(["05/10/2026;x;1,00"]))).rejects.toThrow(/Conta não encontrada/);
    await expect(previewImport(db, dirB, B, id, "x.csv", csv(["05/10/2026;x;1,00"]))).rejects.toThrow(/Conta não encontrada/); // outra empresa
    expect(await n("bank_import_batches")).toBe(0);
  });

  it("desfazer importação: só sem vínculos; libera o arquivo; some do saldo; transação é imutável", async () => {
    await approvedBatch();
    const id = await acct();
    const file = ofx([{ id: "A1", date: "20261015", amt: "2500.00", memo: `PIX ${D1}` }, { id: "A2", date: "20261016", amt: "-39.90", memo: "TARIFA" }]);
    const { batchId } = await imp(id, file);
    const t = (await txs(id)).find((x) => x.amountCents === 250000)!;
    await allocate(db, gerA, A, t.id, (await chargeOf(cli1)).id, "2.500,00", undefined, TODAY);
    await expect(undoImport(db, gerA, A, batchId, "arquivo da conta errada")).rejects.toThrow(/vinculadas a cobranças/);
    await expect(undoImport(db, asstA, A, batchId, "arquivo da conta errada")).rejects.toThrow(Forbidden);
    const al = (await getTransaction(db, contA, A, t.id))!.allocations[0];
    await undoAllocation(db, gerA, A, al.id, "vínculo feito por engano");
    await expect(undoImport(db, gerA, A, batchId, "ruim")).rejects.toThrow(/motivo/);
    await undoImport(db, gerA, A, batchId, "arquivo da conta errada");
    expect((await listAccounts(db, contA, A))[0]).toMatchObject({ balanceCents: 100000, txCount: 0 });
    expect((await listImports(db, contA, A, id))[0]).toMatchObject({ status: "desfeito", undoReason: "arquivo da conta errada" });
    expect(await imp(id, file)).toMatchObject({ imported: 2 }); // o arquivo pode entrar de novo
    expect(await n("bank_transactions where status = 'desfeita'")).toBe(2);
    await expect(undoImport(db, gerA, A, batchId, "já desfeita antes")).rejects.toThrow(/aplicada/);
    // imutabilidade no banco
    await expect(db.execute(sql`update bank_transactions set amount = 1 where status = 'ativa'`)).rejects.toThrow();
    await expect(db.execute(sql`update bank_transactions set description = 'x' where status = 'ativa'`)).rejects.toThrow();
    await expect(db.execute(sql`delete from bank_transactions`)).rejects.toThrow();
    await expect(db.execute(sql`update bank_transactions set status = 'ativa' where status = 'desfeita'`)).rejects.toThrow();
  });

  it("sugestões SEGURAS: forte só com documento + uma cobrança de mesmo saldo; dois Pix iguais sem identificador nunca são 'forte'", async () => {
    await approvedBatch(); // duas cobranças de R$ 2.500,00 (Cliente Um e Cliente Dois)
    const id = await acct();
    await imp(id, ofx([
      { id: "T1", date: "20261015", amt: "2500.00", memo: `PIX RECEBIDO ${D1}` }, // doc do cliente 1 + valor → forte
      { id: "T2", date: "20261015", amt: "2500.00", memo: "PIX RECEBIDO FULANO" }, // sem identificador, valor igual a duas cobranças → só 'valor'
      { id: "T3", date: "20261015", amt: "2500.00", memo: "PIX RECEBIDO FULANO" }, // idêntico ao T2
      { id: "T4", date: "20261015", amt: "1000.00", memo: `TED ${D2}` }, // doc do cliente 2, valor diferente → 'cliente'
      { id: "T5", date: "20261015", amt: "77.00", memo: "DEPOSITO" }, // nada
      { id: "T6", date: "20261015", amt: "2500.00", memo: `PIX ${D1} E ${D2}` }, // dois clientes no histórico → ambígua
    ]));
    const forte = (await txs(id, "pendentes")).find((t) => t.description === `PIX RECEBIDO ${D1}`)!;
    expect(forte.suggestion).toMatchObject({ level: "forte", customerName: "Cliente Um", chargeId: (await chargeOf(cli1)).id });
    const fulanos = (await txs(id, "pendentes")).filter((t) => t.description === "PIX RECEBIDO FULANO");
    expect(fulanos).toHaveLength(2);
    expect(fulanos.every((t) => t.suggestion?.level === "valor" && (t.suggestion as { count: number }).count === 2)).toBe(true);
    expect((await txs(id, "pendentes")).find((t) => t.description.startsWith("TED"))!.suggestion).toMatchObject({ level: "cliente", customerName: "Cliente Dois" });
    expect((await txs(id, "pendentes")).find((t) => t.description === "DEPOSITO")!.suggestion).toEqual({ level: "nenhuma" });
    expect((await txs(id, "pendentes")).find((t) => t.description.includes(" E "))!.suggestion).toMatchObject({ level: "ambigua" });
    // nada é aplicado sozinho
    expect(await n("bank_allocations")).toBe(0); expect(await n("payments")).toBe(0);
  });

  it("documento do cliente com DUAS cobranças de mesmo saldo → ambígua (nunca escolhe uma)", async () => {
    await activeContract(cli1); await activeContract(cli1, terms({ dueDay: "15" })); // mesma data de emissão (dia 1): duas cobranças de R$ 2.500,00 do mesmo cliente
    const { batchId } = await generateBatch(db, asstA, A, D);
    await approveBatch(db, dirA, A, batchId, (await getBatch(db, asstA, A, batchId))!.hash);
    const id = await acct();
    await imp(id, ofx([{ id: "T1", date: "20261015", amt: "2500.00", memo: `PIX ${D1}` }]));
    expect((await txs(id, "pendentes"))[0].suggestion).toMatchObject({ level: "ambigua", count: 2 });
  });

  it("vínculo: cria pagamento 'extrato', quita, é idempotente; parcial entre duas cobranças; nunca passa do crédito nem do saldo", async () => {
    await approvedBatch();
    const id = await acct();
    await imp(id, ofx([{ id: "T1", date: "20261015", amt: "2500.00", memo: `PIX ${D1}` }, { id: "T2", date: "20261015", amt: "3000.00", memo: "TED GRUPO" }, { id: "T3", date: "20261015", amt: "-10.00", memo: "TARIFA" }]));
    const all = await txs(id);
    const T = (d: string) => all.find((t) => t.description.startsWith(d))!;
    const c1 = await chargeOf(cli1), c2 = await chargeOf(cli2);
    await expect(allocate(db, contA, A, T("PIX").id, c1.id, "1,00", undefined, TODAY)).rejects.toThrow(Forbidden);
    await expect(allocate(db, asstA, A, T("TARIFA").id, c1.id, "1,00", undefined, TODAY)).rejects.toThrow(/Só créditos/);
    await expect(allocate(db, asstA, A, T("PIX").id, c1.id, "0", undefined, TODAY)).rejects.toThrow(/valor válido/);
    await expect(allocate(db, asstA, A, T("PIX").id, c1.id, "2.500,01", undefined, TODAY)).rejects.toThrow(/resta do crédito \(R\$ 2\.500,00\)/);
    await expect(allocate(db, asstA, A, T("PIX").id, c1.id, "100,00", undefined, "2026-10-14")).rejects.toThrow(/futura/);
    const r = await allocate(db, asstA, A, T("PIX").id, c1.id, "2.500,00", "form-bank-0001", TODAY);
    expect(r).toMatchObject({ duplicate: false, settled: true });
    expect(await allocate(db, asstA, A, T("PIX").id, c1.id, "2.500,00", "form-bank-0001", TODAY)).toMatchObject({ duplicate: true, allocationId: r.allocationId });
    await expect(allocate(db, asstA, A, T("PIX").id, c2.id, "1,00", "form-bank-0001", TODAY)).rejects.toThrow(/já usada/);
    const rc = (await getReceivable(db, contA, A, c1.id, TODAY))!;
    expect(rc).toMatchObject({ situation: "quitada", paidCents: 250000 });
    expect(rc.payments[0]).toMatchObject({ method: "extrato", paidAt: "2026-10-15", note: "Conciliação bancária" });
    // pagamento conciliado não é estornado "por fora"
    await expect(reversePayment(db, gerA, A, rc.payments[0].id, "tentando estornar por fora")).rejects.toThrow(/desfaça o vínculo/);
    // crédito de 3.000 dividido entre duas cobranças; a segunda recebe só 500 (parcial) e o crédito não pode ser usado além do total
    await allocate(db, asstA, A, T("TED").id, c2.id, "2.500,00", undefined, TODAY);
    await expect(allocate(db, asstA, A, T("TED").id, c2.id, "1,00", undefined, TODAY)).rejects.toThrow(/saldo em aberto|passa do saldo/);
    const g = (await getTransaction(db, contA, A, T("TED").id))!;
    expect(g).toMatchObject({ allocatedCents: 250000, remainingCents: 50000 });
    expect((await txs(id, "pendentes")).map((t) => t.description)).toEqual(["TED GRUPO"]); // sobra de 500 ainda pendente
    expect((await txs(id, "pendentes"))[0]).toMatchObject({ remainingCents: 50000, allocatedCents: 250000 });
    expect((await txs(id, "conciliadas")).map((t) => t.description).sort()).toEqual([`PIX ${D1}`, "TED GRUPO"].sort());
    expect((await listAccounts(db, contA, A))[0]).toMatchObject({ pendingCount: 1, pendingCents: 50000 });
  });

  it("juros/multa e desconto na conciliação: o crédito é consumido pelo DINHEIRO (principal + juros − desconto)", async () => {
    await approvedBatch(); // 2 cobranças de R$ 2.500,00
    const id = await acct();
    await imp(id, ofx([{ id: "T1", date: "20261015", amt: "2530.00", memo: `PIX ${D1}` }, { id: "T2", date: "20261016", amt: "2450.00", memo: `PIX ${D2}` }]));
    const T = async (d: string) => (await txs(id)).find((t) => t.description.startsWith(d))!;
    const c1 = await chargeOf(cli1), c2 = await chargeOf(cli2);
    // crédito 2.530 ≠ saldo 2.500: sem sugestão "forte" (só identifica o cliente); o vínculo é manual, com os juros informados
    expect((await T(`PIX ${D1}`)).suggestion).toMatchObject({ level: "cliente", customerName: "Cliente Um" });
    const r = await allocate(db, asstA, A, (await T(`PIX ${D1}`)).id, c1.id, "2.530,00", undefined, TODAY, { interest: "30,00" });
    expect(r).toMatchObject({ settled: true });
    let g = (await getTransaction(db, contA, A, (await T(`PIX ${D1}`)).id))!;
    expect(g).toMatchObject({ allocatedCents: 253000, remainingCents: 0 }); // o crédito inteiro foi usado
    const rc = (await getReceivable(db, contA, A, c1.id, TODAY))!;
    expect(rc).toMatchObject({ paidCents: 250000, interestCents: 3000, situation: "quitada" });
    expect(rc.payments[0]).toMatchObject({ amountCents: 250000, interestCents: 3000, cashCents: 253000, method: "extrato" });
    // desconto: crédito 2.450 quita a cobrança de 2.500 com 50 de desconto
    await allocate(db, asstA, A, (await T(`PIX ${D2}`)).id, c2.id, "2.450,00", undefined, TODAY, { discount: "50,00" });
    g = (await getTransaction(db, contA, A, (await T(`PIX ${D2}`)).id))!;
    expect(g).toMatchObject({ allocatedCents: 245000, remainingCents: 0 });
    expect(await getReceivable(db, contA, A, c2.id, TODAY)).toMatchObject({ paidCents: 250000, discountCents: 5000, openCents: 0, situation: "quitada" });
    // desfazer vínculo estorna tudo (principal, juros e desconto) e libera o crédito
    await undoAllocation(db, gerA, A, g.allocations[0].id, "desconto concedido por engano");
    expect((await getTransaction(db, contA, A, (await T(`PIX ${D2}`)).id))).toMatchObject({ allocatedCents: 0, remainingCents: 245000 });
    expect(await getReceivable(db, contA, A, c2.id, TODAY)).toMatchObject({ paidCents: 0, discountCents: 0, situation: "vencida" });
    // o banco exige que o vínculo seja igual ao DINHEIRO do pagamento: vínculo pelo principal é recusado
    const pay = (await db.insert(schema.payments).values({ companyId: A, chargeId: c2.id, amount: "2500.00", discountAmount: "50.00", paidAt: "2026-10-16", method: "extrato", registeredBy: asstA }).returning())[0];
    const ins = (amount: string) => db.insert(schema.bankAllocations).values({ companyId: A, transactionId: (g.tx.id), chargeId: c2.id, paymentId: pay.id, amount, createdBy: asstA });
    await expect(ins("2500.00")).rejects.toThrow(); // principal, não o dinheiro
    await expect(ins("2450.00")).resolves.toBeDefined(); // dinheiro = 2500 + 0 − 50
  });

  it("um crédito pode quitar várias cobranças; uma cobrança pode receber vários créditos", async () => {
    await approvedBatch();
    const id = await acct();
    await imp(id, ofx([{ id: "T1", date: "20261015", amt: "5000.00", memo: "TED DOIS CLIENTES" }, { id: "T2", date: "20261016", amt: "1000.00", memo: "PIX PARTE" }, { id: "T3", date: "20261017", amt: "1500.00", memo: "PIX RESTO" }]));
    const T = async (d: string) => (await txs(id)).find((t) => t.description === d)!;
    const c1 = await chargeOf(cli1), c2 = await chargeOf(cli2);
    await allocate(db, gerA, A, (await T("TED DOIS CLIENTES")).id, c1.id, "2.500,00", undefined, TODAY);
    await allocate(db, gerA, A, (await T("TED DOIS CLIENTES")).id, c2.id, "2.500,00", undefined, TODAY);
    expect((await txs(id, "pendentes")).map((t) => t.description).sort()).toEqual(["PIX PARTE", "PIX RESTO"]);
    // cliente 1 já quitou: os créditos seguintes não cabem nela, mas cabem na cobrança do 2? também quitada → recusado
    await expect(allocate(db, gerA, A, (await T("PIX PARTE")).id, c1.id, "1.000,00", undefined, TODAY)).rejects.toThrow(/saldo em aberto/);
  });

  it("desfazer vínculo: estorna o pagamento, devolve o saldo e o crédito, mantém histórico; refazer funciona", async () => {
    await approvedBatch();
    const id = await acct();
    await imp(id, ofx([{ id: "T1", date: "20261015", amt: "2500.00", memo: "PIX X" }]));
    const t = (await txs(id))[0], c = await chargeOf(cli1);
    const { allocationId } = await allocate(db, asstA, A, t.id, c.id, "2.500,00", undefined, TODAY);
    await expect(undoAllocation(db, asstA, A, allocationId, "vínculo errado")).rejects.toThrow(Forbidden);
    await expect(undoAllocation(db, gerA, A, allocationId, "ruim")).rejects.toThrow(/motivo/);
    await undoAllocation(db, gerA, A, allocationId, "vínculo no cliente errado");
    await expect(undoAllocation(db, gerA, A, allocationId, "vínculo no cliente errado")).rejects.toThrow(/já foi desfeito/);
    expect(await getReceivable(db, contA, A, c.id, TODAY)).toMatchObject({ situation: "vencida", paidCents: 0 });
    const g = (await getTransaction(db, contA, A, t.id))!;
    expect(g).toMatchObject({ allocatedCents: 0, remainingCents: 250000 });
    expect(g.allocations).toEqual([expect.objectContaining({ status: "desfeita", undoReason: "vínculo no cliente errado" })]);
    expect((await getReceivable(db, contA, A, c.id, TODAY))!.payments[0]).toMatchObject({ status: "estornado" });
    expect((await getReceivable(db, contA, A, c.id, TODAY))!.payments[0].reverseReason).toContain("Conciliação desfeita");
    await allocate(db, asstA, A, t.id, (await chargeOf(cli2)).id, "2.500,00", undefined, TODAY); // refaz no cliente certo
    expect((await getTransaction(db, contA, A, t.id))!.remainingCents).toBe(0);
  });

  it("classificar (tarifa/transferência/outro): impede vínculo; só sem vínculo; remover libera; filtros", async () => {
    await approvedBatch();
    const id = await acct();
    await imp(id, ofx([{ id: "T1", date: "20261015", amt: "2500.00", memo: "PIX A" }, { id: "T2", date: "20261015", amt: "2500.00", memo: "TRANSF ENTRE CONTAS" }, { id: "T3", date: "20261015", amt: "-39.90", memo: "TARIFA" }]));
    const T = async (d: string) => (await txs(id)).find((t) => t.description === d)!;
    await expect(markTransaction(db, contA, A, (await T("TARIFA")).id, "tarifa", "")).rejects.toThrow(Forbidden);
    await expect(markTransaction(db, asstA, A, (await T("TARIFA")).id, "xx", "")).rejects.toThrow(/inválida/);
    await markTransaction(db, asstA, A, (await T("TARIFA")).id, "tarifa", "mensal");
    await expect(markTransaction(db, asstA, A, (await T("TARIFA")).id, "tarifa", "")).rejects.toThrow(/já está classificada/);
    await markTransaction(db, asstA, A, (await T("TRANSF ENTRE CONTAS")).id, "transferencia_grupo", "");
    await expect(allocate(db, asstA, A, (await T("TRANSF ENTRE CONTAS")).id, (await chargeOf(cli1)).id, "2.500,00", undefined, TODAY)).rejects.toThrow(/classificada/);
    await allocate(db, asstA, A, (await T("PIX A")).id, (await chargeOf(cli1)).id, "2.500,00", undefined, TODAY);
    await expect(markTransaction(db, asstA, A, (await T("PIX A")).id, "outro", "")).rejects.toThrow(/já tem vínculo/);
    expect((await txs(id, "ignoradas")).map((t) => [t.description, t.mark]).sort()).toEqual([["TARIFA", "tarifa"], ["TRANSF ENTRE CONTAS", "transferencia_grupo"]]);
    expect(await txs(id, "pendentes")).toHaveLength(0); expect(await txs(id, "debitos")).toHaveLength(0);
    await unmarkTransaction(db, asstA, A, (await T("TRANSF ENTRE CONTAS")).id);
    await expect(unmarkTransaction(db, asstA, A, (await T("TRANSF ENTRE CONTAS")).id)).rejects.toThrow(/não está classificada/);
    expect((await txs(id, "pendentes")).map((t) => t.description)).toEqual(["TRANSF ENTRE CONTAS"]);
    expect((await listTransactions(db, contA, A, id, "todas", "tarifa")).items).toHaveLength(1);
    expect((await listTransactions(db, contA, A, id, "todas", "%")).items).toHaveLength(0); // curinga escapado
  });

  it("banco: vínculo e pagamento nunca se separam, nem por SQL direto (os dois lados)", async () => {
    await approvedBatch();
    const id = await acct();
    await imp(id, ofx([{ id: "T1", date: "20261015", amt: "2500.00", memo: "PIX A" }]));
    const t = (await txs(id))[0], c = await chargeOf(cli1);
    const { allocationId } = await allocate(db, asstA, A, t.id, c.id, "2.500,00", undefined, TODAY);
    const payId = (await db.select().from(schema.bankAllocations))[0].paymentId;
    // pagamento → não pode ser estornado por fora enquanto o vínculo estiver ativo
    await expect(db.execute(sql`update payments set status = 'estornado', reversed_by = ${gerA}, reversed_at = now(), reverse_reason = 'por fora' where id = ${payId}`)).rejects.toThrow();
    // vínculo → não pode ser desfeito com o pagamento ainda ativo
    await expect(db.execute(sql`update bank_allocations set status = 'desfeita', undone_by = ${gerA}, undone_at = now(), undo_reason = 'por fora' where id = ${allocationId}`)).rejects.toThrow();
    expect((await getReceivable(db, contA, A, c.id, TODAY))!.situation).toBe("quitada");
    // o caminho do serviço continua funcionando (estorno + desfazer na mesma transação)
    await undoAllocation(db, gerA, A, allocationId, "desfazendo pelo serviço");
    expect((await getReceivable(db, contA, A, c.id, TODAY))!.situation).toBe("vencida");
    // a permissão do estorno vale só dentro da transação: fora dela, outro pagamento conciliado continua protegido
    await allocate(db, asstA, A, t.id, c.id, "100,00", undefined, TODAY);
    const p2 = (await db.select().from(schema.bankAllocations).where(eq(schema.bankAllocations.status, "ativa")))[0].paymentId;
    await expect(db.execute(sql`update payments set status = 'estornado', reversed_by = ${gerA}, reversed_at = now(), reverse_reason = 'de novo por fora' where id = ${p2}`)).rejects.toThrow();
  });

  it("banco: triggers barram vínculo acima do crédito, em débito, em transação classificada; vínculo é imutável e não se apaga", async () => {
    await approvedBatch();
    const id = await acct();
    await imp(id, ofx([{ id: "T1", date: "20261015", amt: "2500.00", memo: "PIX A" }, { id: "T2", date: "20261015", amt: "-10.00", memo: "TARIFA" }, { id: "T3", date: "20261015", amt: "100.00", memo: "MARCADA" }]));
    const T = async (d: string) => (await txs(id)).find((t) => t.description === d)!;
    const c1 = await chargeOf(cli1), c2 = await chargeOf(cli2);
    const payRow = async (chargeId: string, amount: string) => (await db.insert(schema.payments).values({ companyId: A, chargeId, amount, paidAt: "2026-10-15", method: "extrato", registeredBy: asstA }).returning())[0];
    const al = async (txId: string, chargeId: string, paymentId: string, amount: string) => db.insert(schema.bankAllocations).values({ companyId: A, transactionId: txId, chargeId, paymentId, amount, createdBy: asstA });
    const p1 = await payRow(c1.id, "2500.00");
    await expect(al((await T("TARIFA")).id, c1.id, p1.id, "2500.00")).rejects.toThrow(); // débito
    await db.insert(schema.bankTransactionMarks).values({ companyId: A, transactionId: (await T("MARCADA")).id, kind: "outro", createdBy: asstA });
    const p2 = await payRow(c2.id, "100.00");
    await expect(al((await T("MARCADA")).id, c2.id, p2.id, "100.00")).rejects.toThrow(); // classificada
    await expect(al((await T("PIX A")).id, c1.id, p1.id, "2500.01")).rejects.toThrow(); // acima do crédito / pagamento diferente
    await expect(al((await T("PIX A")).id, c2.id, p1.id, "2500.00")).rejects.toThrow(); // pagamento de outra cobrança
    await al((await T("PIX A")).id, c1.id, p1.id, "2500.00");
    const p3 = await payRow(c2.id, "100.00");
    await expect(al((await T("PIX A")).id, c2.id, p3.id, "100.00")).rejects.toThrow(); // crédito já todo usado
    await expect(db.execute(sql`update bank_allocations set amount = 1`)).rejects.toThrow();
    await expect(db.execute(sql`delete from bank_allocations`)).rejects.toThrow();
    await expect(db.insert(schema.bankTransactionMarks).values({ companyId: A, transactionId: (await T("PIX A")).id, kind: "outro", createdBy: asstA })).rejects.toThrow(); // já vinculada
  });

  it("concorrência: dois vínculos simultâneos que juntos passam do crédito → só um entra; vínculo × baixa manual na mesma cobrança → nunca passa do saldo", async () => {
    await approvedBatch();
    const id = await acct();
    await imp(id, ofx([{ id: "T1", date: "20261015", amt: "2500.00", memo: "PIX A" }, { id: "T2", date: "20261015", amt: "2500.00", memo: "PIX B" }]));
    const T = async (d: string) => (await txs(id)).find((t) => t.description === d)!;
    const c1 = await chargeOf(cli1), c2 = await chargeOf(cli2);
    const r = await Promise.allSettled([allocate(db, asstA, A, (await T("PIX A")).id, c1.id, "2.000,00", undefined, TODAY), allocate(db, asstA, A, (await T("PIX A")).id, c2.id, "2.000,00", undefined, TODAY)]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect((r.find((x) => x.status === "rejected") as PromiseRejectedResult).reason.message).toMatch(/resta do crédito/);
    const c = c2.id;
    const r2 = await Promise.allSettled([allocate(db, asstA, A, (await T("PIX B")).id, c, "2.500,00", undefined, TODAY), registerPayment(db, asstA, A, c, { amount: "2.500,00", paidAt: "2026-10-15", method: "pix" }, TODAY)]);
    expect(r2.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect((await getReceivable(db, contA, A, c, TODAY))!.paidCents).toBeLessThanOrEqual(250000);
  });

  it("auditoria sem descrição do extrato, nomes, valores ou documentos; isolamento entre empresas", async () => {
    await approvedBatch();
    const id = await acct();
    await imp(id, ofx([{ id: "T1", date: "20261015", amt: "2500.00", memo: `PIX SEGREDO FULANO ${D1}` }]));
    const t = (await txs(id))[0];
    const { allocationId } = await allocate(db, asstA, A, t.id, (await chargeOf(cli1)).id, "2.500,00", undefined, TODAY);
    await markTransaction(db, asstA, A, (await txs(id, "todas"))[0].id, "outro", "x").catch(() => undefined);
    await undoAllocation(db, gerA, A, allocationId, "motivo com nome Maria");
    const logs = await db.select().from(schema.auditLog).where(sql`${schema.auditLog.action} like 'bank.%' or ${schema.auditLog.action} like 'receivable.%'`);
    const txt = JSON.stringify(logs.map((l) => l.detail));
    for (const bad of ["SEGREDO", "FULANO", D1, "2500", "2.500", "Maria", "Cliente Um", "Conta Cora"]) expect(txt).not.toContain(bad);
    expect(logs.map((l) => l.action)).toEqual(expect.arrayContaining(["bank.account.created", "bank.import.previewed", "bank.import.applied", "bank.allocated", "bank.allocation_undone"]));
    // outra empresa
    await createAccount(db, dirB, B, { name: "Conta B", bank: "Cora", openingBalance: "0", openingDate: "2026-01-01" });
    expect(await listTransactions(db, dirB, B, id).catch((e) => (e as Error).message)).toBe("Conta não encontrada");
    expect(await getTransaction(db, dirB, B, t.id)).toBeNull();
    await expect(allocate(db, dirB, B, t.id, (await chargeOf(cli1)).id, "1,00", undefined, TODAY)).rejects.toThrow(/não encontrada/);
    await expect(undoAllocation(db, dirB, B, allocationId, "tentando de outra empresa")).rejects.toThrow(/não encontrado/);
    expect(await getImport(db, dirB, B, (await listImports(db, contA, A, id))[0].id)).toBeNull();
    expect(await listAccounts(db, dirB, B)).toHaveLength(1);
  });
});
