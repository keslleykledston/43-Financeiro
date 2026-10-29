import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { auditLog, holidays, whatsappSendAuthorizations, whatsappSendLog, whatsappSessionCompanies, whatsappSessions } from "@/lib/db/schema";
import { Invalid, requirePerm } from "@/modules/identity/service";
import { getSettings } from "@/modules/messaging/service";
import { WINDOW_REASON, windowState } from "@/modules/messaging/window";
import { createWahaClient, sessionNameFor, wahaConfigured, WahaError, type WahaClient, type WahaEnv, type WahaSession } from "@/modules/providers/waha";
import { CAPS, chatIdFor, mapWahaStatus, maskMe, maskPhone, parseBrPhone, refHash, testText, type Check, type SessionStatus } from "./domain";

/**
 * W1 — conexões de WhatsApp (WAHA, NÃO oficial) e envio MANUAL de teste. Nada aqui é automático: sem régua, sem fila, sem webhook (entregas 2 a 4).
 * Travas do envio de teste, todas obrigatórias: chave do servidor WHATSAPP_SEND_ENABLED, módulo ligado, WAHA configurada, conexão vinculada à empresa, não pausada e CONECTADA,
 * empresa não pausada, autorização ativa com o número exato, janela de envio, limites diários (autorização, empresa, conexão) e confirmação humana.
 * Rede nunca dentro de transação do banco. Resultado ambíguo vira "desconhecido" e nunca é reenviado sozinho.
 */
export const moduleOn = (env: WahaEnv = process.env) => env.WHATSAPP_MODULE_ENABLED === "true";
export const sendOn = (env: WahaEnv = process.env) => env.WHATSAPP_SEND_ENABLED === "true";
export type Deps = { waha?: WahaClient; env?: WahaEnv; now?: Date };
const envOf = (d?: Deps) => d?.env ?? process.env;
const clientOf = (d?: Deps) => d?.waha ?? createWahaClient(envOf(d));
const manausDay = (d = new Date()) => d.toLocaleDateString("sv-SE", { timeZone: "America/Manaus" });
const MAX_SESSIONS = 3;
const clean = (s: unknown, max: number) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

const audit = (x: DB, companyId: string, actorId: string | null, action: string, detail: Record<string, unknown> = {}) => x.insert(auditLog).values({ companyId, actorId, action, detail });

/** A conexão só existe para quem tem vínculo ATIVO com a empresa: outra empresa recebe o mesmo "não encontrada" (sem vazar que existe). */
async function bound(x: DB, companyId: string, sessionId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId ?? "")) throw new Invalid("Conexão não encontrada");
  const [r] = await x.select({ s: whatsappSessions, b: whatsappSessionCompanies }).from(whatsappSessions)
    .innerJoin(whatsappSessionCompanies, and(eq(whatsappSessionCompanies.sessionId, whatsappSessions.id), eq(whatsappSessionCompanies.companyId, companyId), isNull(whatsappSessionCompanies.revokedAt)))
    .where(eq(whatsappSessions.id, sessionId));
  if (!r || r.s.status === "REVOKED") throw new Invalid("Conexão não encontrada");
  return r;
}

export async function listSessions(db: DB, actorId: string, companyId: string) {
  await requirePerm(db, actorId, companyId, "whatsapp.read");
  const rows = await db.select({ s: whatsappSessions, b: whatsappSessionCompanies }).from(whatsappSessions)
    .innerJoin(whatsappSessionCompanies, and(eq(whatsappSessionCompanies.sessionId, whatsappSessions.id), eq(whatsappSessionCompanies.companyId, companyId), isNull(whatsappSessionCompanies.revokedAt)))
    .orderBy(desc(whatsappSessions.createdAt));
  const counts = rows.length ? ((await db.execute(sql`select session_id::text id, count(*)::int n from whatsapp_session_companies where revoked_at is null and session_id in (${sql.join(rows.map((r) => sql`${r.s.id}`), sql`, `)}) group by 1`)) as unknown as { id: string; n: number }[]) : [];
  const n = new Map(counts.map((c) => [c.id, c.n]));
  return rows.filter((r) => r.s.status !== "REVOKED").map(({ s, b }) => ({
    id: s.id, displayName: s.displayName, senderIdentity: b.senderIdentity, status: s.status as SessionStatus, paused: s.paused, phoneMasked: s.phoneMasked, engine: s.engine,
    lastSeenAt: s.lastSeenAt, lastError: s.lastError, companiesBound: n.get(s.id) ?? 1, createdAt: s.createdAt,
  }));
}

