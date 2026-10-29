import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { eq, sql } from "drizzle-orm";
import { databaseUrl } from "@/lib/db/url";
import * as schema from "@/lib/db/schema";
import type { DB } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import { saveSettings } from "@/modules/messaging/service";
import { FakeWaha } from "./helpers/fake-waha";
import {
  createSession, disconnectSession, evaluateTestSend, getAuthorization, getQr, listSendLog, listSessions, refreshSession, revokeAuthorization, saveAuthorization, sendTest, setPaused, settleStaleSends, startSession, type Deps,
} from "@/modules/whatsapp/service";

const enabled = !!process.env.POSTGRES_USER;
let seq = 0;
const k = () => `tentativa-${++seq}-${Math.random().toString(36).slice(2, 10)}`; // uma chave por tentativa, como o formulário
const PHONE = "92 99999-0000", DIGITS = "5592999990000";
const ENV_ON = { WAHA_API_KEY: "k", WAHA_BASE_INTERNAL_URL: "http://waha:3000", WHATSAPP_MODULE_ENABLED: "true", WHATSAPP_SEND_ENABLED: "true" };

describe.skipIf(!enabled)("W1 WhatsApp: conexões, QR, isolamento por empresa, autorização e envio de teste (DB de teste, WAHA falsa)", () => {
  let admin: ReturnType<typeof postgres>, conn: ReturnType<typeof postgres>, db: DB;
  let A: string, B: string, dirA: string, dirB: string, gerA: string, asstA: string, contA: string, techA: string, outsider: string;
  let waha: FakeWaha, deps: Deps;

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
    await db.execute(sql`truncate whatsapp_send_log, whatsapp_send_authorizations, whatsapp_session_companies, whatsapp_sessions, messaging_settings, holidays, audit_log, invitations, memberships, companies, users restart identity cascade`);
    const [a, b] = await db.insert(schema.companies).values([{ name: "Empresa A" }, { name: "Empresa B" }]).returning();
    A = a.id; B = b.id;
    const mk = async (e: string) => (await db.insert(schema.users).values({ email: e, name: e.split("@")[0], passwordHash: "x" }).returning())[0].id;
    dirA = await mk("dir-a@t.com"); dirB = await mk("dir-b@t.com"); gerA = await mk("ger@t.com"); asstA = await mk("asst@t.com"); contA = await mk("cont@t.com"); techA = await mk("tech@t.com"); outsider = await mk("fora@t.com");
    await db.insert(schema.memberships).values([
      { userId: dirA, companyId: A, role: "diretoria" }, { userId: dirB, companyId: B, role: "diretoria" }, { userId: gerA, companyId: A, role: "gerente" },
      { userId: asstA, companyId: A, role: "assistente" }, { userId: contA, companyId: A, role: "contabilidade" }, { userId: techA, companyId: A, role: "admin_tecnico" },
    ]);
    waha = new FakeWaha();
    deps = { waha, env: { ...ENV_ON } };
    for (const co of [A, B]) { const who = co === A ? dirA : dirB; await saveSettings(db, who, co, { windowStart: "00:00", windowEnd: "23:59", weekdays: [0, 1, 2, 3, 4, 5, 6], skipHolidays: false, maxPerRun: "50", maxPerHour: "30", maxLateDays: "2" }); }
  });

  const newSession = async (who = dirA, co = A, name = "Financeiro principal") => (await createSession(db, who, co, { displayName: name, senderIdentity: "Financeiro Empresa A", confirmAuthorized: true }, deps)).sessionId;
  const providerName = async (id: string) => (await db.select().from(schema.whatsappSessions).where(eq(schema.whatsappSessions.id, id)))[0].providerSession;
  const ready = async (o: { phone?: string; limit?: number } = {}) => {
    const id = await newSession(); waha.connect(await providerName(id));
    await refreshSession(db, dirA, A, id, deps); await setPaused(db, dirA, A, id, false);
    await saveAuthorization(db, dirA, A, { reference: "e-mail da diretoria de 29/10/2026", phones: o.phone ?? PHONE, dailyLimit: o.limit ?? 5 });
    return id;
  };
  const audits = async () => (await db.select().from(schema.auditLog).where(sql`action like 'whatsapp.%'`)).map((a) => a.action);

  it("A01 papel: só diretoria e admin técnico criam conexão; gerente/assistente/contabilidade e quem não é da empresa recebem 403", async () => {
    for (const who of [gerA, asstA, contA]) await expect(createSession(db, who, A, { displayName: "X1", senderIdentity: "Fin A", confirmAuthorized: true }, deps)).rejects.toBeInstanceOf(Forbidden);
    await expect(createSession(db, outsider, A, { displayName: "X1", senderIdentity: "Fin A", confirmAuthorized: true }, deps)).rejects.toBeInstanceOf(Forbidden);
    await expect(createSession(db, dirB, A, { displayName: "X1", senderIdentity: "Fin A", confirmAuthorized: true }, deps)).rejects.toBeInstanceOf(Forbidden); // diretoria de B não age em A
    expect(await newSession(techA)).toBeTruthy();
    expect((await db.select().from(schema.whatsappSessions))).toHaveLength(1);
    await expect(listSessions(db, contA, A)).rejects.toBeInstanceOf(Forbidden);
    expect(await listSessions(db, gerA, A)).toHaveLength(1);
  });

  it("criar: valida campos, exige confirmação, módulo ligado e WAHA configurada; nasce PAUSADA e vinculada só à empresa que criou", async () => {
    const base = { displayName: "Financeiro", senderIdentity: "Financeiro Empresa A", confirmAuthorized: true };
    await expect(createSession(db, dirA, A, { ...base, confirmAuthorized: false }, deps)).rejects.toThrow(/autorização para usar/);
    await expect(createSession(db, dirA, A, { ...base, displayName: " x " }, deps)).rejects.toThrow(/nome interno/);
    await expect(createSession(db, dirA, A, { ...base, senderIdentity: "ab" }, deps)).rejects.toThrow(/aparece para o cliente/);
    await expect(createSession(db, dirA, A, base, { ...deps, env: { ...ENV_ON, WHATSAPP_MODULE_ENABLED: "false" } })).rejects.toThrow(/desligado no servidor/);
    await expect(createSession(db, dirA, A, base, { ...deps, env: { ...ENV_ON, WAHA_API_KEY: "" } })).rejects.toThrow(/não está configurada/);
    expect(waha.calls).toHaveLength(0); // nada foi para a WAHA nas recusas
    const id = await newSession();
    const [s] = await db.select().from(schema.whatsappSessions);
    expect(s).toMatchObject({ id, paused: true, status: "QR_REQUIRED", engine: "GOWS", createdBy: dirA });
    expect(s.providerSession).toMatch(/^k3g-[a-f0-9]{8}$/);
    const b = await db.select().from(schema.whatsappSessionCompanies);
    expect(b).toHaveLength(1); expect(b[0]).toMatchObject({ companyId: A, sessionId: id, senderIdentity: "Financeiro Empresa A" });
    expect(await audits()).toContain("whatsapp.session.created");
  });

  it("no máximo 3 conexões por empresa", async () => {
    for (let i = 0; i < 3; i++) await newSession(dirA, A, `Conexão ${i + 1}`);
    await expect(newSession(dirA, A, "Conexão 4")).rejects.toThrow(/já tem 3 conexões/);
  });

  it("WAHA fora do ar na criação: a conexão fica 'com problema' (código curto), sem erro vazando, e dá para tentar de novo", async () => {
    waha.down = true;
    const id = await newSession();
    const [s] = await db.select().from(schema.whatsappSessions).where(eq(schema.whatsappSessions.id, id));
    expect(s.status).toBe("DEGRADED"); expect(s.lastError).toBe("nao_enviado");
    await expect(startSession(db, dirA, A, id, deps)).rejects.toThrow(/WAHA não respondeu/);
    waha.down = false;
    await startSession(db, dirA, A, id, deps);
    expect((await listSessions(db, dirA, A))[0].status).toBe("QR_REQUIRED");
  });

  it("A02/A21 isolamento: a empresa B não vê nem comanda a conexão da A (mesma resposta de 'não encontrada')", async () => {
    const id = await newSession();
    expect(await listSessions(db, dirB, B)).toEqual([]);
    for (const act of [
      () => refreshSession(db, dirB, B, id, deps), () => startSession(db, dirB, B, id, deps), () => getQr(db, dirB, B, id, deps), () => setPaused(db, dirB, B, id, false),
      () => disconnectSession(db, dirB, B, id, true, deps),
    ]) await expect(act()).rejects.toThrow(/Conexão não encontrada/);
    const ev = await evaluateTestSend(db, dirB, B, { sessionId: id, phone: PHONE }, deps); // a lista de verificação não lança: só diz "sem vínculo", sem revelar a conexão
    expect(ev.canSend).toBe(false); expect(ev.session).toBeNull(); expect(ev.checks.find((c) => c.key === "bound")?.ok).toBe(false);
    await expect(sendTest(db, dirB, B, { sessionId: id, phone: PHONE, confirm: true, key: k() }, deps)).rejects.toThrow(/Envio bloqueado/);
    expect(waha.calls.filter((c) => c === "send")).toHaveLength(0);
    // id inválido também não vaza nada
    await expect(refreshSession(db, dirA, A, "nao-e-uuid", deps)).rejects.toThrow(/Conexão não encontrada/);
    // vínculo revogado = some para a empresa
    await db.update(schema.whatsappSessionCompanies).set({ revokedAt: new Date(), revokedBy: dirA }).where(eq(schema.whatsappSessionCompanies.companyId, A));
    expect(await listSessions(db, dirA, A)).toEqual([]);
    await expect(startSession(db, dirA, A, id, deps)).rejects.toThrow(/Conexão não encontrada/);
  });

  it("A03 QR: só para quem gerencia e só com a conexão aguardando leitura; conectada ou parada não entrega QR", async () => {
    const id = await newSession();
    expect((await getQr(db, dirA, A, id, deps)).toString()).toBe("PNGfake");
    await expect(getQr(db, gerA, A, id, deps)).rejects.toBeInstanceOf(Forbidden); // gerente lê estado, não QR
    waha.connect(await providerName(id));
    await expect(getQr(db, dirA, A, id, deps)).rejects.toThrow(/não está aguardando/);
    expect((await listSessions(db, dirA, A))[0]).toMatchObject({ status: "CONNECTED", phoneMasked: "+55 92 •••••-7777" });
  });

  it("A04 WAHA offline: o estado vira 'com problema' (visível) e volta sozinho quando a WAHA volta; histórico preservado", async () => {
    const id = await ready();
    waha.down = true;
    expect(await refreshSession(db, dirA, A, id, deps)).toMatchObject({ status: "DEGRADED", wahaDown: true });
    const ev = await evaluateTestSend(db, dirA, A, { sessionId: id, phone: PHONE }, deps);
    expect(ev.canSend).toBe(false); expect(ev.checks.find((c) => c.key === "session_connected")?.ok).toBe(false);
    await expect(sendTest(db, dirA, A, { sessionId: id, phone: PHONE, confirm: true, key: k() }, deps)).rejects.toThrow(/Envio bloqueado/);
    expect(waha.sent).toHaveLength(0);
    waha.down = false;
    expect(await refreshSession(db, dirA, A, id, deps)).toMatchObject({ status: "CONNECTED", wahaDown: false });
  });

  it("desconectar: exige confirmação, pausa, faz logout+stop e mantém o histórico; sessão sem login não impede", async () => {
    const id = await ready();
    await expect(disconnectSession(db, dirA, A, id, false, deps)).rejects.toThrow(/Confirme/);
    await disconnectSession(db, dirA, A, id, true, deps);
    expect(waha.calls).toEqual(expect.arrayContaining(["logout", "stop"]));
    const [s] = await db.select().from(schema.whatsappSessions);
    expect(s).toMatchObject({ status: "DISCONNECTED", paused: true });
    expect(await audits()).toContain("whatsapp.session.disconnected");
    await expect(disconnectSession(db, dirA, A, id, true, deps)).resolves.toBeUndefined(); // logout recusado (já sem login) é aceito
    expect(await db.select().from(schema.whatsappSessions)).toHaveLength(1); // nada apagado
  });

  it("autorização: só diretoria; valida números/limite; nova substitui a antiga; só revogar, nunca editar ou apagar (banco)", async () => {
    await expect(saveAuthorization(db, gerA, A, { reference: "autorização escrita", phones: PHONE, dailyLimit: 3 })).rejects.toBeInstanceOf(Forbidden);
    await expect(saveAuthorization(db, techA, A, { reference: "autorização escrita", phones: PHONE, dailyLimit: 3 })).rejects.toBeInstanceOf(Forbidden);
    await expect(saveAuthorization(db, dirA, A, { reference: "x", phones: PHONE, dailyLimit: 3 })).rejects.toThrow(/autorização escrita/);
    await expect(saveAuthorization(db, dirA, A, { reference: "autorização escrita", phones: "92 1234", dailyLimit: 3 })).rejects.toThrow(/Número inválido/);
    await expect(saveAuthorization(db, dirA, A, { reference: "autorização escrita", phones: "", dailyLimit: 3 })).rejects.toThrow(/de 1 a 10 números/);
    await expect(saveAuthorization(db, dirA, A, { reference: "autorização escrita", phones: Array.from({ length: 11 }, (_, i) => `92 99999-00${String(i).padStart(2, "0")}`).join("\n"), dailyLimit: 3 })).rejects.toThrow(/de 1 a 10 números/);
    for (const lim of [0, 11, 1.5, "x"]) await expect(saveAuthorization(db, dirA, A, { reference: "autorização escrita", phones: PHONE, dailyLimit: lim })).rejects.toThrow(/limite diário/);
    await saveAuthorization(db, dirA, A, { reference: "autorização escrita", phones: `${PHONE}\n(92) 98888-1111, +55 92 99999-0000`, dailyLimit: 3 });
    const a1 = await getAuthorization(db, gerA, A);
    expect(a1).toMatchObject({ count: 2, dailyLimit: 3 }); expect(a1!.phones).toEqual(["+55 92 •••••-0000", "+55 92 •••••-1111"]);
    await saveAuthorization(db, dirA, A, { reference: "nova autorização", phones: "92 97777-2222", dailyLimit: 1 });
    const all = await db.select().from(schema.whatsappSendAuthorizations);
    expect(all.filter((x) => x.active)).toHaveLength(1); expect(all).toHaveLength(2);
    expect(await getAuthorization(db, dirB, B)).toBeNull(); // outra empresa não vê
    const why = async (q: ReturnType<typeof sql>) => { try { await db.execute(q); return ""; } catch (e) { return (e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message; } };
    expect(await why(sql`update whatsapp_send_authorizations set allowed = array['5511999990000'] where active`)).toMatch(/só pode ser revogada/);
    expect(await why(sql`delete from whatsapp_send_authorizations`)).toMatch(/permanentes/);
    await revokeAuthorization(db, dirA, A);
    expect(await getAuthorization(db, dirA, A)).toBeNull();
  });

  it("A05/A16/A18 bloqueios: sem autorização, chave do servidor desligada, conexão pausada, empresa pausada — cada um com o motivo e NADA enviado", async () => {
    const id = await newSession(); waha.connect(await providerName(id)); await refreshSession(db, dirA, A, id, deps); await setPaused(db, dirA, A, id, false);
    const tryIt = async (d: Deps = deps) => sendTest(db, dirA, A, { sessionId: id, phone: PHONE, confirm: true, key: k() }, d).then(() => "ENVIOU", (e: Error) => e.message);
    const win = { windowStart: "00:00", windowEnd: "23:59", weekdays: [0, 1, 2, 3, 4, 5, 6], skipHolidays: false, maxPerRun: "50", maxPerHour: "30", maxLateDays: "2" };
    expect(await tryIt()).toMatch(/Registre a autorização/);                              // A05: sem autorização
    await saveAuthorization(db, dirA, A, { reference: "autorização escrita", phones: PHONE, dailyLimit: 5 });
    expect(await tryIt({ ...deps, env: { ...ENV_ON, WHATSAPP_SEND_ENABLED: "false" } })).toMatch(/WHATSAPP_SEND_ENABLED/); // A16: chave desligada
    await setPaused(db, dirA, A, id, true);
    expect(await tryIt()).toMatch(/pausada/);                                              // conexão pausada
    await setPaused(db, dirA, A, id, false);
    await saveSettings(db, dirA, A, { ...win, paused: true });
    expect(await tryIt()).toMatch(/pausados/);                                             // A18: empresa pausada
    await saveSettings(db, dirA, A, { ...win, paused: false });
    expect(waha.sent).toHaveLength(0);
    expect(await db.select().from(schema.whatsappSendLog)).toHaveLength(0);                // bloqueio não reserva nada
    const blocked = (await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "whatsapp.test_blocked")));
    expect(blocked.length).toBe(4); expect(JSON.stringify(blocked.map((b) => b.detail))).not.toMatch(/5592|99999/);
    expect(await tryIt()).toBe("ENVIOU");                                                  // liberado: agora vai
  });

  it("número fora da lista, inválido, de grupo ou sem confirmação: bloqueado", async () => {
    const id = await ready();
    for (const phone of ["92 98888-1111", "abc", "", "120363025246125486@g.us"]) await expect(sendTest(db, dirA, A, { sessionId: id, phone, confirm: true, key: k() }, deps)).rejects.toThrow(/Envio bloqueado/);
    await expect(sendTest(db, dirA, A, { sessionId: id, phone: PHONE, confirm: false, key: k() }, deps)).rejects.toThrow(/Confirme/);
    expect(waha.sent).toHaveLength(0);
    await expect(sendTest(db, asstA, A, { sessionId: id, phone: PHONE, confirm: true, key: k() }, deps)).rejects.toBeInstanceOf(Forbidden); // assistente não envia
    await expect(sendTest(db, techA, A, { sessionId: id, phone: PHONE, confirm: true, key: k() }, deps)).rejects.toBeInstanceOf(Forbidden);
  });

  it("envio feliz: texto fixo para a conversa individual, log só com número mascarado e sem texto, auditoria sem telefone", async () => {
    const id = await ready();
    const r = await sendTest(db, gerA, A, { sessionId: id, phone: PHONE, confirm: true, key: k() }, deps); // gerente também envia
    expect(waha.sent).toHaveLength(1);
    expect(waha.sent[0]).toMatchObject({ chatId: `${DIGITS}@c.us`, session: await providerName(id) });
    expect(waha.sent[0].text).toContain("Financeiro Empresa A"); expect(waha.sent[0].text).not.toMatch(/PARAR|http/);
    const [l] = await db.select().from(schema.whatsappSendLog);
    expect(l).toMatchObject({ id: r.logId, status: "enviado", phoneMasked: "+55 92 •••••-0000", kind: "teste", companyId: A, sessionId: id, actorId: gerA });
    expect(l.providerRef).toBe(createHash("sha256").update("ref-1").digest("hex").slice(0, 32)); expect(l.finishedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(l)).not.toContain(DIGITS);
    const au = (await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "whatsapp.test_sent")))[0];
    expect(JSON.stringify(au.detail)).not.toMatch(/5592|99999|Teste do K3G/);
    expect((await listSendLog(db, dirA, A))).toHaveLength(1);
    expect(await listSendLog(db, dirB, B)).toEqual([]);
  });

  it("A12 resultado ambíguo: vira 'desconhecido', explica que PODE ter chegado, conta no limite e NÃO é reenviado sozinho", async () => {
    const id = await ready({ limit: 2 });
    waha.sendMode = "unknown";
    await expect(sendTest(db, dirA, A, { sessionId: id, phone: PHONE, confirm: true, key: k() }, deps)).rejects.toThrow(/PODE ter chegado/);
    expect(waha.calls.filter((c) => c === "send")).toHaveLength(1); // uma única tentativa
    const [l] = await db.select().from(schema.whatsappSendLog);
    expect(l).toMatchObject({ status: "desconhecido", error: "sem_confirmacao" });
    waha.sendMode = "ok";
    await sendTest(db, dirA, A, { sessionId: id, phone: PHONE, confirm: true, key: k() }, deps); // reenvio só por ação humana
    await expect(sendTest(db, dirA, A, { sessionId: id, phone: PHONE, confirm: true, key: k() }, deps)).rejects.toThrow(/Limite da autorização|Limite diário/); // o ambíguo contou: 2 de 2
  });

  it("recusa da WAHA (400): 'falhou' com código, sem texto do provedor", async () => {
    const id = await ready();
    waha.sendMode = "fail";
    await expect(sendTest(db, dirA, A, { sessionId: id, phone: PHONE, confirm: true, key: k() }, deps)).rejects.toThrow(/recusou o envio \(http_400\)/);
    expect((await db.select().from(schema.whatsappSendLog))[0]).toMatchObject({ status: "falhou", error: "http_400" });
  });

  it("A17 janela: fora do horário/dia o envio é bloqueado com o motivo", async () => {
    const id = await ready();
    await saveSettings(db, dirA, A, { windowStart: "09:00", windowEnd: "17:00", weekdays: [1, 2, 3, 4, 5], skipHolidays: true, maxPerRun: "50", maxPerHour: "30", maxLateDays: "2" });
    const sat = new Date("2026-10-31T18:00:00Z"); // sábado 14:00 em Manaus
    await expect(sendTest(db, dirA, A, { sessionId: id, phone: PHONE, confirm: true, key: k() }, { ...deps, now: sat })).rejects.toThrow(/Dia da semana não permitido/);
    const night = new Date("2026-10-29T06:00:00Z"); // quinta 02:00 em Manaus
    await expect(sendTest(db, dirA, A, { sessionId: id, phone: PHONE, confirm: true, key: k() }, { ...deps, now: night })).rejects.toThrow(/Fora do horário/);
    expect(waha.sent).toHaveLength(0);
  });

  it("limites: o da autorização vale, o da conexão soma as empresas que a compartilham, e o da empresa é 10", async () => {
    const id = await ready({ limit: 2 });
    const go = () => sendTest(db, dirA, A, { sessionId: id, phone: PHONE, confirm: true, key: k() }, deps);
    await go(); await go();
    await expect(go()).rejects.toThrow(/Limite/);
    expect(waha.sent).toHaveLength(2);
    // conexão compartilhada: 20 envios da empresa B hoje esgotam a conexão para a A
    await db.insert(schema.whatsappSessionCompanies).values({ sessionId: id, companyId: B, senderIdentity: "Financeiro Empresa B", authorizedBy: dirB });
    await revokeAuthorization(db, dirA, A);
    await saveAuthorization(db, dirA, A, { reference: "nova autorização", phones: PHONE, dailyLimit: 10 });
    await db.execute(sql`insert into whatsapp_send_log (company_id, session_id, phone_masked, idempotency_key, status, finished_at) select ${B}::uuid, ${id}::uuid, '+55 92 •••••-1111', 'carga-lote-' || g, 'enviado', now() from generate_series(1, 18) g`);
    await expect(go()).rejects.toThrow(/Limite de 20 por dia/);
    expect(waha.sent).toHaveLength(2);
    // a lista da A não enxerga as linhas da B
    expect((await listSendLog(db, dirA, A, 50)).length).toBe(2);
  });

  it("A11 concorrência: duas tentativas simultâneas com 1 vaga enviam UMA só mensagem", async () => {
    const id = await ready({ limit: 1 });
    const r = await Promise.allSettled([1, 2, 3].map(() => sendTest(db, dirA, A, { sessionId: id, phone: PHONE, confirm: true, key: k() }, deps)));
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(waha.sent).toHaveLength(1);
    expect(await db.select().from(schema.whatsappSendLog)).toHaveLength(1);
  });

  it("A11b idempotência: o MESMO formulário (mesma chave) repetido ou em paralelo envia UMA mensagem, mesmo com vagas sobrando; chave nova envia outra", async () => {
    const id = await ready({ limit: 5 });
    const same = "tentativa-fixa-0001";
    const r = await Promise.allSettled([1, 2, 3, 4].map(() => sendTest(db, dirA, A, { sessionId: id, phone: PHONE, confirm: true, key: same }, deps)));
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(waha.sent).toHaveLength(1);
    await expect(sendTest(db, dirA, A, { sessionId: id, phone: PHONE, confirm: true, key: same }, deps)).rejects.toThrow(/já foi registrado \(enviado\)/); // recarga/reenvio depois
    expect(waha.sent).toHaveLength(1);
    await sendTest(db, dirA, A, { sessionId: id, phone: PHONE, confirm: true, key: "tentativa-fixa-0002" }, deps);
    expect(waha.sent).toHaveLength(2);
    for (const bad of ["", "curta", "tem espaço na chave aqui", "a".repeat(65), "../../etc"]) await expect(sendTest(db, dirA, A, { sessionId: id, phone: PHONE, confirm: true, key: bad }, deps)).rejects.toThrow(/Formulário vencido/);
    expect(waha.sent).toHaveLength(2);
    // a chave vale por empresa: a mesma chave em outra empresa não colide nem vaza
    expect((await db.select().from(schema.whatsappSendLog)).map((x) => x.idempotencyKey).sort()).toEqual(["tentativa-fixa-0001", "tentativa-fixa-0002"]);
  });

  it("a conexão cair ENTRE a avaliação e o envio bloqueia no último instante (estado lido na WAHA agora): nada sai e o registro fecha como falhou", async () => {
    const id = await ready();
    waha.getCount = 0; waha.dropOnGet = 2; // 1ª leitura (antes de avaliar) = conectada; 2ª (última conferência) = parada
    await expect(sendTest(db, dirA, A, { sessionId: id, phone: PHONE, confirm: true, key: k() }, deps)).rejects.toThrow(/último momento/);
    expect(waha.sent).toHaveLength(0);
    expect((await db.select().from(schema.whatsappSendLog))[0]).toMatchObject({ status: "falhou", error: "conexao_nao_conectada" });
    expect((await listSessions(db, dirA, A))[0].status).toBe("DISCONNECTED"); // e o estado verdadeiro foi gravado
  });

  it("o id devolvido pela WAHA (que traz o telefone) nunca é gravado cru: só o hash", async () => {
    const id = await ready();
    waha.refOverride = `true_${DIGITS}@c.us_3EB0ABCDEF`;
    await sendTest(db, dirA, A, { sessionId: id, phone: PHONE, confirm: true, key: k() }, deps);
    const [l] = await db.select().from(schema.whatsappSendLog);
    expect(l.providerRef).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(l)).not.toContain(DIGITS);
    expect(JSON.stringify(await db.select().from(schema.auditLog))).not.toContain(DIGITS);
  });

  it("reserva presa em 'enviando' (processo caiu): conta no limite, aparece, e só a diretoria a encerra como 'sem confirmação' depois de 10 min — sem reenviar", async () => {
    const id = await ready({ limit: 1 });
    const ins = (mins: number, key: string) => db.execute(sql`insert into whatsapp_send_log (company_id, session_id, phone_masked, idempotency_key, status, created_at) values (${A}::uuid, ${id}::uuid, '+55 92 •••••-0000', ${key}, 'enviando', now() - make_interval(mins => ${mins}))`);
    await ins(30, "reserva-antiga-001");
    await expect(sendTest(db, dirA, A, { sessionId: id, phone: PHONE, confirm: true, key: k() }, deps)).rejects.toThrow(/Limite/); // a presa ocupa a vaga
    await ins(2, "reserva-recente-01");
    await expect(settleStaleSends(db, gerA, A)).rejects.toBeInstanceOf(Forbidden);
    expect(await settleStaleSends(db, dirA, A)).toBe(1);
    const rows = await db.select().from(schema.whatsappSendLog);
    expect(rows.find((r) => r.idempotencyKey === "reserva-antiga-001")).toMatchObject({ status: "desconhecido", error: "reserva_abandonada" });
    expect(rows.find((r) => r.idempotencyKey === "reserva-recente-01")!.status).toBe("enviando"); // a recente não é tocada
    expect(await settleStaleSends(db, dirA, A)).toBe(0);
    expect(waha.sent).toHaveLength(0);
  });

  it("exceção inesperada depois da reserva não deixa 'enviando' pendurado: antes do pedido = falhou; depois = desconhecido (nunca reenviado)", async () => {
    const id = await ready({ limit: 5 });
    const orig = waha.sendText.bind(waha);
    waha.sendText = async () => { waha.calls.push("send"); throw new Error("bug inesperado com 5592999990000"); };
    await expect(sendTest(db, dirA, A, { sessionId: id, phone: PHONE, confirm: true, key: k() }, deps)).rejects.toThrow(/PODE ter sido enviada/);
    waha.sendText = orig;
    const origGet = waha.getSession.bind(waha); let n = 0;
    waha.getSession = async (name: string) => { if (++n === 2) throw new Error("falha do banco simulada"); return origGet(name); }; // 1ª leitura (refresh) ok; a da última conferência explode
    await expect(sendTest(db, dirA, A, { sessionId: id, phone: PHONE, confirm: true, key: k() }, deps)).rejects.toThrow(/último momento/); // erro de leitura = conexao_sem_resposta: bloqueia
    const rows = await db.select().from(schema.whatsappSendLog);
    expect(rows.map((r) => `${r.status}:${r.error}`).sort()).toEqual(["desconhecido:erro_interno", "falhou:conexao_sem_resposta"]);
    expect(rows.every((r) => r.status !== "enviando")).toBe(true);
    expect(JSON.stringify(await db.select().from(schema.auditLog))).not.toContain(DIGITS); // a mensagem da exceção (com telefone) nunca vai para a auditoria
    expect(waha.sent).toHaveLength(0);
  });

  it("resultado tardio depois de a reserva ser encerrada à mão não altera o registro (fica só a auditoria 'resultado tardio')", async () => {
    const id = await ready({ limit: 5 });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const orig = waha.sendText.bind(waha);
    waha.sendText = async (m) => { waha.calls.push("send"); await gate; return orig(m); };
    const pending = sendTest(db, dirA, A, { sessionId: id, phone: PHONE, confirm: true, key: k() }, deps);
    await new Promise((r) => setTimeout(r, 300));
    await db.execute(sql`alter table whatsapp_send_log disable trigger whatsapp_send_log_guard_trg`); // só o teste envelhece a reserva (o gatilho proíbe mexer em created_at)
    await db.execute(sql`update whatsapp_send_log set created_at = now() - interval '30 minutes'`);
    await db.execute(sql`alter table whatsapp_send_log enable trigger whatsapp_send_log_guard_trg`);
    expect(await settleStaleSends(db, dirA, A)).toBe(1);
    release(); await pending;
    const [l] = await db.select().from(schema.whatsappSendLog);
    expect(l).toMatchObject({ status: "desconhecido", error: "reserva_abandonada" }); // a verdade do registro não muda
    expect((await audits())).toContain("whatsapp.test_late_result");
    expect((await audits())).not.toContain("whatsapp.test_sent");
  });

  it("antes de enviar, o número é CONSULTADO na WAHA (sem isso o motor falha com 'no LID found'); usa o id canônico; número fora do WhatsApp ou divergente não envia", async () => {
    const id = await ready({ limit: 5 });
    // 1) caminho feliz: consulta ocorre ANTES do envio
    await sendTest(db, dirA, A, { sessionId: id, phone: PHONE, confirm: true, key: k() }, deps);
    expect(waha.calls.indexOf("check")).toBeLessThan(waha.calls.indexOf("send"));
    expect(waha.checked).toEqual([DIGITS]);
    // 2) a WAHA conhece o MESMO contato sem o 9º dígito (conta antiga do WhatsApp): equivalência oficial, envia ao id canônico
    waha.pnOverride = "559299990000@c.us"; // 12 dígitos; o autorizado tem 13 (5592 9 9999 0000)
    await sendTest(db, dirA, A, { sessionId: id, phone: PHONE, confirm: true, key: k() }, deps);
    expect(waha.sent[1].chatId).toBe("559299990000@c.us");
    // 3) a WAHA devolve OUTRO número (finais diferentes, DDD diferente, forma de telefone fixo, id interno): bloqueado, nada enviado
    for (const pn of ["559299991111@c.us", "551199990000@c.us", "559222220000@c.us", "5592999990000999@c.us", "160123456789@lid", "5592999990000@g.us"]) {
      waha.pnOverride = pn;
      await expect(sendTest(db, dirA, A, { sessionId: id, phone: PHONE, confirm: true, key: k() }, deps)).rejects.toThrow(/outro número|identificador/);
    }
    // 3b) existe, mas a WAHA não devolve id individual: nada sai
    waha.pnOverride = "SEM_PN";
    // 4) número não está no WhatsApp: falhou, nada enviado
    await expect(sendTest(db, dirA, A, { sessionId: id, phone: PHONE, confirm: true, key: k() }, deps)).rejects.toThrow(/identificador/);
    waha.pnOverride = ""; waha.exists = "no";
    await expect(sendTest(db, dirA, A, { sessionId: id, phone: PHONE, confirm: true, key: k() }, deps)).rejects.toThrow(/não foi encontrado no WhatsApp/);
    // 5) consulta falhou (WAHA lenta): nada saiu, registro fecha como falhou (não 'desconhecido': a consulta não envia)
    waha.exists = "error";
    await expect(sendTest(db, dirA, A, { sessionId: id, phone: PHONE, confirm: true, key: k() }, deps)).rejects.toThrow(/último momento/);
    expect(waha.sent).toHaveLength(2);
    const st = (await db.select().from(schema.whatsappSendLog)).map((r) => `${r.status}:${r.error ?? "-"}`).sort();
    expect(st.filter((x) => x.startsWith("falhou:numero_divergente"))).toHaveLength(6);
    expect(st.filter((x) => !x.startsWith("falhou:numero_divergente"))).toEqual(["enviado:-", "enviado:-", "falhou:conexao_sem_resposta", "falhou:numero_fora_do_whatsapp", "falhou:numero_sem_id_canonico"]);
  });

  it("registro de envios é permanente e só sai de 'enviando' uma vez; conexão e vínculo não são editados nem apagados", async () => {
    const id = await ready(); await sendTest(db, dirA, A, { sessionId: id, phone: PHONE, confirm: true, key: k() }, deps);
    const why = async (q: ReturnType<typeof sql>) => { try { await db.execute(q); return ""; } catch (e) { return (e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message; } };
    expect(await why(sql`update whatsapp_send_log set status = 'falhou'`)).toMatch(/só sai de "enviando" uma vez/);
    await db.execute(sql`insert into whatsapp_send_log (company_id, session_id, phone_masked, idempotency_key, status) values (${A}::uuid, ${id}::uuid, '+55 92 •••••-0000', 'chave-em-curso-1', 'enviando')`);
    expect(await why(sql`update whatsapp_send_log set phone_masked = 'x' where idempotency_key = 'chave-em-curso-1'`)).toMatch(/só sai de/);        // enviando só pode ser fechado, não reescrito
    expect(await why(sql`update whatsapp_send_log set status = 'enviado' where idempotency_key = 'chave-em-curso-1'`)).toMatch(/finished/);          // fechar exige a data de término
    expect(await why(sql`update whatsapp_send_log set status = 'desconhecido', finished_at = now() where idempotency_key = 'chave-em-curso-1'`)).toBe(""); // o fechamento válido passa
    expect(await why(sql`update whatsapp_send_log set phone_masked = 'x'`)).toMatch(/só sai de/);
    expect(await why(sql`delete from whatsapp_send_log`)).toMatch(/permanente/);
    expect(await why(sql`delete from whatsapp_sessions`)).toMatch(/não são apagadas/);
    expect(await why(sql`update whatsapp_sessions set provider_session = 'k3g-00000000'`)).toMatch(/identidade/);
    expect(await why(sql`delete from whatsapp_session_companies`)).toMatch(/permanente/);
    expect(await why(sql`update whatsapp_session_companies set company_id = ${B}::uuid`)).toMatch(/só pode ser revogado/);
    expect(await why(sql`update whatsapp_sessions set status = 'CONNECTED'`)).toBe(""); // estado muda normalmente
    expect(await why(sql`insert into whatsapp_send_log (company_id, session_id, phone_masked, idempotency_key, status) values (${A}::uuid, ${id}::uuid, 'x', 'chave-imutavel-1', 'enviado')`)).toMatch(/finished/); // enviado sem data de término: recusado
  });

  it("os formulários nunca escolhem a empresa: o serviço usa a empresa do contexto e confere o vínculo da conexão", async () => {
    const idA = await newSession(dirA, A, "Conexão da A");
    const idB = await newSession(dirB, B, "Conexão da B");
    expect((await listSessions(db, dirA, A)).map((s) => s.id)).toEqual([idA]);
    expect((await listSessions(db, dirB, B)).map((s) => s.id)).toEqual([idB]);
    await expect(setPaused(db, dirA, A, idB, false)).rejects.toThrow(/Conexão não encontrada/); // id de outra empresa informado na empresa certa
  });
});
