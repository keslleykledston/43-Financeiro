import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { and, eq, sql } from "drizzle-orm";
import { databaseUrl } from "@/lib/db/url";
import * as schema from "@/lib/db/schema";
import type { DB } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import { createParty } from "@/modules/crm/service";
import { createContract, decideVersion, getContract } from "@/modules/contracts/service";
import { approveBatch, cancelBatch, generateBatch, getBatch, reopenBatch } from "@/modules/billing/batches";
import { getAutomation, runCompany, runDateOf, setAutomation, tickBilling } from "@/modules/billing/automation";
import { cancelPendingBoletos, processIssuance, requestIssuance, saveIssuanceSettings } from "@/modules/issuance/service";
import { ensureDefaultTemplates, scheduleQueue } from "@/modules/messaging/service";
import { paymentSyncStatus } from "@/modules/issuance/sync-status";
import { createMockProviders } from "@/modules/providers/mock";

const enabled = !!process.env.POSTGRES_USER;
// Datas no FUTURO em relação ao relógio real: as solicitações nascem «devidas agora» (relógio real) e a rodada de teste roda depois delas.
// Competência 2027-01, vencimento 2027-02-14, emissão segunda 2027-02-01 (09:00 Manaus = 13:00Z). Prévia a partir de quinta 2027-01-28.
const ISSUE = "2027-02-01";
const at = (iso: string, hhmm: string) => new Date(`${iso}T${hhmm}:00-04:00`);
const terms = (o: Record<string, unknown> = {}) => ({ description: "Monitoramento de redes", monthlyAmount: "2.500,00", startAt: "2026-01-01", endAt: "", dueDay: "14", invoiceJointRequired: false, issueDayOverride: "", ...o });