export async function createSession(db: DB, actorId: string, companyId: string, input: { displayName: string; senderIdentity: string; confirmAuthorized: boolean }, deps?: Deps) {
  await requirePerm(db, actorId, companyId, "whatsapp.manage");
  const env = envOf(deps);
  if (!moduleOn(env)) throw new Invalid("O módulo WhatsApp está desligado no servidor (WHATSAPP_MODULE_ENABLED)");
  if (!wahaConfigured(env)) throw new Invalid("A conexão com a WAHA não está configurada no servidor");
  const displayName = clean(input.displayName, 64), senderIdentity = clean(input.senderIdentity, 80);
  if (displayName.length < 2) throw new Invalid("Dê um nome interno à conexão (2 a 64 letras)");
  if (senderIdentity.length < 3) throw new Invalid("Informe o nome que aparece para o cliente (ex.: Financeiro K3G Solutions)");
  if (!input.confirmAuthorized) throw new Invalid("Confirme que você tem autorização para usar este número");
  let sessionId = "", name = "";
  for (let i = 0; i < 3 && !sessionId; i++) {
    const id = randomUUID(); name = sessionNameFor(id);
    try {
      await db.transaction(async (tx) => {
        const x = tx as unknown as DB;
        await x.execute(sql`select pg_advisory_xact_lock(hashtext(${"whatsapp-session:" + companyId}))`);
        const [{ n }] = (await x.execute(sql`select count(*)::int n from whatsapp_session_companies b join whatsapp_sessions s on s.id = b.session_id where b.company_id = ${companyId} and b.revoked_at is null and s.status <> 'REVOKED'`)) as unknown as { n: number }[];
        if (n >= MAX_SESSIONS) throw new Invalid(`Esta empresa já tem ${MAX_SESSIONS} conexões. Remova uma antes de criar outra`);
        await x.insert(whatsappSessions).values({ id, providerSession: name, displayName, createdBy: actorId });
        await x.insert(whatsappSessionCompanies).values({ sessionId: id, companyId, senderIdentity, authorizedBy: actorId });
        await audit(x, companyId, actorId, "whatsapp.session.created", { sessionId: id });
      });
      sessionId = id;
    } catch (e) { if (e instanceof Invalid) throw e; if ((e as { cause?: { code?: string } }).cause?.code !== "23505") throw e; }
  }
  if (!sessionId) throw new Invalid("Não foi possível criar a conexão agora. Tente de novo");
  await syncFromWaha(db, sessionId, name, async (w) => w.createSession(name), deps); // se a WAHA falhar, a conexão fica "com problema" e dá para tentar de novo
  return { sessionId };
}

/** Aplica o resultado da WAHA à linha (status, telefone mascarado, última leitura). Falha da WAHA vira "com problema" com código curto, nunca o corpo. */
async function syncFromWaha(db: DB, sessionId: string, name: string, op: (w: WahaClient) => Promise<{ status: string; meId: string | null; engine: string | null } | null>, deps?: Deps): Promise<{ status: SessionStatus; wahaDown: boolean }> {
  try {
    const r = await op(clientOf(deps));
    const status: SessionStatus = r ? mapWahaStatus(r.status) : "DISCONNECTED";
    await db.update(whatsappSessions).set({ status, phoneMasked: r ? maskMe(r.meId) ?? sql`${whatsappSessions.phoneMasked}` : sql`${whatsappSessions.phoneMasked}`, engine: r?.engine ?? sql`${whatsappSessions.engine}`, lastSeenAt: new Date(), lastError: r ? null : "sessao_ausente_na_waha", updatedAt: new Date() }).where(eq(whatsappSessions.id, sessionId));
    return { status, wahaDown: false };
  } catch (e) {
    const code = e instanceof WahaError ? e.code : "erro_desconhecido";
    await db.update(whatsappSessions).set({ status: "DEGRADED", lastError: code.slice(0, 60), updatedAt: new Date() }).where(and(eq(whatsappSessions.id, sessionId), sql`${whatsappSessions.status} <> 'REVOKED'`));
    return { status: "DEGRADED", wahaDown: true };
  }
}

