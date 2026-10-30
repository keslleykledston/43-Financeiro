import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import { approveBatch, generateBatch, getBatch, reopenBatch } from "@/modules/billing/batches";
import { registerPayment } from "@/modules/receivables/service";
import { ensureWhatsappDefaults, saveDraft, activateVersion, saveSettings, cancelQueueForCharges } from "@/modules/messaging/service";
import { FakeWaha } from "./helpers/fake-waha";
import { createSession, recordConsent, refreshSession, setPaused, settleStaleSends, type Deps } from "@/modules/whatsapp/service";
import { SEND_PHRASE, cancelOutbox, dispatchOutbox, evaluateCustomerSend, getCompanySettings, listOutbox, outboxBody, queueCustomerMessage, resolveUnknown, saveCompanySettings, whatsappTemplateOptions } from "@/modules/whatsapp/outbound";

const enabled = !!process.env.POSTGRES_USER;
const ENV_ON = { WAHA_API_KEY: "k", WAHA_BASE_INTERNAL_URL: "http://waha:3000", WHATSAPP_MODULE_ENABLED: "true", WHATSAPP_SEND_ENABLED: "true" };
const PHONE = "(92) 99999-0000", DIGITS = "5592999990000";
const D = "2026-10-01"; // competência 2026-09, vencimento 2026-10-14, valor 2.500,00
let seq = 0;
const k = () => `tentativa-${++seq}-${Math.random().toString(36).slice(2, 10)}`;
const terms = (o: Record<string, unknown> = {}) => ({ description: "Monitoramento de redes", monthlyAmount: "2.500,00", startAt: "2026-01-01", endAt: "", dueDay: "14", invoiceJointRequired: false, issueDayOverride: "", ...o });

