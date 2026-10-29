import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { eq, sql } from "drizzle-orm";
import { databaseUrl } from "@/lib/db/url";
import * as schema from "@/lib/db/schema";
import type { DB } from "@/lib/db";
import { Invalid } from "@/modules/identity/service";
import { createParty } from "@/modules/crm/service";
import { createContract, decideVersion, getContract } from "@/modules/contracts/service";
import { approveBatch, generateBatch, getBatch } from "@/modules/billing/batches";
import { listIssuance, processIssuance, requestBatchIssuance, saveIssuanceSettings } from "@/modules/issuance/service";
import { cancelBoleto } from "@/modules/issuance/cancel";
import { syncBoletoStatus } from "@/modules/issuance/sync";
import { LiveNotAvailable, __setCoraTransportForTests } from "@/modules/providers/registry";
import { saveCoraCredentials } from "@/modules/providers/cora-config";
import { CORA_HOSTS, CoraNetworkError, type Transport } from "@/modules/providers/cora-http";
import { uuidFromKey } from "@/modules/providers/cora-boleto";
import { TEST_CERT, TEST_KEY } from "./fixtures/cora-teste";

const enabled = !!process.env.POSTGRES_USER;
const CNPJ1 = "11.222.333/0001-81", CNPJ2 = "12.ABC.345/01DE-35";
const D = "2026-10-01"; // competência 2026-09, vencimento 2026-10-14
const terms = (o: Record<string, unknown> = {}) => ({ description: "Monitoramento de redes", monthlyAmount: "2.500,00", startAt: "2026-01-01", endAt: "", dueDay: "14", invoiceJointRequired: false, issueDayOverride: "", ...o });

type Inv = { id: string; status: string; code: string; amount: number; due: string; doc: string; name: string; description: string; idem: string };
/** "Cora" falsa com estado: token, emissão idempotente por Idempotency-Key, listagem por CPF/CNPJ + vencimento, detalhe e cancelamento. Só imita o formato real da API. */
function fakeCora() {
  const inv = new Map<string, Inv>(); const byIdem = new Map<string, string>();
  const calls: { host: string; method: string; path: string; headers: Record<string, string>; body?: any }[] = [];
  const hooks = { dropAfterCreate: 0, failCreate: null as null | { status: number; body: unknown }, failBeforeCreate: 0, amountOverride: null as null | number, paid: new Set<string>() };
  let seq = 0;
  const j = (status: number, body: unknown) => ({ status, body: body === null ? "" : JSON.stringify(body) });
  const full = (i: Inv) => ({ id: i.id, status: i.status, code: i.code, total_amount: hooks.amountOverride ?? i.amount, total_paid: i.status === "PAID" ? i.amount : 0, customer: { name: i.name, document: { identity: i.doc, type: i.doc.length === 11 ? "CPF" : "CNPJ" } }, services: [{ name: i.description.slice(0, 100), amount: i.amount }], payment_terms: { due_date: i.due }, payment_options: { bank_slip: { digitable: "00190000090321583700012584580174791420000002000", barcode: "00197914200000020000000003215837001258458017", our_number: "1", registered: true, url: `https://pdf.invalid/${i.id}.pdf` } }, payments: [] });
  const summary = (i: Inv) => ({ id: i.id, status: i.status, total_amount: i.amount, due_date: i.due, customer: { name: i.name } }); // a listagem real NÃO traz `code`
  const transport: Transport = async (o) => {
    const body = o.body && o.headers["content-type"] === "application/json" ? JSON.parse(o.body) : undefined;
    calls.push({ host: o.host, method: o.method, path: o.path, headers: o.headers, body });
    const [path, qs] = o.path.split("?"); const q = new URLSearchParams(qs ?? "");
    if (path === "/token") return j(200, { access_token: "tok_fake_" + calls.length, expires_in: 3600, token_type: "Bearer" });
    if (o.method === "POST" && path === "/v2/invoices") {
      if (hooks.failBeforeCreate > 0) { hooks.failBeforeCreate--; throw new CoraNetworkError("conexão caiu antes de enviar"); }
      if (hooks.failCreate) { const f = hooks.failCreate; return j(f.status, f.body); }
      const idem = o.headers["Idempotency-Key"];
      if (!/^[0-9a-f-]{36}$/.test(idem)) return j(400, { code: "invalid_request", errors: [{ code: "Idempotency-Key", message: "header is required" }] });
      let id = byIdem.get(idem);
      if (!id) {
        if (body.payment_terms.due_date < "2026-01-01") return j(400, { code: "invalid_request", message: "Request has invalid parameters", errors: [{ code: "paymentTerms.dueDate", message: "cannot be a past date" }] });
        id = `inv_fake${String(++seq).padStart(6, "0")}`; byIdem.set(idem, id);
        inv.set(id, { id, status: "OPEN", code: body.code, amount: body.services[0].amount, due: body.payment_terms.due_date, doc: body.customer.document.identity, name: body.customer.name, description: body.services[0].description, idem });
      }
      if (hooks.dropAfterCreate > 0) { hooks.dropAfterCreate--; throw new CoraNetworkError("resposta perdida"); }
      return j(200, full(inv.get(id)!));
    }
    if (o.method === "GET" && path === "/v2/invoices") {
      const items = [...inv.values()].filter((i) => (!q.get("search") || i.doc === q.get("search")) && (!q.get("start") || i.due >= q.get("start")!) && (!q.get("end") || i.due <= q.get("end")!));
      return j(200, { totalItems: items.length, items: items.map(summary) });
    }
    const m = /^\/v2\/invoices\/(inv_\w+)$/.exec(path);
    if (m) {
      const i = inv.get(m[1]);
      if (!i) return j(404, { code: "not_found", message: "invoice not found" });
      if (o.method === "GET") return j(200, full(i));
      if (o.method === "DELETE") {
        if (hooks.paid.has(i.id) || i.status === "PAID") return j(422, { code: "REC-0006", message: "invoice already paid" });
        i.status = "CANCELLED"; return j(204, null);
      }
    }
    return j(404, { code: "not_found" });
  };
  return { transport, inv, calls, hooks, posts: () => calls.filter((c) => c.method === "POST" && c.path === "/v2/invoices") };
}