describe.skipIf(!enabled)("F1 faturamento automático: prévia no prazo, «aprovar e agendar», emissão no dia/hora certos (DB de teste)", () => {
  let admin: ReturnType<typeof postgres>, conn: ReturnType<typeof postgres>, db: DB;
  let A: string, B: string, dirA: string, dirB: string, gerA: string, asstA: string, cli1: string, cli2: string;

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
    await db.execute(sql`truncate billing_automation, issuance_requests, issuance_settings, cora_webhooks, bank_transaction_marks, bank_allocations, bank_transactions, bank_import_rows, bank_import_batches, bank_accounts, payments, messaging_settings, message_queue, message_template_versions, message_templates, charge_invoices, charges, billing_batches, holidays, contract_versions, contracts, integration_conflicts, integration_sync_runs, integration_connections, rate_limits, customer_contacts, vendor_contacts, customers, vendors, audit_log, invitations, memberships, companies, users restart identity cascade`);
    const [a, b] = await db.insert(schema.companies).values([{ name: "Empresa A" }, { name: "Empresa B" }]).returning();
    A = a.id; B = b.id;
    const mk = async (e: string) => (await db.insert(schema.users).values({ email: e, name: e, passwordHash: "x" }).returning())[0].id;
    dirA = await mk("dir-a@t.com"); dirB = await mk("dir-b@t.com"); gerA = await mk("ger@t.com"); asstA = await mk("asst@t.com");
    await db.insert(schema.memberships).values([
      { userId: dirA, companyId: A, role: "diretoria" }, { userId: dirB, companyId: B, role: "diretoria" }, { userId: gerA, companyId: A, role: "gerente" }, { userId: asstA, companyId: A, role: "assistente" },
    ]);
    cli1 = (await createParty(db, dirA, A, { kind: "cliente", legalName: "Cliente Um", document: "11.222.333/0001-81" })).id;
    cli2 = (await createParty(db, dirA, A, { kind: "cliente", legalName: "Cliente Dois", document: "12.ABC.345/01DE-35" })).id;
    await db.insert(schema.customerContacts).values([
      { companyId: A, partyId: cli1, name: "Fin Um", email: "fin1@exemplo.com", isFinancial: true },
      { companyId: A, partyId: cli2, name: "Fin Dois", email: "fin2@exemplo.com", isFinancial: true },
    ]);
    await ensureDefaultTemplates(db, dirA, A);
  });

  const activeContract = async (customer: string, t = terms()) => {
    const c = await createContract(db, asstA, A, customer, t);
    await decideVersion(db, dirA, A, (await getContract(db, dirA, A, c.id))!.versions[0].id, "aprovar");
    return c.id;
  };
  const contracts = async () => { await activeContract(cli1); await activeContract(cli2); };
  const providers = () => createMockProviders();
  const batchRow = async (date = ISSUE) => (await db.select().from(schema.billingBatches).where(and(eq(schema.billingBatches.companyId, A), eq(schema.billingBatches.issueDate, date))))[0];
  const n = async (q: string) => Number((await db.execute(sql.raw(`select count(*)::int n from ${q}`)))[0].n);
  const run = (now: Date) => runCompany(db, A, now, { providers: providers() });
  /** prévia gerada pelo sistema → aprovada com «agendar» pela gerência */
  const scheduled = async (who = gerA) => {
    await contracts(); await setAutomation(db, dirA, A, true);
    await run(at("2027-01-28", "10:00"));
    const b = await batchRow(); const g = (await getBatch(db, who, A, b.id))!;
    await approveBatch(db, who, A, b.id, g.hash, { schedule: true });
    return b.id;
  };

  it("ligar/desligar: só quem pode gerir a emissão; fica gravado quem e quando; começa desligado", async () => {
    expect((await getAutomation(db, dirA, A)).enabled).toBe(false);
    await expect(setAutomation(db, gerA, A, true)).rejects.toThrow(Forbidden);
    await expect(setAutomation(db, asstA, A, true)).rejects.toThrow(Forbidden);
    await setAutomation(db, dirA, A, true);
    const [r] = await db.select().from(schema.billingAutomation).where(eq(schema.billingAutomation.companyId, A));
    expect(r.enabled).toBe(true); expect(r.enabledBy).toBe(dirA); expect(r.enabledAt).toBeTruthy();
    expect(await n("audit_log where action = 'billing.auto.toggled'")).toBe(1);
    await expect(setAutomation(db, dirB, A, true)).rejects.toThrow(Forbidden); // outra empresa
    await setAutomation(db, dirA, A, false);
    expect((await getAutomation(db, dirA, A)).enabled).toBe(false);
  });

  it("prévia automática: só a partir de 2 dias úteis antes, sem aprovar, gerada pelo sistema; não recria lote cancelado", async () => {
    await contracts(); await setAutomation(db, dirA, A, true);
    const early = await run(at("2027-01-27", "10:00"));
    expect(early.previews).toBe(0); expect(await batchRow()).toBeUndefined();
    const r = await run(at("2027-01-28", "10:00"));
    expect(r.previews).toBe(1);
    const b = await batchRow();
    expect(b.status).toBe("rascunho"); expect(b.generatedBy).toBeNull(); expect(b.autoIssue).toBe(false);
    expect((await run(at("2027-01-28", "10:05"))).previews).toBe(0); // idempotente
    expect(await n("billing_batches")).toBe(1);
    await cancelBatch(db, gerA, A, b.id); // cancelar de propósito
    expect((await run(at("2027-01-29", "10:00"))).previews).toBe(0);
    expect((await batchRow()) .status).toBe("cancelado");
    expect(await n("audit_log where action = 'billing.auto.preview'")).toBe(1);
  });

  it("empresa sem o faturamento ligado: o agendador não faz nada; e só age na SUA empresa", async () => {
    await contracts();
    expect((await run(at("2027-01-28", "10:00"))).previews).toBe(0);
    await setAutomation(db, dirB, B, true);
    const res = await tickBilling(db, at("2027-01-28", "10:00"), { providers: providers() });
    expect(res.map((r) => r.companyId)).toEqual([B]); // A segue desligada
    expect(await n("billing_batches")).toBe(0);
  });

  it("quem gerou NÃO impede ninguém: a prévia do sistema pode ser aprovada pela gerência; «agendar» exige gerente/diretoria e a chave ligada", async () => {
    await contracts();
    const b0 = await generateBatch(db, asstA, A, ISSUE);
    const g0 = (await getBatch(db, asstA, A, b0.batchId))!;
    await expect(approveBatch(db, gerA, A, b0.batchId, g0.hash, { schedule: true })).rejects.toThrow(/faturamento automático não está ligado/);
    await setAutomation(db, dirA, A, true);
    await expect(approveBatch(db, asstA, A, b0.batchId, g0.hash, { schedule: true })).rejects.toThrow(Forbidden);
    await approveBatch(db, gerA, A, b0.batchId, g0.hash, { schedule: true });
    const b = await batchRow();
    expect(b.status).toBe("aprovado"); expect(b.autoIssue).toBe(true); expect(b.approvedBy).toBe(gerA);
  });

  it("aprovar SEM agendar não vira emissão automática", async () => {
    await contracts(); await setAutomation(db, dirA, A, true);
    await run(at("2027-01-28", "10:00"));
    const b = await batchRow(); const g = (await getBatch(db, gerA, A, b.id))!;
    await approveBatch(db, gerA, A, b.id, g.hash);
    await saveIssuanceSettings(db, dirA, A, { paused: false, dailyLimit: 20 });
    await run(at(ISSUE, "10:00"));
    expect(await n("issuance_requests")).toBe(0);
  });

  it("emissão no dia certo: antes das 09:00 espera; às 09:00 solicita e emite (em nome de quem aprovou), cria a fila e conclui", async () => {
    const id = await scheduled();
    await saveIssuanceSettings(db, dirA, A, { paused: false, dailyLimit: 20 });
    expect((await run(at("2027-01-29", "10:00"))).requested).toBe(0); // dia anterior
    expect((await run(at(ISSUE, "08:59"))).requested).toBe(0); // dia certo, antes das 09:00
    expect(await n("issuance_requests")).toBe(0);
    const r = await run(at(ISSUE, "09:00"));
    expect(r.requested).toBe(2); expect(r.processed).toBe(2); expect(r.completed).toBe(1);
    expect(await n("issuance_requests where status = 'emitido' and kind = 'boleto'")).toBe(2);
    const [req] = await db.select().from(schema.issuanceRequests); expect(req.requestedBy).toBe(gerA);
    const b = await batchRow(); expect(b.autoDoneAt).toBeTruthy(); expect(b.autoRequestedAt).toBeTruthy();
    expect(await n("message_queue where kind = 'emissao' and channel = 'email' and status = 'pendente'")).toBe(2); // fila de avisos nasceu
    expect(await n("audit_log where action = 'billing.auto.completed'")).toBe(1);
    // idempotente: nova rodada não emite nem cria nada
    const again = await run(at(ISSUE, "09:30"));
    expect(again).toMatchObject({ requested: 0, processed: 0, completed: 0 });
    expect(await n("issuance_requests")).toBe(2);
    void id;
  });

  it("emissão pausada ou sem permissão do aprovador: nada sai (e volta a andar quando liberar)", async () => {
    await scheduled();
    const r = await run(at(ISSUE, "10:00")); // emissão nasce PAUSADA
    expect(r.requested).toBe(0); expect(r.waiting).toContain("Emissão pausada"); expect(await n("issuance_requests")).toBe(0);
    await saveIssuanceSettings(db, dirA, A, { paused: false, dailyLimit: 20 });
    await db.update(schema.memberships).set({ status: "removed" }).where(eq(schema.memberships.userId, gerA)); // aprovador perdeu o acesso
    await expect(run(at(ISSUE, "10:00"))).rejects.toThrow(Forbidden);
    expect(await n("issuance_requests")).toBe(0);
    await db.update(schema.memberships).set({ status: "active" }).where(eq(schema.memberships.userId, gerA));
    expect((await run(at(ISSUE, "10:05"))).processed).toBe(2);
  });

  it("limite diário menor que o lote: emite o que cabe hoje e termina no dia seguinte, sem pedir nada de novo", async () => {
    await scheduled();
    await saveIssuanceSettings(db, dirA, A, { paused: false, dailyLimit: 1 });
    const d1 = await run(at(ISSUE, "09:00"));
    expect(d1.processed).toBe(1); expect(d1.completed).toBe(0);
    expect((await batchRow()).autoDoneAt).toBeNull();
    const d2 = await run(at("2027-02-02", "09:00"));
    expect(d2.processed).toBe(1); expect(d2.completed).toBe(1);
    expect(await n("issuance_requests where status = 'emitido'")).toBe(2);
  });

  it("pedido cancelado de propósito NÃO é recriado pelo agendador; o lote conclui com o que foi emitido", async () => {
    await scheduled();
    await saveIssuanceSettings(db, dirA, A, { paused: false, dailyLimit: 1 });
    expect((await run(at(ISSUE, "09:00"))).processed).toBe(1); // 1 emitido, 1 pendente (limite do dia)
    await cancelPendingBoletos(db, dirA, A); // a pessoa cancela o que sobrou, de propósito
    const d2 = await run(at("2027-02-02", "09:00"));
    expect(d2.requested).toBe(0); expect(d2.processed).toBe(0); expect(d2.completed).toBe(1);
    expect(await n("issuance_requests where status = 'emitido'")).toBe(1);
    expect(await n("issuance_requests where status = 'cancelado'")).toBe(1);
    expect(await n("issuance_requests")).toBe(2); // nada novo foi criado
  });

  it("boleto REAL: lote aprovado ANTES de armar a empresa não é emitido (e com a chave do servidor desligada também não)", async () => {
    await scheduled();
    await db.insert(schema.issuanceSettings).values({ companyId: A, paused: false, dailyLimit: 20, boletoProvider: "cora_producao", liveAuthorizedBy: dirA, liveAuthorizedAt: new Date(Date.now() + 60_000), liveCanary: false })
      .onConflictDoUpdate({ target: schema.issuanceSettings.companyId, set: { paused: false, boletoProvider: "cora_producao", liveAuthorizedBy: dirA, liveAuthorizedAt: new Date(Date.now() + 60_000), liveCanary: false } });
    const old = process.env.CORA_PROD_EMISSION_ENABLED;
    try {
      process.env.CORA_PROD_EMISSION_ENABLED = "false";
      expect((await run(at(ISSUE, "10:00"))).waiting.join()).toMatch(/produção desligada/);
      process.env.CORA_PROD_EMISSION_ENABLED = "true";
      expect((await run(at(ISSUE, "10:00"))).waiting.join()).toMatch(/aprove de novo/);
      expect(await n("issuance_requests")).toBe(0);
    } finally { if (old === undefined) delete process.env.CORA_PROD_EMISSION_ENABLED; else process.env.CORA_PROD_EMISSION_ENABLED = old; }
  });

  it("desligar o faturamento automático impede a emissão (e religar retoma); a tela usa os mesmos feriados do agendador", async () => {
    await scheduled();
    await saveIssuanceSettings(db, dirA, A, { paused: false, dailyLimit: 20 });
    await setAutomation(db, dirA, A, false);
    expect((await run(at(ISSUE, "10:00"))).requested).toBe(0);
    expect(await n("issuance_requests")).toBe(0);
    await setAutomation(db, dirA, A, true);
    expect((await run(at(ISSUE, "10:05"))).processed).toBe(2);
    expect(await runDateOf(db, gerA, A, "2027-11-15")).toBe("2027-11-12"); // Proclamação da República (segunda) → sexta
    await db.insert(schema.holidays).values({ companyId: A, day: "2027-12-06", name: "Feriado local" });
    expect(await runDateOf(db, gerA, A, "2027-12-06")).toBe("2027-12-03");
  });

  it("reabrir o lote desfaz o agendamento", async () => {
    const id = await scheduled();
    await reopenBatch(db, gerA, A, id, "Corrigir um valor");
    const b = await batchRow();
    expect(b.status).toBe("rascunho"); expect(b.autoIssue).toBe(false); expect(b.autoRequestedAt).toBeNull(); expect(b.autoDoneAt).toBeNull();
  });

  it("aviso de EMISSÃO: fila criada depois da data entra para hoje SÓ se o boleto foi emitido (e antes do vencimento)", async () => {
    await contracts();
    const { batchId } = await generateBatch(db, asstA, A, ISSUE);
    const g = (await getBatch(db, asstA, A, batchId))!;
    await approveBatch(db, gerA, A, batchId, g.hash);
    await saveIssuanceSettings(db, dirA, A, { paused: false, dailyLimit: 20 });
    const c1 = (await db.select().from(schema.charges).where(eq(schema.charges.customerId, cli1)))[0];
    await requestIssuance(db, gerA, A, c1.id, "boleto"); // só o cliente 1 teve o boleto emitido
    await processIssuance(db, gerA, A, new Date(Date.now() + 60_000), providers());
    const r = await scheduleQueue(db, dirA, A, "2027-02-03"); // 2 dias depois da emissão, antes do vencimento (14/02)
    expect(r.created).toBeGreaterThan(0);
    const em = await db.select().from(schema.messageQueue).where(and(eq(schema.messageQueue.kind, "emissao"), eq(schema.messageQueue.channel, "email")));
    expect(em).toHaveLength(1); expect(em[0].chargeId).toBe(c1.id); expect(em[0].scheduledFor).toBe("2027-02-03");
    // depois do vencimento a emissão não é mais enviada
    await db.execute(sql`delete from message_queue`);
    await scheduleQueue(db, dirA, A, "2027-02-20");
    expect(await n("message_queue where kind = 'emissao'")).toBe(0);
  });

  it("conferência de pagamentos: simulado não confere; Cora com baixa automática mostra a última rodada e acusa parada", async () => {
    expect((await paymentSyncStatus(db, dirA, A)).active).toBe(false);
    await db.insert(schema.issuanceSettings).values({ companyId: A, paused: false, dailyLimit: 20, boletoProvider: "cora_homologacao", autoSettle: false });
    expect((await paymentSyncStatus(db, dirA, A)).reason).toMatch(/desligada/);
    await db.update(schema.issuanceSettings).set({ autoSettle: true }).where(eq(schema.issuanceSettings.companyId, A));
    const none = await paymentSyncStatus(db, dirA, A);
    expect(none.active).toBe(true); expect(none.stale).toBe(true); expect(none.lastAt).toBeNull();
    await db.insert(schema.auditLog).values({ companyId: A, actorId: null, action: "issuance.sync", detail: { checked: 8, paid: 1, failed: 0, needsReview: 0 } });
    const ok = await paymentSyncStatus(db, dirA, A);
    expect(ok).toMatchObject({ stale: false, checked: 8, paid: 1, webhook: false });
    expect((await paymentSyncStatus(db, dirA, A, new Date(Date.now() + 31 * 60_000))).stale).toBe(true);
    await expect(paymentSyncStatus(db, dirB, A)).rejects.toThrow(Forbidden);
  });
  void Invalid;
});
