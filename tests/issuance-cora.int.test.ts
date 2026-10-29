import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { boletoView } from "@/modules/issuance/boleto-details";
import { registerPayment, reversePayment } from "@/modules/receivables/service";
import { MAX_EVENT_ATTEMPTS, disableCoraWebhook, enableCoraWebhook, processWebhookEvents, receiveCoraWebhook, webhookStatus } from "@/modules/issuance/webhooks";
import { createHash } from "node:crypto";
import { ensureDefaultTemplates, listQueue, processQueue, scheduleQueue } from "@/modules/messaging/service";
import { __setPdfFetcherForTests } from "@/modules/messaging/boleto-mail";
import { saveEmailAccount } from "@/modules/providers/email-config";
import { authorizeEmailLive } from "@/modules/providers/email-auth";
import { LiveNotAvailable, __setCoraTransportForTests } from "@/modules/providers/registry";
import { saveCoraCredentials } from "@/modules/providers/cora-config";
import { CORA_HOSTS, CoraNetworkError, type Transport } from "@/modules/providers/cora-http";
import { uuidFromKey } from "@/modules/providers/cora-boleto";
import { TEST_CERT, TEST_KEY } from "./fixtures/cora-teste";

const enabled = !!process.env.POSTGRES_USER;
const CNPJ1 = "11.222.333/0001-81", CNPJ2 = "12.ABC.345/01DE-35";
const D = "2026-10-01"; // competência 2026-09, vencimento 2026-10-14
const terms = (o: Record<string, unknown> = {}) => ({ description: "Monitoramento de redes", monthlyAmount: "2.500,00", startAt: "2026-01-01", endAt: "", dueDay: "14", invoiceJointRequired: false, issueDayOverride: "", ...o });

