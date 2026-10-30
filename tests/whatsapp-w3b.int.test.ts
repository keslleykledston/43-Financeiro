import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { eq, sql } from "drizzle-orm";
import { databaseUrl } from "@/lib/db/url";
import * as schema from "@/lib/db/schema";
import type { DB } from "@/lib/db";
import { Forbidden } from "@/modules/identity/service";
import { createParty } from "@/modules/crm/service";
import { createContract, decideVersion, getContract } from "@/modules/contracts/service";
import { approveBatch, generateBatch, getBatch } from "@/modules/billing/batches";
import { ensureWhatsappDefaults, saveSettings } from "@/modules/messaging/service";
import { FakeWaha } from "./helpers/fake-waha";
import { bindCompany, consentState, createSession, recordConsent, refreshSession, setPaused, type Deps } from "@/modules/whatsapp/service";
import { SEND_PHRASE, dispatchOutbox, evaluateCustomerSend, queueCustomerMessage, saveCompanySettings, whatsappTemplateOptions } from "@/modules/whatsapp/outbound";
import { WEBHOOK_MAX_BYTES, __resetHookLimiter, readBodyCapped, assignTriage, discardTriage, listInbox, listTriage, hasOpenReply, markDispute, optOutFromInbox, processInboundEvent, processPendingInbound, receiveWahaWebhook, setHandling, verifyHmac } from "@/modules/whatsapp/inbound";
import { open } from "@/lib/security/secretbox";

const enabled = !!process.env.POSTGRES_USER;
const KEY = "chave-hmac-de-teste-0123456789abcdef";
const ENV = { WAHA_API_KEY: "k", WAHA_BASE_INTERNAL_URL: "http://waha:3000", WHATSAPP_MODULE_ENABLED: "true", WHATSAPP_SEND_ENABLED: "true", WHATSAPP_HOOK_HMAC_KEY: KEY };
const PHONE = "(92) 99999-0000", DIGITS = "5592999990000", OTHER = "5592988881111" /* contato do 2º cliente */, UNKNOWN = "5592977770000" /* ninguém cadastrado */;
const D = "2026-10-01";
let seq = 0;
const k = () => `tentativa-${++seq}-${Math.random().toString(36).slice(2, 10)}`;
const terms = (o: Record<string, unknown> = {}) => ({ description: "Monitoramento de redes", monthlyAmount: "2.500,00", startAt: "2026-01-01", endAt: "", dueDay: "14", invoiceJointRequired: false, issueDayOverride: "", ...o });

