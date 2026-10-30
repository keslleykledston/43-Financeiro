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
import { ensureWhatsappDefaults, saveSettings } from "@/modules/messaging/service";
import { FakeWaha } from "./helpers/fake-waha";
import { bindCompany, createSession, recordConsent, refreshSession, setPaused, type Deps } from "@/modules/whatsapp/service";
import { SEND_PHRASE, dispatchOutbox, queueCustomerMessage, saveCompanySettings, whatsappTemplateOptions } from "@/modules/whatsapp/outbound";
import { AUTO_PHRASE, getAutomation, reguaOverview, runWhatsappAutomation, saveAutomation, simulateRegua } from "@/modules/whatsapp/regua";
import { processInboundEvent } from "@/modules/whatsapp/inbound";

const enabled = !!process.env.POSTGRES_USER;
const ENV = { WAHA_API_KEY: "k", WAHA_BASE_INTERNAL_URL: "http://waha:3000", WHATSAPP_MODULE_ENABLED: "true", WHATSAPP_SEND_ENABLED: "true", WHATSAPP_AUTOMATION_ENABLED: "true", WHATSAPP_HOOK_HMAC_KEY: "k" };
const PHONE = "(92) 99999-0000", PHONE2 = "(92) 98888-1111", DIGITS = "5592999990000";
const D = "2026-10-01";
let seq = 0;
const k = () => `tentativa-${++seq}-${Math.random().toString(36).slice(2, 10)}`;
const terms = (o: Record<string, unknown> = {}) => ({ description: "Monitoramento de redes", monthlyAmount: "2.500,00", startAt: "2026-01-01", endAt: "", dueDay: "14", invoiceJointRequired: false, issueDayOverride: "", ...o });