describe.skipIf(!enabled)("W3a cobrança por WhatsApp: fila, revalidação no envio, histórico e isolamento (DB de teste, WAHA falsa)", () => {
  let admin: ReturnType<typeof postgres>, conn: ReturnType<typeof postgres>, db: DB;
  let A: string, B: string, dirA: string, dirB: string, gerA: string, asstA: string, contA: string, techA: string, cli1: string, cli2: string, sid: string;
  let waha: FakeWaha, deps: Deps, tpl: Record<string, string>, ch1: string, ch2: string;

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
    await db.execute(sql`truncate whatsapp_outbox, whatsapp_company_settings, whatsapp_consents, whatsapp_send_log, whatsapp_send_authorizations, whatsapp_session_companies, whatsapp_sessions, messaging_settings, message_queue, message_template_versions, message_templates, payments, charges, billing_batches, holidays, contract_versions, contracts, customer_contacts, customers, audit_log, invitations, memberships, companies, users restart identity cascade`);
    const [a, b] = await db.insert(schema.companies).values([{ name: "Empresa A" }, { name: "Empresa B" }]).returning();
    A = a.id; B = b.id;
    const mk = async (e: string) => (await db.insert(schema.users).values({ email: e, name: e.split("@")[0], passwordHash: "x" }).returning())[0].id;
    dirA = await mk("dir-a@t.com"); dirB = await mk("dir-b@t.com"); gerA = await mk("ger@t.com"); asstA = await mk("asst@t.com"); contA = await mk("cont@t.com"); techA = await mk("tech@t.com");
    await db.insert(schema.memberships).values([
      { userId: dirA, companyId: A, role: "diretoria" }, { userId: dirB, companyId: B, role: "diretoria" }, { userId: gerA, companyId: A, role: "gerente" },
      { userId: asstA, companyId: A, role: "assistente" }, { userId: contA, companyId: A, role: "contabilidade" }, { userId: techA, companyId: A, role: "admin_tecnico" },
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
    waha = new FakeWaha(); deps = { waha, env: { ...ENV_ON } };
    const win = { windowStart: "00:00", windowEnd: "23:59", weekdays: [0, 1, 2, 3, 4, 5, 6], skipHolidays: false, maxPerRun: "50", maxPerHour: "30", maxLateDays: "2" };
    await saveSettings(db, dirA, A, win); await saveSettings(db, dirB, B, win);
    sid = (await createSession(db, dirA, A, { displayName: "Financeiro", senderIdentity: "Financeiro Empresa A", confirmAuthorized: true }, deps)).sessionId;
    waha.connect((await db.select().from(schema.whatsappSessions))[0].providerSession); await refreshSession(db, dirA, A, sid, deps); await setPaused(db, dirA, A, sid, false);
    await ensureWhatsappDefaults(db, dirA, A);
    tpl = Object.fromEntries((await whatsappTemplateOptions(db, gerA, A)).map((t) => [t.kind, t.versionId]));
    await saveCompanySettings(db, dirA, A, { enable: true, reference: "e-mail da diretoria de 29/10/2026", dailyCap: 10, phrase: SEND_PHRASE });
    await recordConsent(db, gerA, A, { phone: PHONE, decision: "opt_in", scope: "company", evidenceSource: "escrito", evidenceRef: "e-mail de 28/10" });
    await recordConsent(db, gerA, A, { phone: "(92) 98888-1111", decision: "opt_in", scope: "company", evidenceSource: "escrito", evidenceRef: "contrato 123" });
  });

  const q = (o: Partial<Parameters<typeof queueCustomerMessage>[3]> = {}, who = gerA, co = A) => queueCustomerMessage(db, who, co, { chargeId: ch1, templateVersionId: tpl.d0, sessionId: sid, confirm: true, key: k(), ...o }, deps);
  const go = (id: string, who = gerA, co = A, d = deps) => dispatchOutbox(db, who, co, id, d);
  const rows = () => db.select().from(schema.whatsappOutbox);
  const why = async (query: ReturnType<typeof sql>) => { try { await db.execute(query); return ""; } catch (e) { return (e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message; } };
  const audits = async () => (await db.select().from(schema.auditLog).where(sql`action like 'whatsapp.%'`)).map((a) => a.action);

  it("configuração por empresa: nasce DESLIGADA; ligar exige diretoria, referência escrita, limite válido e a frase; desligar é imediato; a automação nunca é tocada", async () => {
    await db.execute(sql`truncate whatsapp_company_settings`);
    expect(await getCompanySettings(db, dirA, A)).toMatchObject({ sendEnabled: false, automationEnabled: false });
    const ev0 = await evaluateCustomerSend(db, gerA, A, { chargeId: ch1, templateVersionId: tpl.d0, sessionId: sid }, deps);
    expect(ev0.canSend).toBe(false); expect(ev0.checks.find((c) => c.key === "company_send")!.ok).toBe(false);
    for (const who of [gerA, asstA, techA, contA]) await expect(saveCompanySettings(db, who, A, { enable: true, reference: "autorização escrita", dailyCap: 5, phrase: SEND_PHRASE })).rejects.toBeInstanceOf(Forbidden);
    await expect(saveCompanySettings(db, dirB, A, { enable: true, reference: "autorização escrita", dailyCap: 5, phrase: SEND_PHRASE })).rejects.toBeInstanceOf(Forbidden);
    await expect(saveCompanySettings(db, dirA, A, { enable: true, reference: "autorização escrita", dailyCap: 5, phrase: "enviar whatsapp" })).rejects.toThrow(/digite exatamente/);
    await expect(saveCompanySettings(db, dirA, A, { enable: true, reference: "x", dailyCap: 5, phrase: SEND_PHRASE })).rejects.toThrow(/autorização escrita/);
    for (const cap of [0, 11, 1.5, "x"]) await expect(saveCompanySettings(db, dirA, A, { enable: true, reference: "autorização escrita", dailyCap: cap, phrase: SEND_PHRASE })).rejects.toThrow(/limite diário/);
    await saveCompanySettings(db, dirA, A, { enable: true, reference: "autorização escrita", dailyCap: 3, phrase: SEND_PHRASE });
    expect(await getCompanySettings(db, gerA, A)).toMatchObject({ sendEnabled: true, automationEnabled: false, dailyCap: 3, reference: "autorização escrita" });
    expect(await getCompanySettings(db, dirB, B)).toMatchObject({ sendEnabled: false }); // por empresa
    await saveCompanySettings(db, dirA, A, { enable: false });
    expect((await getCompanySettings(db, dirA, A)).sendEnabled).toBe(false);
    expect(await why(sql`update whatsapp_company_settings set send_enabled = true, reference = null where company_id = ${A}::uuid`)).toMatch(/auth_chk/);   // o banco exige a referência para ligar
    expect(await why(sql`update whatsapp_company_settings set automation_enabled = true, reference = null, authorized_by = null where company_id = ${A}::uuid`)).toMatch(/auth_chk/);
    expect(await why(sql`delete from whatsapp_company_settings`)).toMatch(/não é apagada/);
    expect(await audits()).toEqual(expect.arrayContaining(["whatsapp.company_send.enabled", "whatsapp.company_send.disabled"]));
  });

  it("modelos de WhatsApp: padrões curtos sem dados do boleto; modelo antigo com boleto é substituído; o já editado por pessoa NÃO é tocado", async () => {
    const opts = await whatsappTemplateOptions(db, gerA, A);
    expect(opts.map((o) => o.kind).sort()).toEqual(["d0", "d_mais_3", "d_mais_7", "d_menos_3", "emissao"]);
    expect(opts.every((o) => o.usable && o.body.length < 600 && /PARAR/.test(o.body) && !/linha_digitavel|link_boleto|pix_copia_cola/.test(o.body))).toBe(true);
    // simula o padrão ANTIGO (com boleto) no d0 e um modelo editado por pessoa no d_menos_3
    await db.execute(sql`update message_template_versions set body = 'Olá {{cliente}}, boleto: {{linha_digitavel}}' where id = ${tpl.d0}::uuid`);
    await db.execute(sql`update message_template_versions set body = 'Texto editado pela equipe para {{cliente}}.' where id = ${tpl.d_menos_3}::uuid`);
    const r = await ensureWhatsappDefaults(db, dirA, A);
    expect(r).toEqual({ created: 0, upgraded: 1 });
    const after = Object.fromEntries((await whatsappTemplateOptions(db, gerA, A)).map((o) => [o.kind, o]));
    expect(after.d0.usable).toBe(true); expect(after.d0.version).toBe(2); expect(after.d0.versionId).not.toBe(tpl.d0);
    expect(after.d_menos_3.body).toBe("Texto editado pela equipe para {{cliente}}."); expect(after.d_menos_3.version).toBe(1);
    expect(await ensureWhatsappDefaults(db, dirA, A)).toEqual({ created: 0, upgraded: 0 }); // idempotente
    await expect(ensureWhatsappDefaults(db, asstA, A)).rejects.toBeInstanceOf(Forbidden);
  });

  it("fluxo feliz: fila (texto cifrado e fixado) → enviar → enviado; WAHA recebe o texto certo na conversa individual; histórico mascarado; auditoria sem telefone nem texto", async () => {
    const { outboxId } = await q();
    const [row] = await rows();
    expect(row).toMatchObject({ id: outboxId, status: "na_fila", milestone: "d0", phone: DIGITS, phoneMasked: "+55 92 •••••-0000", customerId: cli1, companyId: A });
    expect(row.bodyEnc).not.toMatch(/Cliente Um|Empresa A|2\.500/);                    // cifrado em repouso
    expect(await outboxBody(db, gerA, A, outboxId)).toMatch(/Cliente Um LTDA.*Empresa A.*R\$\s?2\.500,00.*14\/10\/2026/s);
    expect(waha.sent).toHaveLength(0);                                                  // enfileirar não envia
    await go(outboxId);
    expect(waha.sent).toHaveLength(1);
    expect(waha.sent[0].chatId).toBe(`${DIGITS}@c.us`);
    expect(waha.sent[0].text).toBe(await outboxBody(db, gerA, A, outboxId));
    const [after] = await rows();
    expect(after).toMatchObject({ status: "enviado", reason: null }); expect(after.providerRef).toMatch(/^[0-9a-f]{32}$/); expect(after.sentAt).toBeInstanceOf(Date); expect(after.finishedAt).toBeInstanceOf(Date);
    const h = await listOutbox(db, gerA, A);
    expect(h).toHaveLength(1); expect(h[0]).toMatchObject({ status: "enviado", phone: "+55 92 •••••-0000", customer: "Cliente Um LTDA", milestone: "d0", amountCents: 250000 });
    expect(JSON.stringify(h)).not.toContain(DIGITS);
    expect(JSON.stringify((await db.select().from(schema.auditLog)).map((a) => [a.action, a.detail]))).not.toMatch(/5592|99999|Cliente Um/);
    expect(await audits()).toEqual(expect.arrayContaining(["whatsapp.customer_queued", "whatsapp.customer_sent"]));
  });

  it("cada trava impede de ir para a fila, com o motivo: sem consentimento, opt-out, celular ausente/fixo, modelo com boleto, empresa não liberada, conexão pausada, janela, limite, aviso recente", async () => {
    const block = async (o: Partial<Parameters<typeof queueCustomerMessage>[3]>, rx: RegExp) => { await expect(q(o)).rejects.toThrow(rx); expect(await rows()).toHaveLength(0); };
    await db.execute(sql`truncate whatsapp_consents`);
    await block({}, /Sem consentimento/);                                              // sem opt-in
    await recordConsent(db, gerA, A, { phone: PHONE, decision: "opt_in", scope: "company", evidenceSource: "escrito", evidenceRef: "e-mail de 28/10" });
    await recordConsent(db, gerA, A, { phone: PHONE, decision: "opt_out", scope: "company", evidenceSource: "verbal", evidenceRef: "pedido verbal" });
    await block({}, /pediu para não receber/);                                         // opt-out prevalece
    await recordConsent(db, gerA, A, { phone: PHONE, decision: "opt_in", scope: "company", evidenceSource: "escrito", evidenceRef: "reconsentimento" });
    await db.execute(sql`update customer_contacts set phone = '(92) 3234-5678' where customer_id = ${cli1}::uuid`);
    await block({}, /telefone de celular/);                                            // fixo não
    await db.execute(sql`update customer_contacts set phone = null where customer_id = ${cli1}::uuid`);
    await block({}, /telefone de celular/);
    await db.execute(sql`update customer_contacts set phone = ${PHONE} where customer_id = ${cli1}::uuid`);
    await db.execute(sql`update message_template_versions set body = 'Boleto {{linha_digitavel}}' where id = ${tpl.d0}::uuid`);
    await block({}, /dados do boleto/);                                                // modelo com campo do boleto
    await block({ templateVersionId: "00000000-0000-4000-8000-000000000000" }, /Modelo não está ativo/);
    await ensureWhatsappDefaults(db, dirA, A); tpl = Object.fromEntries((await whatsappTemplateOptions(db, gerA, A)).map((t) => [t.kind, t.versionId]));
    await saveCompanySettings(db, dirA, A, { enable: false });
    await block({ templateVersionId: tpl.d0 }, /ainda não liberou/);
    await saveCompanySettings(db, dirA, A, { enable: true, reference: "autorização escrita", dailyCap: 1, phrase: SEND_PHRASE });
    await setPaused(db, dirA, A, sid, true);
    await block({ templateVersionId: tpl.d0 }, /pausada/);
    await setPaused(db, dirA, A, sid, false);
    await saveSettings(db, dirA, A, { windowStart: "09:00", windowEnd: "17:00", weekdays: [1, 2, 3, 4, 5], skipHolidays: true, maxPerRun: "50", maxPerHour: "30", maxLateDays: "2" });
    const sat = new Date("2026-10-31T18:00:00Z");
    await expect(queueCustomerMessage(db, gerA, A, { chargeId: ch1, templateVersionId: tpl.d0, sessionId: sid, confirm: true, key: k() }, { ...deps, now: sat })).rejects.toThrow(/Dia da semana não permitido/);
    await saveSettings(db, dirA, A, { windowStart: "00:00", windowEnd: "23:59", weekdays: [0, 1, 2, 3, 4, 5, 6], skipHolidays: false, maxPerRun: "50", maxPerHour: "30", maxLateDays: "2" });
    await recordConsent(db, gerA, A, { phone: "(92) 98888-1111", decision: "opt_in", scope: "company", evidenceSource: "escrito", evidenceRef: "contrato 123" });
    // limite 1/dia: a 1ª sai, a 2ª (outro cliente) é barrada pelo limite; e o MESMO cliente em 7 dias também
    const one = await q({ templateVersionId: tpl.d0 }); await go(one.outboxId);
    await expect(q({ chargeId: ch2, templateVersionId: tpl.d0 })).rejects.toThrow(/Limite de 1 por dia/);
    await saveCompanySettings(db, dirA, A, { enable: true, reference: "autorização escrita", dailyCap: 10, phrase: SEND_PHRASE });
    await expect(q({ templateVersionId: tpl.d_mais_3 })).rejects.toThrow(/nos últimos 7 dias/);
    expect(waha.sent).toHaveLength(1);
    expect((await audits()).filter((a) => a === "whatsapp.customer_blocked").length).toBeGreaterThanOrEqual(8);
  });

  it("antes de enfileirar: confirmação obrigatória, chave de tentativa válida, permissão; o MESMO formulário e a mesma cobrança/modelo/telefone não duplicam (corrida incluída)", async () => {
    await expect(q({ confirm: false })).rejects.toThrow(/Confirme/);
    await expect(q({ key: "curta" })).rejects.toThrow(/Formulário vencido/);
    for (const who of [asstA, techA, contA]) await expect(q({}, who)).rejects.toBeInstanceOf(Forbidden);
    await expect(q({}, dirB, A)).rejects.toBeInstanceOf(Forbidden);
    const same = "formulario-fixo-0001";
    const r = await Promise.allSettled([1, 2, 3, 4].map(() => q({ key: same })));
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(await rows()).toHaveLength(1);
    await expect(q({ key: "outro-formulario-0002" })).rejects.toThrow(/já existe uma mensagem|Já existe uma mensagem/i); // mesma cobrança+modelo+telefone, outra tentativa
    await expect(q({ key: same })).rejects.toThrow(/já foi registrada/);
    expect(await rows()).toHaveLength(1);
  });

  it("enviar REVALIDA: cobrança paga depois da fila → suprimida na hora (e a fila para sozinha); opt-out depois da fila → suprimida; nada sai", async () => {
    const a = await q(); const b = await q({ chargeId: ch2 });
    await registerPayment(db, dirA, A, ch1, { amount: "2.500,00", method: "pix", paidAt: "2026-10-20" });
    expect((await rows()).find((r) => r.id === a.outboxId)).toMatchObject({ status: "suprimido", reason: "cobranca_alterada" }); // o pagamento parou a fila
    await expect(go(a.outboxId)).rejects.toThrow(/já foi processada \(Suprimido\)/);
    await recordConsent(db, gerA, A, { phone: "(92) 98888-1111", decision: "opt_out", scope: "company", evidenceSource: "verbal", evidenceRef: "pediu por telefone" });
    await expect(go(b.outboxId)).rejects.toThrow(/Mensagem suprimida: Este contato pediu para não receber/);
    expect((await rows()).find((r) => r.id === b.outboxId)).toMatchObject({ status: "suprimido", reason: "optout" });
    expect(waha.sent).toHaveLength(0);
    await expect(go(b.outboxId)).rejects.toThrow(/já foi processada/);                  // suprimida não volta
  });

  it("lote reaberto/cobrança alterada suprime a fila; modelo ou cobrança que mudam depois da prévia NÃO enviam texto diferente do aprovado", async () => {
    const a = await q();
    await reopenBatch(db, dirA, A, (await db.select().from(schema.billingBatches))[0].id, "ajuste de teste");
    expect((await rows()).find((r) => r.id === a.outboxId)).toMatchObject({ status: "suprimido", reason: "cobranca_alterada" });
    // modelo editado depois da fila: o texto re-renderizado difere → não envia; cancelar e refazer
    await approveBatch(db, dirA, A, (await db.select().from(schema.billingBatches))[0].id, (await getBatch(db, dirA, A, (await db.select().from(schema.billingBatches))[0].id))!.hash);
    const chs = await db.select().from(schema.charges);
    const c1 = chs.find((c) => c.customerId === cli1 && c.status === "aprovada")!.id;
    const b = await q({ chargeId: c1 });
    await saveDraft(db, dirA, A, "d0", "whatsapp", "", "Olá {{cliente}}, texto NOVO do modelo. Responda PARAR.");
    const draft = (await db.select().from(schema.messageTemplateVersions).where(eq(schema.messageTemplateVersions.state, "rascunho")))[0];
    await activateVersion(db, dirA, A, draft.id);
    await expect(go(b.outboxId)).rejects.toThrow(/Modelo não está ativo|mudou depois de a mensagem entrar na fila/);
    expect(waha.sent).toHaveLength(0);
    expect((await rows()).find((r) => r.id === b.outboxId)!.status).toMatch(/na_fila|suprimido/);
  });

  it("bloqueios TEMPORÁRIOS (janela, conexão pausada/caída, chave desligada) mantêm a mensagem na fila; liberado, ela sai", async () => {
    const a = await q();
    const sat = new Date("2026-10-31T18:00:00Z");
    await saveSettings(db, dirA, A, { windowStart: "09:00", windowEnd: "17:00", weekdays: [1, 2, 3, 4, 5], skipHolidays: true, maxPerRun: "50", maxPerHour: "30", maxLateDays: "2" });
    await expect(go(a.outboxId, gerA, A, { ...deps, now: sat })).rejects.toThrow(/continua na fila/);
    await saveSettings(db, dirA, A, { windowStart: "00:00", windowEnd: "23:59", weekdays: [0, 1, 2, 3, 4, 5, 6], skipHolidays: false, maxPerRun: "50", maxPerHour: "30", maxLateDays: "2" });
    await setPaused(db, dirA, A, sid, true);
    await expect(go(a.outboxId)).rejects.toThrow(/continua na fila/);
    await setPaused(db, dirA, A, sid, false);
    await expect(go(a.outboxId, gerA, A, { ...deps, env: { ...ENV_ON, WHATSAPP_SEND_ENABLED: "false" } })).rejects.toThrow(/continua na fila/);
    waha.down = true;
    await expect(go(a.outboxId)).rejects.toThrow(/continua na fila/);
    waha.down = false;
    expect((await rows())[0].status).toBe("na_fila"); expect(waha.sent).toHaveLength(0);
    await go(a.outboxId);
    expect((await rows())[0].status).toBe("enviado");
  });

  it("enviar em paralelo a MESMA mensagem manda UMA vez; WAHA que cai entre a conferência e o envio não envia (e a mensagem é suprimida com o motivo)", async () => {
    const a = await q();
    const r = await Promise.allSettled([1, 2, 3, 4].map(() => go(a.outboxId)));
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(waha.sent).toHaveLength(1);
    // queda da conexão entre avaliar e enviar (estado lido na WAHA)
    const b = await q({ chargeId: ch2 });
    waha.getCount = 0; waha.dropOnGet = 2;
    await expect(go(b.outboxId)).rejects.toThrow(/último instante/);
    expect(waha.sent).toHaveLength(1);
    expect((await rows()).find((x) => x.id === b.outboxId)).toMatchObject({ status: "suprimido", reason: "conexao_nao_conectada" });
  });

  it("2 cobranças do MESMO cliente enviadas ao mesmo tempo: só um aviso sai (a regra dos 7 dias vale sob trava); a outra é suprimida", async () => {
    await db.execute(sql`insert into charges (company_id, batch_id, contract_id, customer_id, competence_month, due_date, issue_date, description, amount, base_amount, adjustment_amount, adjustment_detail, joint_invoice, warnings, status)
      select company_id, batch_id, contract_id, customer_id, '2026-08-01', due_date, issue_date, description, amount, base_amount, adjustment_amount, adjustment_detail, joint_invoice, warnings, status from charges where id = ${ch1}::uuid`);
    const chB = (await db.select().from(schema.charges).where(eq(schema.charges.customerId, cli1))).find((c) => c.id !== ch1)!.id;
    const a = await q({ templateVersionId: tpl.d0 });
    const b = await q({ chargeId: chB, templateVersionId: tpl.d_mais_3 });          // marco diferente: a fila deixa (a regra dos 7 dias vale no ENVIO, sob trava)
    const r = await Promise.allSettled([go(a.outboxId), go(b.outboxId)]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(waha.sent).toHaveLength(1);
    const st = (await rows()).map((x) => x.status).sort();
    expect(st).toEqual(["enviado", "suprimido"]);
    expect((await rows()).find((x) => x.status === "suprimido")!.reason).toMatch(/aviso_recente/);
  });

  it("reserva abandonada em 'enviando' (o servidor caiu): conta no limite, só a diretoria encerra como «sem confirmação» depois de 10 min, nunca reenvia", async () => {
    const a = await q();
    await db.execute(sql`update whatsapp_outbox set status = 'enviando', updated_at = now() - interval '30 minutes'`);
    await expect(go(a.outboxId)).rejects.toThrow(/já foi processada \(Enviando\)/);
    await expect(settleStaleSends(db, gerA, A)).rejects.toBeInstanceOf(Forbidden);
    expect(await settleStaleSends(db, dirA, A)).toBe(1);
    expect((await rows())[0]).toMatchObject({ status: "desconhecido", reason: "reserva_abandonada" });
    expect(await settleStaleSends(db, dirA, A)).toBe(0);
    expect(waha.sent).toHaveLength(0);
    await resolveUnknown(db, dirA, A, a.outboxId, "falhou");                              // e a conferência humana resolve
    expect((await rows())[0].status).toBe("falhou");
    // reserva recente não é tocada
    const b = await q({ chargeId: ch2 });
    await db.execute(sql`update whatsapp_outbox set status = 'enviando', updated_at = now() where id = ${b.outboxId}::uuid`);
    expect(await settleStaleSends(db, dirA, A)).toBe(0);
  });

  it("desligar a empresa suprime o que estava na fila: religar depois NÃO envia mensagem antiga", async () => {
    const a = await q();
    await saveCompanySettings(db, dirA, A, { enable: false });
    expect((await rows())[0]).toMatchObject({ status: "suprimido", reason: "empresa_desligada" });
    await saveCompanySettings(db, dirA, A, { enable: true, reference: "autorização escrita", dailyCap: 5, phrase: SEND_PHRASE });
    await expect(go(a.outboxId)).rejects.toThrow(/já foi processada \(Suprimido\)/);
    expect(waha.sent).toHaveLength(0);
  });

  it("cancelar só o BOLETO não suprime a mensagem (a cobrança segue devida); pagamento/lote reaberto suprimem", async () => {
    const a = await q();
    await db.transaction(async (tx) => { await cancelQueueForCharges(tx as unknown as DB, A, [ch1], { keepWhatsapp: true }); });
    expect((await rows())[0].status).toBe("na_fila");
    await db.transaction(async (tx) => { await cancelQueueForCharges(tx as unknown as DB, A, [ch1]); });
    expect((await rows()).find((r) => r.id === a.outboxId)).toMatchObject({ status: "suprimido", reason: "cobranca_alterada" });
  });

  it("A12 resultado ambíguo vira «sem confirmação»: não reenvia sozinho, ocupa o limite, só a diretoria resolve (por conferência humana) e uma vez", async () => {
    const a = await q(); waha.sendMode = "unknown";
    await expect(go(a.outboxId)).rejects.toThrow(/PODE ter chegado/);
    expect((await rows())[0]).toMatchObject({ status: "desconhecido", reason: "sem_confirmacao" });
    waha.sendMode = "ok";
    await expect(go(a.outboxId)).rejects.toThrow(/já foi processada \(Sem confirmação\)/);
    expect(waha.calls.filter((c) => c === "send")).toHaveLength(1);
    await expect(resolveUnknown(db, gerA, A, a.outboxId, "enviado")).rejects.toBeInstanceOf(Forbidden);
    await expect(resolveUnknown(db, dirB, A, a.outboxId, "enviado")).rejects.toBeInstanceOf(Forbidden);
    await expect(resolveUnknown(db, dirA, A, a.outboxId, "talvez" as never)).rejects.toThrow(/enviada ou não/);
    await resolveUnknown(db, dirA, A, a.outboxId, "falhou");
    expect((await rows())[0]).toMatchObject({ status: "falhou", reason: "confirmado_nao_enviado" });
    await expect(resolveUnknown(db, dirA, A, a.outboxId, "enviado")).rejects.toThrow(/Só mensagem «sem confirmação»/);
    expect(waha.sent).toHaveLength(0);
  });

  it("cancelar: só mensagem na fila; o banco só permite as transições válidas, não altera identidade/texto e não apaga", async () => {
    const a = await q();
    await cancelOutbox(db, gerA, A, a.outboxId);
    expect((await rows())[0]).toMatchObject({ status: "cancelado", reason: "cancelado_pelo_operador" });
    await expect(cancelOutbox(db, gerA, A, a.outboxId)).rejects.toThrow(/Só mensagem na fila/);
    await expect(go(a.outboxId)).rejects.toThrow(/já foi processada \(Cancelado\)/);
    const b = await q(); await go(b.outboxId);
    await expect(cancelOutbox(db, gerA, A, b.outboxId)).rejects.toThrow(/Só mensagem na fila/);
    expect(await why(sql`update whatsapp_outbox set status = 'na_fila' where id = ${b.outboxId}::uuid`)).toMatch(/transição de estado/);
    expect(await why(sql`update whatsapp_outbox set status = 'na_fila' where id = ${a.outboxId}::uuid`)).toMatch(/encerrada|transição/);
    expect(await why(sql`update whatsapp_outbox set phone = '5592988880000' where id = ${b.outboxId}::uuid`)).toMatch(/identidade e o texto/);
    expect(await why(sql`update whatsapp_outbox set body_enc = 'x' where id = ${b.outboxId}::uuid`)).toMatch(/identidade e o texto/);
    expect(await why(sql`update whatsapp_outbox set reason = 'x' where id = ${b.outboxId}::uuid`)).toMatch(/resultado do envio/);
    expect(await why(sql`update whatsapp_outbox set delivery = 'entregue', delivered_at = now() where id = ${b.outboxId}::uuid`)).toBe(""); // a confirmação de entrega pode chegar
    expect(await why(sql`delete from whatsapp_outbox`)).toMatch(/permanente/);
    expect(await why(sql`update whatsapp_outbox set status = 'enviado' where id = ${a.outboxId}::uuid`)).toMatch(/encerrada|transição/);
  });

  it("isolamento: a empresa B não vê, não envia, não cancela nem lê o texto da fila da A; permissões por papel", async () => {
    const a = await q();
    await expect(go(a.outboxId, dirB, B)).rejects.toThrow(/Mensagem não encontrada/);
    await expect(cancelOutbox(db, dirB, B, a.outboxId)).rejects.toThrow(/Mensagem não encontrada/);
    await expect(outboxBody(db, dirB, B, a.outboxId)).rejects.toThrow(/Mensagem não encontrada/);
    expect(await listOutbox(db, dirB, B)).toEqual([]);
    await expect(go(a.outboxId, dirB, A)).rejects.toBeInstanceOf(Forbidden);              // dirB não é membro da A
    await expect(evaluateCustomerSend(db, dirB, B, { chargeId: ch1, templateVersionId: tpl.d0, sessionId: sid }, deps)).resolves.toMatchObject({ canSend: false }); // B não tem a cobrança nem a conexão
    for (const who of [asstA, techA, contA]) { await expect(listOutbox(db, who, A)).rejects.toBeInstanceOf(Forbidden); await expect(go(a.outboxId, who)).rejects.toBeInstanceOf(Forbidden); }
    expect(await listOutbox(db, gerA, A)).toHaveLength(1);
    await expect(go("lixo")).rejects.toThrow(/Mensagem não encontrada/);
    // o texto cifrado é ligado à empresa: copiar para outra empresa não abre
    const [row] = await rows();
    const sealed = row.bodyEnc;
    const { open } = await import("@/lib/security/secretbox");
    expect(() => open(sealed, `whatsapp-outbox:${B}`)).toThrow();
  });

  it("a fila de cobrança divide o limite da conexão com o teste e entra na contagem do dia", async () => {
    const a = await q(); await go(a.outboxId);
    const ev = await evaluateCustomerSend(db, gerA, A, { chargeId: ch2, templateVersionId: tpl.d0, sessionId: sid }, deps);
    expect(ev.checks.find((c) => c.key === "cap_company")).toMatchObject({ ok: true, detail: "1 de 10 hoje" });
    await db.execute(sql`insert into whatsapp_send_log (company_id, session_id, phone_masked, idempotency_key, status, finished_at) select ${A}::uuid, ${sid}::uuid, '+55 92 •••••-1111', 'carga-teste-' || g, 'enviado', now() from generate_series(1, 9) g`);
    const ev2 = await evaluateCustomerSend(db, gerA, A, { chargeId: ch2, templateVersionId: tpl.d0, sessionId: sid }, deps);
    expect(ev2.checks.find((c) => c.key === "cap_company")).toMatchObject({ ok: false });   // 1 de cobrança + 9 de teste = 10 = limite da empresa
  });
});