/** Relê o estado na WAHA (usado pela tela a cada poucos segundos e antes de qualquer envio). */
export async function refreshSession(db: DB, actorId: string, companyId: string, sessionId: string, deps?: Deps) {
  await requirePerm(db, actorId, companyId, "whatsapp.read");
  const { s } = await bound(db, companyId, sessionId);
  if (!moduleOn(envOf(deps)) || !wahaConfigured(envOf(deps))) return { status: s.status as SessionStatus, wahaDown: true };
  return syncFromWaha(db, s.id, s.providerSession, (w) => w.getSession(s.providerSession), deps);
}

export async function startSession(db: DB, actorId: string, companyId: string, sessionId: string, deps?: Deps) {
  await requirePerm(db, actorId, companyId, "whatsapp.manage");
  if (!moduleOn(envOf(deps))) throw new Invalid("O módulo WhatsApp está desligado no servidor");
  const { s } = await bound(db, companyId, sessionId);
  const r = await syncFromWaha(db, s.id, s.providerSession, async (w) => ((await w.getSession(s.providerSession)) ? w.startSession(s.providerSession) : w.createSession(s.providerSession)), deps);
  await audit(db, companyId, actorId, "whatsapp.session.started", { sessionId: s.id, status: r.status });
  if (r.wahaDown) throw new Invalid("A WAHA não respondeu. Confira se o serviço está no ar e tente de novo");
}

/** PNG do QR, só para quem gerencia, só com a conexão aguardando leitura. O chamador responde `no-store`. */
export async function getQr(db: DB, actorId: string, companyId: string, sessionId: string, deps?: Deps): Promise<Buffer> {
  await requirePerm(db, actorId, companyId, "whatsapp.manage");
  const { s } = await bound(db, companyId, sessionId);
  if (!moduleOn(envOf(deps))) throw new Invalid("O módulo WhatsApp está desligado no servidor");
  const r = await syncFromWaha(db, s.id, s.providerSession, (w) => w.getSession(s.providerSession), deps);
  if (r.status !== "QR_REQUIRED") throw new Invalid("A conexão não está aguardando leitura do QR");
  try { return await clientOf(deps).qr(s.providerSession); }
  catch { throw new Invalid("O QR não está disponível agora. Aguarde alguns segundos"); }
}

export async function setPaused(db: DB, actorId: string, companyId: string, sessionId: string, paused: boolean) {
  await requirePerm(db, actorId, companyId, "whatsapp.manage");
  const { s } = await bound(db, companyId, sessionId);
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await x.update(whatsappSessions).set({ paused, updatedAt: new Date() }).where(eq(whatsappSessions.id, s.id));
    await audit(x, companyId, actorId, paused ? "whatsapp.session.paused" : "whatsapp.session.resumed", { sessionId: s.id });
  });
}

/** Desconecta o aparelho (logout) e para a sessão. O registro e o histórico ficam; a conexão volta pausada. */
export async function disconnectSession(db: DB, actorId: string, companyId: string, sessionId: string, confirm: boolean, deps?: Deps) {
  await requirePerm(db, actorId, companyId, "whatsapp.manage");
  if (!confirm) throw new Invalid("Confirme que deseja desconectar este número");
  const { s } = await bound(db, companyId, sessionId);
  await db.update(whatsappSessions).set({ paused: true, updatedAt: new Date() }).where(eq(whatsappSessions.id, s.id)); // pausa primeiro: nenhum envio entra enquanto desconecta
  const w = clientOf(deps);
  let failed = "";
  try { await w.logoutSession(s.providerSession); } catch (e) { if (!(e instanceof WahaError && e.kind === "http")) failed = e instanceof WahaError ? e.code : "erro"; } // sessão sem login: o logout recusa, e tudo bem
  try { await w.stopSession(s.providerSession); } catch (e) { if (!(e instanceof WahaError && e.kind === "http")) failed = e instanceof WahaError ? e.code : "erro"; }
  await db.update(whatsappSessions).set({ status: failed ? "DEGRADED" : "DISCONNECTED", lastError: failed || null, updatedAt: new Date() }).where(eq(whatsappSessions.id, s.id));
  await audit(db, companyId, actorId, "whatsapp.session.disconnected", { sessionId: s.id, ok: !failed });
  if (failed) throw new Invalid("A WAHA não confirmou a desconexão. A conexão ficou pausada; confira o aparelho e tente de novo");
}