describe.skipIf(!enabled)("W4 WhatsApp: régua automática (DB de teste, WAHA falsa) — desligada por padrão, no dia certo, com as mesmas travas do envio manual", () => {
  let admin: ReturnType<typeof postgres>, conn: ReturnType<typeof postgres>, db: DB;
  let A: string, B: string, dirA: string, dirB: string, gerA: string, asstA: string, cli1: string, cli2: string, sid: string, ch1: string, ch2: string, DUE: string, NOW: Date;
  let waha: FakeWaha, deps: Deps, tpl: Record<string, string>;
  const run = (o: Partial<Deps> & { pauseMs?: () => number } = {}) => runWhatsappAutomation(db, { ...deps, now: NOW, pauseMs: () => 0, ...o });
  const arm = async (kinds: string[] = ["d0"], daysAgo = 3) => {
    await saveAutomation(db, dirA, A, { enable: true, kinds, reference: "e-mail da diretoria de 30/10", phrase: AUTO_PHRASE });
    await db.execute(sql`update whatsapp_company_settings set automation_authorized_at = ${new Date(NOW.getTime() - daysAgo * 86400000).toISOString()}::timestamptz where company_id = ${A}`); // vale a partir do dia seguinte ao de ligar (relativo ao «hoje» simulado)
  };
  const outbox = () => db.select().from(schema.whatsappOutbox);
  const why = async (query: ReturnType<typeof sql>) => { try { await db.execute(query); return ""; } catch (e) { return (e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message; } };

  beforeAll(async () => {
    const base = databaseUrl();
    admin = postgres(base.replace(/\/k3gfinance$/, "/postgres"), { max: 1 });
    if (!(await admin`select 1 from pg_database where datname = 'k3gfinance_test'`).length) await admin.unsafe("create database k3gfinance_test");
    conn = postgres(base.replace(/\/k3gfinance$/, "/k3gfinance_test"), { max: 8 });
    db = drizzle(conn, { schema });
    await migrate(db, { migrationsFolder: "./drizzle" });
  });
  afterAll(async () => { await conn?.end(); await admin?.end(); });

  beforeEach(async () => {
    await db.execute(sql`truncate rate_limits, whatsapp_inbound_events, whatsapp_outbox, whatsapp_company_settings, whatsapp_consents, whatsapp_send_log, whatsapp_send_authorizations, whatsapp_session_companies, whatsapp_sessions, messaging_settings, message_queue, message_template_versions, message_templates, payments, charges, billing_batches, holidays, contract_versions, contracts, customer_contacts, customers, audit_log, invitations, memberships, companies, users restart identity cascade`);
    const [a, b] = await db.insert(schema.companies).values([{ name: "Empresa A" }, { name: "Empresa B" }]).returning();
    A = a.id; B = b.id;
    const mk = async (e: string) => (await db.insert(schema.users).values({ email: e, name: e.split("@")[0], passwordHash: "x" }).returning())[0].id;
    dirA = await mk("dir-a@t.com"); dirB = await mk("dir-b@t.com"); gerA = await mk("ger-a@t.com"); asstA = await mk("asst@t.com");
    await db.insert(schema.memberships).values([{ userId: dirA, companyId: A, role: "diretoria" }, { userId: dirB, companyId: B, role: "diretoria" }, { userId: gerA, companyId: A, role: "gerente" }, { userId: asstA, companyId: A, role: "assistente" }]);
    cli1 = (await createParty(db, dirA, A, { kind: "cliente", legalName: "Cliente Um LTDA", document: "11.222.333/0001-81" })).id;
    cli2 = (await createParty(db, dirA, A, { kind: "cliente", legalName: "Cliente Dois LTDA", document: "12.ABC.345/01DE-35" })).id;
    for (const c of [cli1, cli2]) { const ct = await createContract(db, asstA, A, c, terms()); await decideVersion(db, dirA, A, (await getContract(db, dirA, A, ct.id))!.versions[0].id, "aprovar"); }
    const { batchId } = await generateBatch(db, asstA, A, D);
    await approveBatch(db, dirA, A, batchId, (await getBatch(db, asstA, A, batchId))!.hash);
    const chs = await db.select().from(schema.charges);
    ch1 = chs.find((c) => c.customerId === cli1)!.id; ch2 = chs.find((c) => c.customerId === cli2)!.id;
    DUE = String(chs[0].dueDate); NOW = new Date(`${DUE}T16:00:00Z`); // meio-dia em Manaus, no dia do vencimento
    await db.insert(schema.customerContacts).values([
      { companyId: A, partyId: cli1, name: "Maria", email: "m@x.com", phone: PHONE, isFinancial: true, source: "manual" },
      { companyId: A, partyId: cli2, name: "João", email: "j@x.com", phone: PHONE2, isFinancial: true, source: "manual" },
    ]);
    waha = new FakeWaha(); deps = { waha, env: { ...ENV } };
    const win = { windowStart: "00:00", windowEnd: "23:59", weekdays: [0, 1, 2, 3, 4, 5, 6], skipHolidays: false, maxPerRun: "50", maxPerHour: "30", maxLateDays: "2" };
    await saveSettings(db, dirA, A, win); await saveSettings(db, dirB, B, win);
    sid = (await createSession(db, dirA, A, { displayName: "Financeiro", senderIdentity: "Financeiro Empresa A", confirmAuthorized: true }, deps)).sessionId;
    const prov = (await db.select().from(schema.whatsappSessions))[0].providerSession;
    waha.connect(prov); await refreshSession(db, dirA, A, sid, deps); await setPaused(db, dirA, A, sid, false);
    await ensureWhatsappDefaults(db, dirA, A);
    tpl = Object.fromEntries((await whatsappTemplateOptions(db, gerA, A)).map((t) => [t.kind, t.versionId]));
    await saveCompanySettings(db, dirA, A, { enable: true, reference: "autorização escrita", dailyCap: 10, phrase: SEND_PHRASE });
    for (const p of [PHONE, PHONE2]) await recordConsent(db, gerA, A, { phone: p, decision: "opt_in", scope: "company", evidenceSource: "escrito", evidenceRef: "e-mail de 28/10" });
  });

  it("nasce DESLIGADA: sem a chave do servidor, sem a régua da empresa ou sem a régua escolhida, NADA sai (e a empresa nem consegue ligar sem o envio liberado)", async () => {
    expect(await run()).toEqual([]);                                                                      // régua desligada na empresa: nenhuma empresa processada
    await arm(["d0"]);
    expect(await run({ env: { ...ENV, WHATSAPP_AUTOMATION_ENABLED: "false" } })).toEqual([]);            // chave do servidor desligada
    expect(await run({ env: { ...ENV, WHATSAPP_SEND_ENABLED: "false" } })).toEqual([]);                   // sem o envio, também não
    expect(waha.sent).toHaveLength(0);
    await db.execute(sql`truncate whatsapp_company_settings`);
    await expect(saveAutomation(db, dirA, A, { enable: true, kinds: ["d0"], reference: "e-mail da diretoria", phrase: AUTO_PHRASE })).rejects.toThrow(/libere a cobrança por WhatsApp/);
  });

  it("ligar exige diretoria, frase exata, referência e réguas válidas; gerente não liga; desligar o envio da empresa desliga a régua e suprime a fila automática", async () => {
    await expect(saveAutomation(db, gerA, A, { enable: true, kinds: ["d0"], reference: "e-mail da diretoria", phrase: AUTO_PHRASE })).rejects.toBeInstanceOf(Forbidden);
    const base = { enable: true, kinds: ["d0"], reference: "e-mail da diretoria", phrase: AUTO_PHRASE };
    await expect(saveAutomation(db, dirA, A, { ...base, phrase: "ligar" })).rejects.toThrow(/digite exatamente/);
    await expect(saveAutomation(db, dirA, A, { ...base, reference: "ok" })).rejects.toBeInstanceOf(Invalid);
    await expect(saveAutomation(db, dirA, A, { ...base, kinds: [] })).rejects.toBeInstanceOf(Invalid);
    await expect(saveAutomation(db, dirA, A, { ...base, kinds: ["d0", "emissao"] })).rejects.toBeInstanceOf(Invalid);   // emissão não é automática
    await saveAutomation(db, dirA, A, base);
    expect(await getAutomation(db, gerA, A, deps)).toMatchObject({ enabled: true, kinds: ["d0"], sendEnabled: true, serverOn: true });
    const q = await queueCustomerMessage(db, gerA, A, { chargeId: ch1, templateVersionId: tpl.d0, sessionId: sid, confirm: true, key: k(), origin: "regua" }, deps);
    await saveCompanySettings(db, dirA, A, { enable: false });                                              // desliga o envio: a régua depende dele
    expect((await getAutomation(db, dirA, A, deps)).enabled).toBe(false);
    expect((await outbox()).find((o) => o.id === q.outboxId)).toMatchObject({ status: "suprimido", reason: "empresa_desligada", origin: "regua" });
    expect(JSON.stringify((await db.select().from(schema.auditLog)).map((a) => [a.action, a.detail]))).not.toMatch(/5592|99999/);
    await expect(db.execute(sql`update whatsapp_company_settings set automation_enabled = true, send_enabled = false where company_id = ${A}`)).rejects.toThrow();   // o banco também exige o envio
  });

  it("no DIA do marco, com tudo verde, envia (origem «régua», nome e valor certos); repetir o ciclo não duplica; só a partir do dia SEGUINTE ao de ligar", async () => {
    await arm(["d0"], 0);                                                                                    // ligada «hoje» (o mesmo dia simulado)
    expect((await run())[0]).toMatchObject({ sent: 0, queued: 0 });                                         // ligada hoje: só vale amanhã
    await arm(["d0"], 3);
    const r = (await run())[0];
    expect(r).toMatchObject({ companyId: A, queued: 2, sent: 2, failed: 0, paused: null });
    const o = await outbox();
    expect(o).toHaveLength(2); expect(o.every((x) => x.origin === "regua" && x.status === "enviado" && x.milestone === "d0")).toBe(true);
    expect(waha.sent).toHaveLength(2); expect(waha.sent[0].text).toMatch(/Cliente (Um|Dois)/);
    expect(waha.sent.every((m) => /PARAR/.test(m.text))).toBe(true);
    expect((await run())[0]).toMatchObject({ queued: 0, sent: 0 });                                          // segundo ciclo: nada novo
    expect(waha.sent).toHaveLength(2);
    expect((await db.select().from(schema.auditLog)).filter((a) => a.action === "whatsapp.regua.queued")).toHaveLength(2);
  });

  it("só o marco ligado: D-3 liga, D0 não; o dia errado não envia nada (sem recuperar dia perdido)", async () => {
    await arm(["d_menos_3"], 5);
    expect((await run())[0]).toMatchObject({ queued: 0 });                                                  // hoje é D0, e só o D-3 está ligado
    const before = new Date(NOW.getTime() - 3 * 86400000);
    expect((await run({ now: before }))[0]).toMatchObject({ queued: 2, sent: 2 });                          // 3 dias antes: é o D-3
    expect((await outbox()).every((x) => x.milestone === "d_menos_3")).toBe(true);
    const late = new Date(NOW.getTime() + 2 * 86400000);                                                     // dois dias depois o D-3 NÃO é recuperado
    expect((await run({ now: late }))[0]).toMatchObject({ queued: 0 });
  });

  it("as MESMAS travas do manual: sem consentimento, pedido de parar, resposta pendente, cobrança paga e aviso recente (7 dias) NÃO saem", async () => {
    await arm(["d0"]);
    await recordConsent(db, gerA, A, { phone: PHONE, decision: "opt_out", scope: "company", evidenceSource: "cliente_iniciou", evidenceRef: "resposta no WhatsApp" });   // cli1 pediu para parar
    await db.insert(schema.whatsappInboundEvents).values({ eventKey: "evt_x1", eventType: "message", providerSession: "k3g-x", companyId: A, customerId: cli2, phone: "559288881111", phoneMasked: "+55 92 •••••-1111", kind: "texto", classification: "resposta", routing: "atribuida", handling: "novo", processedAt: new Date() });   // cli2 respondeu (12 dígitos, como a WAHA devolve)
    expect((await run())[0]).toMatchObject({ queued: 0, sent: 0 });
    await db.execute(sql`update whatsapp_inbound_events set handling = 'resolvido'`);                         // resolvida: cli2 voltaria a valer…
    await db.execute(sql`insert into payments (company_id, charge_id, amount, paid_at, method, status, registered_by) select company_id, id, amount, current_date, 'pix', 'ativo', ${dirA}::uuid from charges where id = ${ch2}::uuid`);   // …mas PAGOU
    expect((await run())[0]).toMatchObject({ queued: 0, sent: 0 });
    await recordConsent(db, gerA, A, { phone: PHONE, decision: "opt_in", scope: "company", evidenceSource: "escrito", evidenceRef: "e-mail de 30/10" });   // cli1 consente de novo…
    const m = await queueCustomerMessage(db, gerA, A, { chargeId: ch1, templateVersionId: tpl.d_mais_3, sessionId: sid, confirm: true, key: k() }, deps);
    await dispatchOutbox(db, gerA, A, m.outboxId, deps);                                                     // …mas já recebeu um aviso manual hoje
    expect((await run())[0]).toMatchObject({ queued: 0, sent: 0 });
    expect(waha.sent).toHaveLength(1);                                                                       // só o manual
  });

  it("pagamento DEPOIS de entrar na fila: não sai (relê a dívida no envio); o que ficou na fila de um dia anterior é suprimido («fora do dia»); desligar suprime a fila automática", async () => {
    await arm(["d0"]);
    await recordConsent(db, gerA, A, { phone: PHONE2, decision: "opt_out", scope: "company", evidenceSource: "cliente_iniciou", evidenceRef: "resposta no WhatsApp" });   // só cli1 está em jogo
    const q = await queueCustomerMessage(db, gerA, A, { chargeId: ch1, templateVersionId: tpl.d0, sessionId: sid, confirm: true, key: "regua-manual-q1", origin: "regua" }, deps);
    await db.execute(sql`insert into payments (company_id, charge_id, amount, paid_at, method, status, registered_by) select company_id, id, amount, current_date, 'pix', 'ativo', ${dirA}::uuid from charges where id = ${ch1}::uuid`);   // PAGOU depois de entrar na fila
    const r = (await run())[0];
    expect(r.sent).toBe(0); expect(r.failed + r.waiting).toBeGreaterThanOrEqual(1);
    expect((await outbox()).find((o) => o.id === q.outboxId)).toMatchObject({ status: "suprimido", reason: "pago_ou_cancelada" });
    expect(waha.sent).toHaveLength(0);
    await recordConsent(db, gerA, A, { phone: PHONE2, decision: "opt_in", scope: "company", evidenceSource: "escrito", evidenceRef: "e-mail de 30/10" });
    const q2 = await queueCustomerMessage(db, gerA, A, { chargeId: ch2, templateVersionId: tpl.d_mais_3, sessionId: sid, confirm: true, key: "regua-manual-q2", origin: "regua" }, deps);
    const r2 = (await run({ now: new Date(Date.now() + 2 * 86400000) }))[0];                                // dias depois: a fila de ontem NÃO sai
    expect(r2.stale).toBe(1);
    expect((await outbox()).find((o) => o.id === q2.outboxId)).toMatchObject({ status: "suprimido", reason: "fora_do_dia" });
    expect(waha.sent).toHaveLength(0);
    const q3 = await queueCustomerMessage(db, gerA, A, { chargeId: ch2, templateVersionId: tpl.d_mais_7, sessionId: sid, confirm: true, key: "regua-manual-q3", origin: "regua" }, deps);
    await saveAutomation(db, dirA, A, { enable: false });
    expect((await outbox()).find((o) => o.id === q3.outboxId)).toMatchObject({ status: "suprimido", reason: "regua_desligada" });
  });

  it("mensagem de origem «régua» NÃO sai pelo botão «Enviar» do histórico se a régua (ou aquele marco, ou a chave do servidor) estiver desligada", async () => {
    await arm(["d0"]);
    const mk = (chargeId: string, tplId: string) => queueCustomerMessage(db, gerA, A, { chargeId, templateVersionId: tplId, sessionId: sid, confirm: true, key: k(), origin: "regua" }, deps);
    const a = await mk(ch1, tpl.d0);
    await expect(dispatchOutbox(db, gerA, A, a.outboxId, { ...deps, env: { ...ENV, WHATSAPP_AUTOMATION_ENABLED: "false" } })).rejects.toThrow(/régua automática está desligada/);   // chave do servidor
    const b = await mk(ch2, tpl.d_mais_3);                                                                  // marco que NÃO está ligado (só o D0 está)
    await expect(dispatchOutbox(db, gerA, A, b.outboxId, deps)).rejects.toThrow(/régua automática está desligada/);
    const c = await mk(ch2, tpl.d0);
    await db.execute(sql`update whatsapp_company_settings set automation_enabled = false where company_id = ${A}`);   // empresa desligada (sem passar pela fila suprimida)
    await expect(dispatchOutbox(db, gerA, A, c.outboxId, deps)).rejects.toThrow(/régua automática está desligada/);
    expect((await outbox()).filter((o) => o.reason === "regua_desligada")).toHaveLength(3);
    expect(waha.sent).toHaveLength(0);
    const manual = await queueCustomerMessage(db, gerA, A, { chargeId: ch1, templateVersionId: tpl.d_mais_7, sessionId: sid, confirm: true, key: k() }, deps);   // o MANUAL segue normal
    await dispatchOutbox(db, gerA, A, manual.outboxId, deps);
    expect(waha.sent).toHaveLength(1);
  });

  it("quem ligou a régua perde a permissão → ela PARA (nada sai) e o painel avisa; falha e «sem confirmação» NUNCA tentam de novo sozinhas", async () => {
    await arm(["d0"]);
    waha.sendMode = "unknown";
    expect((await run())[0]).toMatchObject({ queued: 2, sent: 0, failed: 2 });
    expect((await outbox()).every((o) => o.status === "desconhecido")).toBe(true);
    waha.sendMode = "ok";
    expect((await run())[0]).toMatchObject({ queued: 0, sent: 0 });                                          // o mesmo marco não é tentado de novo
    expect(waha.sent).toHaveLength(0);
    await db.execute(sql`truncate whatsapp_outbox`);
    await db.execute(sql`update memberships set status = 'removed' where user_id = ${dirA}::uuid`);
    expect((await run())[0]).toMatchObject({ paused: "responsavel_sem_permissao", sent: 0, queued: 0 });
    await db.execute(sql`update memberships set status = 'active' where user_id = ${dirA}::uuid`);
    expect((await run())[0]).toMatchObject({ paused: null, queued: 2 });
  });

  it("simulação não envia nada, mostra o motivo e exige permissão; o painel conta enviadas/entregues/suprimidas e as pagas depois do aviso (só correlação)", async () => {
    await expect(simulateRegua(db, asstA, A, { day: DUE }, deps)).rejects.toBeInstanceOf(Forbidden);
    await recordConsent(db, gerA, A, { phone: PHONE, decision: "opt_out", scope: "company", evidenceSource: "cliente_iniciou", evidenceRef: "resposta no WhatsApp" });
    const s = await simulateRegua(db, gerA, A, { day: DUE, kinds: ["d0"] }, { ...deps, now: NOW });
    expect(waha.sent).toHaveLength(0); expect(await outbox()).toHaveLength(0);
    expect(s.rows.find((r) => r.customer.startsWith("Cliente Um"))).toMatchObject({ outcome: "nunca", armed: false });
    expect(s.rows.find((r) => r.customer.startsWith("Cliente Dois"))).toMatchObject({ outcome: "sairia", why: null });
    expect((await simulateRegua(db, gerA, A, { day: "2026-01-01" }, deps)).rows).toHaveLength(0);
    await arm(["d0"]);
    await run();
    await db.execute(sql`update whatsapp_outbox set delivery = 'lido', delivered_at = now(), read_at = now() where status = 'enviado'`);
    await db.execute(sql`insert into payments (company_id, charge_id, amount, paid_at, method, status, registered_by) select company_id, id, amount, current_date, 'pix', 'ativo', ${dirA}::uuid from charges where id = ${ch2}::uuid`);
    const ov = await reguaOverview(db, gerA, A, 30, deps);
    expect(ov.totals).toMatchObject({ sent: 1, delivered: 1, read: 1, byOrigin: { regua: 1 } });
    expect(ov.status).toMatchObject({ serverOn: true, automationEnabled: true, actorOk: true, connected: true });
    expect(ov.optOuts).toBe(1); expect(ov.paidAfterNotice.charges).toBe(1); expect(ov.paidAfterNotice.cents).toBeGreaterThan(0);
    await expect(reguaOverview(db, asstA, A, 30, deps)).rejects.toBeInstanceOf(Forbidden);
  });

  it("isolamento: a régua da empresa A não toca na B; a origem é imutável e o histórico não se apaga", async () => {
    await arm(["d0"]);
    await run();
    expect((await outbox()).every((o) => o.companyId === A)).toBe(true);
    expect((await getAutomation(db, dirB, B, deps)).enabled).toBe(false);
    expect(await why(sql`update whatsapp_outbox set origin = 'manual'`)).toMatch(/identidade|não podem ser alterados/);
    expect(await why(sql`delete from whatsapp_outbox`)).toMatch(/permanente/);
    void processInboundEvent; void bindCompany; void eq;
  });
});
