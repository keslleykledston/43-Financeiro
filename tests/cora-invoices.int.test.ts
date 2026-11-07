import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { and, eq, sql } from "drizzle-orm";
import { databaseUrl } from "@/lib/db/url";
import * as schema from "@/lib/db/schema";
import type { DB } from "@/lib/db";
import { Forbidden } from "@/modules/identity/service";
import { createParty } from "@/modules/crm/service";
import { createContract, decideVersion, getContract } from "@/modules/contracts/service";
import { approveBatch, generateBatch, getBatch } from "@/modules/billing/batches";
import { saveCoraCredentials } from "@/modules/providers/cora-config";
import type { Transport } from "@/modules/providers/cora-http";
import { tickCoraInvoices, __resetCoraTick } from "@/modules/receivables/cora-tick";
import { coraInvoicesView, importCoraInvoices, refreshCoraInvoices, refreshOneCoraInvoice, setOverdueCollection } from "@/modules/receivables/cora-invoices";
import { TEST_CERT, TEST_KEY } from "./fixtures/cora-teste";

const enabled = !!process.env.POSTGRES_USER;
const DOC1 = "11222333000181", DOC2 = "45723174000110";
const noSleep = async () => {};
type Inv = { id: string; status: string; due: string; total: number; paid?: number; occ?: string; code?: string };
/** Cora falsa: filtra por documento (search), data inicial (start) e página; GET por id; pode limitar (429) as primeiras chamadas. */
const fakeCora = (byDoc: Record<string, Inv[]>, o: { limit429?: number; docOf?: Record<string, string>; pageCap?: number } = {}) => {
  let n429 = o.limit429 ?? 0; const state = { calls: 0, byDoc, writes: 0 };
  const ownerDoc = (id: string) => o.docOf?.[id] ?? Object.entries(state.byDoc).find(([, l]) => l.some((x) => x.id === id))?.[0] ?? "";
  const body = (i: Inv, detail = false) => ({ id: i.id, status: i.status, code: i.code ?? null, total_amount: i.total, total_paid: i.paid ?? 0, occurrence_date: i.occ ?? null, payment_terms: { due_date: i.due }, ...(detail ? { customer: { name: "X", document: { identity: ownerDoc(i.id), type: "CNPJ" } } } : {}), payment_options: { bank_slip: { digitable: "0019000", url: "https://x/y.pdf" } }, payments: i.paid ? [{ id: "p1", status: "SUCCESS", method: "BANK_SLIP", total_paid: i.paid, finalized_at: `${i.occ ?? "2026-10-20"}T12:00:00Z` }] : [] });
  const t: Transport = async (r) => {
    if (r.method !== "GET" && r.path !== "/token") state.writes++;
    if (r.path === "/token") return { status: 200, body: JSON.stringify({ access_token: "eyJabcdefghij.klmnopqrst.uvw", expires_in: 3600 }) };
    state.calls++;
    if (n429 > 0) { n429--; return { status: 429, body: "{}" }; }
    const u = new URL(`https://h${r.path}`);
    const m = /^\/v2\/invoices\/([^/]+)$/.exec(u.pathname);
    const all = Object.values(state.byDoc).flat();
    if (m) { const i = all.find((x) => x.id === m[1]); return i ? { status: 200, body: JSON.stringify(body(i, true)) } : { status: 404, body: "{}" }; }
    const doc = u.searchParams.get("search"), start = u.searchParams.get("start") ?? "0000-00-00", page = Number(u.searchParams.get("page") ?? 1), per = Number(u.searchParams.get("perPage") ?? 20);
    // como a Cora real: com `search`, só responde se vierem início E fim
    const list = doc && !(u.searchParams.get("start") && u.searchParams.get("end")) ? [] : (doc ? state.byDoc[doc] ?? [] : all).filter((i) => i.due >= start);
    void o.pageCap;
    return { status: 200, body: JSON.stringify({ totalItems: list.length, items: list.slice((page - 1) * per, page * per).map((x) => body(x)) }) };
  };
  return { t, state };
};