// ---------- Autorização de envio real (por empresa) ----------
export async function getAuthorization(db: DB, actorId: string, companyId: string) {
  await requirePerm(db, actorId, companyId, "whatsapp.read");
  const [a] = await db.select().from(whatsappSendAuthorizations).where(and(eq(whatsappSendAuthorizations.companyId, companyId), eq(whatsappSendAuthorizations.active, true)));
  return a ? { id: a.id, reference: a.reference, phones: a.allowed.map(maskPhone), count: a.allowed.length, dailyLimit: a.dailyLimit, authorizedAt: a.createdAt } : null;
}

export async function saveAuthorization(db: DB, actorId: string, companyId: string, input: { reference: string; phones: string; dailyLimit: unknown }) {
  await requirePerm(db, actorId, companyId, "whatsapp.authorize");
  const reference = clean(input.reference, 200);
  if (reference.length < 5) throw new Invalid("Informe onde está a autorização escrita (e-mail, ata, documento)");
  const parsed = String(input.phones ?? "").split(/[\n,;]+/).map((p) => p.trim()).filter(Boolean);
  const phones: string[] = [];
  for (const p of parsed) { const d = parseBrPhone(p); if (!d) throw new Invalid(`Número inválido: ${p.slice(0, 20)}. Use DDD + número (ex.: 92 99999-0000)`); if (!phones.includes(d)) phones.push(d); }
  if (phones.length < 1 || phones.length > CAPS.authorizationMax) throw new Invalid(`Informe de 1 a ${CAPS.authorizationMax} números`);
  const limit = Number(input.dailyLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > CAPS.authorizationMax) throw new Invalid(`O limite diário deve ficar entre 1 e ${CAPS.authorizationMax}`);
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await x.execute(sql`select pg_advisory_xact_lock(hashtext(${"whatsapp-auth:" + companyId}))`);
    await x.update(whatsappSendAuthorizations).set({ active: false, revokedAt: new Date(), revokedBy: actorId, updatedAt: new Date() }).where(and(eq(whatsappSendAuthorizations.companyId, companyId), eq(whatsappSendAuthorizations.active, true)));
    await x.insert(whatsappSendAuthorizations).values({ companyId, reference, allowed: phones, dailyLimit: limit, authorizedBy: actorId });
    await audit(x, companyId, actorId, "whatsapp.authorization.saved", { numbers: phones.length, dailyLimit: limit });
  });
}

export async function revokeAuthorization(db: DB, actorId: string, companyId: string) {
  await requirePerm(db, actorId, companyId, "whatsapp.authorize");
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    const r = await x.update(whatsappSendAuthorizations).set({ active: false, revokedAt: new Date(), revokedBy: actorId, updatedAt: new Date() }).where(and(eq(whatsappSendAuthorizations.companyId, companyId), eq(whatsappSendAuthorizations.active, true))).returning({ id: whatsappSendAuthorizations.id });
    if (r.length) await audit(x, companyId, actorId, "whatsapp.authorization.revoked", {});
  });
}

// ---------- Envio manual de teste ----------
async function usedToday(x: DB, companyId: string, sessionId: string, today = manausDay()) {
  const r = (await x.execute(sql`select
      count(*) filter (where company_id = ${companyId})::int company,
      count(*) filter (where session_id = ${sessionId})::int session
    from whatsapp_send_log where status in ('enviando', 'enviado', 'desconhecido') and (created_at at time zone 'America/Manaus')::date = ${today}::date and (company_id = ${companyId} or session_id = ${sessionId})`)) as unknown as { company: number; session: number }[];
  return { company: Number(r[0].company), session: Number(r[0].session) };
}

