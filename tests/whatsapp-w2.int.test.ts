import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { eq, sql } from "drizzle-orm";
import { databaseUrl } from "@/lib/db/url";
import * as schema from "@/lib/db/schema";
import type { DB } from "@/lib/db";
import { Forbidden } from "@/modules/identity/service";
import { saveSettings } from "@/modules/messaging/service";
import { createParty } from "@/modules/crm/service";
import { FakeWaha } from "./helpers/fake-waha";
import {
  bindCompany, consentState, createSession, evaluateTestSend, getQr, listBindings, listConsents, listSessions, recentBlocks, recordConsent, refreshSession, saveAuthorization, sendTest, setPaused, unbindCompany, type Deps,
} from "@/modules/whatsapp/service";

const enabled = !!process.env.POSTGRES_USER;
const PHONE = "92 99999-0000", DIGITS = "5592999990000", OTHER = "92 98888-1111";
const ENV_ON = { WAHA_API_KEY: "k", WAHA_BASE_INTERNAL_URL: "http://waha:3000", WHATSAPP_MODULE_ENABLED: "true", WHATSAPP_SEND_ENABLED: "true" };
let seq = 0;
const k = () => `tentativa-${++seq}-${Math.random().toString(36).slice(2, 10)}`;

describe.skipIf(!enabled)("W2 WhatsApp: vínculo de empresas, consentimento/opt-out e bloqueios — isolamento por empresa (DB de teste, WAHA falsa)", () => {
  let admin: ReturnType<typeof postgres>, conn: ReturnType<typeof postgres>, db: DB;
  let A: string, B: string, C: string, dirAB: string, dirA: string, dirB: string, gerA: string, gerB: string, asstA: string, contA: string, techA: string;
  let waha: FakeWaha, deps: Deps, sid: string;

  beforeAll(async () => {
    const base = databaseUrl();
    admin = postgres(base.replace(/\/k3gfinance$/, "/postgres"), { max: 1 });
    if (!(await admin`select 1 from pg_database where datname = 'k3gfinance_test'`).length) await admin.unsafe("create database k3gfinance_test");
    conn = postgres(base.replace(/\/k3gfinance$/, "/k3gfinance_test"), { max: 6 });
    db = drizzle(conn, { schema });
    await migrate(db, { migrationsFolder: "./drizzle" });
  });
  afterAll(async () => { await conn?.end(); await admin?.end(); });

  beforeEach(async () => {
    await db.execute(sql`truncate whatsapp_consents, whatsapp_send_log, whatsapp_send_authorizations, whatsapp_session_companies, whatsapp_sessions, messaging_settings, holidays, customer_contacts, customers, audit_log, invitations, memberships, companies, users restart identity cascade`);
    const cs = await db.insert(schema.companies).values([{ name: "Empresa A" }, { name: "Empresa B" }, { name: "Empresa C" }]).returning();
    [A, B, C] = cs.map((c) => c.id);
    const mk = async (e: string) => (await db.insert(schema.users).values({ email: e, name: e.split("@")[0], passwordHash: "x" }).returning())[0].id;
    dirAB = await mk("dir-ab@t.com"); dirA = await mk("dir-a@t.com"); dirB = await mk("dir-b@t.com"); gerA = await mk("ger-a@t.com"); gerB = await mk("ger-b@t.com"); asstA = await mk("asst@t.com"); contA = await mk("cont@t.com"); techA = await mk("tech@t.com");
    await db.insert(schema.memberships).values([
      { userId: dirAB, companyId: A, role: "diretoria" }, { userId: dirAB, companyId: B, role: "diretoria" }, { userId: dirA, companyId: A, role: "diretoria" }, { userId: dirB, companyId: B, role: "diretoria" },
      { userId: gerA, companyId: A, role: "gerente" }, { userId: gerB, companyId: B, role: "gerente" }, { userId: asstA, companyId: A, role: "assistente" }, { userId: contA, companyId: A, role: "contabilidade" }, { userId: techA, companyId: A, role: "admin_tecnico" },
    ]);
    waha = new FakeWaha();
    deps = { waha, env: { ...ENV_ON } };
    const win = { windowStart: "00:00", windowEnd: "23:59", weekdays: [0, 1, 2, 3, 4, 5, 6], skipHolidays: false, maxPerRun: "50", maxPerHour: "30", maxLateDays: "2" };
    await saveSettings(db, dirAB, A, win); await saveSettings(db, dirAB, B, win);
    sid = (await createSession(db, dirA, A, { displayName: "Financeiro grupo", senderIdentity: "Financeiro Empresa A", confirmAuthorized: true }, deps)).sessionId;
    const name = (await db.select().from(schema.whatsappSessions))[0].providerSession;
    waha.connect(name); await refreshSession(db, dirA, A, sid, deps); await setPaused(db, dirA, A, sid, false);
  });

  const bind = (who = dirAB, target = B, identity = "Financeiro Empresa B", confirm = true) => bindCompany(db, who, A, sid, { targetCompanyId: target, senderIdentity: identity, confirm });
  const auth = (who: string, co: string, phones = PHONE, limit = 5) => saveAuthorization(db, who, co, { reference: "e-mail da diretoria de 29/10/2026", phones, dailyLimit: limit });
  const send = (who: string, co: string, phone = PHONE) => sendTest(db, who, co, { sessionId: sid, phone, confirm: true, key: k() }, deps);
  const rec = (who: string, co: string, o: Partial<Parameters<typeof recordConsent>[3]> = {}) => recordConsent(db, who, co, { phone: PHONE, decision: "opt_in", scope: "company", evidenceSource: "escrito", evidenceRef: "e-mail de 28/10", ...o });
  const audits = async () => (await db.select().from(schema.auditLog).where(sql`action like 'whatsapp.%'`)).map((a) => `${a.action}:${a.companyId === A ? "A" : a.companyId === B ? "B" : "?"}`);

  it("vincular exige diretoria nas DUAS empresas (403 em qualquer outro caso); a empresa que entra usa o mesmo número sem novo QR e nasce sem autorização", async () => {
    await expect(bind(dirA)).rejects.toBeInstanceOf(Forbidden);                       // diretoria só da A: não é da B
    await expect(bind(dirB)).rejects.toBeInstanceOf(Forbidden);                       // diretoria só da B: não manda na conexão da A
    await expect(bind(gerA)).rejects.toBeInstanceOf(Forbidden);                       // gerente não
    await expect(bind(techA)).rejects.toBeInstanceOf(Forbidden);                      // admin técnico não autoriza
    await expect(bind(dirAB, C)).rejects.toBeInstanceOf(Forbidden);                   // C: dirAB nem é membro (sem revelar se existe)
    await expect(bind(dirAB, "00000000-0000-4000-8000-000000000000")).rejects.toBeInstanceOf(Forbidden);
    await expect(bind(dirAB, "lixo")).rejects.toThrow(/Empresa não encontrada/);
    expect(await db.select().from(schema.whatsappSessionCompanies)).toHaveLength(1);
    await expect(bind(dirAB, B, "ab")).rejects.toThrow(/aparece para o cliente/);
    await expect(bind(dirAB, B, "Financeiro Empresa B", false)).rejects.toThrow(/as duas empresas autorizam/);
    await bind();
    expect(await db.select().from(schema.whatsappSessionCompanies)).toHaveLength(2);
    expect(await audits()).toEqual(expect.arrayContaining(["whatsapp.session.company_bound:A", "whatsapp.session.company_bound:B"]));
    const b = await listSessions(db, dirB, B);
    expect(b).toHaveLength(1); expect(b[0]).toMatchObject({ id: sid, senderIdentity: "Financeiro Empresa B", status: "CONNECTED", companiesBound: 2 });
    expect((await db.select().from(schema.whatsappSessions))).toHaveLength(1);        // continua UMA conexão
    await expect(bind()).rejects.toThrow(/já usa a conexão/);                         // duplicado
    await expect(bindCompany(db, dirAB, A, sid, { targetCompanyId: A, senderIdentity: "Financeiro A", confirm: true })).rejects.toThrow(/já usa a conexão/);
    const ev = await evaluateTestSend(db, dirB, B, { sessionId: sid, phone: PHONE }, deps);
    expect(ev.canSend).toBe(false); expect(ev.checks.find((c) => c.key === "authorization")?.ok).toBe(false); // a autorização da A não vale para a B
  });

  it("no máximo 5 empresas por conexão", async () => {
    const extra = await db.insert(schema.companies).values([{ name: "E1" }, { name: "E2" }, { name: "E3" }]).returning();
    for (const e of extra) await db.insert(schema.memberships).values({ userId: dirAB, companyId: e.id, role: "diretoria" });
    await bind();
    await bindCompany(db, dirAB, A, sid, { targetCompanyId: extra[0].id, senderIdentity: "Financeiro E1", confirm: true });
    await bindCompany(db, dirAB, A, sid, { targetCompanyId: extra[1].id, senderIdentity: "Financeiro E2", confirm: true });
    await bindCompany(db, dirAB, A, sid, { targetCompanyId: extra[2].id, senderIdentity: "Financeiro E3", confirm: true });
    const six = (await db.insert(schema.companies).values({ name: "E4" }).returning())[0];
    await db.insert(schema.memberships).values({ userId: dirAB, companyId: six.id, role: "diretoria" });
    await expect(bindCompany(db, dirAB, A, sid, { targetCompanyId: six.id, senderIdentity: "Financeiro E4", confirm: true })).rejects.toThrow(/já é usada por 5 empresas/);
  });

  it("nomes de empresa só aparecem para quem também é membro dela; as outras viram 'Outra empresa do grupo'", async () => {
    await bind();
    const asB = await listBindings(db, dirB, B, sid);                    // dirB só é membro da B
    expect(asB.map((x) => x.name).sort()).toEqual(["Empresa B", "Outra empresa do grupo"]);
    expect(asB.find((x) => x.name === "Outra empresa do grupo")).toMatchObject({ companyId: null, identity: null }); // nome e remetente de empresa alheia ocultos
    expect(JSON.stringify(asB)).not.toMatch(/Empresa A|Financeiro Empresa A/);
    const asBoth = await listBindings(db, dirAB, A, sid);
    expect(asBoth.map((x) => x.name).sort()).toEqual(["Empresa A", "Empresa B"]);
    expect(asBoth.every((x) => x.companyId)).toBe(true);
    expect(asBoth.every((x) => x.since instanceof Date && !Number.isNaN(x.since.getTime()))).toBe(true); // a tela usa Date
    await expect(listBindings(db, contA, A, sid)).rejects.toBeInstanceOf(Forbidden);   // contabilidade não lê conexões
    await expect(listBindings(db, dirA, B, sid)).rejects.toBeInstanceOf(Forbidden);    // dirA não é da B
  });

  it("cada empresa envia com o SEU remetente, a SUA autorização e o SEU registro; o limite da conexão soma as duas (A24: sair bloqueia na hora)", async () => {
    await bind(); await auth(dirA, A); await auth(dirB, B);
    await send(dirA, A); await send(dirB, B);
    expect(waha.sent.map((m) => /Financeiro Empresa (A|B)/.exec(m.text)![1])).toEqual(["A", "B"]);
    const logs = await db.select().from(schema.whatsappSendLog);
    expect(logs.map((l) => l.companyId === A ? "A" : "B").sort()).toEqual(["A", "B"]);
    // a conexão é compartilhada: 20 envios da A hoje esgotam a conexão para a B (cada empresa respeita também o seu teto)
    await db.execute(sql`insert into whatsapp_send_log (company_id, session_id, phone_masked, idempotency_key, status, finished_at) select ${A}::uuid, ${sid}::uuid, '+55 92 •••••-1111', 'carga-a-' || g, 'enviado', now() from generate_series(1, 18) g`);
    await expect(send(dirB, B)).rejects.toThrow(/Limite de 20 por dia/);
    // a empresa B sai: bloqueada na hora; a A segue (se houvesse vaga)
    await expect(unbindCompany(db, dirB, B, sid, false)).rejects.toThrow(/Confirme/);
    await unbindCompany(db, dirB, B, sid, true);
    expect(await listSessions(db, dirB, B)).toEqual([]);
    await expect(send(dirB, B)).rejects.toThrow(/Envio bloqueado/);
    expect((await db.select().from(schema.whatsappSessionCompanies)).filter((x) => !x.revokedAt)).toHaveLength(1);
    expect(await audits()).toContain("whatsapp.session.company_unbound:B");
  });

  it("sair: só a diretoria da PRÓPRIA empresa; a última empresa não sai (use desconectar); o vínculo revogado fica no histórico e o banco só permite revogar", async () => {
    await bind();
    await expect(unbindCompany(db, dirA, B, sid, true)).rejects.toBeInstanceOf(Forbidden);   // diretoria da A não tira a B
    await expect(unbindCompany(db, gerB, B, sid, true)).rejects.toBeInstanceOf(Forbidden);
    await unbindCompany(db, dirB, B, sid, true);
    await expect(unbindCompany(db, dirA, A, sid, true)).rejects.toThrow(/última empresa/);
    const rows = await db.select().from(schema.whatsappSessionCompanies);
    expect(rows).toHaveLength(2); expect(rows.filter((r) => r.revokedAt).map((r) => r.revokedBy)).toEqual([dirB]);
    await bind(); // pode voltar depois
    expect((await db.select().from(schema.whatsappSessionCompanies)).filter((x) => !x.revokedAt)).toHaveLength(2);
    const why = async (q: ReturnType<typeof sql>) => { try { await db.execute(q); return ""; } catch (e) { return (e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message; } };
    expect(await why(sql`update whatsapp_session_companies set sender_identity = 'x1x' where revoked_at is null`)).toMatch(/só pode ser revogado/);
  });

  it("consentimento: só diretoria/gerência registram; global só diretoria; valida número, escolha, prova e cliente da MESMA empresa; repetir o mesmo estado é recusado", async () => {
    for (const who of [asstA, contA, techA]) await expect(rec(who, A)).rejects.toBeInstanceOf(Forbidden);
    await expect(rec(dirB, A)).rejects.toBeInstanceOf(Forbidden);                       // de outra empresa
    await expect(rec(gerA, A, { decision: "opt_out", scope: "global" })).rejects.toBeInstanceOf(Forbidden); // global é da diretoria
    await expect(rec(gerA, A, { phone: "92 1234" })).rejects.toThrow(/Número inválido/);
    await expect(rec(gerA, A, { decision: "talvez" })).rejects.toThrow(/consentiu ou pediu/);
    await expect(rec(gerA, A, { evidenceSource: "boato" })).rejects.toThrow(/prova/);
    await expect(rec(gerA, A, { evidenceRef: " x " })).rejects.toThrow(/onde está a prova/);
    const custB = (await createParty(db, dirB, B, { kind: "cliente", legalName: "Cliente da B", document: "11.222.333/0001-81" })).id;
    await expect(rec(gerA, A, { customerId: custB })).rejects.toThrow(/Cliente não encontrado/); // cliente de outra empresa
    await expect(rec(gerA, A, { customerId: "lixo" })).rejects.toThrow(/Cliente não encontrado/);
    const custA = (await createParty(db, dirA, A, { kind: "cliente", legalName: "Cliente da A", document: "12.ABC.345/01DE-35" })).id;
    await rec(gerA, A, { customerId: custA });
    expect((await consentState(db, A, DIGITS)).state).toBe("opt_in");
    await expect(rec(gerA, A)).rejects.toThrow(/já está registrado assim/);
    expect((await consentState(db, B, DIGITS)).state).toBe("none");                      // consentimento é por empresa
    expect(await db.select().from(schema.whatsappConsents)).toHaveLength(1);
  });

  it("estado = evento mais recente: opt-out vence e só um novo opt-in com prova o desfaz; o pedido de parar GLOBAL prevalece sobre qualquer consentimento de qualquer empresa", async () => {
    await rec(gerA, A);
    await rec(gerA, A, { decision: "opt_out", evidenceRef: "pedido por WhatsApp" });
    expect((await consentState(db, A, DIGITS)).state).toBe("opt_out_company");
    await rec(gerA, A);                                                                  // voltou a aceitar, com prova
    expect((await consentState(db, A, DIGITS)).state).toBe("opt_in");
    await rec(gerB, B);                                                                  // B também tem consentimento
    expect((await consentState(db, B, DIGITS)).state).toBe("opt_in");
    await rec(dirA, A, { decision: "opt_out", scope: "global", evidenceRef: "cliente pediu parar tudo" });
    expect((await consentState(db, A, DIGITS)).state).toBe("opt_out_global");
    expect((await consentState(db, B, DIGITS)).state).toBe("opt_out_global");            // a B também fica bloqueada
    await rec(gerB, B, { decision: "opt_out", evidenceRef: "pedido registrado na B" });  // opt-in da empresa não desfaz o global
    await rec(gerB, B, { evidenceRef: "reconsentimento" });                              // a B registra o aceite, mas...
    expect((await consentState(db, B, DIGITS)).state).toBe("opt_out_global");            // ...o global do número prevalece (opt-in da empresa NÃO o desfaz)
    expect((await consentState(db, A, DIGITS)).state).toBe("opt_out_global");
    await expect(rec(dirA, A, { decision: "opt_in", scope: "global", evidenceSource: "verbal", evidenceRef: "cliente voltou a aceitar" })).rejects.toThrow(/prova por escrito/); // verbal não desfaz o global
    expect((await consentState(db, B, DIGITS)).state).toBe("opt_out_global");
    await expect(rec(gerA, A, { decision: "opt_in", scope: "global", evidenceRef: "cliente voltou a aceitar" })).rejects.toBeInstanceOf(Forbidden); // e só a diretoria
    await rec(dirA, A, { decision: "opt_in", scope: "global", evidenceSource: "cliente_iniciou", evidenceRef: "cliente escreveu pedindo para voltar" }); // só outro global COM prova escrita/iniciada pelo cliente
    expect((await consentState(db, B, DIGITS)).state).toBe("opt_in");                    // volta ao último registro da B
    expect((await consentState(db, A, DIGITS)).state).toBe("opt_in");
    expect(await audits()).toEqual(expect.arrayContaining(["whatsapp.consent.opt_in:A", "whatsapp.consent.opt_out:A", "whatsapp.consent.opt_in:B"]));
    expect(JSON.stringify(await db.select().from(schema.auditLog))).not.toMatch(/5592|99999/); // auditoria sem telefone
  });

  it("a prova do consentimento é só uma referência: e-mail, telefone, CPF/CNPJ e sequências longas de dígitos são recusados; datas e números de contrato passam", async () => {
    for (const bad of ["fulano@empresa.com", "ligou do 92 99999-0000", "(92) 3234-5678", "+55 92 99999 0000", "cpf 123.456.789-09", "12345678909", "cnpj 11.222.333/0001-81", "protocolo 123456789012"]) await expect(rec(gerA, A, { evidenceRef: bad })).rejects.toThrow(/dado pessoal/);
    for (const ok of ["e-mail de 28/10/2026", "contrato 123", "anotação do atendimento 29/10 15h", "pedido 4821", "ata de 2026-10-29"]) { await rec(gerA, A, { evidenceRef: ok, phone: "92 96666-" + String(1000 + Math.floor(Math.random() * 8000)) }); }
    expect(await db.select().from(schema.whatsappConsents)).toHaveLength(5);
  });

  it("a lista de verificação do TESTE mostra o consentimento só como informação (vale a autorização por número); envio a cliente exigirá opt-in nas próximas entregas", async () => {
    await bind(); await auth(dirA, A);
    let ev = await evaluateTestSend(db, gerA, A, { sessionId: sid, phone: PHONE }, deps);
    expect(ev.checks.find((c) => c.key === "consent_info")).toMatchObject({ ok: true, detail: expect.stringMatching(/Sem registro.*TESTE/) });
    expect(ev.canSend).toBe(true);
    await rec(gerA, A);
    ev = await evaluateTestSend(db, gerA, A, { sessionId: sid, phone: PHONE }, deps);
    expect(ev.checks.find((c) => c.key === "consent_info")!.detail).toMatch(/Consentiu/);
  });

  it("listagem: só diretoria/gerência; telefone mascarado; cada empresa vê só os SEUS; opt-out global de outra empresa aparece como estado, sem dizer quem pediu", async () => {
    await rec(gerA, A);
    await rec(gerA, A, { phone: OTHER, decision: "opt_out", evidenceRef: "pedido verbal" });
    await rec(gerB, B, { phone: "92 97777-2222" });
    const a = await listConsents(db, gerA, A);
    expect(a.map((r) => r.phone).sort()).toEqual(["+55 92 •••••-0000", "+55 92 •••••-1111"]);
    expect(JSON.stringify(a)).not.toMatch(/5592999|98888|99999/);
    expect(a.find((r) => r.phone.endsWith("1111"))!.state).toBe("opt_out_company");
    expect(a.every((r) => r.at instanceof Date)).toBe(true);
    expect((await listConsents(db, gerB, B)).map((r) => r.phone)).toEqual(["+55 92 •••••-2222"]); // B não vê as da A
    for (const who of [asstA, contA, techA]) await expect(listConsents(db, who, A)).rejects.toBeInstanceOf(Forbidden);
    await expect(listConsents(db, dirB, A)).rejects.toBeInstanceOf(Forbidden);
    await rec(dirA, A, { decision: "opt_out", scope: "global", evidenceRef: "cliente pediu parar tudo" });
    await rec(gerB, B, { phone: PHONE });                                                  // a B consentiu esse número
    const b = await listConsents(db, gerB, B);
    expect(b.find((r) => r.phone.endsWith("0000"))!.state).toBe("opt_out_global");
    expect(JSON.stringify(b)).not.toMatch(/Empresa A|dir-a|ger-a/);                        // sem dizer quem pediu
  });

  it("o registro de consentimento é permanente (sem editar/apagar) e o banco liga o cliente à MESMA empresa", async () => {
    await rec(gerA, A);
    const why = async (q: ReturnType<typeof sql>) => { try { await db.execute(q); return ""; } catch (e) { return (e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message; } };
    expect(await why(sql`update whatsapp_consents set decision = 'opt_out'`)).toMatch(/permanente/);
    expect(await why(sql`delete from whatsapp_consents`)).toMatch(/permanente/);
    const custB = (await createParty(db, dirB, B, { kind: "cliente", legalName: "Cliente da B", document: "11.222.333/0001-81" })).id;
    expect(await why(sql`insert into whatsapp_consents (company_id, customer_id, phone, decision, scope, evidence_source, evidence_ref, actor_id) values (${A}::uuid, ${custB}::uuid, ${DIGITS}, 'opt_in', 'company', 'escrito', 'prova de teste', ${gerA}::uuid)`)).toMatch(/foreign key/);
    expect(await why(sql`insert into whatsapp_consents (company_id, phone, decision, scope, evidence_source, evidence_ref, actor_id) values (${A}::uuid, '123', 'opt_in', 'company', 'escrito', 'prova de teste', ${gerA}::uuid)`)).toMatch(/phone_chk/);
    expect(await why(sql`insert into whatsapp_consents (company_id, phone, decision, scope, evidence_source, evidence_ref, actor_id) values (${A}::uuid, ${DIGITS}, 'talvez', 'company', 'escrito', 'prova de teste', ${gerA}::uuid)`)).toMatch(/decision_chk/);
  });

  it("OPT-OUT PREVALECE: número da lista autorizada que pediu para parar (nesta empresa, ou global registrado por OUTRA empresa) não recebe o teste; o pedido de última hora também barra", async () => {
    await bind(); await auth(dirA, A); await auth(dirB, B);
    await rec(gerA, A, { decision: "opt_out", evidenceRef: "pedido verbal" });
    const ev = await evaluateTestSend(db, gerA, A, { sessionId: sid, phone: PHONE }, deps);
    expect(ev.checks.find((c) => c.key === "optout")).toMatchObject({ ok: false });
    expect(ev.checks.find((c) => c.key === "allowed")!.ok).toBe(true);                  // estava autorizado... e mesmo assim bloqueia
    await expect(send(gerA, A)).rejects.toThrow(/pediu para não receber mensagens desta empresa/);
    await rec(gerA, A, { evidenceRef: "reconsentimento por escrito" });                // voltou a aceitar: libera
    await send(gerA, A);
    expect(waha.sent).toHaveLength(1);
    // global registrado pela diretoria da B bloqueia a A
    await rec(dirB, B, { decision: "opt_out", scope: "global", evidenceRef: "pedido do cliente" });
    await expect(send(gerA, A)).rejects.toThrow(/nenhuma empresa/);
    await expect(send(dirB, B)).rejects.toThrow(/nenhuma empresa/);
    expect(waha.sent).toHaveLength(1);
    await rec(dirB, B, { decision: "opt_in", scope: "global", evidenceRef: "cliente voltou" });
    // opt-out registrado DEPOIS da avaliação, no instante da consulta do número: barra no último momento e nada sai
    waha.onCheck = async () => { await rec(gerA, A, { decision: "opt_out", evidenceRef: "pedido de última hora" }); waha.onCheck = null; };
    await expect(send(gerA, A)).rejects.toThrow(/último momento/);
    expect(waha.sent).toHaveLength(1);
    expect((await db.select().from(schema.whatsappSendLog)).filter((l) => l.error === "bloqueado_antes_de_enviar")).toHaveLength(1);
  });

  it("bloqueios recentes: motivo legível por tentativa, só da própria empresa, sem número e sem texto; exige permissão de leitura", async () => {
    await bind(); await auth(dirA, A);
    await rec(gerA, A, { decision: "opt_out", evidenceRef: "pedido verbal" });
    await expect(send(gerA, A)).rejects.toThrow(/Envio bloqueado/);
    await expect(send(gerA, A, OTHER)).rejects.toThrow(/Envio bloqueado/);
    const a = await recentBlocks(db, gerA, A);
    expect(a).toHaveLength(2);
    expect(a.flatMap((x) => x.reasons)).toEqual(expect.arrayContaining(["Contato pediu para não receber", "Número fora da lista autorizada"]));
    expect(JSON.stringify(a)).not.toMatch(/5592|99999|98888|Teste do K3G/);
    expect(await recentBlocks(db, dirB, B)).toEqual([]);                                  // a B não vê os da A
    await expect(recentBlocks(db, contA, A)).rejects.toBeInstanceOf(Forbidden);
    await expect(recentBlocks(db, dirB, A)).rejects.toBeInstanceOf(Forbidden);
  });

  it("QR e controle da conexão compartilhada continuam exigindo permissão na empresa de quem pede", async () => {
    await bind();
    expect((await getQr(db, dirB, B, sid, deps).catch((e) => e.message))).toMatch(/não está aguardando/); // B é diretoria da B e vê a conexão (conectada: sem QR)
    await expect(getQr(db, gerB, B, sid, deps)).rejects.toBeInstanceOf(Forbidden);                       // gerente não tem QR
    await expect(getQr(db, dirA, B, sid, deps)).rejects.toBeInstanceOf(Forbidden);                       // dirA não é da B
  });
});