describe.skipIf(!enabled)("F1b — espelho dos boletos da Cora (somente leitura) + chave por cliente (DB de teste)", () => {
  let admin: ReturnType<typeof postgres>, conn: ReturnType<typeof postgres>, db: DB;
  let A: string, B: string, dirA: string, dirB: string, gerA: string, asstA: string, cli1: string, cli2: string, cliB: string;

  beforeAll(async () => {
    process.env.K3G_CREDENTIALS_KEY = "chave-de-teste-0123456789abcdef-0123456789";
    const base = databaseUrl();
    admin = postgres(base.replace(/\/k3gfinance$/, "/postgres"), { max: 1 });
    if (!(await admin`select 1 from pg_database where datname = 'k3gfinance_test'`).length) await admin.unsafe("create database k3gfinance_test");
    conn = postgres(base.replace(/\/k3gfinance$/, "/k3gfinance_test"), { max: 4 });
    db = drizzle(conn, { schema });
    await migrate(db, { migrationsFolder: "./drizzle" });
  });
  afterAll(async () => { await conn?.end(); await admin?.end(); });

  beforeEach(async () => {
    await db.execute(sql`truncate cora_invoices, provider_credentials, issuance_requests, issuance_settings, payments, message_queue, message_template_versions, message_templates, charge_invoices, charges, billing_batches, holidays, contract_versions, contracts, rate_limits, customer_contacts, vendor_contacts, customers, vendors, audit_log, invitations, memberships, companies, users restart identity cascade`);
    const [a, b] = await db.insert(schema.companies).values([{ name: "Empresa A" }, { name: "Empresa B" }]).returning();
    A = a.id; B = b.id;
    const mk = async (e: string) => (await db.insert(schema.users).values({ email: e, name: e, passwordHash: "x" }).returning())[0].id;
    dirA = await mk("dir-a@t.com"); dirB = await mk("dir-b@t.com"); gerA = await mk("ger@t.com"); asstA = await mk("asst@t.com");
    await db.insert(schema.memberships).values([{ userId: dirA, companyId: A, role: "diretoria" }, { userId: dirB, companyId: B, role: "diretoria" }, { userId: gerA, companyId: A, role: "gerente" }, { userId: asstA, companyId: A, role: "assistente" }]);
    cli1 = (await createParty(db, dirA, A, { kind: "cliente", legalName: "Cliente Um", document: DOC1 })).id;
    cli2 = (await createParty(db, dirA, A, { kind: "cliente", legalName: "Cliente Dois", document: DOC2 })).id;
    cliB = (await createParty(db, dirB, B, { kind: "cliente", legalName: "Cliente da B", document: "12345678909" })).id;
    await saveCoraCredentials(db, dirA, A, { environment: "producao", label: "Prod", clientId: "int-cliente-prod-123", certificate: TEST_CERT, privateKey: TEST_KEY });
  });

  const n = async (q: string) => Number((await db.execute(sql.raw(`select count(*)::int n from ${q}`)))[0].n);
  const data = (): Record<string, Inv[]> => ({
    [DOC1]: [
      { id: "inv_old", status: "PAID", due: "2025-12-20", total: 10000, paid: 10000 }, // antes de 01/01/2026: fora
      { id: "inv_late", status: "LATE", due: "2026-09-21", total: 70000 },
      { id: "inv_paid", status: "PAID", due: "2026-10-15", total: 150000, paid: 153549, occ: "2026-10-26" },
      { id: "inv_open", status: "OPEN", due: "2026-11-20", total: 80000 },
      { id: "inv_weird", status: "WHATEVER", due: "2026-11-21", total: 100 },
    ],
    [DOC2]: [{ id: "inv_canc", status: "CANCELLED", due: "2026-10-26", total: 25000 }, { id: "inv_late2", status: "LATE", due: "2026-10-05", total: 170200 }],
  });

  it("importa desde 01/01/2026 (todas as situações), pelo documento do cliente; ignora o que é anterior e situação desconhecida; idempotente", async () => {
    const f = fakeCora(data());
    const r = await importCoraInvoices(db, dirA, A, { transport: f.t, sleep: noSleep });
    expect(r).toMatchObject({ customers: 2, inserted: 5, updated: 0, unknownStatus: 1, failedCustomers: 0 });
    const rows = await db.select().from(schema.coraInvoices).where(eq(schema.coraInvoices.companyId, A));
    expect(rows.map((x) => x.coraId).sort()).toEqual(["inv_canc", "inv_late", "inv_late2", "inv_open", "inv_paid"]);
    expect(rows.find((x) => x.coraId === "inv_late")!.customerId).toBe(cli1);
    expect(rows.find((x) => x.coraId === "inv_late2")!.customerId).toBe(cli2);
    expect(rows.find((x) => x.coraId === "inv_paid")).toMatchObject({ status: "PAID", totalCents: 150000, paidCents: 153549, paidOn: "2026-10-26" });
    expect(f.state.writes).toBe(0); // só leitura na Cora
    const again = await importCoraInvoices(db, dirA, A, { transport: f.t, sleep: noSleep });
    expect(again).toMatchObject({ inserted: 0, updated: 5 });
    expect(await n("cora_invoices")).toBe(5);
    expect(await n("audit_log where action = 'cora.invoices.imported'")).toBe(2);
  });

  it("NÃO vira cobrança nem alimenta mensagem: nenhuma cobrança, lote, solicitação ou fila é criada", async () => {
    await importCoraInvoices(db, dirA, A, { transport: fakeCora(data()).t, sleep: noSleep });
    for (const t of ["charges", "billing_batches", "issuance_requests", "message_queue", "payments"]) expect(await n(t)).toBe(0);
    expect(await n("whatsapp_outbox")).toBe(0);
  });

  it("a chave de cobrança dos atrasados nasce DESLIGADA em todo cliente; só a diretoria muda; fica na auditoria; não vaza entre empresas", async () => {
    expect(await n("customers where overdue_collection")).toBe(0);
    await expect(setOverdueCollection(db, gerA, A, cli1, true)).rejects.toThrow(Forbidden);
    await expect(setOverdueCollection(db, asstA, A, cli1, true)).rejects.toThrow(Forbidden);
    await expect(setOverdueCollection(db, dirB, A, cli1, true)).rejects.toThrow(Forbidden); // diretoria de outra empresa
    await expect(setOverdueCollection(db, dirB, B, cli1, true)).rejects.toThrow(/Cliente não encontrado/); // cliente de outra empresa
    await setOverdueCollection(db, dirA, A, cli1, true);
    const rows = await db.select({ id: schema.customers.id, on: schema.customers.overdueCollection }).from(schema.customers);
    expect(rows.filter((r) => r.on).map((r) => r.id)).toEqual([cli1]); // só ele
    expect(await n("audit_log where action = 'customer.overdue_collection'")).toBe(1);
    await setOverdueCollection(db, dirA, A, cli1, false);
    expect(await n("customers where overdue_collection")).toBe(0);
  });

  it("isolamento e permissão: só gerente/diretoria importam; sem credencial da Cora nada acontece; empresa B não ganha linhas", async () => {
    const f = fakeCora(data());
    await expect(importCoraInvoices(db, asstA, A, { transport: f.t, sleep: noSleep })).rejects.toThrow(Forbidden);
    await expect(importCoraInvoices(db, dirB, A, { transport: f.t, sleep: noSleep })).rejects.toThrow(Forbidden);
    await expect(importCoraInvoices(db, dirB, B, { transport: f.t, sleep: noSleep })).rejects.toThrow(/credenciais da Cora de produção/);
    await importCoraInvoices(db, gerA, A, { transport: f.t, sleep: noSleep });
    expect(await n(`cora_invoices where company_id = '${B}'`)).toBe(0);
    await expect(coraInvoicesView(db, dirB, A)).rejects.toThrow(Forbidden);
  });

  it("documento do boleto diferente do cliente consultado (ou ausente): NADA daquele cliente entra; os outros entram", async () => {
    const f = fakeCora(data(), { docOf: { inv_late: DOC2 } }); // a Cora devolveu, na busca do cliente 1, um boleto que é do documento 2
    const r = await importCoraInvoices(db, dirA, A, { transport: f.t, sleep: noSleep });
    expect(r).toMatchObject({ docMismatch: 1, customers: 2 });
    const ids = (await db.select({ c: schema.coraInvoices.coraId }).from(schema.coraInvoices)).map((x) => x.c).sort();
    expect(ids).toEqual(["inv_canc", "inv_late2"]); // só o cliente 2
  });

  it("o documento é conferido em TODO boleto novo (não só no primeiro): um intruso no meio de boletos encerrados derruba o cliente inteiro", async () => {
    const d = { [DOC1]: [{ id: "inv_ok_0001", status: "PAID", due: "2026-02-10", total: 100, paid: 100 }, { id: "inv_intruso1", status: "CANCELLED", due: "2026-03-10", total: 100 }], [DOC2]: data()[DOC2] };
    const r = await importCoraInvoices(db, dirA, A, { transport: fakeCora(d, { docOf: { inv_intruso1: DOC2 } }).t, sleep: noSleep });
    expect(r.docMismatch).toBe(1);
    expect((await db.select().from(schema.coraInvoices)).every((x) => x.customerId === cli2)).toBe(true);
  });

  it("importação diária reservada no banco: dois agendadores no mesmo dia, só um importa; os ciclos seguintes só atualizam", async () => {
    const f = fakeCora(data());
    await importCoraInvoices(db, dirA, A, { transport: f.t, sleep: noSleep }); // cria o espelho (empresa passa a ser alvo do ciclo)
    await db.execute(sql`delete from audit_log`);
    const t1 = new Date("2027-03-02T14:00:00-04:00"); // depois das 06:00 de Manaus
    __resetCoraTick();
    const a = await tickCoraInvoices(db, t1, { transport: f.t, sleep: noSleep });
    __resetCoraTick(); // outro processo/reinício
    const b = await tickCoraInvoices(db, new Date(t1.getTime() + 3_600_000), { transport: f.t, sleep: noSleep });
    expect(a).toMatchObject({ imported: 1, refreshed: 0 }); expect(b).toMatchObject({ imported: 0, refreshed: 1 });
    expect(await n("audit_log where action = 'cora.invoices.import_started'")).toBe(1);
    // reserva que ficou sem conclusão (processo caiu): depois de 3 h outra tentativa retoma
    await db.execute(sql`delete from audit_log where action = 'cora.invoices.imported'`);
    __resetCoraTick();
    expect((await tickCoraInvoices(db, new Date(t1.getTime() + 4 * 3_600_000), { transport: f.t, sleep: noSleep })).imported).toBe(1);
    const before = new Date("2027-03-02T05:00:00-04:00"); __resetCoraTick();
    expect((await tickCoraInvoices(db, before, { transport: f.t, sleep: noSleep })).imported).toBe(0); // antes das 06:00 não importa
  });

  it("dois cadastros ativos com o mesmo documento (formatos diferentes): ambos ficam de fora até resolver", async () => {
    await db.insert(schema.customers).values({ companyId: A, legalName: "Cliente Um (duplicado)", document: "11.222.333/0001-81", docType: "cnpj" } as never);
    const r = await importCoraInvoices(db, dirA, A, { transport: fakeCora(data()).t, sleep: noSleep });
    expect(r.ambiguousCustomers).toBe(2);
    expect((await db.select().from(schema.coraInvoices)).every((x) => x.customerId === cli2)).toBe(true);
  });

  it("a busca da Cora sem o fim do período devolve vazio — a importação sempre manda início e fim", async () => {
    const r = await importCoraInvoices(db, dirA, A, { transport: fakeCora(data()).t, sleep: noSleep });
    expect(r.fetched).toBeGreaterThan(0); // se mandasse só o início, a Cora real devolveria 0
  });

  it("mais de uma página: percorre até o fim (sem truncar em silêncio)", async () => {
    const many: Inv[] = Array.from({ length: 450 }, (_, k) => ({ id: `inv_many_${String(k).padStart(5, "0")}`, status: "PAID", due: "2026-03-10", total: 100, paid: 100 }));
    const r = await importCoraInvoices(db, dirA, A, { transport: fakeCora({ [DOC1]: many, [DOC2]: [] }).t, sleep: noSleep });
    expect(r, JSON.stringify(r)).toMatchObject({ inserted: 450 }); expect(await n("cora_invoices")).toBe(450);
  });

  it("limite da Cora (429): espera e tenta de novo, sem perder cliente", async () => {
    const f = fakeCora(data(), { limit429: 3 });
    const r = await importCoraInvoices(db, dirA, A, { transport: f.t, sleep: noSleep });
    expect(r).toMatchObject({ failedCustomers: 0, inserted: 5 });
  });

  it("boleto emitido pela plataforma é ligado à cobrança (chargeId) e aparece como tal", async () => {
    const c = await createContract(db, asstA, A, cli1, { description: "Monitoramento", monthlyAmount: "800,00", startAt: "2026-01-01", endAt: "", dueDay: "20", invoiceJointRequired: false, issueDayOverride: "" });
    await decideVersion(db, dirA, A, (await getContract(db, dirA, A, c.id))!.versions[0].id, "aprovar");
    const { batchId } = await generateBatch(db, asstA, A, "2027-02-08");
    await approveBatch(db, dirA, A, batchId, (await getBatch(db, asstA, A, batchId))!.hash);
    const ch = (await db.select().from(schema.charges).where(eq(schema.charges.companyId, A)))[0];
    await db.insert(schema.issuanceRequests).values({ companyId: A, chargeId: ch.id, kind: "boleto", idempotencyKey: `boleto:${ch.id}`, requestedBy: dirA, status: "emitido", mode: "cora_producao", externalRef: "inv_open" });
    await importCoraInvoices(db, dirA, A, { transport: fakeCora(data()).t, sleep: noSleep });
    const linked = await db.select({ id: schema.coraInvoices.coraId, ch: schema.coraInvoices.chargeId }).from(schema.coraInvoices).where(eq(schema.coraInvoices.companyId, A));
    expect(linked.find((r) => r.id === "inv_open")!.ch).toBe(ch.id);
    expect(linked.filter((r) => r.ch).length).toBe(1);
    expect((await coraInvoicesView(db, dirA, A, { filter: "a_vencer" })).rows[0].charge_id).toBe(ch.id);
  });

  it("atualização rápida: aberto que pagou vira PAGO com a data; aberto que sumiu da janela é consultado; cancelado é marcado", async () => {
    const d = data();
    const f = fakeCora(d);
    await importCoraInvoices(db, dirA, A, { transport: f.t, sleep: noSleep });
    d[DOC1].find((i) => i.id === "inv_late")!.status = "PAID"; Object.assign(d[DOC1].find((i) => i.id === "inv_late")!, { paid: 70000, occ: "2026-11-06" });
    d[DOC2].find((i) => i.id === "inv_late2")!.status = "CANCELLED";
    const r = await refreshCoraInvoices(db, dirA, A, { transport: f.t, sleep: noSleep });
    expect(r).toMatchObject({ updated: 2, becamePaid: 1, becameCancelled: 1, failed: 0 });
    const paid = (await db.select().from(schema.coraInvoices).where(eq(schema.coraInvoices.coraId, "inv_late")))[0];
    expect(paid).toMatchObject({ status: "PAID", paidCents: 70000, paidOn: "2026-11-06" });
    expect((await refreshCoraInvoices(db, dirA, A, { transport: f.t, sleep: noSleep })).updated).toBe(0); // sem mudança
    expect(f.state.writes).toBe(0);
  });

  it("aviso (webhook) de um boleto do espelho reconsulta só esse; boleto desconhecido devolve falso", async () => {
    const d = data(); const f = fakeCora(d);
    await importCoraInvoices(db, dirA, A, { transport: f.t, sleep: noSleep });
    Object.assign(d[DOC1].find((i) => i.id === "inv_open")!, { status: "PAID", paid: 80000, occ: "2026-11-07" });
    expect(await refreshOneCoraInvoice(db, A, "inv_open", { transport: f.t, sleep: noSleep })).toBe(true);
    expect((await db.select().from(schema.coraInvoices).where(eq(schema.coraInvoices.coraId, "inv_open")))[0]).toMatchObject({ status: "PAID", paidOn: "2026-11-07" });
    expect(await refreshOneCoraInvoice(db, A, "inv_nao_existe", { transport: f.t, sleep: noSleep })).toBe(false);
  });

  it("tela: resumo por situação, filtro padrão = em atraso, dias de atraso, busca por cliente", async () => {
    await importCoraInvoices(db, dirA, A, { transport: fakeCora(data()).t, sleep: noSleep });
    const v = await coraInvoicesView(db, asstA, A);
    expect(v.filter).toBe("atrasados");
    expect(v.summary.late).toEqual({ n: 2, cents: 70000 + 170200 });
    expect(v.summary.paid.n).toBe(1); expect(v.summary.cancelled.n).toBe(1); expect(v.summary.open.n).toBe(1);
    expect(v.rows.map((r) => r.cora_id).sort()).toEqual(["inv_late", "inv_late2"]);
    expect(v.rows.every((r) => r.daysLate > 0 && r.overdue_collection === false)).toBe(true);
    expect((await coraInvoicesView(db, asstA, A, { filter: "todos", q: "dois" })).rows.map((r) => r.cora_id).sort()).toEqual(["inv_canc", "inv_late2"]);
    expect((await coraInvoicesView(db, asstA, A, { filter: "pagos" })).rows).toHaveLength(1);
  });
  void and;
});