/** Lista de verificação do envio de teste (a mesma que a tela mostra e o envio exige). `canSend` = todas verdes. Não envia nada e não usa rede. */
export async function evaluateTestSend(db: DB, actorId: string, companyId: string, input: { sessionId: string; phone: string }, deps?: Deps) {
  await requirePerm(db, actorId, companyId, "whatsapp.send");
  const env = envOf(deps);
  const checks: Check[] = [];
  const add = (key: string, ok: boolean, label: string, detail?: string) => { checks.push({ key, ok, label, detail }); return ok; };
  add("server_flag", sendOn(env), "Envio liberado no servidor", sendOn(env) ? undefined : "A chave WHATSAPP_SEND_ENABLED está desligada: nada pode ser enviado");
  add("module", moduleOn(env) && wahaConfigured(env), "Módulo WhatsApp e WAHA configurados", moduleOn(env) && wahaConfigured(env) ? undefined : "O módulo está desligado ou a WAHA não está configurada no servidor");
  let sess: Awaited<ReturnType<typeof bound>> | null = null;
  try { sess = await bound(db, companyId, input.sessionId); } catch { /* sem vínculo */ }
  add("bound", !!sess, "Conexão vinculada a esta empresa", sess ? undefined : "Escolha uma conexão desta empresa");
  if (sess) {
    add("session_active", !sess.s.paused, "Conexão não está pausada", sess.s.paused ? "A conexão está pausada. Libere em Conexões" : undefined);
    add("session_connected", sess.s.status === "CONNECTED", "Conexão conectada", sess.s.status === "CONNECTED" ? undefined : `Situação atual: ${sess.s.status === "QR_REQUIRED" ? "aguardando leitura do QR" : sess.s.status === "DEGRADED" ? "com problema" : sess.s.status === "DISCONNECTED" ? "desconectada" : sess.s.status === "STARTING" ? "iniciando" : "criada"}`);
  }
  const st = await getSettings(db, actorId, companyId);
  add("company_active", !st.paused, "Envios da empresa não estão pausados", st.paused ? "A empresa está com os envios pausados em Mensagens → Configuração" : undefined);
  const [auth] = await db.select().from(whatsappSendAuthorizations).where(and(eq(whatsappSendAuthorizations.companyId, companyId), eq(whatsappSendAuthorizations.active, true)));
  add("authorization", !!auth, "Autorização de envio registrada", auth ? undefined : "Registre a autorização (referência e números permitidos) nesta página");
  const digits = parseBrPhone(input.phone);
  add("phone", !!digits, "Número válido (individual)", digits ? undefined : "Informe DDD + número de celular");
  add("allowed", !!digits && !!auth && auth.allowed.includes(digits), "Número está na lista autorizada", digits && auth && auth.allowed.includes(digits) ? undefined : "Só números da autorização podem receber o teste");
  const hol = await db.select().from(holidays).where(eq(holidays.companyId, companyId));
  const w = windowState(deps?.now ?? new Date(), st, new Map(hol.map((h) => [h.day, h.name])));
  add("window", w.open, "Dentro da janela de envio", w.open ? undefined : `${WINDOW_REASON[w.reason]} (horário de Manaus; ajuste em Mensagens → Configuração)`);
  if (sess) {
    const u = await usedToday(db, companyId, sess.s.id, manausDay(deps?.now));
    const lim = auth?.dailyLimit ?? 0;
    add("cap_auth", u.company < lim, "Limite da autorização", u.company < lim ? `${u.company} de ${lim} hoje` : `Limite diário da autorização atingido (${lim})`);
    add("cap_company", u.company < CAPS.companyDaily, "Limite diário da empresa", u.company < CAPS.companyDaily ? undefined : `Limite de ${CAPS.companyDaily} por dia atingido`);
    add("cap_session", u.session < CAPS.sessionDaily, "Limite diário da conexão", u.session < CAPS.sessionDaily ? undefined : `Limite de ${CAPS.sessionDaily} por dia atingido (soma das empresas)`);
  }
  return { checks, canSend: checks.every((c) => c.ok), digits, session: sess?.s ?? null, senderIdentity: sess?.b.senderIdentity ?? null, authorizationId: auth?.id ?? null };
}

const IDEM = /^[A-Za-z0-9_-]{8,64}$/;
class DuplicateKey extends Error {}

/**
 * `key` = uma por tentativa da tela (o formulário gera uma nova a cada envio): reenviar o MESMO formulário (duplo clique, recarga, repetição da requisição) nunca manda de novo.
 */