type Inv = { id: string; status: string; code: string; amount: number; due: string; doc: string; name: string; description: string; idem: string; forms?: string[] };
/** "Cora" falsa com estado: token, emissão idempotente por Idempotency-Key, listagem por CPF/CNPJ + vencimento, detalhe e cancelamento. Só imita o formato real da API. */
function fakeCora() {
  const inv = new Map<string, Inv>(); const byIdem = new Map<string, string>();
  const calls: { host: string; method: string; path: string; headers: Record<string, string>; body?: any }[] = [];
  const hooks = { paidMethod: null as null | string, tokenFail: false, failEndpointAt: 0, getFails: 0, pdfUrl: null as null | ((id: string) => string), paidOn: null as null | string, paidTotal: null as null | number, paidInterest: null as null | number, paidFine: null as null | number, dropAfterCreate: 0, failCreate: null as null | { status: number; body: unknown }, failBeforeCreate: 0, amountOverride: null as null | number, paid: new Set<string>() };
  let seq = 0, epSeq = 0;
  const endpoints = new Map<string, { id: string; url: string; resource: string; trigger: string }>();
  const j = (status: number, body: unknown) => ({ status, body: body === null ? "" : JSON.stringify(body) });
  const full = (i: Inv) => ({ id: i.id, status: i.status, code: i.code, total_amount: hooks.amountOverride ?? i.amount, total_paid: i.status === "PAID" ? (hooks.paidTotal ?? i.amount) : 0, customer: { name: i.name, document: { identity: i.doc, type: i.doc.length === 11 ? "CPF" : "CNPJ" } }, services: [{ name: i.description.slice(0, 100), amount: i.amount }], payment_terms: { due_date: i.due }, payment_options: { bank_slip: { digitable: "00190000090321583700012584580174791420000002000", barcode: "00197914200000020000000003215837001258458017", our_number: "1", registered: true, url: hooks.pdfUrl?.(i.id) ?? `https://pdf.cora.com.br/${i.id}.pdf` } }, pix: (i.forms ?? []).includes("PIX") ? { emv: "00020126580014br.gov.bcb.pix0136" + i.id + "5204000053039865406" + String(i.amount) + "5802BR5909K3G TESTE6004TEST" } : null, occurrence_date: i.status === "PAID" ? (hooks.paidOn ?? "2026-10-20") : undefined, payments: i.status === "PAID" ? [{ id: `pay_${i.id}`, status: "SUCCESS", created_at: "2026-10-20T10:00:00Z", finalized_at: "2026-10-20T10:00:05Z", total_paid: hooks.paidTotal ?? i.amount, method: hooks.paidMethod ?? "BANK_SLIP", order: 1, interest: hooks.paidInterest ?? 0, fine: hooks.paidFine ?? 0 }] : [] });
  const summary = (i: Inv) => ({ id: i.id, status: i.status, total_amount: i.amount, due_date: i.due, customer: { name: i.name } }); // a listagem real NÃO traz `code`
  const transport: Transport = async (o) => {
    const body = o.body && o.headers["content-type"] === "application/json" ? JSON.parse(o.body) : undefined;
    calls.push({ host: o.host, method: o.method, path: o.path, headers: o.headers, body });
    const [path, qs] = o.path.split("?"); const q = new URLSearchParams(qs ?? "");
    if (path === "/endpoints" || path === "/endpoints/") {
      if (o.method === "POST") {
        if (hooks.failEndpointAt && endpoints.size >= hooks.failEndpointAt - 1) return j(400, { code: "invalid_request", message: "bad url" });
        if (!/^https:\/\//.test(body.url) || body.resource !== "invoice") return j(400, { code: "invalid_request" });
        const e = { id: `ep_fake${++epSeq}`, url: body.url, resource: body.resource, trigger: body.trigger }; endpoints.set(e.id, e); return j(200, { ...e, connectionTimeout: 1000, readTimeout: 2000, includeResource: false, expandable: false, active: true });
      }
      if (o.method === "GET") return j(200, [...endpoints.values()].map((e) => ({ ...e, active: true })));
    }
    const em = /^\/endpoints\/(ep_\w+)$/.exec(path);
    if (em && o.method === "DELETE") { if (!endpoints.delete(em[1])) return j(422, { code: "invalid" }); return j(204, null); }
    if (hooks.getFails > 0 && o.method === "GET" && /^\/v2\/invoices\/inv_/.test(path)) { hooks.getFails--; return j(429, { code: "rate_limit" }); }
    if (path === "/token" && hooks.tokenFail) return j(401, { error: "access_denied" });
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
        inv.set(id, { id, status: "OPEN", code: body.code, amount: body.services[0].amount, due: body.payment_terms.due_date, doc: body.customer.document.identity, name: body.customer.name, description: body.services[0].description, idem, forms: body.payment_forms });
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
  return { transport, inv, endpoints, calls, hooks, posts: () => calls.filter((c) => c.method === "POST" && c.path === "/v2/invoices") };
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
  afterAll(async () => { __setCoraTransportForTests(undefined); __setPdfFetcherForTests(undefined); await conn?.end(); await admin?.end(); });
  afterEach(() => { vi.useRealTimers(); delete process.env.CORA_STAGE_ENABLED; delete process.env.CORA_LIVE_ENABLED; delete process.env.CORA_PROD_EMISSION_ENABLED; });

  beforeEach(async () => {
    await db.execute(sql`truncate email_send_log, email_live_authorizations, email_accounts, boleto_cancel_requests, boleto_cancellations, provider_credentials, issuance_requests, issuance_settings, bank_transaction_marks, bank_allocations, bank_transactions, bank_import_rows, bank_import_batches, bank_accounts, payments, messaging_settings, message_queue, message_template_versions, message_templates, charges, billing_batches, holidays, contract_versions, contracts, integration_conflicts, integration_sync_runs, integration_connections, rate_limits, customer_contacts, vendor_contacts, customers, vendors, audit_log, invitations, memberships, companies, users restart identity cascade`);
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
    await expect(saveIssuanceSettings(db, dirA, A, { paused: false, dailyLimit: 20, boletoProvider: "cora_inexistente" })).rejects.toThrow(Invalid); // modo desconhecido
    await expect(saveIssuanceSettings(db, dirA, A, { paused: false, dailyLimit: 20, boletoProvider: "cora_producao", liveConfirm: "EMITIR BOLETOS REAIS" })).rejects.toThrow(LiveNotAvailable); // produção desligada no servidor (CORA_PROD_EMISSION_ENABLED)
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
    expect(p1.body).toMatchObject({ customer: { name: "Cliente Um", document: { identity: "11222333000181", type: "CNPJ" } }, services: [{ amount: 250000 }], payment_terms: { due_date: "2026-10-14" }, payment_forms: ["BANK_SLIP", "PIX"] }); // boleto + QR Code Pix
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

  it("DADOS DO BOLETO (E10b-3): consulta ao vivo na Cora, só https no PDF, nada guardado; simulado não tem dado real; sem permissão não consulta", async () => {
    const batchId = await approvedBatch(); await useCora();
    await requestBatchIssuance(db, gerA, A, batchId, "boleto");
    await processIssuance(db, gerA, A, NOW);
    const c1 = await chargeOf(cli1);
    const v = await boletoView(db, gerA, A, c1.id);
    expect(v).toMatchObject({ kind: "ok", mode: "cora_homologacao", details: { rawStatus: "OPEN", totalAmountCents: 250000, totalPaidCents: 0, payments: [] } });
    if (v.kind === "ok") { expect(v.details.pixEmv).toMatch(/^00020126/); }
    if (v.kind === "ok") { expect(v.details.digitable).toMatch(/^\d{40,50}$/); expect(v.details.pdfUrl).toMatch(/^https:\/\/pdf\.cora\.com\.br\//); }
    cora.hooks.pdfUrl = () => "javascript:alert(1)"; // esquema perigoso vindo da resposta externa: nunca devolvido
    const v2 = await boletoView(db, gerA, A, c1.id);
    expect(v2.kind === "ok" && v2.details.pdfUrl).toBeNull();
    cora.hooks.pdfUrl = () => "https://storage.googleapis.com/download/storage/v1/b/outro-bucket/o/x.pdf?alt=media"; // mesmo host do Google, mas OUTRO bucket: não
    const v2b = await boletoView(db, gerA, A, c1.id);
    expect(v2b.kind === "ok" && v2b.details.pdfUrl).toBeNull();
    cora.hooks.pdfUrl = () => "https://storage.googleapis.com/download/storage/v1/b/cora_production_exporter_bankslip_storage/o/inv_x.pdf?generation=1&alt=media"; // o formato REAL observado: aceito
    const v2c = await boletoView(db, gerA, A, c1.id);
    expect(v2c.kind === "ok" && v2c.details.pdfUrl).toMatch(/cora_production_exporter_bankslip_storage/);
    cora.hooks.pdfUrl = () => "https://evil.example.com/boleto.pdf"; // https, mas de outro domínio: também não
    const v3 = await boletoView(db, gerA, A, c1.id);
    expect(v3.kind === "ok" && v3.details.pdfUrl).toBeNull();
    const outsider = (await db.insert(schema.users).values({ email: "fora@t.com", name: "fora", passwordHash: "x" }).returning())[0].id;
    await expect(boletoView(db, outsider, A, c1.id)).rejects.toThrow(); // sem papel na empresa: recusado
    expect(await n("audit_log where detail::text like '%00190000090321583700%'")).toBe(0); // linha digitável não vai para a auditoria
    delete process.env.CORA_STAGE_ENABLED;
    expect(await boletoView(db, gerA, A, c1.id)).toMatchObject({ kind: "indisponivel" }); // chave desligada: falha fechada
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

  it("BAIXA AUTOMÁTICA (E10b-4): só com a opção ligada e tudo conferindo; idempotente; juros/multa viram acréscimo; valor diferente vai para conferência; já baixada não duplica", async () => {
    const batchId = await approvedBatch(); await useCora();
    await expect(saveIssuanceSettings(db, gerA, A, { paused: false, dailyLimit: 20, autoSettle: true })).rejects.toThrow(); // só diretoria
    await requestBatchIssuance(db, gerA, A, batchId, "boleto");
    await processIssuance(db, gerA, A, NOW);
    const c1 = await chargeOf(cli1), c2 = await chargeOf(cli2);
    const r1 = (await reqs()).find((x) => x.chargeId === c1.id)!, r2 = (await reqs()).find((x) => x.chargeId === c2.id)!;
    // 1) desligada: pago só marca (já coberto em outro teste); ligar e repetir
    await saveIssuanceSettings(db, dirA, A, { paused: false, dailyLimit: 20, autoSettle: true });
    expect((await saveIssuanceSettings(db, dirA, A, { paused: false, dailyLimit: 20 }), (await db.select().from(schema.issuanceSettings))[0].autoSettle)).toBe(true); // omitido mantém
    // 2) cliente 1 pagou com juros/multa: pago 2.520,00 = principal 2.500,00 + 20,00 de encargos
    cora.inv.get(r1.externalRef!)!.status = "PAID"; cora.hooks.paidTotal = 252000; cora.hooks.paidFine = 1500; cora.hooks.paidInterest = 500; cora.hooks.paidOn = "2026-10-20";
    const o1 = await syncBoletoStatus(db, gerA, A, NOW);
    expect(o1).toMatchObject({ checked: 2, paid: 1, settled: 1, needsReview: 0 });
    const p1 = await db.select().from(schema.payments).where(eq(schema.payments.chargeId, c1.id));
    expect(p1).toHaveLength(1);
    expect(p1[0]).toMatchObject({ amount: "2500.00", interestAmount: "20.00", discountAmount: "0.00", paidAt: "2026-10-20", method: "boleto", status: "ativo" });
    const sys = (await db.select().from(schema.users).where(eq(schema.users.email, "sistema-cora@k3g.invalid")))[0];
    expect(sys.disabledAt).not.toBeNull(); expect(p1[0].registeredBy).toBe(sys.id); // usuário de sistema, sem login
    expect((await reqs()).find((x) => x.id === r1.id)).toMatchObject({ externalStatus: "pago" });
    expect((await reqs()).find((x) => x.id === r1.id)!.settledAt).not.toBeNull();
    // repetir: nada novo (nem pagamento duplicado)
    expect(await syncBoletoStatus(db, gerA, A, new Date(NOW.getTime() + 60_000))).toMatchObject({ settled: 0, paid: 0 });
    expect(await db.select().from(schema.payments).where(eq(schema.payments.chargeId, c1.id))).toHaveLength(1);
    // 3) cliente 2 pagou valor DIFERENTE do saldo (2.490,00): não baixa; fica para conferência manual
    cora.hooks.paidTotal = 249000; cora.hooks.paidFine = 0; cora.hooks.paidInterest = 0;
    cora.inv.get(r2.externalRef!)!.status = "PAID";
    const o2 = await syncBoletoStatus(db, gerA, A, new Date(NOW.getTime() + 120_000));
    expect(o2).toMatchObject({ paid: 1, settled: 0, needsReview: 1 });
    expect(await db.select().from(schema.payments).where(eq(schema.payments.chargeId, c2.id))).toHaveLength(0);
    expect((await reqs()).find((x) => x.id === r2.id)).toMatchObject({ externalStatus: "pago", settledAt: null });
    expect(await n("audit_log where action = 'boleto.settle_review'")).toBe(1);
    // 4) a diretoria dá a baixa manual; a próxima rodada vê "já baixada" e NÃO duplica
    await registerPayment(db, dirA, A, c2.id, { amount: "2.500,00", method: "pix", paidAt: "2026-10-21" });
    cora.hooks.paidTotal = 250000;
    expect(await syncBoletoStatus(db, gerA, A, new Date(NOW.getTime() + 180_000))).toMatchObject({ settled: 0 });
    expect(await db.select().from(schema.payments).where(eq(schema.payments.chargeId, c2.id))).toHaveLength(1);
    expect((await reqs()).find((x) => x.id === r2.id)!.settledAt).not.toBeNull();
    // nada de rotas de pagamento na Cora
    expect(cora.calls.every((c) => c.method === "GET" || c.path === "/token" || c.path === "/v2/invoices")).toBe(true);
  });

  it("BAIXA AUTOMÁTICA: pagamento por PIX (QR Code do boleto) é lançado com a forma 'pix'; por boleto, 'boleto'", async () => {
    const batchId = await approvedBatch(); await useCora();
    await saveIssuanceSettings(db, dirA, A, { paused: false, dailyLimit: 20, autoSettle: true });
    await requestBatchIssuance(db, gerA, A, batchId, "boleto");
    await processIssuance(db, gerA, A, NOW);
    const c1 = await chargeOf(cli1), c2 = await chargeOf(cli2);
    const r1 = (await reqs()).find((x) => x.chargeId === c1.id)!, r2 = (await reqs()).find((x) => x.chargeId === c2.id)!;
    cora.hooks.paidOn = "2026-10-20";
    cora.inv.get(r1.externalRef!)!.status = "PAID"; cora.hooks.paidMethod = "PIX";
    await syncBoletoStatus(db, gerA, A, new Date(NOW.getTime() + 60_000));
    cora.inv.get(r2.externalRef!)!.status = "PAID"; cora.hooks.paidMethod = "BANK_SLIP";
    await syncBoletoStatus(db, gerA, A, new Date(NOW.getTime() + 120_000));
    expect((await db.select().from(schema.payments).where(eq(schema.payments.chargeId, c1.id)))[0].method).toBe("pix");
    expect((await db.select().from(schema.payments).where(eq(schema.payments.chargeId, c2.id)))[0].method).toBe("boleto");
  });

  it("BAIXA AUTOMÁTICA: sem pagamento concluído, soma diferente do total ou desligada, nunca baixa; no simulado a opção é recusada", async () => {
    const batchId = await approvedBatch(); await useCora();
    await requestBatchIssuance(db, gerA, A, batchId, "boleto");
    await processIssuance(db, gerA, A, NOW);
    const c1 = await chargeOf(cli1); const r1 = (await reqs()).find((x) => x.chargeId === c1.id)!;
    // desligada (padrão): pago não gera pagamento
    cora.inv.get(r1.externalRef!)!.status = "PAID";
    expect(await syncBoletoStatus(db, gerA, A, NOW)).toMatchObject({ paid: 1, settled: 0 });
    expect(await n("payments")).toBe(0);
    // ligada, mas a Cora mostra pago SEM pagamento concluído (total_paid ≠ soma): conferência
    await saveIssuanceSettings(db, dirA, A, { paused: false, dailyLimit: 20, autoSettle: true });
    cora.hooks.paidTotal = 100;
    const inv = cora.inv.get(r1.externalRef!)!; inv.status = "PAID";
    expect(await syncBoletoStatus(db, gerA, A, new Date(NOW.getTime() + 60_000))).toMatchObject({ settled: 0, needsReview: 1 });
    expect(await n("payments")).toBe(0);
    // trocar para simulado com a opção ligada é recusado
    await db.update(schema.issuanceRequests).set({ status: "cancelado" }).where(eq(schema.issuanceRequests.id, r1.id)).catch(() => undefined);
    await expect(saveIssuanceSettings(db, dirA, A, { paused: false, dailyLimit: 20, boletoProvider: "simulado", autoSettle: true })).rejects.toThrow(Invalid);
  });

  it("BAIXA AUTOMÁTICA: data futura/ausente, valor do boleto ≠ cobrança e baixa já estornada vão para conferência; nunca ajusta data nem refaz baixa estornada", async () => {
    const batchId = await approvedBatch(); await useCora();
    await saveIssuanceSettings(db, dirA, A, { paused: false, dailyLimit: 20, autoSettle: true });
    await requestBatchIssuance(db, gerA, A, batchId, "boleto");
    await processIssuance(db, gerA, A, NOW);
    const c1 = await chargeOf(cli1), c2 = await chargeOf(cli2);
    const r1 = (await reqs()).find((x) => x.chargeId === c1.id)!, r2 = (await reqs()).find((x) => x.chargeId === c2.id)!;
    const at = (m: number) => new Date(NOW.getTime() + m * 60_000);
    // data futura: conferência (não vira "hoje")
    cora.inv.get(r1.externalRef!)!.status = "PAID"; cora.hooks.paidOn = "2999-01-01";
    expect(await syncBoletoStatus(db, gerA, A, at(1))).toMatchObject({ settled: 0, needsReview: 1 });
    expect(await n("payments")).toBe(0);
    // data válida: baixa; depois a diretoria ESTORNA e a rodada seguinte NÃO refaz sozinha
    cora.hooks.paidOn = "2026-10-20";
    expect(await syncBoletoStatus(db, gerA, A, at(2))).toMatchObject({ settled: 1 });
    const pay = (await db.select().from(schema.payments).where(eq(schema.payments.chargeId, c1.id)))[0];
    await reversePayment(db, dirA, A, pay.id, "estorno de teste");
    await db.execute(sql`update issuance_requests set settled_at = null where id = ${r1.id}`); // como se a baixa ainda não tivesse sido conferida
    expect(await syncBoletoStatus(db, gerA, A, at(3))).toMatchObject({ settled: 0, needsReview: 1 });
    expect(await db.select().from(schema.payments).where(eq(schema.payments.chargeId, c1.id))).toHaveLength(1); // só o estornado
    expect((await reqs()).find((x) => x.id === r1.id)!.settledAt).toBeNull();
    // boleto com valor diferente do da cobrança (alguém mexeu na Cora): conferência
    cora.hooks.amountOverride = 199900; cora.inv.get(r2.externalRef!)!.status = "PAID"; cora.hooks.paidTotal = 199900;
    expect(await syncBoletoStatus(db, gerA, A, at(4))).toMatchObject({ settled: 0 });
    expect(await db.select().from(schema.payments).where(eq(schema.payments.chargeId, c2.id))).toHaveLength(0);
    expect((await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "boleto.settle_review"))).map((a) => (a.detail as { reason: string }).reason).sort())
      .toEqual(["baixa_anterior_estornada", "data_do_pagamento_ausente_ou_futura", "valor_do_boleto_diferente_da_cobranca", "valor_do_boleto_diferente_da_cobranca"]); // um por boleto e motivo
    await syncBoletoStatus(db, gerA, A, at(5)); await syncBoletoStatus(db, gerA, A, at(6)); // repetir a conferência NÃO repete o registro de auditoria (sem ruído a cada 10 min)
    expect(await n("audit_log where action = 'boleto.settle_review'")).toBe(4);
  });

  it("WEBHOOK: aviso repetido (com ou sem id) e chamadas simultâneas geram um evento só", async () => {
    stageOn(); await creds();
    await enableCoraWebhook(db, dirA, A, "homologacao", "https://app.exemplo.com.br", cora.transport);
    const secret = /([A-Za-z0-9_-]{43})$/.exec([...cora.endpoints.values()][0].url)![1];
    const h = { type: "invoice.paid", resourceId: "inv_abcdefg1" };
    await Promise.all([1, 2, 3, 4, 5].map(() => receiveCoraWebhook(db, secret, { ...h, eventId: "ev-sim" })));
    await Promise.all([1, 2, 3, 4, 5].map(() => receiveCoraWebhook(db, secret, { ...h, eventId: null }))); // mesmo boleto/tipo já pendente: não duplica
    await Promise.all([1, 2, 3, 4, 5].map(() => receiveCoraWebhook(db, secret, { type: "invoice.canceled", resourceId: "inv_abcdefg2", eventId: null }))); // outro boleto, sem id: um só
    expect(await n("cora_webhook_events where event_id = 'ev-sim'")).toBe(1);
    expect(await n("cora_webhook_events where event_id is null")).toBe(1);
    expect(await n("cora_webhook_events")).toBe(2);
    // retenção: processado antigo é apagado
    await db.execute(sql`update cora_webhook_events set status = 'processado', processed_at = now() - interval '40 days'`);
    await processWebhookEvents(db, new Date());
    expect(await n("cora_webhook_events")).toBe(0);
  });

  it("WEBHOOK (E10b-5): ativar cadastra 2 avisos na Cora, guarda só o HASH do segredo, gira o segredo removendo os antigos, desativar remove; só diretoria; só https; só homologação por ora", async () => {
    stageOn(); await creds();
    await expect(enableCoraWebhook(db, gerA, A, "homologacao", "https://app.exemplo.com.br", cora.transport)).rejects.toThrow(); // só quem gerencia credenciais
    await expect(enableCoraWebhook(db, dirA, A, "homologacao", "http://inseguro.exemplo.com", cora.transport)).rejects.toThrow(Invalid);
    for (const bad of ["https://app.exemplo.com.br:8443", "https://app.exemplo.com.br/caminho", "https://user:pw@app.exemplo.com.br", "https://localhost", "https://exemplo..com"]) await expect(enableCoraWebhook(db, dirA, A, "homologacao", bad, cora.transport)).rejects.toThrow(Invalid);
    await expect(enableCoraWebhook(db, dirA, A, "producao", "https://app.exemplo.com.br", cora.transport)).rejects.toThrow(Invalid); // produção só na fase própria
    await expect(enableCoraWebhook(db, dirA, A, "homologacao", "https://app.exemplo.com.br", cora.transport)).resolves.toEqual({ triggers: 2 });
    const eps = [...cora.endpoints.values()];
    expect(eps.map((e) => e.trigger).sort()).toEqual(["canceled", "paid"]);
    const secret1 = /\/api\/v1\/webhooks\/cora\/([A-Za-z0-9_-]{43})$/.exec(eps[0].url)![1];
    const row = (await db.select().from(schema.coraWebhooks))[0];
    expect(row.secretHash).toBe(createHash("sha256").update(secret1).digest("hex")); // só o hash
    expect(JSON.stringify(row)).not.toContain(secret1);
    expect(await n("audit_log where detail::text like '%" + secret1 + "%'")).toBe(0);
    expect(await webhookStatus(db, dirA, A)).toEqual(expect.arrayContaining([expect.objectContaining({ environment: "homologacao", active: true, triggers: 2 }), expect.objectContaining({ environment: "producao", active: false })]));
    // girar: antigos removidos na Cora, segredo antigo deixa de valer
    await enableCoraWebhook(db, dirA, A, "homologacao", "https://app.exemplo.com.br", cora.transport);
    expect(cora.endpoints.size).toBe(2);
    expect([...cora.endpoints.values()].every((e) => !e.url.endsWith(secret1))).toBe(true);
    expect((await receiveCoraWebhook(db, secret1, { type: "invoice.paid", resourceId: "inv_abcdefg1", eventId: null })).status).toBe(404);
    // falha no meio do cadastro: desfaz o que criou e não ativa nada novo
    await disableCoraWebhook(db, dirA, A, "homologacao", cora.transport);
    expect(cora.endpoints.size).toBe(0); expect(await n("cora_webhooks")).toBe(0);
    cora.hooks.failEndpointAt = 2;
    await expect(enableCoraWebhook(db, dirA, A, "homologacao", "https://app.exemplo.com.br", cora.transport)).rejects.toThrow(Invalid);
    expect(cora.endpoints.size).toBe(0); expect(await n("cora_webhooks")).toBe(0);
  });

  it("WEBHOOK: receptor valida segredo e formato, grava evento pendente sem confiar em nada, ignora duplicado/outros tipos e limita a frequência", async () => {
    stageOn(); await creds();
    await enableCoraWebhook(db, dirA, A, "homologacao", "https://app.exemplo.com.br", cora.transport);
    const secret = /([A-Za-z0-9_-]{43})$/.exec([...cora.endpoints.values()][0].url)![1];
    expect((await receiveCoraWebhook(db, "curto", { type: "invoice.paid", resourceId: "inv_abcdefg1", eventId: null })).status).toBe(404);
    expect((await receiveCoraWebhook(db, "x".repeat(43), { type: "invoice.paid", resourceId: "inv_abcdefg1", eventId: null })).status).toBe(404);
    expect(await n("cora_webhook_events")).toBe(0);
    expect((await receiveCoraWebhook(db, secret, { type: "invoice.paid", resourceId: "inv_abcdefg1", eventId: "ev-1" })).status).toBe(200);
    expect((await receiveCoraWebhook(db, secret, { type: "invoice.paid", resourceId: "inv_abcdefg1", eventId: "ev-1" })).status).toBe(200); // reenvio: um evento só
    expect((await receiveCoraWebhook(db, secret, { type: "invoice.CANCELED", resourceId: "inv_abcdefg9", eventId: "ev-up" })).status).toBe(200); // a Cora manda o gatilho em MAIÚSCULAS: normalizado
    expect((await receiveCoraWebhook(db, secret, { type: "transfer.completed", resourceId: "inv_abcdefg1", eventId: null })).status).toBe(200); // outro recurso: aceito e ignorado
    expect((await receiveCoraWebhook(db, secret, { type: "invoice.paid", resourceId: "'; drop table x;--", eventId: null })).status).toBe(200); // formato inválido: ignorado
    expect((await receiveCoraWebhook(db, secret, { type: null, resourceId: null, eventId: null })).status).toBe(200);
    expect(await n("cora_webhook_events")).toBe(2);
    expect((await db.select().from(schema.coraWebhookEvents).where(eq(schema.coraWebhookEvents.resourceId, "inv_abcdefg1")))[0]).toMatchObject({ status: "pendente", eventType: "invoice.paid", environment: "homologacao" });
    expect((await db.select().from(schema.coraWebhookEvents).where(eq(schema.coraWebhookEvents.resourceId, "inv_abcdefg9")))[0].eventType).toBe("invoice.canceled");
    const t0 = new Date();
    let last = 200;
    for (let i = 0; i < 610; i++) last = (await receiveCoraWebhook(db, secret, { type: "invoice.paid", resourceId: "inv_abcdefg1", eventId: null }, t0)).status;
    expect(last).toBe(429);
  });

  it("WEBHOOK: o aviso só dispara a RECONSULTA — pago na Cora baixa (com a opção ligada); aviso falso/de boleto desconhecido é ignorado; falha da Cora repete até o limite", async () => {
    const batchId = await approvedBatch(); await useCora();
    await saveIssuanceSettings(db, dirA, A, { paused: false, dailyLimit: 20, autoSettle: true });
    await enableCoraWebhook(db, dirA, A, "homologacao", "https://app.exemplo.com.br", cora.transport);
    const secret = /([A-Za-z0-9_-]{43})$/.exec([...cora.endpoints.values()][0].url)![1];
    await requestBatchIssuance(db, gerA, A, batchId, "boleto");
    await processIssuance(db, gerA, A, NOW);
    const c1 = await chargeOf(cli1), c2 = await chargeOf(cli2);
    const r1 = (await reqs()).find((x) => x.chargeId === c1.id)!, r2 = (await reqs()).find((x) => x.chargeId === c2.id)!;
    // aviso FALSO de pagamento (Cora ainda mostra OPEN): reconsulta, nada muda
    await receiveCoraWebhook(db, secret, { type: "invoice.paid", resourceId: r2.externalRef!, eventId: null });
    expect(await processWebhookEvents(db, NOW)).toMatchObject({ processed: 1, errors: 0 });
    expect(await n("payments")).toBe(0);
    expect((await db.select().from(schema.coraWebhookEvents))[0]).toMatchObject({ status: "processado", outcome: "sem_mudanca" });
    // aviso de boleto que não é nosso: ignorado
    await receiveCoraWebhook(db, secret, { type: "invoice.paid", resourceId: "inv_naoexiste1", eventId: null });
    expect(await processWebhookEvents(db, NOW)).toMatchObject({ processed: 0, ignored: 1 });
    // pago de verdade na Cora + aviso: baixa automática
    cora.inv.get(r1.externalRef!)!.status = "PAID"; cora.hooks.paidOn = "2026-10-22";
    await receiveCoraWebhook(db, secret, { type: "invoice.paid", resourceId: r1.externalRef!, eventId: "ev-pago" });
    expect(await processWebhookEvents(db, NOW)).toMatchObject({ processed: 1 });
    expect((await db.select().from(schema.payments).where(eq(schema.payments.chargeId, c1.id)))[0]).toMatchObject({ amount: "2500.00", paidAt: "2026-10-22", method: "boleto" });
    expect(await n("cora_webhook_events where outcome = 'baixado'")).toBe(1);
    // a Cora limita a consulta: evento volta para a fila; após o limite de tentativas vira erro
    cora.inv.get(r2.externalRef!)!.status = "CANCELLED";
    await receiveCoraWebhook(db, secret, { type: "invoice.canceled", resourceId: r2.externalRef!, eventId: "ev-canc" });
    cora.hooks.getFails = 100;
    for (let i = 1; i < MAX_EVENT_ATTEMPTS; i++) { expect(await processWebhookEvents(db, NOW)).toMatchObject({ errors: 1 }); expect((await db.select().from(schema.coraWebhookEvents).where(eq(schema.coraWebhookEvents.eventId, "ev-canc")))[0].status).toBe("pendente"); }
    expect(await processWebhookEvents(db, NOW)).toMatchObject({ errors: 1 });
    expect((await db.select().from(schema.coraWebhookEvents).where(eq(schema.coraWebhookEvents.eventId, "ev-canc")))[0]).toMatchObject({ status: "erro", attempts: MAX_EVENT_ATTEMPTS });
    expect(cora.calls.every((c) => c.host === CORA_HOSTS.homologacao)).toBe(true);
  });

  // ───────── E10b-6 — emissão em PRODUÇÃO (boletos reais). Tudo contra a Cora falsa; relógio fixado para a regra de vencimento. ─────────
  const prodOn = () => { process.env.CORA_PROD_EMISSION_ENABLED = "true"; };
  const credsProd = () => saveCoraCredentials(db, dirA, A, { environment: "producao", label: "Prod", clientId: "int-cliente-prod-123", certificate: TEST_CERT, privateKey: TEST_KEY });
  const PHRASE = "EMITIR BOLETOS REAIS";
  const arm = (extra: Record<string, unknown> = {}) => saveIssuanceSettings(db, dirA, A, { paused: false, dailyLimit: 20, boletoProvider: "cora_producao", liveConfirm: PHRASE, ...extra });
  const clock = (iso: string) => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(iso)); };
  const REAL = Date.now(); // o relógio do banco é o real; só o JavaScript (regra de vencimento) usa o relógio fixado
  const PN = (hours = 0) => new Date(REAL + 5 * 60_000 + hours * 3600_000);

  it("PRODUÇÃO — ARMAR: exige a chave do servidor, credencial de produção, confirmação digitada, acesso que autentica e diretoria; entra em canário; banco guarda quem autorizou", async () => {
    const batchId = await approvedBatch();
    await expect(arm()).rejects.toThrow(LiveNotAvailable); // chave do servidor desligada
    prodOn();
    await expect(arm()).rejects.toThrow(/Credenciais da Cora de produção/); // sem credencial
    await credsProd();
    clock("2026-10-05T12:00:00-04:00"); // (o certificado de teste só vale a partir de hoje: a credencial é gravada antes de fixar o relógio)
    await expect(saveIssuanceSettings(db, gerA, A, { paused: false, dailyLimit: 20, boletoProvider: "cora_producao", liveConfirm: PHRASE })).rejects.toThrow(); // só diretoria
    await expect(arm({ liveConfirm: "emitir boletos reais" })).rejects.toThrow(Invalid); // frase exata
    await expect(arm({ liveConfirm: "" })).rejects.toThrow(Invalid);
    cora.hooks.tokenFail = true;
    await expect(arm()).rejects.toThrow(/recusou o acesso de produção/); // a credencial não autentica: nada ligado
    expect((await db.select().from(schema.issuanceSettings))).toHaveLength(0);
    cora.hooks.tokenFail = false;
    await requestBatchIssuance(db, gerA, A, batchId, "boleto"); // pendentes em andamento: não troca
    await expect(arm()).rejects.toThrow(/boletos em andamento/);
    await db.execute(sql`update issuance_requests set status = 'cancelado'`);
    await arm({ liveCanary: false }); // pedir "sem canário" na entrada é ignorado: entra SEMPRE em canário
    const st = (await db.select().from(schema.issuanceSettings))[0];
    expect(st).toMatchObject({ boletoProvider: "cora_producao", liveCanary: true, liveAuthorizedBy: dirA });
    expect(st.liveAuthorizedAt).not.toBeNull();
    expect(await n("audit_log where action = 'issuance.settings.saved' and detail->>'liveArmed' = 'true'")).toBe(1);
    expect(cora.calls.every((c) => c.method === "GET" || c.path === "/token")).toBe(true); // armar só autenticou: nada criado
    expect(cora.calls.every((c) => c.host === CORA_HOSTS.producao || c.host === CORA_HOSTS.homologacao)).toBe(true);
    // sair do canário exige a frase de novo
    await expect(saveIssuanceSettings(db, dirA, A, { paused: false, dailyLimit: 20, liveCanary: false })).rejects.toThrow(Invalid);
    await saveIssuanceSettings(db, dirA, A, { paused: false, dailyLimit: 20, liveCanary: false, liveConfirm: PHRASE });
    expect((await db.select().from(schema.issuanceSettings))[0].liveCanary).toBe(false);
    // voltar ao simulado apaga a autorização; religar exige tudo de novo
    await saveIssuanceSettings(db, dirA, A, { paused: false, dailyLimit: 20, boletoProvider: "simulado" });
    expect((await db.select().from(schema.issuanceSettings))[0]).toMatchObject({ boletoProvider: "simulado", liveAuthorizedBy: null, liveAuthorizedAt: null });
  });

  it("PRODUÇÃO — EMITIR: sem confirmação a rodada é recusada; com ela emite no host de produção; canário limita a 3 por dia; anti-duplicidade e vencimento/valor protegem", async () => {
    await credsProd(); clock("2026-10-05T12:00:00-04:00");
    const c3 = (await createParty(db, dirA, A, { kind: "cliente", legalName: "Cliente Tres", document: "529.982.247-25" })).id;
    const c4 = (await createParty(db, dirA, A, { kind: "cliente", legalName: "Cliente Quatro", document: "111.444.777-35" })).id;
    for (const c of [cli1, cli2, c3, c4]) await activeContract(c);
    const { batchId } = await generateBatch(db, asstA, A, D);
    await approveBatch(db, dirA, A, batchId, (await getBatch(db, asstA, A, batchId))!.hash);
    prodOn(); await arm();
    await requestBatchIssuance(db, gerA, A, batchId, "boleto");
    await expect(processIssuance(db, gerA, A, PN())).rejects.toThrow(/confirmação explícita/); // sem confirmação: nada
    expect(cora.posts()).toHaveLength(0);
    // um boleto igual JÁ existe na Cora (emitido à mão) para o cliente 1: não emite, falha com código claro
    cora.inv.set("inv_manual000001", { id: "inv_manual000001", status: "OPEN", code: "manual-planilha", amount: 250000, due: "2026-10-14", doc: "11222333000181", name: "Cliente Um", description: "x", idem: "m1" });
    const r1 = await processIssuance(db, gerA, A, PN(), undefined, { confirmLive: true });
    const chargeIds: Record<string, string> = {}; for (const c of [cli1, cli2, c3, c4]) chargeIds[c] = (await chargeOf(c)).id;
    // canário: só 3 reservados no dia (a ordem entre os 4 não importa); o resto espera o dia seguinte
    expect(r1.claimed).toBe(3);
    expect(r1.waiting).toMatch(/canário/);
    expect((await reqs()).filter((r) => r.status === "pendente")).toHaveLength(1);
    expect(cora.calls.filter((c) => c.path !== "/token").every((c) => c.host === CORA_HOSTS.producao)).toBe(true); // só o host de PRODUÇÃO
    expect(cora.posts().every((c) => c.headers["Idempotency-Key"]?.length === 36 && !/payment|pay|transfer/i.test(c.path))).toBe(true);
    // dia seguinte: o canário libera mais 3 (resta 1)
    clock("2026-10-06T12:00:00-04:00");
    const r2 = await processIssuance(db, gerA, A, PN(26), undefined, { confirmLive: true });
    expect(r2.claimed).toBe(1);
    expect((await reqs()).filter((r) => r.status === "pendente")).toHaveLength(0);
    // no fim: o cliente 1 (já tinha boleto igual na Cora, emitido à mão) NÃO foi emitido; os outros 3 sim, todos reais
    const all = await reqs();
    expect(all.find((r) => r.chargeId === chargeIds[cli1])).toMatchObject({ status: "falhou", lastError: "boleto_ja_existe_na_cora", mode: "cora_producao" });
    const emitted = all.filter((r) => r.status === "emitido");
    expect(emitted).toHaveLength(3);
    expect(emitted.every((r) => r.mode === "cora_producao" && /^inv_/.test(r.externalRef ?? ""))).toBe(true);
    expect(cora.posts()).toHaveLength(3); // nenhum POST para o cliente com boleto igual
    expect(cora.posts().every((c) => c.body.customer.document.identity !== "11222333000181")).toBe(true);
  });

  it("LIMITE DIÁRIO conta só o provedor em uso: boletos da Cora de TESTES emitidos hoje não gastam o limite da emissão REAL", async () => {
    await useCora(); // Cora de testes
    const batchId = await approvedBatch();
    await requestBatchIssuance(db, gerA, A, batchId, "boleto");
    await processIssuance(db, gerA, A, NOW); // 2 emitidos hoje no stage
    expect((await reqs()).filter((r) => r.status === "emitido")).toHaveLength(2);
    for (const c of [cli1, cli2]) await cancelBoleto(db, dirA, A, { chargeId: (await chargeOf(c)).id, reason: "preparo", confirm: true });
    await credsProd(); prodOn();
    await arm({ dailyLimit: 1 }); // limite 1 por dia, e já houve 2 emissões de TESTE hoje
    clock("2026-10-05T12:00:00-04:00");
    await requestBatchIssuance(db, gerA, A, batchId, "boleto");
    const out = await processIssuance(db, gerA, A, PN(), undefined, { confirmLive: true });
    expect(out.claimed).toBe(1); // antes: 0 ("limite diário atingido") por contar os de teste
    expect(out.issued + out.failed).toBe(1);
    expect((await reqs()).filter((r) => r.mode === "cora_producao" && r.status !== "pendente")).toHaveLength(1);
  });

  it("PRODUÇÃO — boleto NOSSO já existente na Cora (resposta perdida) é devolvido sem criar outro; vencimento passado e valor acima do teto não emitem", async () => {
    await credsProd(); clock("2026-10-05T12:00:00-04:00");
    const batchId = await approvedBatch();
    prodOn(); await arm({ dailyLimit: 20 });
    await saveIssuanceSettings(db, dirA, A, { paused: false, dailyLimit: 20, liveCanary: false, liveConfirm: PHRASE });
    await requestBatchIssuance(db, gerA, A, batchId, "boleto");
    const c1 = await chargeOf(cli1);
    // a Cora já tem o boleto com o NOSSO code (emissão anterior cuja resposta se perdeu)
    cora.inv.set("inv_nosso0000001", { id: "inv_nosso0000001", status: "OPEN", code: `k3g:boleto:${c1.id}`, amount: 250000, due: "2026-10-14", doc: "11222333000181", name: "Cliente Um", description: "x", idem: "n1" });
    const out = await processIssuance(db, gerA, A, PN(), undefined, { confirmLive: true });
    expect(out.issued).toBe(2);
    const mine = (await reqs()).find((r) => r.chargeId === c1.id)!;
    expect(mine).toMatchObject({ status: "emitido", externalRef: "inv_nosso0000001" });
    expect(cora.posts()).toHaveLength(1); // só o cliente 2 foi criado
    // vencimento no passado (relógio avança além de 14/10): recusado localmente, nenhuma chamada de criação
    await db.execute(sql`update issuance_requests set status = 'cancelado', external_ref = external_ref`);
    clock("2026-10-20T12:00:00-04:00");
    await requestBatchIssuance(db, gerA, A, batchId, "boleto");
    const before = cora.posts().length;
    const o2 = await processIssuance(db, gerA, A, PN(), undefined, { confirmLive: true });
    expect(o2.failed).toBe(2);
    expect((await reqs()).filter((r) => r.status === "falhou").every((r) => r.lastError === "vencimento_no_passado")).toBe(true);
    expect(cora.posts().length).toBe(before);
  });

  it("PRODUÇÃO — valor acima do teto não emite; cancelar boleto real só com a trava do servidor ligada; webhook de produção só com a trava", async () => {
    await credsProd(); clock("2026-10-05T12:00:00-04:00");
    const batchId = await approvedBatch();
    prodOn(); await arm();
    await requestBatchIssuance(db, gerA, A, batchId, "boleto");
    await processIssuance(db, gerA, A, PN(), undefined, { confirmLive: true });
    const c1 = await chargeOf(cli1);
    const r1 = (await reqs()).find((x) => x.chargeId === c1.id)!;
    expect(r1.status).toBe("emitido");
    // cancelar (diretoria): DELETE no host de produção, com a trava ligada
    await expect(cancelBoleto(db, dirA, A, { chargeId: c1.id, reason: "teste de cancelamento", confirm: true })).rejects.toThrow(/boleto REAL/); // falta a confirmação específica de boleto real
    expect(cora.calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
    expect(await cancelBoleto(db, dirA, A, { chargeId: c1.id, reason: "teste de cancelamento", confirm: true, confirmLive: true })).toMatchObject({ status: "cancelado" });
    expect(cora.calls.filter((c) => c.method === "DELETE").every((c) => c.host === CORA_HOSTS.producao)).toBe(true);
    // trava do servidor desligada: o outro boleto real NÃO pode ser cancelado (falha fechada, nada enviado)
    delete process.env.CORA_PROD_EMISSION_ENABLED;
    const c2 = await chargeOf(cli2);
    const nCalls = cora.calls.length;
    await expect(cancelBoleto(db, dirA, A, { chargeId: c2.id, reason: "sem a chave", confirm: true, confirmLive: true })).rejects.toThrow(LiveNotAvailable);
    expect(cora.calls.length).toBe(nCalls);
    await expect(enableCoraWebhook(db, dirA, A, "producao", "https://app.exemplo.com.br", cora.transport)).rejects.toThrow(Invalid);
    prodOn();
    // empresa NÃO armada para produção: o aviso de produção também não é cadastrado
    await db.execute(sql`update issuance_settings set boleto_provider = 'simulado', live_authorized_by = null, live_authorized_at = null`);
    await expect(enableCoraWebhook(db, dirA, A, "producao", "https://app.exemplo.com.br", cora.transport)).rejects.toThrow(/Ligue antes a emissão em produção/);
    expect(cora.calls.filter((c) => c.path === "/endpoints")).toHaveLength(0);
    await db.execute(sql`update issuance_settings set boleto_provider = 'cora_producao', live_authorized_by = ${dirA}, live_authorized_at = now()`);
    await expect(enableCoraWebhook(db, dirA, A, "producao", "https://app.exemplo.com.br", cora.transport)).resolves.toEqual({ triggers: 2 });
    expect([...cora.calls].filter((c) => c.path === "/endpoints").every((c) => c.host === CORA_HOSTS.producao)).toBe(true);
  });

  it("PRODUÇÃO — baixa automática e atualização de situação funcionam no modo de produção (só consulta + lançamento)", async () => {
    await credsProd(); clock("2026-10-05T12:00:00-04:00");
    const batchId = await approvedBatch();
    prodOn(); await arm();
    await saveIssuanceSettings(db, dirA, A, { paused: false, dailyLimit: 20, autoSettle: true });
    await requestBatchIssuance(db, gerA, A, batchId, "boleto");
    await processIssuance(db, gerA, A, PN(), undefined, { confirmLive: true });
    const c1 = await chargeOf(cli1); const r1 = (await reqs()).find((x) => x.chargeId === c1.id)!;
    cora.inv.get(r1.externalRef!)!.status = "PAID"; cora.hooks.paidOn = "2026-10-05";
    const before = cora.calls.length;
    const o = await syncBoletoStatus(db, gerA, A, PN());
    expect(o).toMatchObject({ paid: 1, settled: 1 });
    expect(cora.calls.slice(before).every((c) => c.method === "GET" || c.path === "/token")).toBe(true);
    expect((await db.select().from(schema.payments).where(eq(schema.payments.chargeId, c1.id)))[0]).toMatchObject({ amount: "2500.00", method: "boleto" });
  });

  // ───────── E33 — boleto no e-mail ─────────
  const PDF_URL = (id: string) => `https://storage.googleapis.com/download/storage/v1/b/cora_stage_exporter_bankslip_storage/o/${id}.pdf?generation=1&alt=media`;
  const pdfBytes = () => Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(300, 0x20), Buffer.from("\n%%EOF")]);
  const msgSetup = async () => {
    await db.insert(schema.customerContacts).values([{ companyId: A, partyId: cli1, name: "Fin Um", email: "fin1@k3gsolutions.com.br", isFinancial: true }, { companyId: A, partyId: cli2, name: "Fin Dois", email: "fin2@k3gsolutions.com.br", isFinancial: true }]);
    await ensureDefaultTemplates(db, dirA, A);
    await scheduleQueue(db, asstA, A, D);
  };
  const mailItems = async (kind = "emissao") => (await listQueue(db, dirA, A)).items.filter((i) => i.channel === "email" && i.kind === kind);
  const LINE = "00190000090321583700012584580174791420000002000"; // linha digitável da Cora falsa
  const smtpSent: { m: Record<string, any> }[] = [];
  const smtpDeps = () => ({ env: { EMAIL_EXTERNAL_ENABLED: "true" }, smtp: { lookup: async () => [{ address: "93.184.216.34", family: 4 }], createTransport: () => ({ sendMail: async (m: Record<string, unknown>) => { smtpSent.push({ m }); return { messageId: `<id${smtpSent.length}@k3g>`, accepted: m.to as string[], rejected: [] }; }, close() {} }) } });

  it("E33 — e-mail SIMULADO com boleto real/de teste: espera o boleto existir; depois o texto leva a linha digitável; boleto cancelado não gera mensagem", async () => {
    await useCora(); cora.hooks.pdfUrl = PDF_URL;
    const batchId = await approvedBatch(); await msgSetup();
    const r0 = await processQueue(db, asstA, A, D);
    expect(r0.processed).toBe(0); expect(r0.waiting).toMatch(/Aguardando o boleto/); // ainda sem boleto: nada é "enviado"
    expect((await mailItems()).map((i) => i.status)).toEqual(["pendente", "pendente"]);
    await requestBatchIssuance(db, gerA, A, batchId, "boleto");
    await processIssuance(db, gerA, A, NOW);
    const r1 = await processQueue(db, asstA, A, D);
    expect(r1.processed).toBe(2);
    const it = await mailItems();
    expect(it.every((i) => i.status === "simulado")).toBe(true);
    expect(it.every((i) => (i.renderedBody ?? "").includes(LINE))).toBe(true);
    // outro dia da régua só para boleto cancelado: o item some da fila (a régua para)
    const c1 = await chargeOf(cli1);
    await cancelBoleto(db, dirA, A, { chargeId: c1.id, reason: "cliente pediu", confirm: true });
    const c2 = await chargeOf(cli2);
    expect(await n(`message_queue where charge_id = '${c1.id}' and status = 'pendente'`)).toBe(0); // a régua do boleto cancelado parou
    expect(await n(`message_queue where charge_id = '${c2.id}' and status = 'pendente'`)).toBeGreaterThan(0); // a do outro cliente segue
  });

  it("E33 — e-mail REAL: leva o PDF do boleto em anexo (conferido) e a linha digitável; PDF que não vem/é inválido não manda e-mail sem o boleto; boleto simulado + modelo com boleto = bloqueado", async () => {
    smtpSent.length = 0;
    await useCora(); cora.hooks.pdfUrl = PDF_URL;
    const batchId = await approvedBatch(); await msgSetup();
    await saveEmailAccount(db, dirA, A, { host: "smtp.k3gsolutions.com.br", port: "587", security: "starttls", fromEmail: "financeiro@k3gsolutions.com.br", fromName: "K3G", replyTo: "", user: "u@k3gsolutions.com.br", password: "Senha-Do-Smtp-123" });
    await authorizeEmailLive(db, dirA, A, { reference: "autorização de teste 28/10/2026", allowed: "@k3gsolutions.com.br", dailyLimit: 10 });
    await requestBatchIssuance(db, gerA, A, batchId, "boleto");
    await processIssuance(db, gerA, A, NOW);
    // 1) o PDF não vem: nada é enviado, o item volta à fila
    __setPdfFetcherForTests((async () => new Response("nao é pdf", { status: 200 })) as typeof fetch);
    await processQueue(db, asstA, A, D, undefined, smtpDeps());
    expect(smtpSent).toHaveLength(0);
    expect((await mailItems()).every((i) => i.status === "pendente" && i.lastError === "pdf_indisponivel")).toBe(true);
    __setPdfFetcherForTests((async () => { throw new Error("rede"); }) as typeof fetch);
    await processQueue(db, asstA, A, D, undefined, smtpDeps());
    expect(smtpSent).toHaveLength(0);
    // 2) o PDF vem: e-mail real com anexo
    __setPdfFetcherForTests((async () => new Response(pdfBytes(), { status: 200, headers: { "content-type": "application/pdf" } })) as typeof fetch);
    await db.execute(sql`update message_queue set status = 'pendente', attempts = 0, last_error = null where channel = 'email' and status = 'bloqueado'`);
    const r = await processQueue(db, asstA, A, D, undefined, smtpDeps());
    expect(r.processed).toBe(2); expect(smtpSent).toHaveLength(2);
    for (const s of smtpSent) {
      expect(s.m.attachments).toHaveLength(1);
      expect(s.m.attachments[0]).toMatchObject({ contentType: "application/pdf", filename: "boleto-2026-10-14.pdf" });
      expect(Buffer.from(s.m.attachments[0].content).subarray(0, 5).toString()).toBe("%PDF-");
      expect(String(s.m.text)).toContain(LINE);
    }
  });

  it("E33 — boleto sem PDF/sem linha, de origem não permitida ou que NÃO é o da cobrança (valor/vencimento) não gera e-mail; boleto que muda entre a consulta e o envio volta à fila", async () => {
    smtpSent.length = 0;
    await useCora(); cora.hooks.pdfUrl = PDF_URL;
    const batchId = await approvedBatch(); await msgSetup();
    await saveEmailAccount(db, dirA, A, { host: "smtp.k3gsolutions.com.br", port: "587", security: "starttls", fromEmail: "financeiro@k3gsolutions.com.br", fromName: "K3G", replyTo: "", user: "u@k3gsolutions.com.br", password: "Senha-Do-Smtp-123" });
    await authorizeEmailLive(db, dirA, A, { reference: "autorização de teste 28/10/2026", allowed: "@k3gsolutions.com.br", dailyLimit: 10 });
    await requestBatchIssuance(db, gerA, A, batchId, "boleto");
    await processIssuance(db, gerA, A, NOW);
    __setPdfFetcherForTests((async () => new Response(pdfBytes(), { status: 200 })) as typeof fetch);
    // PDF de origem NÃO permitida (resposta da Cora com outro domínio): ninguém recebe, e-mail algum sai
    cora.hooks.pdfUrl = () => "https://evil.example.com/x.pdf";
    await processQueue(db, asstA, A, D, undefined, smtpDeps());
    expect(smtpSent).toHaveLength(0); expect((await mailItems()).every((i) => i.status === "pendente")).toBe(true);
    // sem PDF algum
    cora.hooks.pdfUrl = () => "";
    await processQueue(db, asstA, A, D, undefined, smtpDeps());
    expect(smtpSent).toHaveLength(0);
    // boleto com valor diferente do da cobrança (alguém mexeu na Cora): não é o boleto desta cobrança
    cora.hooks.pdfUrl = PDF_URL; cora.hooks.amountOverride = 199900;
    await processQueue(db, asstA, A, D, undefined, smtpDeps());
    expect(smtpSent).toHaveLength(0);
    cora.hooks.amountOverride = null;
    // muda ENTRE a consulta da rodada e o envio (cancelado na Cora depois de reservar): nada sai, o item volta à fila
    const c1 = await chargeOf(cli1); const r1 = (await reqs()).find((x) => x.chargeId === c1.id)!;
    await processQueue(db, asstA, A, D, undefined, { ...smtpDeps(), afterReserve: async () => { cora.inv.get(r1.externalRef!)!.status = "CANCELLED"; } });
    const um = (await mailItems()).find((i) => i.customerName === "Cliente Um")!;
    expect(um).toMatchObject({ status: "pendente", lastError: "boleto_mudou" });
    expect(smtpSent.every((s) => !/Cliente Um|fin1@/.test(JSON.stringify(s.m.to)))).toBe(true); // o do cliente 1 não saiu
  });

  it("E33 — PDF fora das origens da Cora, redirecionado ou grande demais nunca vira anexo", async () => {
    const { fetchBoletoPdf } = await import("@/modules/messaging/boleto-mail");
    const okFetch = (async () => new Response(pdfBytes(), { status: 200 })) as typeof fetch;
    await expect(fetchBoletoPdf("https://evil.example.com/x.pdf", okFetch)).rejects.toThrow(/origem/);
    await expect(fetchBoletoPdf("http://storage.googleapis.com/download/storage/v1/b/cora_production_exporter_bankslip_storage/o/x.pdf", okFetch)).rejects.toThrow(/origem/);
    await expect(fetchBoletoPdf(PDF_URL("x"), (async () => new Response(Buffer.alloc(3_100_000, 0x41), { status: 200 })) as typeof fetch)).rejects.toThrow(/grande|invalido/);
    await expect(fetchBoletoPdf(PDF_URL("x"), (async () => new Response("%PDF-1.4 curto", { status: 200 })) as typeof fetch)).rejects.toThrow(/invalido/);
    await expect(fetchBoletoPdf(PDF_URL("x"), (async () => new Response("x", { status: 404 })) as typeof fetch)).rejects.toThrow(/http_404/);
    expect((await fetchBoletoPdf(PDF_URL("x"), okFetch)).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("E33 — e-mail REAL com boleto SIMULADO e modelo que usa o boleto: bloqueado (nunca boleto de mentira para cliente de verdade)", async () => {
    smtpSent.length = 0;
    await approvedBatch(); await msgSetup(); // provedor simulado (padrão)
    await saveEmailAccount(db, dirA, A, { host: "smtp.k3gsolutions.com.br", port: "587", security: "starttls", fromEmail: "financeiro@k3gsolutions.com.br", fromName: "K3G", replyTo: "", user: "u@k3gsolutions.com.br", password: "Senha-Do-Smtp-123" });
    await authorizeEmailLive(db, dirA, A, { reference: "autorização de teste 28/10/2026", allowed: "@k3gsolutions.com.br", dailyLimit: 10 });
    await processQueue(db, asstA, A, D, undefined, smtpDeps());
    expect(smtpSent).toHaveLength(0);
    const it = await mailItems();
    expect(it.every((i) => i.status === "bloqueado" && /boleto desta empresa é simulado/.test(i.blockedReason ?? ""))).toBe(true);
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

  it("banco protege o boleto real: solicitação da Cora não é apagada (nem em cascata), não troca de modo, e produção não existe sem autorização registrada", async () => {
    const batchId = await approvedBatch(); await useCora();
    await requestBatchIssuance(db, gerA, A, batchId, "boleto");
    await processIssuance(db, gerA, A, NOW);
    const c1 = await chargeOf(cli1);
    await refused(db.execute(sql`delete from issuance_requests where charge_id = ${c1.id}`), /issuance_live_protected/);
    await refused(db.execute(sql`delete from charges where id = ${c1.id}`), /issuance_live_protected/); // cascata também recusa
    await refused(db.execute(sql`update issuance_requests set mode = 'simulado' where charge_id = ${c1.id}`), /issuance_live_protected/);
    await refused(db.execute(sql`update issuance_requests set mode = 'cora_producao' where charge_id = ${c1.id}`), /issuance_live_protected/); // o modo não muda depois de definido
    await refused(db.execute(sql`update issuance_requests set mode = 'cora_inexistente' where charge_id = ${c1.id}`), /issuance_requests_mode_chk|issuance_live_protected/);
    await refused(db.execute(sql`update issuance_settings set boleto_provider = 'cora_producao'`), /issuance_settings_live_auth_chk/); // o banco recusa produção sem autorização registrada
    expect(await n("issuance_requests where mode = 'cora_homologacao'")).toBe(2);
  });
});