describe.skipIf(!enabled)("W3b WhatsApp: webhook assinado, respostas, pedido de parar, entrega, caixa de entrada e triagem (DB de teste, WAHA falsa)", () => {
  let admin: ReturnType<typeof postgres>, conn: ReturnType<typeof postgres>, db: DB;
  let A: string, B: string, dirAB: string, dirA: string, dirB: string, gerA: string, gerB: string, asstA: string, contA: string, techA: string, cli1: string, cli2: string, sid: string, provSession: string;
  let waha: FakeWaha, deps: Deps, tpl: Record<string, string>, ch1: string, ch2: string, evN = 0;

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
    dirAB = await mk("dir-ab@t.com"); dirA = await mk("dir-a@t.com"); dirB = await mk("dir-b@t.com"); gerA = await mk("ger-a@t.com"); gerB = await mk("ger-b@t.com"); asstA = await mk("asst@t.com"); contA = await mk("cont@t.com"); techA = await mk("tech@t.com");
    await db.insert(schema.memberships).values([
      { userId: dirAB, companyId: A, role: "diretoria" }, { userId: dirAB, companyId: B, role: "diretoria" }, { userId: dirA, companyId: A, role: "diretoria" }, { userId: dirB, companyId: B, role: "diretoria" },
      { userId: gerA, companyId: A, role: "gerente" }, { userId: gerB, companyId: B, role: "gerente" }, { userId: asstA, companyId: A, role: "assistente" }, { userId: contA, companyId: A, role: "contabilidade" }, { userId: techA, companyId: A, role: "admin_tecnico" },
    ]);
    cli1 = (await createParty(db, dirA, A, { kind: "cliente", legalName: "Cliente Um LTDA", document: "11.222.333/0001-81" })).id;
    cli2 = (await createParty(db, dirA, A, { kind: "cliente", legalName: "Cliente Dois LTDA", document: "12.ABC.345/01DE-35" })).id;
    for (const c of [cli1, cli2]) { const ct = await createContract(db, asstA, A, c, terms()); await decideVersion(db, dirA, A, (await getContract(db, dirA, A, ct.id))!.versions[0].id, "aprovar"); }
    const { batchId } = await generateBatch(db, asstA, A, D);
    await approveBatch(db, dirA, A, batchId, (await getBatch(db, asstA, A, batchId))!.hash);
    const chs = await db.select().from(schema.charges);
    ch1 = chs.find((c) => c.customerId === cli1)!.id; ch2 = chs.find((c) => c.customerId === cli2)!.id;
    await db.insert(schema.customerContacts).values([
      { companyId: A, partyId: cli1, name: "Maria", email: "m@x.com", phone: PHONE, isFinancial: true, source: "manual" },
      { companyId: A, partyId: cli2, name: "João", email: "j@x.com", phone: "(92) 98888-1111", isFinancial: true, source: "manual" },
    ]);
    __resetHookLimiter();
    waha = new FakeWaha(); deps = { waha, env: { ...ENV } };
    const win = { windowStart: "00:00", windowEnd: "23:59", weekdays: [0, 1, 2, 3, 4, 5, 6], skipHolidays: false, maxPerRun: "50", maxPerHour: "30", maxLateDays: "2" };
    await saveSettings(db, dirAB, A, win); await saveSettings(db, dirAB, B, win);
    sid = (await createSession(db, dirA, A, { displayName: "Financeiro", senderIdentity: "Financeiro Empresa A", confirmAuthorized: true }, deps)).sessionId;
    provSession = (await db.select().from(schema.whatsappSessions))[0].providerSession;
    waha.connect(provSession); await refreshSession(db, dirA, A, sid, deps); await setPaused(db, dirA, A, sid, false);
    await ensureWhatsappDefaults(db, dirA, A);
    tpl = Object.fromEntries((await whatsappTemplateOptions(db, gerA, A)).map((t) => [t.kind, t.versionId]));
    await saveCompanySettings(db, dirA, A, { enable: true, reference: "autorização escrita", dailyCap: 10, phrase: SEND_PHRASE });
    for (const p of [PHONE, "(92) 98888-1111"]) await recordConsent(db, gerA, A, { phone: p, decision: "opt_in", scope: "company", evidenceSource: "escrito", evidenceRef: "e-mail de 28/10" });
  });

  // ---------- helpers ----------
  const sign = (raw: Buffer, key = KEY) => createHmac("sha512", key).update(raw).digest("hex");
  type Over = { key?: string; alg?: string | null; ts?: number; tamper?: boolean; hmac?: string | null; env?: Record<string, string | undefined>; now?: Date };
  const hook = async (event: string, payload: Record<string, unknown>, o: Over & { session?: string; id?: string } = {}) => {
    const body = { id: o.id ?? `evt_${++evN}_${Math.random().toString(36).slice(2, 10)}`, timestamp: Date.now(), event, session: o.session ?? provSession, me: null, payload };
    const raw = Buffer.from(JSON.stringify(body));
    const signed = o.hmac !== undefined ? o.hmac : sign(raw, o.key);
    const sent = o.tamper ? Buffer.from(JSON.stringify({ ...body, payload: { ...payload, body: "outra coisa" } })) : raw;
    const r = await receiveWahaWebhook(db, sent, { hmac: signed, algorithm: o.alg === undefined ? "sha512" : o.alg, timestamp: String(o.ts ?? Date.now()), contentLength: String(sent.length) }, o.env ?? { ...ENV }, o.now ?? new Date(), deps);
    return { ...r, id: body.id };
  };
  const msg = (from: string, body: string, extra: Record<string, unknown> = {}) => hook("message", { from, fromMe: false, body, hasMedia: false, ...extra });
  const msgO = (from: string, body: string, o: Over) => hook("message", { from, fromMe: false, body, hasMedia: false }, o);   // com opções de assinatura/tempo
  const events = () => db.select().from(schema.whatsappInboundEvents);
  const sentOnce = async (chargeId = ch1, phone = DIGITS) => { // deixa uma conversa recente da empresa A com o número
    const q = await queueCustomerMessage(db, gerA, A, { chargeId, templateVersionId: tpl.d0, sessionId: sid, confirm: true, key: k() }, deps);
    await dispatchOutbox(db, gerA, A, q.outboxId, deps); void phone; return q.outboxId;
  };
  const why = async (query: ReturnType<typeof sql>) => { try { await db.execute(query); return ""; } catch (e) { return (e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message; } };

  it("A13 assinatura: só HMAC-SHA512 do corpo BRUTO, em tempo constante, dentro da janela e do tamanho; qualquer falha não grava nada; sem chave no servidor = nada entra (503)", async () => {
    expect((await msg(`${DIGITS}@c.us`, "oi")).status).toBe(202);
    expect(await events()).toHaveLength(1);
    await db.execute(sql`truncate whatsapp_inbound_events`);
    const bad: [string, Over, number][] = [
      ["assinatura errada", { hmac: "0".repeat(128) }, 401], ["sem assinatura", { hmac: null }, 401], ["algoritmo errado", { alg: "sha256" }, 401], ["sem algoritmo", { alg: null }, 401], ["chave errada", { key: "outra-chave" }, 401],
      ["corpo alterado depois de assinar", { tamper: true }, 401], ["hex curto", { hmac: "abc" }, 401], ["tempo vencido (replay)", { ts: Date.now() - 20 * 60_000 }, 401], ["tempo no futuro", { ts: Date.now() + 20 * 60_000 }, 401],
      ["sem chave no servidor", { env: { ...ENV, WHATSAPP_HOOK_HMAC_KEY: undefined } }, 503],
    ];
    for (const [name, o, code] of bad) expect((await msgO(`${DIGITS}@c.us`, "oi", o)).status, name).toBe(code);
    expect(await events()).toHaveLength(0);
    // corpo gigante: 413 (pelo cabeçalho e pelo tamanho real); JSON inválido assinado: 400
    const big = Buffer.alloc(WEBHOOK_MAX_BYTES + 1, 65);
    expect((await receiveWahaWebhook(db, big, { hmac: sign(big), algorithm: "sha512", timestamp: String(Date.now()), contentLength: String(big.length) }, { ...ENV }, new Date(), deps)).status).toBe(413);
    expect((await receiveWahaWebhook(db, Buffer.from("x"), { hmac: sign(Buffer.from("x")), algorithm: "sha512", timestamp: String(Date.now()), contentLength: "999999999" }, { ...ENV }, new Date(), deps)).status).toBe(413);
    const junk = Buffer.from("{nao é json");
    expect((await receiveWahaWebhook(db, junk, { hmac: sign(junk), algorithm: "sha512", timestamp: String(Date.now()), contentLength: String(junk.length) }, { ...ENV }, new Date(), deps)).status).toBe(400);
    expect(await events()).toHaveLength(0);
    expect(verifyHmac(Buffer.from("a"), sign(Buffer.from("a")), "SHA512", KEY)).toBe(true);   // algoritmo sem diferença de caixa
    expect(verifyHmac(Buffer.from("a"), sign(Buffer.from("a")).toUpperCase(), "sha512", KEY)).toBe(true);
  });

  it("tentativas inválidas em excesso viram 429 (e nada é gravado); uma assinatura boa continua passando antes do limite", async () => {
    let last = 0;
    const auditsBefore = (await db.select().from(schema.auditLog)).length;
    for (let i = 0; i < 62; i++) last = (await msgO(`${DIGITS}@c.us`, "oi", { hmac: "0".repeat(128) })).status;
    expect(last).toBe(429);
    expect(await events()).toHaveLength(0);
    expect(await db.select().from(schema.auditLog)).toHaveLength(auditsBefore);                                               // nem auditoria
    expect((await db.execute(sql`select count(*)::int n from rate_limits`) as unknown as { n: number }[])[0].n).toBe(0);   // nenhuma escrita no banco por tentativa inválida
    expect((await msg(`${DIGITS}@c.us`, "oi")).status).toBe(202);                                                          // a assinatura BOA continua passando
  });

  it("A14 o mesmo aviso duas vezes (ou em paralelo) vira UM registro; evento fora do que usamos, eco da própria conta, grupo, canal, status e conexão desconhecida são aceitos e descartados", async () => {
    const id = "evt_fixo_0001";
    const r = await Promise.all([1, 2, 3].map(() => hook("message", { from: `${DIGITS}@c.us`, fromMe: false, body: "oi" }, { id })));
    expect(r.every((x) => x.status === 202)).toBe(true);
    expect(await events()).toHaveLength(1);
    await db.execute(sql`truncate whatsapp_inbound_events`);
    for (const [e, p, o] of [["message", { from: `${DIGITS}@c.us`, fromMe: true, body: "eco" }, {}], ["message", { from: "120363025246125486@g.us", fromMe: false, body: "grupo" }, {}], ["message", { from: "status@broadcast", fromMe: false, body: "x" }, {}],
      ["message", { from: "1203630@newsletter", fromMe: false, body: "canal" }, {}], ["presence.update", { from: `${DIGITS}@c.us` }, {}], ["message", { from: `${DIGITS}@c.us`, body: "x" }, { session: "k3g-ffffffff" }], ["message", { from: `${DIGITS}@c.us`, body: "x" }, { session: "default" }],
      ["message", { from: "", body: "x" }, {}]] as [string, Record<string, unknown>, { session?: string }][]) expect((await hook(e, p, o)).status).toBe(202);
    expect(await events()).toHaveLength(0);
  });

  it("roteamento DETERMINÍSTICO: conversa recente de UMA empresa → essa empresa; contato único → essa empresa; contato em duas empresas ou número desconhecido → triagem (sem empresa)", async () => {
    await bindCompany(db, dirAB, A, sid, { targetCompanyId: B, senderIdentity: "Financeiro Empresa B", confirm: true });
    await msg(`${DIGITS}@c.us`, "oi, tudo bem?");                                              // contato só da A (sem conversa): contexto
    let [e] = await events();
    expect(e).toMatchObject({ routing: "atribuida", companyId: A, customerId: cli1, phone: DIGITS, classification: "resposta", handling: "novo" });
    await db.execute(sql`truncate whatsapp_inbound_events`);
    await msg(`${UNKNOWN}@c.us`, "bom dia");                                                      // número desconhecido: triagem
    [e] = await events();
    expect(e).toMatchObject({ routing: "triagem", companyId: null, classification: "resposta" });
    await db.execute(sql`truncate whatsapp_inbound_events`);
    await db.insert(schema.customerContacts).values({ companyId: B, partyId: (await createParty(db, dirB, B, { kind: "cliente", legalName: "Cliente da B", document: "45.723.174/0001-10" })).id, name: "Pedro", email: "p@b.com", phone: PHONE, isFinancial: true, source: "manual" });
    await msg(`${DIGITS}@c.us`, "oi");                                                          // o MESMO telefone é contato em A e em B: ambíguo → triagem
    [e] = await events();
    expect(e).toMatchObject({ routing: "triagem", companyId: null });
    // conversa recente da A com o número desfaz a ambiguidade (A falou por último, B não)
    await db.execute(sql`truncate whatsapp_inbound_events`);
    await sentOnce();
    await msg(`${DIGITS}@c.us`, "recebi, obrigado");
    [e] = await events();
    expect(e).toMatchObject({ routing: "atribuida", companyId: A });
  });

  it("A15 triagem é invisível às empresas: caixa da A e da B não mostram; só quem é diretoria em TODAS as empresas da conexão vê, atribui ou descarta; nome de empresa alheia não vaza", async () => {
    await bindCompany(db, dirAB, A, sid, { targetCompanyId: B, senderIdentity: "Financeiro Empresa B", confirm: true });
    await msg(`${UNKNOWN}@c.us`, "alguém aí?");
    expect(await listInbox(db, dirA, A)).toEqual([]); expect(await listInbox(db, dirB, B)).toEqual([]); expect(await listInbox(db, gerA, A)).toEqual([]);
    expect(await listTriage(db, dirA)).toEqual([]); expect(await listTriage(db, dirB)).toEqual([]); expect(await listTriage(db, gerA)).toEqual([]); expect(await listTriage(db, asstA)).toEqual([]);
    const t = await listTriage(db, dirAB);
    expect(t).toHaveLength(1); expect(t[0]).toMatchObject({ phone: "+55 92 •••••-0000", body: "alguém aí?", classification: "resposta" }); expect(t[0].companies.map((c) => c.name).sort()).toEqual(["Empresa A", "Empresa B"]);
    await expect(assignTriage(db, dirA, t[0].id, A)).rejects.toThrow(/Mensagem não encontrada/);        // dirA não é diretoria da B
    await expect(assignTriage(db, dirAB, t[0].id, "00000000-0000-4000-8000-000000000000")).rejects.toThrow(/empresa da conexão/);
    await assignTriage(db, dirAB, t[0].id, B);
    expect(await listTriage(db, dirAB)).toEqual([]);
    expect((await listInbox(db, gerB, B)).map((i) => i.body)).toEqual(["alguém aí?"]);                  // agora é da B
    expect(await listInbox(db, gerA, A)).toEqual([]);                                                    // a A continua sem ver
    await msg(`${UNKNOWN}@c.us`, "segunda"); const t2 = await listTriage(db, dirAB);
    await discardTriage(db, dirAB, t2[0].id);
    expect((await events()).find((x) => x.id === t2[0].id)).toMatchObject({ routing: "descartada", handling: "resolvido" });
    await expect(discardTriage(db, dirAB, t2[0].id)).rejects.toThrow(/Mensagem não encontrada/);
  });

  it("A07 PARAR: registra o pedido de parar NA HORA como consentimento do sistema (sem telefone na auditoria), suprime a fila da empresa e bloqueia o envio; a outra empresa não é afetada", async () => {
    await bindCompany(db, dirAB, A, sid, { targetCompanyId: B, senderIdentity: "Financeiro Empresa B", confirm: true });
    await sentOnce();
    const q2 = await queueCustomerMessage(db, gerA, A, { chargeId: ch2, templateVersionId: tpl.d0, sessionId: sid, confirm: true, key: k() }, deps);   // outra cobrança, outro cliente: não deve ser afetada
    const q3 = await db.execute(sql`select 1`); void q3;
    await msg(`${DIGITS}@c.us`, "PARAR");
    const [e] = await events();
    expect(e).toMatchObject({ classification: "opt_out", routing: "atribuida", companyId: A, optoutApplied: "company", handling: "resolvido", needsReview: false });
    expect((await consentState(db, A, DIGITS)).state).toBe("opt_out_company");
    expect((await consentState(db, B, DIGITS)).state).toBe("none");                                     // a B nunca teve consentimento: segue sem; e nada global
    const c = (await db.select().from(schema.whatsappConsents)).filter((x) => x.decision === "opt_out");
    expect(c).toHaveLength(1); expect(c[0]).toMatchObject({ scope: "company", evidenceSource: "cliente_iniciou", companyId: A });
    expect((await db.select().from(schema.users).where(eq(schema.users.id, c[0].actorId)))[0]).toMatchObject({ email: "sistema-whatsapp@k3g.invalid", name: "WhatsApp (automático)" });
    expect(JSON.stringify((await db.select().from(schema.auditLog)).map((a) => [a.action, a.detail]))).not.toMatch(/5592|99999|PARAR/);
    const q = await db.select().from(schema.whatsappOutbox);
    expect(q.find((r) => r.id === q2.outboxId)!.status).toBe("na_fila");                                  // outro cliente: intacto
    const ev = await evaluateCustomerSend(db, gerA, A, { chargeId: ch1, templateVersionId: tpl.d_mais_3, sessionId: sid }, deps);
    expect(ev.canSend).toBe(false); expect(ev.checks.find((x) => x.key === "consent")).toMatchObject({ ok: false });
    await msg(`${DIGITS}@c.us`, "parar de novo");                                                          // repetir não duplica o registro
    expect((await db.select().from(schema.whatsappConsents)).filter((x) => x.decision === "opt_out")).toHaveLength(1);
  });

  it("PARAR com mensagem na fila do MESMO cliente: a fila é suprimida (optout) e nada sai", async () => {
    const a = await queueCustomerMessage(db, gerA, A, { chargeId: ch1, templateVersionId: tpl.d0, sessionId: sid, confirm: true, key: k() }, deps);
    await msg(`${DIGITS}@c.us`, "Pare por favor!");
    expect((await db.select().from(schema.whatsappOutbox)).find((r) => r.id === a.outboxId)).toMatchObject({ status: "suprimido", reason: "optout" });
    await expect(dispatchOutbox(db, gerA, A, a.outboxId, deps)).rejects.toThrow(/já foi processada \(Suprimido\)/);
    expect(waha.sent).toHaveLength(0);
  });

  it("pedido AMBÍGUO bloqueia (conservador) e vai para humano; «nenhuma mensagem de ninguém» vale para TODAS as empresas; número desconhecido que pede parar vira bloqueio GLOBAL com revisão", async () => {
    await bindCompany(db, dirAB, A, sid, { targetCompanyId: B, senderIdentity: "Financeiro Empresa B", confirm: true });
    await msg(`${DIGITS}@c.us`, "quero cancelar o contrato");
    let e = (await events()).at(-1)!;
    expect(e).toMatchObject({ classification: "opt_out_ambiguo", optoutApplied: "company", needsReview: true, handling: "novo", companyId: A });
    expect((await consentState(db, A, DIGITS)).state).toBe("opt_out_company");
    await db.execute(sql`truncate whatsapp_inbound_events, whatsapp_consents`);
    await msg(`${DIGITS}@c.us`, "não me envie nenhuma mensagem");                                          // pede parar TUDO
    e = (await events()).at(-1)!;
    expect(e).toMatchObject({ classification: "opt_out", optoutApplied: "global", companyId: A });
    expect((await consentState(db, A, DIGITS)).state).toBe("opt_out_global");
    expect((await consentState(db, B, DIGITS)).state).toBe("opt_out_global");                             // B também bloqueada
    await db.execute(sql`truncate whatsapp_inbound_events, whatsapp_consents`);
    await msg(`${UNKNOWN}@c.us`, "SAIR");                                                                     // não dá para saber de qual empresa: bloqueia mais amplamente
    e = (await events()).at(-1)!;
    expect(e).toMatchObject({ classification: "opt_out", routing: "triagem", companyId: null, optoutApplied: "global", needsReview: true });
    expect((await consentState(db, A, UNKNOWN)).state).toBe("opt_out_global");
    expect((await db.select().from(schema.whatsappConsents))[0]).toMatchObject({ scope: "global" });
  });

  it("resposta de cliente SUSPENDE a cobrança até resolver (e contestação até limpar): bloqueio temporário, a mensagem espera na fila; resolver libera", async () => {
    const a = await queueCustomerMessage(db, gerA, A, { chargeId: ch1, templateVersionId: tpl.d0, sessionId: sid, confirm: true, key: k() }, deps);
    await msg(`${DIGITS}@c.us`, "oi, qual é esse valor?");
    const [e] = await events();
    expect(e).toMatchObject({ handling: "novo", classification: "resposta", companyId: A });
    await expect(dispatchOutbox(db, gerA, A, a.outboxId, deps)).rejects.toThrow(/continua na fila/);
    expect((await evaluateCustomerSend(db, gerA, A, { chargeId: ch1, templateVersionId: tpl.d0, sessionId: sid }, deps)).checks.find((c) => c.key === "reply_pending")).toMatchObject({ ok: false });
    await expect(setHandling(db, asstA, A, e.id, { handling: "resolvido" })).rejects.toBeInstanceOf(Forbidden);
    await setHandling(db, gerA, A, e.id, { handling: "em_atendimento" });
    await expect(dispatchOutbox(db, gerA, A, a.outboxId, deps)).rejects.toThrow(/continua na fila/);          // em atendimento ainda suspende
    await markDispute(db, gerA, A, e.id, true);
    await setHandling(db, gerA, A, e.id, { handling: "resolvido" });
    await expect(dispatchOutbox(db, gerA, A, a.outboxId, deps)).rejects.toThrow(/continua na fila/);          // contestação segura mesmo resolvida
    await markDispute(db, gerA, A, e.id, false);
    await setHandling(db, gerA, A, e.id, { handling: "resolvido" });
    await dispatchOutbox(db, gerA, A, a.outboxId, deps);
    expect(waha.sent).toHaveLength(1);
  });

  it("confirmação de entrega/leitura: casa pelo hash do id da NOSSA mensagem; só avança (entregue → lido); id desconhecido e mensagem não enviada não mudam nada", async () => {
    const id = await sentOnce();
    const ackOf = (mid: string, ack: string) => hook("message.ack", { id: mid, ack, ackName: ack });
    await ackOf("id-que-nao-e-nosso", "READ");
    expect((await db.select().from(schema.whatsappOutbox))[0].delivery).toBeNull();
    await ackOf("ref-1", "SERVER");                                                                          // só chegou ao servidor: ainda não é entrega
    expect((await db.select().from(schema.whatsappOutbox))[0].delivery).toBeNull();
    await ackOf("ref-1", "DEVICE");
    let o = (await db.select().from(schema.whatsappOutbox))[0];
    expect(o).toMatchObject({ id, delivery: "entregue" }); expect(o.deliveredAt).toBeInstanceOf(Date);
    await ackOf("ref-1", "READ");
    o = (await db.select().from(schema.whatsappOutbox))[0];
    expect(o.delivery).toBe("lido"); expect(o.readAt).toBeInstanceOf(Date);
    await ackOf("ref-1", "DEVICE");                                                                          // não volta de lido para entregue
    expect((await db.select().from(schema.whatsappOutbox))[0].delivery).toBe("lido");
    expect(o.status).toBe("enviado");
    expect(await why(sql`update whatsapp_outbox set reason = 'x' where id = ${id}::uuid`)).toMatch(/resultado do envio/);   // o resultado do envio segue imutável
  });

  it("ack casa pelo ID da mensagem mesmo com a conversa diferente: o envio devolve «@c.us» e o aviso de entrega/leitura vem com «@lid» (verificado ao vivo)", async () => {
    waha.refOverride = "true_5592999990000@c.us_3EB0A1B2C3D4E5F60718";
    const id = await sentOnce();
    await hook("message.ack", { id: "true_123456789012345@lid_3EB0A1B2C3D4E5F60718", ack: "DEVICE", ackName: "DEVICE" });
    expect((await db.select().from(schema.whatsappOutbox))[0]).toMatchObject({ id, delivery: "entregue" });
    await hook("message.ack", { id: "true_123456789012345@lid_3EB0A1B2C3D4E5F60718", ack: "READ", ackName: "READ" });
    expect((await db.select().from(schema.whatsappOutbox))[0].delivery).toBe("lido");
    await hook("message.ack", { id: "true_123456789012345@lid_3EB0FFFFFFFFFFFFFFFF", ack: "READ", ackName: "READ" });   // outro ID: não mexe
    expect((await db.select().from(schema.whatsappOutbox))[0].delivery).toBe("lido");
  });

  it("número SEM o 9º dígito (como a WAHA devolve p/ contas antigas) é o MESMO contato: a resposta liga ao cliente e suspende a cobrança; «PARAR» bloqueia o cadastro com 9 dígito e suprime a fila", async () => {
    const SEM9 = "559299990000";                                                                           // DIGITS sem o 9º dígito
    const a = await queueCustomerMessage(db, gerA, A, { chargeId: ch1, templateVersionId: tpl.d0, sessionId: sid, confirm: true, key: k() }, deps);
    await dispatchOutbox(db, gerA, A, a.outboxId, deps);
    await msg(`${SEM9}@c.us`, "oi, qual é esse valor?");
    const [e] = await events();
    expect(e).toMatchObject({ classification: "resposta", companyId: A, customerId: cli1, routing: "atribuida" });   // cliente identificado pela conversa, apesar do 12 dígitos
    expect(await hasOpenReply(db, A, DIGITS)).toBe(true);                                                  // consulta com o 13 dígitos do cadastro
    expect((await evaluateCustomerSend(db, gerA, A, { chargeId: ch1, templateVersionId: tpl.d_mais_3, sessionId: sid }, deps)).checks.find((c) => c.key === "reply_pending")).toMatchObject({ ok: false });
    await setHandling(db, gerA, A, e.id, { handling: "resolvido" });
    expect(await hasOpenReply(db, A, DIGITS)).toBe(false);
    await msg(`${SEM9}@c.us`, "PARAR");
    expect((await consentState(db, A, DIGITS)).state).toBe("opt_out_company");                               // cadastro (13) bloqueado pelo pedido vindo em 12
    expect((await consentState(db, A, SEM9)).state).toBe("opt_out_company");
    const ev = await evaluateCustomerSend(db, gerA, A, { chargeId: ch1, templateVersionId: tpl.d_mais_3, sessionId: sid }, deps);
    expect(ev.canSend).toBe(false); expect(ev.checks.find((x) => x.key === "consent")).toMatchObject({ ok: false });
    expect((await db.select().from(schema.whatsappConsents)).filter((x) => x.decision === "opt_out")).toHaveLength(1);
    await msg(`${DIGITS}@c.us`, "parar");                                                                  // a mesma pessoa em outra forma: não duplica
    expect((await db.select().from(schema.whatsappConsents)).filter((x) => x.decision === "opt_out")).toHaveLength(1);
  });

  it("aviso de estado da conexão só DISPARA a leitura autenticada (nunca é a fonte): payload mentindo «WORKING» não deixa a conexão «conectada»", async () => {
    waha.sessions.get(provSession)!.status = "STOPPED";
    await hook("session.status", { name: provSession, status: "WORKING" });
    expect((await db.select().from(schema.whatsappSessions))[0].status).toBe("DISCONNECTED");
    waha.sessions.get(provSession)!.status = "WORKING";
    await hook("session.status", { name: provSession, status: "STOPPED" });
    expect((await db.select().from(schema.whatsappSessions))[0].status).toBe("CONNECTED");
  });

  it("resposta que chega com id interno (@lid): o telefone vem da WAHA; sem tradução vai para a triagem; WAHA fora do ar deixa PENDENTE e o agendador resolve depois", async () => {
    waha.lids.set("160123456789@lid", DIGITS);
    await msg("160123456789@lid", "oi pelo lid");
    expect((await events())[0]).toMatchObject({ phone: DIGITS, routing: "atribuida", companyId: A });
    await db.execute(sql`truncate whatsapp_inbound_events`);
    await msg("160999999999@lid", "quem sou eu?");
    expect((await events())[0]).toMatchObject({ phone: null, routing: "triagem", classification: "sem_numero", needsReview: true });
    await db.execute(sql`truncate whatsapp_inbound_events`);
    waha.down = true;
    await msg("160123456789@lid", "WAHA caiu");
    let [e] = await events();
    expect(e).toMatchObject({ routing: "pendente", attempts: 1 }); expect(e.error).toMatch(/lid_indisponivel/);
    waha.down = false;
    await db.execute(sql`update whatsapp_inbound_events set updated_at = now() - interval '1 minute'`);
    expect(await processPendingInbound(db, deps)).toBe(1);
    [e] = await events();
    expect(e).toMatchObject({ routing: "atribuida", companyId: A, phone: DIGITS });
    expect(await processPendingInbound(db, deps)).toBe(0);
    await processInboundEvent(db, e.id, deps);                                                               // reprocessar o já tratado não faz nada
    expect((await events())[0].attempts).toBe(1 + 1);
  });

  it("enxurrada de um número só: depois de 30 por hora, o resto é ignorado (sem gravar texto nem criar triagem)", async () => {
    for (let i = 0; i < 33; i++) await msg(`${UNKNOWN}@c.us`, `spam ${i}`);
    const ev = await events();
    expect(ev.filter((e) => e.routing === "triagem")).toHaveLength(31);          // o limite olha os 30 anteriores da última hora
    expect(ev.filter((e) => e.routing === "ignorada")).toHaveLength(2);         // o resto é descartado
    expect(ev.filter((e) => e.routing === "ignorada").every((e) => e.classification === "ignorada")).toBe(true);
  }, 60_000);

  it("a caixa da empresa: só diretoria/gerência; texto decifrado só ali (no banco fica cifrado); outra empresa não vê nem age; atendimento exige permissão de envio; pedido de parar da caixa (global só diretoria)", async () => {
    await msg(`${DIGITS}@c.us`, "preciso de segunda via");
    const [row] = await events();
    expect(row.bodyEnc).not.toMatch(/segunda via/);
    expect(() => open(row.bodyEnc!, "whatsapp-inbound-outra-coisa")).toThrow();
    const inbox = await listInbox(db, gerA, A);
    expect(inbox).toHaveLength(1); expect(inbox[0]).toMatchObject({ body: "preciso de segunda via", customer: "Cliente Um LTDA", phone: "+55 92 •••••-0000", handling: "novo" });
    for (const who of [asstA, contA, techA]) await expect(listInbox(db, who, A)).rejects.toBeInstanceOf(Forbidden);
    await expect(listInbox(db, dirB, A)).rejects.toBeInstanceOf(Forbidden);
    expect(await listInbox(db, dirB, B)).toEqual([]);
    await expect(setHandling(db, dirB, B, row.id, { handling: "resolvido" })).rejects.toThrow(/Mensagem não encontrada/);
    await expect(markDispute(db, dirB, B, row.id, true)).rejects.toThrow(/Mensagem não encontrada/);
    await expect(optOutFromInbox(db, dirB, B, row.id, "company")).rejects.toThrow(/Mensagem não encontrada/);
    await expect(optOutFromInbox(db, gerA, A, row.id, "global")).rejects.toBeInstanceOf(Forbidden);         // global é da diretoria
    await optOutFromInbox(db, gerA, A, row.id, "company");
    expect((await consentState(db, A, DIGITS)).state).toBe("opt_out_company");
    await optOutFromInbox(db, gerA, A, row.id, "company");                                                    // repetir não quebra
    await optOutFromInbox(db, dirA, A, row.id, "global");
    expect((await consentState(db, B, DIGITS)).state).toBe("opt_out_global");
    expect((await events())[0]).toMatchObject({ optoutApplied: "global", handling: "resolvido" });
  });

  it("corpo lido em FLUXO com corte em 256 KB: cabeçalho declarado grande ou fluxo sem fim não enchem a memória", async () => {
    const mk = (chunks: number, declared?: number) => new Request("http://x/hook", { method: "POST", headers: declared ? { "content-length": String(declared) } : {}, body: new ReadableStream({ start(c) { for (let i = 0; i < chunks; i++) c.enqueue(new Uint8Array(65_536)); c.close(); } }), duplex: "half" } as RequestInit);
    expect((await readBodyCapped(mk(2)))!.length).toBe(131_072);
    expect(await readBodyCapped(mk(5))).toBeNull();                                  // 320 KB: corta
    expect(await readBodyCapped(mk(1, WEBHOOK_MAX_BYTES + 1))).toBeNull();           // cabeçalho já declara grande demais
    expect((await readBodyCapped(new Request("http://x/hook", { method: "POST" })))!.length).toBe(0);
  });

  it("processamento DUPLICADO de «PARAR» (inline + agendador ao mesmo tempo): um consentimento e uma auditoria só", async () => {
    await msg(`${DIGITS}@c.us`, "PARAR");                                              // já tratado
    const [e] = await events();
    // simula o evento voltando a «pendente» (lease vencida) e dois processadores em paralelo
    await db.execute(sql`alter table whatsapp_inbound_events disable trigger whatsapp_inbound_events_guard_trg`);
    await db.execute(sql`update whatsapp_inbound_events set routing = 'pendente', attempts = 1, updated_at = now() - interval '2 minutes', optout_applied = null`);
    await db.execute(sql`alter table whatsapp_inbound_events enable trigger whatsapp_inbound_events_guard_trg`);
    await Promise.all([processInboundEvent(db, e.id, deps), processInboundEvent(db, e.id, deps), processInboundEvent(db, e.id, deps)]);
    expect((await db.select().from(schema.whatsappConsents)).filter((x) => x.decision === "opt_out")).toHaveLength(1);
    expect((await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "whatsapp.inbound_optout"))).length).toBeLessThanOrEqual(2); // 1 do 1º tratamento + no máximo 1 da reprocessagem vencedora
  });

  it("o banco: evento não se apaga nem tem o conteúdo alterado (roteamento/atendimento mudam); mídia é registrada sem baixar nada", async () => {
    await msg(`${DIGITS}@c.us`, "", { hasMedia: true, type: "image" });
    const [e] = await events();
    expect(e).toMatchObject({ kind: "midia", bodyEnc: null, classification: "resposta", routing: "atribuida" });
    expect(await why(sql`delete from whatsapp_inbound_events`)).toMatch(/permanente/);
    expect(await why(sql`update whatsapp_inbound_events set body_enc = 'x'`)).toMatch(/não pode ser alterado/);
    expect(await why(sql`update whatsapp_inbound_events set phone = '5592000000000'`)).toMatch(/não pode ser alterado/);       // já resolvido: não muda
    expect(await why(sql`update whatsapp_inbound_events set event_key = 'outra'`)).toMatch(/não pode ser alterado/);
    expect(await why(sql`update whatsapp_inbound_events set handling = 'resolvido'`)).toBe("");
    expect(await why(sql`update whatsapp_inbound_events set routing = 'qualquer'`)).toMatch(/routing_chk/);
  });
});