export async function sendTest(db: DB, actorId: string, companyId: string, input: { sessionId: string; phone: string; confirm: boolean; key: string }, deps?: Deps) {
  await requirePerm(db, actorId, companyId, "whatsapp.send");
  if (!input.confirm) throw new Invalid("Confirme que o número é seu ou de quem autorizou o teste");
  if (!IDEM.test(input.key ?? "")) throw new Invalid("Formulário vencido. Recarregue a página e tente de novo");
  const dup = async (x: DB) => (await x.select({ s: whatsappSendLog.status }).from(whatsappSendLog).where(and(eq(whatsappSendLog.companyId, companyId), eq(whatsappSendLog.idempotencyKey, input.key))))[0];
  const already = (st: string) => new Invalid(`Este envio já foi registrado (${st === "desconhecido" ? "sem confirmação" : st}). Nada novo foi enviado; para outro teste, recarregue a página`);
  { const d = await dup(db); if (d) throw already(d.s); }
  const env = envOf(deps);
  // estado fresco da conexão antes de decidir (a tela mostra o último conhecido)
  if (moduleOn(env) && wahaConfigured(env) && /^[0-9a-f-]{36}$/i.test(input.sessionId ?? "")) { try { await refreshSession(db, actorId, companyId, input.sessionId, deps); } catch { /* sem vínculo: a lista de verificação explica */ } }
  const ev = await evaluateTestSend(db, actorId, companyId, input, deps);
  const blocked = ev.checks.filter((c) => !c.ok);
  if (blocked.length || !ev.session || !ev.digits || !ev.senderIdentity) {
    await audit(db, companyId, actorId, "whatsapp.test_blocked", { reasons: blocked.map((b) => b.key) });
    throw new Invalid(`Envio bloqueado: ${blocked[0]?.detail ?? blocked[0]?.label ?? "verifique a lista"}. Nada foi enviado`);
  }
  const session = ev.session, digits = ev.digits, authId = ev.authorizationId;
  const logId = await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await x.execute(sql`select pg_advisory_xact_lock(hashtext(${"whatsapp-send:" + session.id}))`); // limites sem corrida (conexão compartilhada entre empresas)
    await x.execute(sql`select pg_advisory_xact_lock(hashtext(${"whatsapp-send-co:" + companyId}))`);
    const d = await dup(x); if (d) throw already(d.s); // outra requisição com a mesma chave chegou primeiro
    const u = await usedToday(x, companyId, session.id, manausDay(deps?.now));
    const [auth] = await x.select().from(whatsappSendAuthorizations).where(and(eq(whatsappSendAuthorizations.companyId, companyId), eq(whatsappSendAuthorizations.active, true)));
    if (!auth || auth.id !== authId) throw new Invalid("A autorização foi revogada. Nada foi enviado");
    if (u.company + 1 > Math.min(auth.dailyLimit, CAPS.companyDaily) || u.session + 1 > CAPS.sessionDaily) throw new Invalid("Limite diário de envios atingido. Nada foi enviado");
    try {
      const [l] = await x.insert(whatsappSendLog).values({ companyId, sessionId: session.id, phoneMasked: maskPhone(digits), idempotencyKey: input.key, actorId }).returning({ id: whatsappSendLog.id });
      return l.id;
    } catch (e) { if ((e as { cause?: { code?: string } }).cause?.code === "23505") throw new DuplicateKey(); throw e; } // mesma chave chegou ao mesmo tempo: é duplicata, não erro
  }).catch(async (e) => { if (e instanceof DuplicateKey) throw already((await dup(db))?.s ?? "enviando"); throw e; });
  const finish = async (r: { status: "enviado" | "falhou" | "desconhecido"; providerRef?: string | null; error?: string | null }) => {
    await db.transaction(async (tx) => {
      const x = tx as unknown as DB;
      const upd = await x.update(whatsappSendLog).set({ status: r.status, providerRef: r.providerRef ?? null, error: r.error ? r.error.slice(0, 60) : null, finishedAt: new Date(), updatedAt: new Date() }).where(and(eq(whatsappSendLog.id, logId), eq(whatsappSendLog.status, "enviando"))).returning({ id: whatsappSendLog.id });
      if (!upd.length) { await audit(x, companyId, actorId, "whatsapp.test_late_result", { logId, status: r.status }); return; } // a reserva já tinha sido encerrada (reserva abandonada): o registro não muda, só fica a auditoria do resultado tardio
      await audit(x, companyId, actorId, r.status === "enviado" ? "whatsapp.test_sent" : "whatsapp.test_failed", { logId, status: r.status, ...(r.error ? { error: r.error.slice(0, 60) } : {}) });
    });
  };
  const abort = async (code: string) => { await finish({ status: "falhou", error: code }); throw new Invalid("O envio foi bloqueado no último momento (chave, pausa, autorização ou conexão mudou). Nada foi enviado"); };
  let calling = false; // true a partir do instante em que o pedido de envio pode ter saído
  try {
    // última conferência antes de sair: chave, pausa, autorização e CONEXÃO (lida na WAHA agora) podem ter mudado entre reservar e enviar
    const [still] = await db.select({ p: whatsappSessions.paused, st: whatsappSessions.status }).from(whatsappSessions).where(eq(whatsappSessions.id, session.id));
    const [authNow] = await db.select({ id: whatsappSendAuthorizations.id }).from(whatsappSendAuthorizations).where(and(eq(whatsappSendAuthorizations.companyId, companyId), eq(whatsappSendAuthorizations.active, true)));
    const [bnd] = await db.select({ id: whatsappSessionCompanies.id }).from(whatsappSessionCompanies).where(and(eq(whatsappSessionCompanies.sessionId, session.id), eq(whatsappSessionCompanies.companyId, companyId), isNull(whatsappSessionCompanies.revokedAt)));
    if (!sendOn(env) || still?.p !== false || still?.st !== "CONNECTED" || authNow?.id !== authId || !bnd) return await abort("bloqueado_antes_de_enviar");
    const w = clientOf(deps);
    let live: WahaSession | null = null;
    try { live = await w.getSession(session.providerSession); } catch { return await abort("conexao_sem_resposta"); }
    if (live?.status !== "WORKING") { await syncFromWaha(db, session.id, session.providerSession, async () => live, deps); return await abort("conexao_nao_conectada"); }
    calling = true;
    const res = await w.sendText({ session: session.providerSession, chatId: chatIdFor(digits), text: testText(ev.senderIdentity) });
    await finish(res.ok ? { status: "enviado", providerRef: refHash(res.providerRef) } : { status: res.unknown ? "desconhecido" : "falhou", error: res.error });
    if (!res.ok) throw new Invalid(res.unknown ? "A WAHA não confirmou o envio (a mensagem PODE ter chegado). Confira o aparelho; ela não será reenviada sozinha" : `A WAHA recusou o envio (${res.error}). Nada foi enviado`);
    return { logId };
  } catch (e) {
    if (e instanceof Invalid) throw e;
    // exceção inesperada depois da reserva: nunca deixar «enviando» pendurado. Antes do pedido = não saiu; depois = pode ter saído (sem confirmação, nunca reenviado sozinho)
    await finish(calling ? { status: "desconhecido", error: "erro_interno" } : { status: "falhou", error: "erro_interno_antes_de_enviar" }).catch(() => { /* a reserva presa será encerrada por settleStaleSends */ });
    throw new Invalid(calling ? "Erro inesperado durante o envio: a mensagem PODE ter sido enviada. Confira o aparelho; ela não será reenviada sozinha" : "Erro inesperado antes do envio. Nada foi enviado");
  }
}