describe.skipIf(!enabled)("E10b-1 motor de emissão × Cora (testes): ponta a ponta contra uma Cora falsa com estado (DB de teste)", () => {
  let admin: ReturnType<typeof postgres>, conn: ReturnType<typeof postgres>, db: DB;
  let A: string, B: string, dirA: string, gerA: string, asstA: string, cli1: string, cli2: string;
  let cora: ReturnType<typeof fakeCora>;

  beforeAll(async () => {
    process.env.K3G_CREDENTIALS_KEY = "chave-de-teste-0123456789abcdef-0123456789";
    const base = databaseUrl();
    admin = postgres(base.replace(/\/k3gfinance$/, "/postgres"), { max: 1 });
    if (!(await admin`select 1 from pg_database where datname = 'k3gfinance_test'`).length) await admin.unsafe("create database k3gfinance_test");
    conn = postgres(base.replace(/\/k3gfinance$/, "/k3gfinance_test"), { max: 4 });
    db = drizzle(conn, { schema });
    await migrate(db, { migrationsFolder: "./drizzle" });
  });
  afterAll(async () => { __setCoraTransportForTests(undefined); await conn?.end(); await admin?.end(); });
  afterEach(() => { delete process.env.CORA_STAGE_ENABLED; delete process.env.CORA_LIVE_ENABLED; });

  beforeEach(async () => {
    await db.execute(sql`truncate boleto_cancel_requests, boleto_cancellations, provider_credentials, issuance_requests, issuance_settings, bank_transaction_marks, bank_allocations, bank_transactions, bank_import_rows, bank_import_batches, bank_accounts, payments, messaging_settings, message_queue, message_template_versions, message_templates, charges, billing_batches, holidays, contract_versions, contracts, integration_conflicts, integration_sync_runs, integration_connections, rate_limits, customer_contacts, vendor_contacts, customers, vendors, audit_log, invitations, memberships, companies, users restart identity cascade`);
    const [a, b] = await db.insert(schema.companies).values([{ name: "Empresa A" }, { name: "Empresa B" }]).returning();
    A = a.id; B = b.id;
    const mk = async (e: string) => (await db.insert(schema.users).values({ email: e, name: e, passwordHash: "x" }).returning())[0].id;
    dirA = await mk("dir-a@t.com"); gerA = await mk("ger@t.com"); asstA = await mk("asst@t.com");
    await db.insert(schema.memberships).values([{ userId: dirA, companyId: A, role: "diretoria" }, { userId: gerA, companyId: A, role: "gerente" }, { userId: asstA, companyId: A, role: "assistente" }]);
    cli1 = (await createParty(db, dirA, A, { kind: "cliente", legalName: "Cliente Um", document: CNPJ1 })).id;
    cli2 = (await createParty(db, dirA, A, { kind: "cliente", legalName: "Cliente Dois", document: CNPJ2 })).id;
    cora = fakeCora();
    __setCoraTransportForTests(cora.transport);
  });

  const stageOn = () => { process.env.CORA_STAGE_ENABLED = "true"; };
  const creds = () => saveCoraCredentials(db, dirA, A, { environment: "homologacao", label: "Teste", clientId: "int-cliente-teste-123", certificate: TEST_CERT, privateKey: TEST_KEY });
  const activeContract = async (customer: string, t = terms()) => {
    const c = await createContract(db, asstA, A, customer, t);
    await decideVersion(db, dirA, A, (await getContract(db, dirA, A, c.id))!.versions[0].id, "aprovar");
  };
  const approvedBatch = async () => {
    await activeContract(cli1); await activeContract(cli2);
    const { batchId } = await generateBatch(db, asstA, A, D);
    await approveBatch(db, dirA, A, batchId, (await getBatch(db, asstA, A, batchId))!.hash);
    return batchId;
  };
  const NOW = new Date(Date.now() + 5 * 60_000);
  const useCora = async (paused = false) => { stageOn(); await creds(); await saveIssuanceSettings(db, dirA, A, { paused, dailyLimit: 20, boletoProvider: "cora_homologacao" }); };
  const reqs = () => db.select().from(schema.issuanceRequests).orderBy(schema.issuanceRequests.createdAt, schema.issuanceRequests.id);
  const chargeOf = async (customer: string) => (await db.select().from(schema.charges).where(eq(schema.charges.customerId, customer)))[0];
  // o Drizzle embrulha o erro do Postgres em "Failed query"; a mensagem real está em `cause`
  const refused = async (p: Promise<unknown>, re: RegExp) => { const e = await p.then(() => null, (x: any) => x); expect(e, "deveria ter sido recusado").not.toBeNull(); expect(String(e.cause?.message ?? e.message)).toMatch(re); };
  const n = async (q: string) => Number((await db.execute(sql.raw(`select count(*)::int n from ${q}`)))[0].n);

  it("trocar para a Cora de testes exige as 3 travas (chave do servidor, credencial de homologação, diretoria) e nenhum boleto em andamento", async () => {
    const batchId = await approvedBatch();
    await expect(saveIssuanceSettings(db, gerA, A, { paused: false, dailyLimit: 20, boletoProvider: "cora_homologacao" })).rejects.toThrow(); // só diretoria
    await expect(saveIssuanceSettings(db, dirA, A, { paused: false, dailyLimit: 20, boletoProvider: "cora_producao" })).rejects.toThrow(Invalid); // não existe modo de produção
    await expect(saveIssuanceSettings(db, dirA, A, { paused: false, dailyLimit: 20, boletoProvider: "cora_homologacao" })).rejects.toThrow(LiveNotAvailable); // chave desligada
    stageOn();
    await expect(saveIssuanceSettings(db, dirA, A, { paused: false, dailyLimit: 20, boletoProvider: "cora_homologacao" })).rejects.toThrow(/Credenciais da Cora de testes/); // sem credencial
    await creds();
    process.env.CORA_LIVE_ENABLED = "true"; // chave de PRODUÇÃO ligada: tudo recusado
    await expect(saveIssuanceSettings(db, dirA, A, { paused: false, dailyLimit: 20, boletoProvider: "cora_homologacao" })).rejects.toThrow(LiveNotAvailable);
    delete process.env.CORA_LIVE_ENABLED;
    await saveIssuanceSettings(db, dirA, A, { paused: false, dailyLimit: 20 }); // sem o campo: mantém o provedor (simulado)
    expect((await db.select().from(schema.issuanceSettings))[0].boletoProvider).toBe("simulado");
    await requestBatchIssuance(db, gerA, A, batchId, "boleto"); // 2 pendentes
    await expect(saveIssuanceSettings(db, dirA, A, { paused: false, dailyLimit: 20, boletoProvider: "cora_homologacao" })).rejects.toThrow(/em andamento/);
    expect(cora.calls).toHaveLength(0); // nada foi para a Cora
  });

  it("EMITE na Cora de testes: valor, vencimento, documento, code e Idempotency-Key corretos; reprocessar não cria outro; só o host de stage é usado", async () => {
    const batchId = await approvedBatch(); await useCora();
    await requestBatchIssuance(db, gerA, A, batchId, "boleto");
    const r = await processIssuance(db, gerA, A, NOW);
    expect(r).toMatchObject({ claimed: 2, issued: 2, failed: 0 });
    const rows = await reqs();
    expect(rows.every((x) => x.mode === "cora_homologacao" && x.status === "emitido" && /^inv_fake/.test(x.externalRef!) && x.externalStatus === "emitido")).toBe(true);
    const posts = cora.posts();
    expect(posts).toHaveLength(2);
    const c1 = await chargeOf(cli1);
    const p1 = posts.find((p) => p.body.code === `k3g:boleto:${c1.id}`)!;
    expect(p1.headers["Idempotency-Key"]).toBe(uuidFromKey(`boleto:${c1.id}`));
    expect(p1.headers.authorization).toMatch(/^Bearer tok_fake_/);
    expect(p1.body).toMatchObject({ customer: { name: "Cliente Um", document: { identity: "11222333000181", type: "CNPJ" } }, services: [{ amount: 250000 }], payment_terms: { due_date: "2026-10-14" }, payment_forms: ["BANK_SLIP"] });
    expect(cora.calls.every((c) => c.host === CORA_HOSTS.homologacao)).toBe(true);
    expect(await processIssuance(db, gerA, A, NOW)).toMatchObject({ claimed: 0, issued: 0 }); // nada novo
    expect(cora.posts()).toHaveLength(2);
    const l = await listIssuance(db, dirA, A);
    expect(l.items.every((i) => i.mode === "cora_homologacao")).toBe(true);
    const audit = JSON.stringify(await db.select().from(schema.auditLog));
    expect(audit).not.toMatch(/tok_fake|11222333000181|Cliente Um|BEGIN/);
  });

  it("RESPOSTA PERDIDA depois de criar: vira 'desconhecido'; a rodada seguinte ACHA o boleto (lista + code) e não emite outro", async () => {
    const batchId = await approvedBatch(); await useCora();
    await requestBatchIssuance(db, gerA, A, batchId, "boleto");
    cora.hooks.dropAfterCreate = 1;
    const r1 = await processIssuance(db, gerA, A, NOW);
    expect(r1).toMatchObject({ unknown: 1, issued: 1 });
    expect((await reqs()).filter((x) => x.status === "desconhecido")).toHaveLength(1);
    expect(cora.inv.size).toBe(2); // a Cora criou os 2 (um com resposta perdida)
    const r2 = await processIssuance(db, gerA, A, new Date(NOW.getTime() + 3 * 60_000));
    expect(r2).toMatchObject({ issued: 1 });
    expect(cora.inv.size).toBe(2); // nenhum duplicado
    expect(cora.posts()).toHaveLength(2); // a reconsulta achou: nem POST novo
    expect((await reqs()).every((x) => x.status === "emitido" && x.mode === "cora_homologacao")).toBe(true);
  });

  it("queda ANTES de a Cora criar: reconsulta não acha e a reemissão usa a MESMA Idempotency-Key (um único boleto)", async () => {
    const batchId = await approvedBatch(); await useCora();
    await requestBatchIssuance(db, gerA, A, batchId, "boleto");
    cora.hooks.failBeforeCreate = 1;
    await processIssuance(db, gerA, A, NOW);
    const stuck = (await reqs()).find((x) => x.status === "desconhecido")!;
    expect(stuck).toBeTruthy();
    await processIssuance(db, gerA, A, new Date(NOW.getTime() + 3 * 60_000));
    expect(cora.inv.size).toBe(2);
    expect((await reqs()).every((x) => x.status === "emitido")).toBe(true);
    const keys = cora.posts().map((p) => p.headers["Idempotency-Key"]);
    expect(new Set(keys).size).toBe(2); // 3 POSTs no total, 2 chaves distintas: a repetida é a mesma da tentativa que caiu
    expect(keys.filter((k) => k === uuidFromKey(stuck.idempotencyKey))).toHaveLength(2);
  });

  it("erros da Cora no vocabulário do motor: 400 → falhou (código seguro); 429/401 → repete com backoff; 500 → desconhecido; valor divergente → falhou", async () => {
    const batchId = await approvedBatch(); await useCora();
    await requestBatchIssuance(db, gerA, A, batchId, "boleto");
    cora.hooks.failCreate = { status: 400, body: { code: "invalid_request", message: "Cliente Um 11222333000181 inválido", errors: [{ code: "paymentTerms.dueDate", message: "cannot be a past date" }] } };
    expect(await processIssuance(db, gerA, A, NOW)).toMatchObject({ failed: 2 });
    expect((await reqs()).every((x) => x.status === "falhou" && x.lastError === "paymentterms_duedate")).toBe(true);
    expect(JSON.stringify(await reqs())).not.toMatch(/Cliente Um|11222333000181/);

    await db.execute(sql`truncate issuance_requests cascade`); // o gatilho recusa DELETE de linha real; a base de teste é isenta de TRUNCATE
    await requestBatchIssuance(db, gerA, A, batchId, "boleto");
    cora.hooks.failCreate = { status: 429, body: { code: "rate_limit" } };
    expect(await processIssuance(db, gerA, A, NOW)).toMatchObject({ retry: 2 });
    cora.hooks.failCreate = { status: 500, body: { message: "boom" } };
    expect(await processIssuance(db, gerA, A, new Date(NOW.getTime() + 3 * 3600_000))).toMatchObject({ unknown: 2 });
    expect((await reqs()).every((x) => x.status === "desconhecido" && x.lastError === "erro_desconhecido")).toBe(true);

    await db.execute(sql`truncate issuance_requests cascade`); // o gatilho recusa DELETE de linha real; a base de teste é isenta de TRUNCATE
    await requestBatchIssuance(db, gerA, A, batchId, "boleto");
    cora.hooks.failCreate = null; cora.hooks.amountOverride = 999900;
    expect(await processIssuance(db, gerA, A, new Date(NOW.getTime() + 6 * 3600_000))).toMatchObject({ failed: 2 });
    expect((await reqs()).every((x) => x.lastError === "valor_divergente")).toBe(true);
  });

  it("chave do servidor desligada: a rodada FALHA FECHADA (nada reservado nem enviado); linhas já emitidas continuam canceláveis só com a trava ligada", async () => {
    const batchId = await approvedBatch(); await useCora();
    await requestBatchIssuance(db, gerA, A, batchId, "boleto");
    delete process.env.CORA_STAGE_ENABLED;
    await expect(processIssuance(db, gerA, A, NOW)).rejects.toThrow(LiveNotAvailable);
    expect((await reqs()).every((x) => x.status === "pendente" && x.attempts === 0)).toBe(true);
    expect(cora.calls).toHaveLength(0);
    stageOn();
    await processIssuance(db, gerA, A, NOW);
    const c1 = await chargeOf(cli1);
    delete process.env.CORA_STAGE_ENABLED;
    await expect(cancelBoleto(db, dirA, A, { chargeId: c1.id, reason: "teste de trava", confirm: true })).rejects.toThrow(LiveNotAvailable);
    expect([...cora.inv.values()].every((i) => i.status === "OPEN")).toBe(true);
  });

  it("CANCELAR (diretoria) cancela na Cora; nova emissão usa chave nova (geração) e cria outro boleto; boleto já pago na Cora não cancela", async () => {
    const batchId = await approvedBatch(); await useCora();
    await requestBatchIssuance(db, gerA, A, batchId, "boleto");
    await processIssuance(db, gerA, A, NOW);
    const c1 = await chargeOf(cli1), c2 = await chargeOf(cli2);
    const first = (await reqs()).find((x) => x.chargeId === c1.id)!;
    expect(await cancelBoleto(db, dirA, A, { chargeId: c1.id, reason: "cliente pediu", confirm: true })).toMatchObject({ status: "cancelado" });
    expect(cora.inv.get(first.externalRef!)!.status).toBe("CANCELLED");
    expect((await db.select().from(schema.boletoCancellations))[0]).toMatchObject({ mode: "cora_homologacao", status: "cancelado" });
    // nova emissão da mesma cobrança: chave g1 → UUID diferente → outro boleto
    await requestBatchIssuance(db, gerA, A, batchId, "boleto");
    await processIssuance(db, gerA, A, new Date(NOW.getTime() + 3 * 60_000));
    const second = (await reqs()).find((x) => x.chargeId === c1.id && x.status === "emitido")!;
    expect(second.idempotencyKey).toBe(`boleto:${c1.id}:g1`);
    expect(second.externalRef).not.toBe(first.externalRef);
    // pago na Cora: cancelar falha com boleto_pago e a régua para
    const r2 = (await reqs()).find((x) => x.chargeId === c2.id)!;
    cora.hooks.paid.add(r2.externalRef!);
    expect(await cancelBoleto(db, dirA, A, { chargeId: c2.id, reason: "teste pago", confirm: true })).toMatchObject({ status: "falhou" });
    expect((await db.select().from(schema.boletoCancellations).where(eq(schema.boletoCancellations.chargeId, c2.id)))[0].lastError).toBe("boleto_pago");
    expect((await reqs()).find((x) => x.id === r2.id)!.externalStatus).toBe("pago");
    expect(cora.calls.every((c) => c.host === CORA_HOSTS.homologacao)).toBe(true);
  });

  it("ATUALIZAR SITUAÇÃO (só consulta): pago → marca e para a régua sem criar baixa; cancelado lá fora → sai das ativas e permite novo boleto (g1); aberto → nada muda", async () => {
    const batchId = await approvedBatch(); await useCora();
    await requestBatchIssuance(db, gerA, A, batchId, "boleto");
    await processIssuance(db, gerA, A, NOW);
    const c1 = await chargeOf(cli1), c2 = await chargeOf(cli2);
    const r1 = (await reqs()).find((x) => x.chargeId === c1.id)!, r2 = (await reqs()).find((x) => x.chargeId === c2.id)!;
    await expect(syncBoletoStatus(db, asstA, A)).rejects.toThrow(); // assistente não roda
    const calls0 = cora.calls.length;
    expect(await syncBoletoStatus(db, gerA, A, NOW)).toMatchObject({ checked: 2, paid: 0, cancelled: 0, failed: 0, skipped: null }); // tudo OPEN: nada muda
    expect((await reqs()).every((x) => x.status === "emitido" && x.externalStatus === "emitido")).toBe(true);
    expect(cora.calls.slice(calls0).every((c) => c.method === "GET" || c.path === "/token")).toBe(true); // SÓ consulta
    cora.inv.get(r1.externalRef!)!.status = "PAID"; // pago na Cora
    cora.inv.get(r2.externalRef!)!.status = "CANCELLED"; // cancelado por fora
    expect(await syncBoletoStatus(db, gerA, A, new Date(NOW.getTime() + 60_000))).toMatchObject({ checked: 2, paid: 1, cancelled: 1, failed: 0 });
    const a = (await reqs()).find((x) => x.id === r1.id)!, b = (await reqs()).find((x) => x.id === r2.id)!;
    expect(a).toMatchObject({ status: "emitido", externalStatus: "pago" });
    expect(b).toMatchObject({ status: "cancelado", externalStatus: "cancelado" });
    expect(await n("payments")).toBe(0); // NÃO cria baixa: isso é conferência humana
    expect(await n("audit_log where action = 'boleto.paid_at_provider'")).toBe(1);
    expect(await n("audit_log where action = 'boleto.cancelled_at_provider'")).toBe(1);
    // repetir não reprocessa o pago nem o cancelado
    expect(await syncBoletoStatus(db, gerA, A, new Date(NOW.getTime() + 120_000))).toMatchObject({ checked: 0, paid: 0, cancelled: 0 });
    // cobrança sem boleto ativo pode ganhar outro (chave de nova geração)
    await requestBatchIssuance(db, gerA, A, batchId, "boleto");
    await processIssuance(db, gerA, A, new Date(NOW.getTime() + 3 * 60_000));
    const again = (await reqs()).find((x) => x.chargeId === c2.id && x.status === "emitido")!;
    expect(again.idempotencyKey).toBe(`boleto:${c2.id}:g1`);
    expect(cora.calls.every((c) => c.host === CORA_HOSTS.homologacao)).toBe(true);
  });

  it("ATUALIZAR SITUAÇÃO não grava por cima de um cancelamento em andamento do mesmo boleto (corrida sync × cancelar)", async () => {
    const batchId = await approvedBatch(); await useCora();
    await requestBatchIssuance(db, gerA, A, batchId, "boleto");
    await processIssuance(db, gerA, A, NOW);
    const c1 = await chargeOf(cli1);
    const r1 = (await reqs()).find((x) => x.chargeId === c1.id)!;
    cora.inv.get(r1.externalRef!)!.status = "CANCELLED"; // a Cora já mostra cancelado...
    await db.insert(schema.boletoCancellations).values({ companyId: A, chargeId: c1.id, requestId: r1.id, externalRef: r1.externalRef!, mode: "cora_homologacao", reason: "em andamento", requestedBy: dirA, status: "enviando" }); // ...mas o cancelamento da plataforma ainda está em curso
    const o = await syncBoletoStatus(db, gerA, A, NOW);
    expect(o.cancelled).toBe(0);
    expect((await reqs()).find((x) => x.id === r1.id)!).toMatchObject({ status: "emitido" }); // não mexeu: quem decide é o cancelamento
    await db.execute(sql`update boleto_cancellations set status = 'cancelado', resolved_at = now()`); // terminou
    await db.update(schema.issuanceRequests).set({ status: "cancelado", externalStatus: "cancelado" }).where(eq(schema.issuanceRequests.id, r1.id));
    expect(await syncBoletoStatus(db, gerA, A, new Date(NOW.getTime() + 60_000))).toMatchObject({ cancelled: 0 }); // nada a fazer
  });

  it("ATUALIZAR SITUAÇÃO com a chave do servidor desligada: não consulta nem altera nada (falha fechada, com aviso)", async () => {
    const batchId = await approvedBatch(); await useCora();
    await requestBatchIssuance(db, gerA, A, batchId, "boleto");
    await processIssuance(db, gerA, A, NOW);
    delete process.env.CORA_STAGE_ENABLED;
    const calls0 = cora.calls.length;
    const o = await syncBoletoStatus(db, gerA, A, NOW);
    expect(o.checked).toBe(0); expect(o.skipped).toMatch(/desligada/);
    expect(cora.calls.length).toBe(calls0);
  });

  it("boleto simulado antigo NÃO vai para a Cora: troca de provedor depois não muda o modo das linhas já emitidas", async () => {
    const batchId = await approvedBatch();
    await saveIssuanceSettings(db, dirA, A, { paused: false, dailyLimit: 20 });
    await requestBatchIssuance(db, gerA, A, batchId, "boleto");
    await processIssuance(db, gerA, A, NOW); // simulado
    expect((await reqs()).every((x) => x.mode === "simulado" && x.status === "emitido")).toBe(true);
    await useCora(); // troca (nada em andamento)
    const c1 = await chargeOf(cli1);
    expect(await cancelBoleto(db, dirA, A, { chargeId: c1.id, reason: "teste misto", confirm: true })).toMatchObject({ status: "cancelado" }); // pelo provedor SIMULADO que emitiu
    expect(cora.calls).toHaveLength(0);
    expect((await db.select().from(schema.boletoCancellations))[0].mode).toBe("simulado");
  });

  it("banco protege o boleto real: solicitação da Cora não é apagada (nem em cascata), não troca de modo, e o modo 'cora_producao' não existe", async () => {
    const batchId = await approvedBatch(); await useCora();
    await requestBatchIssuance(db, gerA, A, batchId, "boleto");
    await processIssuance(db, gerA, A, NOW);
    const c1 = await chargeOf(cli1);
    await refused(db.execute(sql`delete from issuance_requests where charge_id = ${c1.id}`), /issuance_live_protected/);
    await refused(db.execute(sql`delete from charges where id = ${c1.id}`), /issuance_live_protected/); // cascata também recusa
    await refused(db.execute(sql`update issuance_requests set mode = 'simulado' where charge_id = ${c1.id}`), /issuance_live_protected/);
    await refused(db.execute(sql`update issuance_requests set mode = 'cora_producao' where charge_id = ${c1.id}`), /issuance_requests_mode_chk|issuance_live_protected/);
    await refused(db.execute(sql`update issuance_settings set boleto_provider = 'cora_producao'`), /issuance_settings_provider_chk/);
    expect(await n("issuance_requests where mode = 'cora_homologacao'")).toBe(2);
  });
});
