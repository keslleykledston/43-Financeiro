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
import { approveBatch, generateBatch, getBatch, reopenBatch } from "@/modules/billing/batches";
import { registerPayment } from "@/modules/receivables/service";
import { IssuanceRetryable, IssuanceTimeout, cancelIssuance, getIssuanceSettings, listIssuance, processIssuance, requestBatchIssuance, requestIssuance, saveIssuanceSettings } from "@/modules/issuance/service";
import { createMockProviders } from "@/modules/providers/mock";
import type { Providers } from "@/modules/providers/types";

const enabled = !!process.env.POSTGRES_USER;
const CNPJ1 = "11.222.333/0001-81", CNPJ2 = "12.ABC.345/01DE-35";
// competência 2026-09, vencimento 2026-10-14, emissão 2026-10-01. Régua: 10-01, 10-11, 10-14, 10-17, 10-21 (+ revisão 10-29).
const D = "2026-10-01";
const terms = (o: Record<string, unknown> = {}) => ({ description: "Monitoramento de redes", monthlyAmount: "2.500,00", startAt: "2026-01-01", endAt: "", dueDay: "14", invoiceJointRequired: false, issueDayOverride: "", ...o });

describe.skipIf(!enabled)("E10 motor de emissão (simulado): reservar → chamar → registrar, reconsulta, limites e travas (DB de teste)", () => {
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
    await db.execute(sql`truncate issuance_requests, issuance_settings, bank_transaction_marks, bank_allocations, bank_transactions, bank_import_rows, bank_import_batches, bank_accounts, payments, messaging_settings, message_queue, message_template_versions, message_templates, charges, billing_batches, holidays, contract_versions, contracts, integration_conflicts, integration_sync_runs, integration_connections, rate_limits, customer_contacts, vendor_contacts, customers, vendors, audit_log, invitations, memberships, companies, users restart identity cascade`);
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
  const NOW = new Date(Date.now() + 5 * 60_000); // as solicitações nascem "devidas agora" (relógio real); a rodada de teste roda logo depois
  const on = (paused = false, dailyLimit = 20) => saveIssuanceSettings(db, dirA, A, { paused, dailyLimit });
  const row = async (id: string) => (await db.select().from(schema.issuanceRequests).where(eq(schema.issuanceRequests.id, id)))[0];
  // provedor que conta chamadas e deixa o teste simular falhas no meio
  const spy = (hooks: { issue?: (n: number) => Promise<void> } = {}) => {
    const base = createMockProviders(); const calls = { issue: 0, find: 0, status: 0, nfse: 0 };
    const p: Providers = {
      ...base,
      boleto: { ...base.boleto, issue: async (i) => { calls.issue++; const r = await base.boleto.issue(i); if (hooks.issue) await hooks.issue(calls.issue); return r; }, find: async (k) => { calls.find++; return base.boleto.find(k); } },
      nfse: { ...base.nfse, issue: async (i) => { calls.nfse++; return base.nfse.issue(i); }, status: async (r) => { calls.status++; return base.nfse.status(r); } },
    };
    return { p, calls };
  };

  it("nasce PAUSADO; só diretoria altera; limites validados; nada é processado pausado", async () => {
    await approvedBatch();
    expect(await getIssuanceSettings(db, contA, A)).toEqual({ paused: true, dailyLimit: 20 });
    await expect(saveIssuanceSettings(db, gerA, A, { paused: false, dailyLimit: 10 })).rejects.toThrow(Forbidden);
    await expect(saveIssuanceSettings(db, dirA, A, { paused: false, dailyLimit: 0 })).rejects.toThrow(/Limite diário/);
    await expect(saveIssuanceSettings(db, dirA, A, { paused: false, dailyLimit: 501 })).rejects.toThrow(Invalid);
    await expect(getIssuanceSettings(db, techA, A)).rejects.toThrow(Forbidden);
    const c = await chargeOf(cli1);
    await requestIssuance(db, gerA, A, c.id, "boleto");
    const { p, calls } = spy();
    expect(await processIssuance(db, gerA, A, NOW, p)).toMatchObject({ claimed: 0, waiting: "Emissão pausada" });
    expect(calls.issue).toBe(0);
    await on(false);
    expect(await processIssuance(db, gerA, A, NOW, p)).toMatchObject({ claimed: 1, issued: 1 });
    expect((await getIssuanceSettings(db, contA, A)).paused).toBe(false);
  });

  it("solicitar: só cobrança aprovada e com saldo; uma por cobrança/tipo; lote em massa; cancelar só antes do envio; RBAC", async () => {
    const batchId = await approvedBatch();
    const c1 = await chargeOf(cli1), c2 = await chargeOf(cli2);
    await expect(requestIssuance(db, asstA, A, c1.id, "boleto")).rejects.toThrow(Forbidden);
    await expect(requestIssuance(db, gerA, A, c1.id, "cheque")).rejects.toThrow(/Tipo/);
    await expect(requestIssuance(db, gerA, A, "não-uuid", "boleto")).rejects.toThrow(/não encontrada/);
    const id = await requestIssuance(db, gerA, A, c1.id, "boleto");
    await expect(requestIssuance(db, gerA, A, c1.id, "boleto")).rejects.toThrow(/Já existe/);
    await requestIssuance(db, gerA, A, c1.id, "nfse"); // tipo diferente pode
    expect(await requestBatchIssuance(db, gerA, A, batchId, "boleto")).toEqual({ created: 1 }); // só a c2 (c1 já tem)
    expect(await requestBatchIssuance(db, gerA, A, batchId, "boleto")).toEqual({ created: 0 });
    await cancelIssuance(db, gerA, A, id);
    await expect(cancelIssuance(db, gerA, A, id)).rejects.toThrow(/ainda não foi enviada/);
    await requestIssuance(db, gerA, A, c1.id, "boleto"); // depois de cancelar, pode pedir de novo
    // cobrança quitada não precisa de boleto
    await registerPayment(db, asstA, A, c2.id, { amount: "2.500,00", paidAt: "2026-10-15", method: "pix" }, "2026-10-20");
    await expect(requestIssuance(db, gerA, A, c2.id, "nfse")).rejects.toThrow(/já quitada/);
    // prévia (lote não aprovado) não pode
    await expect(requestBatchIssuance(db, gerA, A, "00000000-0000-0000-0000-000000000000", "boleto")).rejects.toThrow(/aprovados/);
    expect((await listIssuance(db, contA, A)).items.length).toBe(4);
    await expect(listIssuance(db, techA, A)).rejects.toThrow(Forbidden);
  });

  it("emite uma vez: referência e idempotência; reprocessar não chama o provedor de novo; auditoria sem dados", async () => {
    await approvedBatch(); await on();
    const c1 = await chargeOf(cli1);
    const id = await requestIssuance(db, gerA, A, c1.id, "boleto");
    const { p, calls } = spy();
    const r = await processIssuance(db, gerA, A, NOW, p);
    expect(r).toMatchObject({ claimed: 1, issued: 1, failed: 0 });
    const x = await row(id);
    expect(x).toMatchObject({ status: "emitido", attempts: 1, mode: "simulado", idempotencyKey: `boleto:${c1.id}`, lastError: null });
    expect(x.externalRef).toMatch(/^mock-boleto-/);
    expect(await processIssuance(db, gerA, A, NOW, p)).toMatchObject({ claimed: 0, issued: 0 });
    expect(calls.issue).toBe(1);
    const logs = await db.select().from(schema.auditLog).where(sql`${schema.auditLog.action} like 'issuance.%'`);
    const txt = JSON.stringify(logs.map((l) => l.detail));
    for (const bad of ["Cliente Um", "2500", "2.500", D1(), "mock-boleto"]) expect(txt).not.toContain(bad);
    await expect(processIssuance(db, contA, A, NOW, p)).rejects.toThrow(Forbidden);
  });
  const D1 = () => CNPJ1.replace(/\D/g, "");

  it("RESPOSTA PERDIDA: o provedor emitiu mas deu timeout → 'desconhecido'; a rodada seguinte RECONSULTA e não reemite", async () => {
    await approvedBatch(); await on();
    const c1 = await chargeOf(cli1);
    const id = await requestIssuance(db, gerA, A, c1.id, "boleto");
    const { p, calls } = spy({ issue: async () => { throw new IssuanceTimeout(); } }); // emitiu e perdeu a resposta
    expect(await processIssuance(db, gerA, A, NOW, p)).toMatchObject({ claimed: 1, unknown: 1, issued: 0, failed: 0 });
    expect(await row(id)).toMatchObject({ status: "desconhecido", lastError: "timeout", externalRef: null });
    // antes do prazo da nova tentativa nada acontece
    expect(await processIssuance(db, gerA, A, new Date(NOW.getTime() + 60_000), p)).toMatchObject({ claimed: 0 });
    // depois do prazo: reconsulta (find) → encontra → emitido, SEM chamar issue de novo
    expect(await processIssuance(db, gerA, A, new Date(NOW.getTime() + 3 * 60_000), p)).toMatchObject({ claimed: 1, issued: 1 });
    expect(calls).toMatchObject({ issue: 1, find: 1 });
    expect(await row(id)).toMatchObject({ status: "emitido", attempts: 2, lastError: null });
    expect((await row(id)).externalRef).toMatch(/^mock-boleto-/);
  });

  it("desconhecido e o provedor NÃO tem a emissão → reemite com a MESMA chave de idempotência", async () => {
    await approvedBatch(); await on();
    const c1 = await chargeOf(cli1);
    const id = await requestIssuance(db, gerA, A, c1.id, "boleto");
    const base = createMockProviders(); let n = 0; const keys: string[] = [];
    const p: Providers = { ...base, boleto: { ...base.boleto, issue: async (i) => { keys.push(i.idempotencyKey); if (++n === 1) throw new IssuanceTimeout(); return base.boleto.issue(i); } } }; // 1ª: caiu antes de criar
    await processIssuance(db, gerA, A, NOW, p);
    expect((await row(id)).status).toBe("desconhecido");
    expect(await processIssuance(db, gerA, A, new Date(NOW.getTime() + 3 * 60_000), p)).toMatchObject({ issued: 1 });
    expect(keys).toEqual([`boleto:${c1.id}`, `boleto:${c1.id}`]);
  });

  it("erro inesperado também vira 'desconhecido' (nunca reemite às cegas); repetível explícito usa backoff; esgota tentativas; validação falha de vez", async () => {
    await approvedBatch(); await on();
    const [c1, c2] = [await chargeOf(cli1), await chargeOf(cli2)];
    const id1 = await requestIssuance(db, gerA, A, c1.id, "boleto");
    const weird: Providers = { ...createMockProviders(), boleto: { ...createMockProviders().boleto, issue: async () => { throw new Error("ECONNRESET"); } } };
    await processIssuance(db, gerA, A, NOW, weird);
    expect(await row(id1)).toMatchObject({ status: "desconhecido", lastError: "erro_desconhecido" });
    // repetível explícito: volta a pendente com backoff crescente
    await db.update(schema.issuanceRequests).set({ status: "cancelado" });
    const id2 = await requestIssuance(db, gerA, A, c2.id, "boleto");
    const flaky: Providers = { ...createMockProviders(), boleto: { ...createMockProviders().boleto, issue: async () => { throw new IssuanceRetryable(); } } };
    let t = NOW;
    await processIssuance(db, gerA, A, t, flaky);
    const a = await row(id2); expect(a).toMatchObject({ status: "pendente", attempts: 1, lastError: "retryable" });
    expect(a.nextAttemptAt.getTime() - t.getTime()).toBe(2 * 60_000);
    expect(await processIssuance(db, gerA, A, new Date(t.getTime() + 60_000), flaky)).toMatchObject({ claimed: 0 }); // ainda no backoff
    t = new Date(t.getTime() + 2 * 60_000); await processIssuance(db, gerA, A, t, flaky);
    expect((await row(id2)).nextAttemptAt.getTime() - t.getTime()).toBe(4 * 60_000);
    for (let i = 0; i < 4; i++) { t = new Date(t.getTime() + 61 * 60_000); await processIssuance(db, gerA, A, t, flaky); }
    expect(await row(id2)).toMatchObject({ status: "falhou", attempts: 5, lastError: "tentativas_esgotadas" });
    // validação do provedor: falha de uma vez
    await db.update(schema.issuanceRequests).set({ status: "cancelado" });
    const id3 = await requestIssuance(db, gerA, A, c1.id, "nfse");
    const bad: Providers = { ...createMockProviders(), nfse: { ...createMockProviders().nfse, issue: async () => { throw new RangeError("valor_invalido"); } } };
    await processIssuance(db, gerA, A, new Date(t.getTime() + 61 * 60_000), bad);
    expect(await row(id3)).toMatchObject({ status: "falhou", attempts: 1, lastError: "valor_invalido" });
  });

  it("desconhecido que nunca se resolve esgota as tentativas e vai para revisão humana", async () => {
    await approvedBatch(); await on();
    const id = await requestIssuance(db, gerA, A, (await chargeOf(cli1)).id, "boleto");
    const dead: Providers = { ...createMockProviders(), boleto: { ...createMockProviders().boleto, issue: async () => { throw new IssuanceTimeout(); }, find: async () => null } };
    let t = NOW;
    for (let i = 0; i < 6; i++) { await processIssuance(db, gerA, A, t, dead); t = new Date(t.getTime() + 3 * 60_000); }
    expect(await row(id)).toMatchObject({ status: "falhou", attempts: 5, lastError: "resultado_desconhecido_revisar" });
  });

  it("processo caiu no meio ('enviando' travado) → recuperado como desconhecido e reconsultado", async () => {
    await approvedBatch(); await on();
    const c1 = await chargeOf(cli1);
    const id = await requestIssuance(db, gerA, A, c1.id, "boleto");
    const { p, calls } = spy();
    // simula: o provedor chegou a emitir, mas o processo morreu antes de registrar
    await p.boleto.issue({ idempotencyKey: `boleto:${c1.id}`, amountCents: 250000, dueDate: "2026-10-14", customerName: "x", customerDocument: "1" });
    await db.update(schema.issuanceRequests).set({ status: "enviando", claimedAt: new Date(NOW.getTime() - 11 * 60_000), attempts: 1 }).where(eq(schema.issuanceRequests.id, id));
    const r = await processIssuance(db, gerA, A, NOW, p);
    expect(r).toMatchObject({ recovered: 1, claimed: 1, issued: 1 });
    expect(calls.issue).toBe(1); expect(calls.find).toBe(1); // só a chamada simulada do teste; o motor reconsultou
    expect(await row(id)).toMatchObject({ status: "emitido", attempts: 2 });
    // recém-reservada (< 10 min) NÃO é recuperada: outra rodada ainda a está processando
    const id2 = await requestIssuance(db, gerA, A, (await chargeOf(cli2)).id, "boleto");
    await db.update(schema.issuanceRequests).set({ status: "enviando", claimedAt: new Date(NOW.getTime() - 60_000), attempts: 1 }).where(eq(schema.issuanceRequests.id, id2));
    expect((await processIssuance(db, gerA, A, NOW, p)).recovered).toBe(0);
    expect((await row(id2)).status).toBe("enviando");
  });

  it("limite diário: não passa do teto e retoma no dia seguinte", async () => {
    await activeContract(cli1, terms({ dueDay: "15" })); await activeContract(cli2); await activeContract(cli1);
    const { batchId } = await generateBatch(db, asstA, A, D); await approveBatch(db, dirA, A, batchId, (await getBatch(db, asstA, A, batchId))!.hash);
    await requestBatchIssuance(db, gerA, A, batchId, "boleto");
    expect((await listIssuance(db, contA, A)).items).toHaveLength(3);
    await on(false, 2);
    const { p, calls } = spy();
    expect(await processIssuance(db, gerA, A, NOW, p)).toMatchObject({ claimed: 2, issued: 2 });
    expect(await processIssuance(db, gerA, A, NOW, p)).toMatchObject({ claimed: 0, waiting: "Limite diário de emissões atingido" });
    expect(await processIssuance(db, gerA, A, new Date(NOW.getTime() + 24 * 3600_000), p)).toMatchObject({ claimed: 1, issued: 1 });
    expect(calls.issue).toBe(3);
  });

  it("NFS-e é assíncrona: 'processando' → consulta de status → emitida (sem gastar limite nem reemitir)", async () => {
    await approvedBatch(); await on(false, 1);
    const id = await requestIssuance(db, gerA, A, (await chargeOf(cli1)).id, "nfse");
    const { p, calls } = spy();
    expect(await processIssuance(db, gerA, A, NOW, p)).toMatchObject({ claimed: 1, processing: 1 });
    expect(await row(id)).toMatchObject({ status: "processando", externalStatus: "processando" });
    expect(await processIssuance(db, gerA, A, NOW, p)).toMatchObject({ issued: 1, claimed: 0 }); // mesmo com limite diário de 1 já gasto
    expect(await row(id)).toMatchObject({ status: "emitido", externalStatus: "emitida" });
    expect(calls).toMatchObject({ nfse: 1, status: 1 });
  });

  it("cobrança quitada ou cancelada entre a solicitação e o envio: o motor cancela em vez de emitir", async () => {
    await approvedBatch(); await on();
    const [c1, c2] = [await chargeOf(cli1), await chargeOf(cli2)];
    const id1 = await requestIssuance(db, gerA, A, c1.id, "boleto"), id2 = await requestIssuance(db, gerA, A, c2.id, "boleto");
    await registerPayment(db, asstA, A, c1.id, { amount: "2.500,00", paidAt: "2026-10-15", method: "pix" }, "2026-10-20");
    await db.execute(sql`update charges set status = 'cancelada' where id = ${c2.id}`);
    const { p, calls } = spy();
    expect(await processIssuance(db, gerA, A, NOW, p)).toMatchObject({ claimed: 2, skipped: 2, issued: 0 });
    expect(calls.issue).toBe(0);
    expect(await row(id1)).toMatchObject({ status: "cancelado", lastError: "cobranca_indisponivel" });
    expect((await row(id2)).status).toBe("cancelado");
  });

  it("reabrir lote: cancela solicitações pendentes; com emissão em andamento/concluída, NÃO reabre", async () => {
    const batchId = await approvedBatch(); await on();
    const [c1, c2] = [await chargeOf(cli1), await chargeOf(cli2)];
    const pend = await requestIssuance(db, gerA, A, c1.id, "boleto");
    await reopenBatch(db, gerA, A, batchId, "ajustar contrato do cliente");
    expect((await row(pend)).status).toBe("cancelado");
    await approveBatch(db, dirA, A, batchId, (await getBatch(db, asstA, A, batchId))!.hash);
    const id2 = await requestIssuance(db, gerA, A, c2.id, "boleto");
    await processIssuance(db, gerA, A, NOW, spy().p);
    expect((await row(id2)).status).toBe("emitido");
    await expect(reopenBatch(db, gerA, A, batchId, "tentando reabrir depois de emitir")).rejects.toThrow(/emissões em andamento ou concluídas/);
    expect((await getBatch(db, asstA, A, batchId))!.batch.status).toBe("aprovado");
  });

  it("last_error nunca guarda texto livre do provedor (possível dado do cliente); só códigos curtos", async () => {
    await approvedBatch(); await on();
    const [c1, c2] = [await chargeOf(cli1), await chargeOf(cli2)];
    const a = await requestIssuance(db, gerA, A, c1.id, "boleto"), b = await requestIssuance(db, gerA, A, c2.id, "boleto");
    const base = createMockProviders();
    const nasty: Providers = { ...base, boleto: { ...base.boleto, issue: async (i) => { throw new RangeError(i.customerName === "Cliente Um" ? "Cliente Um 11.222.333/0001-81 inválido" : "documento_invalido"); } } };
    await processIssuance(db, gerA, A, NOW, nasty);
    expect((await row(a)).lastError).toBe("validacao_provedor");
    expect((await row(b)).lastError).toBe("documento_invalido");
    expect(JSON.stringify(await db.select().from(schema.issuanceRequests))).not.toContain("11.222.333");
  });

  it("injeção de provedor só existe nos testes: no runtime normal (sem VITEST) é recusada", async () => {
    await approvedBatch(); await on();
    await requestIssuance(db, gerA, A, (await chargeOf(cli1)).id, "boleto");
    const env = process.env as Record<string, string | undefined>; const old = env.VITEST;
    delete env.VITEST;
    try { await expect(processIssuance(db, gerA, A, NOW, spy().p)).rejects.toThrow(/proibida fora dos testes/); } finally { env.VITEST = old; }
    expect(await n("issuance_requests where status = 'pendente'")).toBe(1);
  });

  it("reabrir × reservar ao mesmo tempo: a reabertura nunca passa por cima de uma reserva em curso", async () => {
    const batchId = await approvedBatch(); await on();
    const id = await requestIssuance(db, gerA, A, (await chargeOf(cli1)).id, "boleto");
    let release!: () => void; const hold = new Promise<void>((r) => { release = r; });
    let locked!: () => void; const ready = new Promise<void>((r) => { locked = r; });
    // rodada do motor no meio da reserva: lock do motor + solicitação já em "enviando", ainda sem confirmar
    const reserving = conn.begin(async (q) => {
      await q`select pg_advisory_xact_lock(hashtext(${"issuance:" + A}))`;
      await q`update issuance_requests set status = 'enviando', claimed_at = now(), attempts = 1 where id = ${id}`;
      locked(); await hold;
    });
    await ready;
    const reopening = reopenBatch(db, gerA, A, batchId, "reabrir durante a reserva");
    await new Promise((r) => setTimeout(r, 300));
    release(); await reserving;
    await expect(reopening).rejects.toThrow(/emissões em andamento ou concluídas/);
    expect((await getBatch(db, asstA, A, batchId))!.batch.status).toBe("aprovado");
  });

  it("concorrência: duas rodadas ao mesmo tempo nunca emitem a mesma cobrança duas vezes", async () => {
    await approvedBatch(); await on();
    await requestIssuance(db, gerA, A, (await chargeOf(cli1)).id, "boleto"); await requestIssuance(db, gerA, A, (await chargeOf(cli2)).id, "boleto");
    const { p, calls } = spy({ issue: async () => { await new Promise((r) => setTimeout(r, 150)); } });
    const rs = await Promise.all([processIssuance(db, gerA, A, NOW, p), processIssuance(db, dirA, A, NOW, p), processIssuance(db, gerA, A, NOW, p)]);
    expect(rs.reduce((s, r) => s + r.issued, 0)).toBe(2);
    expect(calls.issue).toBe(2);
    expect(await n("issuance_requests where status = 'emitido'")).toBe(2);
  });

  it("travas: chave real ligada ou provedor não simulado → recusa antes de reservar; banco só aceita modo 'simulado'; isolamento", async () => {
    await approvedBatch(); await on();
    const id = await requestIssuance(db, gerA, A, (await chargeOf(cli1)).id, "boleto");
    process.env.CORA_LIVE_ENABLED = "true";
    try { await expect(processIssuance(db, gerA, A, NOW)).rejects.toThrow(/adaptador real/); } finally { delete process.env.CORA_LIVE_ENABLED; }
    const base = createMockProviders();
    await expect(processIssuance(db, gerA, A, NOW, { ...base, boleto: { ...base.boleto, mode: "live" } })).rejects.toThrow(/não simulado/);
    expect(await row(id)).toMatchObject({ status: "pendente", attempts: 0 }); // nada foi reservado
    await expect(db.execute(sql`update issuance_requests set mode = 'real'`)).rejects.toThrow();
    await expect(db.execute(sql`update issuance_requests set status = 'emitido', external_ref = null`)).rejects.toThrow(); // emitido exige referência
    expect(await listIssuance(db, dirB, B)).toMatchObject({ items: [] });
    await expect(requestIssuance(db, dirB, B, (await chargeOf(cli1)).id, "boleto")).rejects.toThrow(/não encontrada/);
    await expect(cancelIssuance(db, dirB, B, id)).rejects.toThrow(/ainda não foi enviada/);
    expect((await processIssuance(db, dirB, B, NOW, spy().p))).toMatchObject({ claimed: 0 });
  });

  it("E26: o texto da nota e do boleto e o endereço do CLIENTE chegam ao provedor; sem texto vale a descrição do contrato; razão social segue na emissão", async () => {
    await approvedBatch(); await on(false);
    await db.update(schema.customers).set({ nfText: "Serviços de {{descricao}} — competência {{competencia}}", boletoText: "Vence {{vencimento}}. Não receber após 10 dias.", cep: "69000000", street: "Av. Exemplo", streetNumber: "100", cityName: "Manaus", cityIbge: "1302603", uf: "AM", tradeName: "Nome Fantasia" }).where(eq(schema.customers.id, cli1));
    const seen: { boleto: unknown[]; nfse: unknown[] } = { boleto: [], nfse: [] };
    const base = createMockProviders();
    const p: Providers = { ...base, boleto: { ...base.boleto, issue: async (i) => { seen.boleto.push(i); return base.boleto.issue(i); } }, nfse: { ...base.nfse, issue: async (i) => { seen.nfse.push(i); return base.nfse.issue(i); } } };
    const c1 = await chargeOf(cli1), c2 = await chargeOf(cli2);
    for (const c of [c1, c2]) { await requestIssuance(db, gerA, A, c.id, "boleto"); await requestIssuance(db, gerA, A, c.id, "nfse"); }
    await processIssuance(db, gerA, A, NOW, p);
    const b1 = seen.boleto.find((x) => (x as { customerName: string }).customerName === "Cliente Um") as Record<string, unknown>;
    const n1 = seen.nfse.find((x) => (x as { customerName: string }).customerName === "Cliente Um") as Record<string, unknown>;
    const n2 = seen.nfse.find((x) => (x as { customerName: string }).customerName === "Cliente Dois") as Record<string, unknown>;
    const b2 = seen.boleto.find((x) => (x as { customerName: string }).customerName === "Cliente Dois") as Record<string, unknown>;
    expect(b1.instructions).toBe("Vence 14/10/2026. Não receber após 10 dias.");
    expect(n1.description).toBe("Serviços de Monitoramento de redes — competência 09/2026");
    expect(n1.customerAddress).toMatchObject({ cep: "69000000", street: "Av. Exemplo", number: "100", city: "Manaus", cityIbge: "1302603", uf: "AM" });
    expect(n1.customerName).toBe("Cliente Um"); // razão social, não o fantasia
    expect(n2.description).toBe("Monitoramento de redes"); expect(b2.instructions).toBeUndefined();
  });
});