/** Reservas que ficaram em "enviando" (processo caiu entre reservar e fechar) viram "sem confirmação" depois de 10 minutos: contam no limite, NUNCA são reenviadas. Só a diretoria. */
export async function settleStaleSends(db: DB, actorId: string, companyId: string) {
  await requirePerm(db, actorId, companyId, "whatsapp.authorize");
  return db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    const r = await x.execute(sql`update whatsapp_send_log set status = 'desconhecido', error = 'reserva_abandonada', finished_at = now(), updated_at = now() where company_id = ${companyId} and status = 'enviando' and created_at < now() - interval '10 minutes' returning id`);
    if (r.length) await audit(x, companyId, actorId, "whatsapp.stale_sends_settled", { count: r.length });
    return r.length;
  });
}

export async function listSendLog(db: DB, actorId: string, companyId: string, limit = 10) {
  await requirePerm(db, actorId, companyId, "whatsapp.read");
  return db.select({ id: whatsappSendLog.id, at: whatsappSendLog.createdAt, phone: whatsappSendLog.phoneMasked, status: whatsappSendLog.status, error: whatsappSendLog.error, kind: whatsappSendLog.kind })
    .from(whatsappSendLog).where(eq(whatsappSendLog.companyId, companyId)).orderBy(desc(whatsappSendLog.createdAt)).limit(limit);
}
