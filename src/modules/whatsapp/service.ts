import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { auditLog, customers, holidays, whatsappConsents, whatsappSendAuthorizations, whatsappSendLog, whatsappSessionCompanies, whatsappSessions } from "@/lib/db/schema";
import { Invalid, requirePerm } from "@/modules/identity/service";
import { getSettings } from "@/modules/messaging/service";
import { WINDOW_REASON, windowState } from "@/modules/messaging/window";
import { createWahaClient, sessionNameFor, wahaConfigured, WahaError, type WahaClient, type WahaEnv, type WahaSession } from "@/modules/providers/waha";
import { BLOCK_REASON_LABEL, CAPS, EVIDENCE_SOURCES, GLOBAL_OPT_IN_SOURCES, chatIdFor, looksLikePii, mapWahaStatus, maskMe, maskPhone, parseBrPhone, msgRef, phoneKey, phoneKeySql, sameBrNumber, testText, type Check, type ConsentState, type EvidenceSource, type SessionStatus } from "./domain";

/**
 * W1 — conexões de WhatsApp (WAHA, NÃO oficial) e envio MANUAL de teste. Nada aqui é automático: sem régua, sem fila, sem webhook (entregas 2 a 4).
 * Travas do envio de teste, todas obrigatórias: chave do servidor WHATSAPP_SEND_ENABLED, módulo ligado, WAHA configurada, conexão vinculada à empresa, não pausada e CONECTADA,
 * empresa não pausada, autorização ativa com o número exato, janela de envio, limites diários (autorização, empresa, conexão) e confirmação humana.
 * Rede nunca dentro de transação do banco. Resultado ambíguo vira "desconhecido" e nunca é reenviado sozinho.
 */
export const moduleOn = (env: WahaEnv = process.env) => env.WHATSAPP_MODULE_ENABLED === "true";
export const sendOn = (env: WahaEnv = process.env) => env.WHATSAPP_SEND_ENABLED === "true";
export type Deps = { waha?: WahaClient; env?: WahaEnv; now?: Date };
export const envOf = (d?: Deps) => d?.env ?? process.env;
export const clientOf = (d?: Deps) => d?.waha ?? createWahaClient(envOf(d));
export const manausDay = (d = new Date()) => d.toLocaleDateString("sv-SE", { timeZone: "America/Manaus" });
const MAX_SESSIONS = 3;
export const clean = (s: unknown, max: number) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

export const audit = (x: DB, companyId: string, actorId: string | null, action: string, detail: Record<string, unknown> = {}) => x.insert(auditLog).values({ companyId, actorId, action, detail });

/** A conexão só existe para quem tem vínculo ATIVO com a empresa: outra empresa recebe o mesmo "não encontrada" (sem vazar que existe). */
export async function bound(x: DB, companyId: string, sessionId: string) {
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
export async function syncFromWaha(db: DB, sessionId: string, name: string, op: (w: WahaClient) => Promise<{ status: string; meId: string | null; engine: string | null } | null>, deps?: Deps): Promise<{ status: SessionStatus; wahaDown: boolean }> {
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
export async function usedToday(x: DB, companyId: string, sessionId: string, today = manausDay(), exceptOutboxId?: string) {
  const r = (await x.execute(sql`select
      (select count(*) from whatsapp_send_log where status in ('enviando', 'enviado', 'desconhecido') and (created_at at time zone 'America/Manaus')::date = ${today}::date and company_id = ${companyId})
      + (select count(*) from whatsapp_outbox where status in ('enviando', 'enviado', 'desconhecido') and (coalesce(sent_at, finished_at, updated_at) at time zone 'America/Manaus')::date = ${today}::date and company_id = ${companyId} and (${exceptOutboxId ?? null}::uuid is null or id <> ${exceptOutboxId ?? null}::uuid)) company,
      (select count(*) from whatsapp_send_log where status in ('enviando', 'enviado', 'desconhecido') and (created_at at time zone 'America/Manaus')::date = ${today}::date and session_id = ${sessionId})
      + (select count(*) from whatsapp_outbox where status in ('enviando', 'enviado', 'desconhecido') and (coalesce(sent_at, finished_at, updated_at) at time zone 'America/Manaus')::date = ${today}::date and session_id = ${sessionId} and (${exceptOutboxId ?? null}::uuid is null or id <> ${exceptOutboxId ?? null}::uuid)) session`)) as unknown as { company: number; session: number }[];
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
  const cs = digits ? await consentState(db, companyId, digits) : null;
  const optedOut = cs?.state === "opt_out_company" || cs?.state === "opt_out_global";
  add("optout", !optedOut, "Contato não pediu para parar", optedOut ? (cs!.state === "opt_out_global" ? "Este número pediu para não receber mensagens de nenhuma empresa. O pedido prevalece sobre a autorização" : "Este número pediu para não receber mensagens desta empresa. O pedido prevalece sobre a autorização") : undefined);
  add("consent_info", true, "Consentimento do contato", cs?.state === "opt_in" ? "Consentiu (registrado)" : "Sem registro: o TESTE vale pela autorização acima. Envio a cliente exige consentimento registrado");
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

/** Resultado da entrega pela WAHA. `abort`/`fail` = NADA saiu; `result` = a WAHA respondeu (falhou) ou ficou ambígua (desconhecido: pode ter saído, nunca reenviar sozinho). */
export type DeliverOutcome =
  | { kind: "sent"; providerRef: string }
  | { kind: "abort"; code: string }
  | { kind: "fail"; code: string; message: string }
  | { kind: "result"; status: "falhou" | "desconhecido"; error: string };

/**
 * NÚCLEO ÚNICO de entrega (teste e cobrança passam pelas mesmas travas): reconferência local → estado da conexão LIDO NA WAHA (exige WORKING) → consulta do número (não envia) →
 * o destino é o id canônico da WAHA, mas só se for o MESMO número pedido (igual ou equivalência oficial do 9º dígito) → nova reconferência → `sendText`. Exceção inesperada nunca vira «enviado».
 */
export async function deliverViaWaha(db: DB, o: { session: { id: string; providerSession: string }; digits: string; text: string; recheckBefore: () => Promise<string | null>; recheckAfterCheck: () => Promise<string | null>; deps?: Deps }): Promise<DeliverOutcome> {
  let calling = false; // true a partir do instante em que o pedido de envio pode ter saído
  try {
    const c1 = await o.recheckBefore();
    if (c1) return { kind: "abort", code: c1 };
    const w = clientOf(o.deps);
    let live: WahaSession | null = null;
    try { live = await w.getSession(o.session.providerSession); } catch { return { kind: "abort", code: "conexao_sem_resposta" }; }
    if (live?.status !== "WORKING") { await syncFromWaha(db, o.session.id, o.session.providerSession, async () => live, o.deps); return { kind: "abort", code: "conexao_nao_conectada" }; }
    // o motor precisa resolver o número antes de enviar (sem isso: "no LID found"); a consulta NÃO envia nada
    let chk: { exists: boolean; chatId: string | null };
    try { chk = await w.checkNumber(o.session.providerSession, o.digits); } catch { return { kind: "abort", code: "conexao_sem_resposta" }; } // a consulta não envia: falhar aqui = nada saiu
    if (!chk.exists) return { kind: "fail", code: "numero_fora_do_whatsapp", message: "Este número não foi encontrado no WhatsApp. Confira o número. Nada foi enviado" };
    if (!chk.chatId) return { kind: "fail", code: "numero_sem_id_canonico", message: "O WhatsApp não devolveu o identificador deste número. Nada foi enviado" };
    // só conversa INDIVIDUAL (c.us) e o mesmo número
    if (!/^55\d{10,11}@c\.us$/.test(chk.chatId) || !sameBrNumber(o.digits, chk.chatId.slice(0, chk.chatId.indexOf("@")))) return { kind: "fail", code: "numero_divergente", message: "O WhatsApp devolveu outro número para este contato. Nada foi enviado" };
    const c2 = await o.recheckAfterCheck();
    if (c2) return { kind: "abort", code: c2 };
    calling = true;
    const res = await w.sendText({ session: o.session.providerSession, chatId: chk.chatId, text: o.text });
    return res.ok ? { kind: "sent", providerRef: msgRef(res.providerRef) } : { kind: "result", status: res.unknown ? "desconhecido" : "falhou", error: res.error };
  } catch {
    return calling ? { kind: "result", status: "desconhecido", error: "erro_interno" } : { kind: "fail", code: "erro_interno_antes_de_enviar", message: "Erro inesperado antes do envio. Nada foi enviado" };
  }
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
  const outcome = await deliverViaWaha(db, {
    session, digits, text: testText(ev.senderIdentity), deps,
    // última conferência antes de sair: chave, pausa, autorização e CONEXÃO podem ter mudado entre reservar e enviar
    recheckBefore: async () => {
      const [still] = await db.select({ p: whatsappSessions.paused, st: whatsappSessions.status }).from(whatsappSessions).where(eq(whatsappSessions.id, session.id));
      const [authNow] = await db.select({ id: whatsappSendAuthorizations.id }).from(whatsappSendAuthorizations).where(and(eq(whatsappSendAuthorizations.companyId, companyId), eq(whatsappSendAuthorizations.active, true)));
      const [bnd] = await db.select({ id: whatsappSessionCompanies.id }).from(whatsappSessionCompanies).where(and(eq(whatsappSessionCompanies.sessionId, session.id), eq(whatsappSessionCompanies.companyId, companyId), isNull(whatsappSessionCompanies.revokedAt)));
      return !sendOn(env) || still?.p !== false || still?.st !== "CONNECTED" || authNow?.id !== authId || !bnd ? "bloqueado_antes_de_enviar" : null;
    },
    // revalida pausa, autorização e opt-out no último instante (a consulta do número levou tempo de rede)
    recheckAfterCheck: async () => {
      const [p2] = await db.select({ p: whatsappSessions.paused }).from(whatsappSessions).where(eq(whatsappSessions.id, session.id));
      const [a2] = await db.select({ id: whatsappSendAuthorizations.id }).from(whatsappSendAuthorizations).where(and(eq(whatsappSendAuthorizations.companyId, companyId), eq(whatsappSendAuthorizations.active, true)));
      const cs2 = await consentState(db, companyId, digits);
      return !sendOn(env) || p2?.p !== false || a2?.id !== authId || cs2.state === "opt_out_company" || cs2.state === "opt_out_global" ? "bloqueado_antes_de_enviar" : null; // opt-out de última hora também barra
    },
  });
  if (outcome.kind === "sent") { await finish({ status: "enviado", providerRef: outcome.providerRef }); return { logId }; }
  if (outcome.kind === "abort") { await finish({ status: "falhou", error: outcome.code }); throw new Invalid("O envio foi bloqueado no último momento (chave, pausa, autorização ou conexão mudou). Nada foi enviado"); }
  if (outcome.kind === "fail") { await finish({ status: "falhou", error: outcome.code }); throw new Invalid(outcome.message); }
  await finish({ status: outcome.status, error: outcome.error });
  throw new Invalid(outcome.error === "erro_interno" ? "Erro inesperado durante o envio: a mensagem PODE ter sido enviada. Confira o aparelho; ela não será reenviada sozinha"
    : outcome.status === "desconhecido" ? "A WAHA não confirmou o envio (a mensagem PODE ter chegado). Confira o aparelho; ela não será reenviada sozinha" : `A WAHA recusou o envio (${outcome.error}). Nada foi enviado`);
}

/** Reservas que ficaram em "enviando" (processo caiu entre reservar e fechar) viram "sem confirmação" depois de 10 minutos: contam no limite, NUNCA são reenviadas. Só a diretoria. */
export async function settleStaleSends(db: DB, actorId: string, companyId: string) {
  await requirePerm(db, actorId, companyId, "whatsapp.authorize");
  return db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    const r = await x.execute(sql`update whatsapp_send_log set status = 'desconhecido', error = 'reserva_abandonada', finished_at = now(), updated_at = now() where company_id = ${companyId} and status = 'enviando' and created_at < now() - interval '10 minutes' returning id`);
    const o = await x.execute(sql`update whatsapp_outbox set status = 'desconhecido', reason = 'reserva_abandonada', finished_at = now(), updated_at = now() where company_id = ${companyId} and status = 'enviando' and updated_at < now() - interval '10 minutes' returning id`);
    const n = r.length + o.length;
    if (n) await audit(x, companyId, actorId, "whatsapp.stale_sends_settled", { count: r.length, outbox: o.length });
    return n;
  });
}

export async function listSendLog(db: DB, actorId: string, companyId: string, limit = 10) {
  await requirePerm(db, actorId, companyId, "whatsapp.read");
  return db.select({ id: whatsappSendLog.id, at: whatsappSendLog.createdAt, phone: whatsappSendLog.phoneMasked, status: whatsappSendLog.status, error: whatsappSendLog.error, kind: whatsappSendLog.kind })
    .from(whatsappSendLog).where(eq(whatsappSendLog.companyId, companyId)).orderBy(desc(whatsappSendLog.createdAt)).limit(limit);
}

// ---------- W2: vínculo de empresas à conexão ----------
const MAX_COMPANIES_PER_SESSION = 5;

/** Empresas com vínculo ativo. Nome de empresa só aparece para quem também é membro dela (outras viram «outra empresa do grupo»): nada vaza entre empresas. */
export async function listBindings(db: DB, actorId: string, companyId: string, sessionId: string) {
  await requirePerm(db, actorId, companyId, "whatsapp.read");
  await bound(db, companyId, sessionId);
  const rows = (await db.execute(sql`
    select b.company_id::text id, b.sender_identity identity, b.created_at at, c.name, (m.user_id is not null) member
    from whatsapp_session_companies b join companies c on c.id = b.company_id
    left join memberships m on m.company_id = b.company_id and m.user_id = ${actorId} and m.status = 'active'
    where b.session_id = ${sessionId} and b.revoked_at is null order by b.created_at`)) as unknown as { id: string; identity: string; at: Date; name: string; member: boolean }[];
  return rows.map((r) => ({ companyId: r.member ? r.id : null, name: r.member ? r.name : "Outra empresa do grupo", identity: r.member ? r.identity : null, since: new Date(r.at), current: r.id === companyId })); // nome E remetente de empresa alheia ficam ocultos
}

/**
 * Vincula OUTRA empresa à conexão (sem novo QR). Exige diretoria (`whatsapp.authorize`) nas DUAS empresas: a da conexão e a que entra. A empresa nova nasce sem autorização de envio
 * e sem consentimentos: cada uma cuida dos seus. O nome do remetente é próprio de cada empresa (transparência: quem cobra é identificado no texto).
 */
export async function bindCompany(db: DB, actorId: string, companyId: string, sessionId: string, input: { targetCompanyId: string; senderIdentity: string; confirm: boolean }) {
  await requirePerm(db, actorId, companyId, "whatsapp.authorize");
  if (!/^[0-9a-f-]{36}$/i.test(input.targetCompanyId ?? "")) throw new Invalid("Empresa não encontrada");
  await requirePerm(db, actorId, input.targetCompanyId, "whatsapp.authorize"); // diretoria também na empresa que entra (senão: 403, sem revelar se existe)
  if (input.targetCompanyId === companyId) throw new Invalid("Esta empresa já usa a conexão");
  const identity = clean(input.senderIdentity, 80);
  if (identity.length < 3) throw new Invalid("Informe o nome que aparece para o cliente (ex.: Financeiro K3G Call)");
  if (!input.confirm) throw new Invalid("Confirme que as duas empresas autorizam o uso compartilhado deste número");
  const { s } = await bound(db, companyId, sessionId);
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await x.execute(sql`select pg_advisory_xact_lock(hashtext(${"whatsapp-bind:" + s.id}))`);
    const [{ n, has }] = (await x.execute(sql`select count(*)::int n, bool_or(company_id = ${input.targetCompanyId}::uuid) has from whatsapp_session_companies where session_id = ${s.id} and revoked_at is null`)) as unknown as { n: number; has: boolean | null }[];
    if (has) throw new Invalid("Esta empresa já usa a conexão");
    if (n >= MAX_COMPANIES_PER_SESSION) throw new Invalid(`A conexão já é usada por ${MAX_COMPANIES_PER_SESSION} empresas`);
    await x.insert(whatsappSessionCompanies).values({ sessionId: s.id, companyId: input.targetCompanyId, senderIdentity: identity, authorizedBy: actorId });
    await audit(x, companyId, actorId, "whatsapp.session.company_bound", { sessionId: s.id, targetCompanyId: input.targetCompanyId });
    await audit(x, input.targetCompanyId, actorId, "whatsapp.session.company_bound", { sessionId: s.id, fromCompanyId: companyId });
  });
}

/** A empresa SAI da conexão (revoga o próprio vínculo; histórico fica). Não dá para tirar a última empresa: para isso, desconectar. Diretoria da própria empresa. */
export async function unbindCompany(db: DB, actorId: string, companyId: string, sessionId: string, confirm: boolean) {
  await requirePerm(db, actorId, companyId, "whatsapp.authorize");
  if (!confirm) throw new Invalid("Confirme que esta empresa deve deixar de usar a conexão");
  const { s } = await bound(db, companyId, sessionId);
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await x.execute(sql`select pg_advisory_xact_lock(hashtext(${"whatsapp-bind:" + s.id}))`);
    const [{ n }] = (await x.execute(sql`select count(*)::int n from whatsapp_session_companies where session_id = ${s.id} and revoked_at is null`)) as unknown as { n: number }[];
    if (n <= 1) throw new Invalid("Esta é a última empresa da conexão. Para encerrar, use «Desconectar número»");
    await x.update(whatsappSessionCompanies).set({ revokedAt: new Date(), revokedBy: actorId, updatedAt: new Date() }).where(and(eq(whatsappSessionCompanies.sessionId, s.id), eq(whatsappSessionCompanies.companyId, companyId), isNull(whatsappSessionCompanies.revokedAt)));
    await audit(x, companyId, actorId, "whatsapp.session.company_unbound", { sessionId: s.id });
  });
}

// ---------- W2: consentimento e opt-out por contato ----------
/** Estado do contato para a empresa. Opt-out GLOBAL do número (de qualquer empresa) prevalece; senão vale o evento mais recente da empresa. Só estado: não revela quem pediu. */
export async function consentState(x: DB, companyId: string, digits: string): Promise<{ state: ConsentState }> {
  const r = (await x.execute(sql`select
      (select decision from whatsapp_consents where ${phoneKeySql("phone")} = ${phoneKey(digits)} and scope = 'global' order by created_at desc, id desc limit 1) g,
      (select decision from whatsapp_consents where company_id = ${companyId} and ${phoneKeySql("phone")} = ${phoneKey(digits)} and scope = 'company' order by created_at desc, id desc limit 1) c`)) as unknown as { g: string | null; c: string | null }[];
  if (r[0].g === "opt_out") return { state: "opt_out_global" };
  if (r[0].c === "opt_out") return { state: "opt_out_company" };
  if (r[0].c === "opt_in") return { state: "opt_in" };
  return { state: "none" };
}

export async function recordConsent(db: DB, actorId: string, companyId: string, input: { phone: string; decision: string; scope: string; evidenceSource: string; evidenceRef: string; customerId?: string }) {
  await requirePerm(db, actorId, companyId, "whatsapp.consent");
  const digits = parseBrPhone(input.phone);
  if (!digits) throw new Invalid("Número inválido. Use DDD + número (ex.: 92 99999-0000)");
  if (input.decision !== "opt_in" && input.decision !== "opt_out") throw new Invalid("Escolha se o contato consentiu ou pediu para parar");
  const scope = input.scope === "global" ? "global" : "company";
  if (scope === "global") await requirePerm(db, actorId, companyId, "whatsapp.authorize"); // pedido de parar em TODAS as empresas: só a diretoria registra (e só outro global desfaz)
  if (!(EVIDENCE_SOURCES as readonly string[]).includes(input.evidenceSource)) throw new Invalid("Escolha de onde vem a prova do consentimento");
  const ref = clean(input.evidenceRef, 200);
  if (ref.length < 3) throw new Invalid("Informe onde está a prova (ex.: e-mail de 28/10, contrato, anotação do atendimento)");
  if (looksLikePii(ref)) throw new Invalid("O campo da prova parece ter dado pessoal (e-mail, telefone, CPF/CNPJ). Escreva só uma referência de onde achar a prova");
  if (scope === "global" && input.decision === "opt_in" && !GLOBAL_OPT_IN_SOURCES.includes(input.evidenceSource as EvidenceSource)) throw new Invalid("Para desfazer um pedido de parar de todas as empresas é preciso prova por escrito, formulário ou iniciada pelo próprio cliente (não vale a verbal)");
  let customerId: string | null = null;
  if (input.customerId) {
    if (!/^[0-9a-f-]{36}$/i.test(input.customerId)) throw new Invalid("Cliente não encontrado");
    const [c] = await db.select({ id: customers.id }).from(customers).where(and(eq(customers.id, input.customerId), eq(customers.companyId, companyId)));
    if (!c) throw new Invalid("Cliente não encontrado"); // cliente de outra empresa = mesma resposta
    customerId = c.id;
  }
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await x.execute(sql`select pg_advisory_xact_lock(hashtext(${"whatsapp-consent:" + (scope === "global" ? "all" : companyId) + ":" + phoneKey(digits)}))`);
    const [last] = (await x.execute(sql`select decision from whatsapp_consents where ${phoneKeySql("phone")} = ${phoneKey(digits)} and scope = ${scope} ${scope === "company" ? sql`and company_id = ${companyId}` : sql``} order by created_at desc, id desc limit 1`)) as unknown as { decision: string }[];
    if (last?.decision === input.decision) throw new Invalid(`Este contato já está registrado assim (${input.decision === "opt_in" ? "consentiu" : "pediu para parar"}). Nada foi alterado`);
    await x.insert(whatsappConsents).values({ companyId, customerId, phone: digits, decision: input.decision, scope, evidenceSource: input.evidenceSource, evidenceRef: ref, actorId });
    await audit(x, companyId, actorId, input.decision === "opt_in" ? "whatsapp.consent.opt_in" : "whatsapp.consent.opt_out", { scope, source: input.evidenceSource }); // sem telefone
  });
}

/** Estado atual de cada contato desta empresa (mascarado). Só diretoria/gerência: é dado de cliente. Opt-out global aparece como estado, sem dizer qual empresa pediu. */
export async function listConsents(db: DB, actorId: string, companyId: string, limit = 200) {
  await requirePerm(db, actorId, companyId, "whatsapp.consent");
  const rows = (await db.execute(sql`
    select distinct on (${phoneKeySql("c.phone")}) c.phone, c.decision, c.scope, c.evidence_source src, c.created_at at, cu.display_name customer, u.name actor,
      (select g.decision from whatsapp_consents g where ${phoneKeySql("g.phone")} = ${phoneKeySql("c.phone")} and g.scope = 'global' order by g.created_at desc, g.id desc limit 1) global_d
    from whatsapp_consents c left join customers cu on cu.company_id = c.company_id and cu.id = c.customer_id left join users u on u.id = c.actor_id
    where c.company_id = ${companyId} and c.scope = 'company' order by ${phoneKeySql("c.phone")}, c.created_at desc, c.id desc`)) as unknown as { phone: string; decision: string; src: EvidenceSource; at: Date; customer: string | null; actor: string | null; global_d: string | null }[];
  return rows.map((r) => ({ ...r, at: new Date(r.at) })).sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit).map((r) => ({
    phone: maskPhone(r.phone), state: (r.global_d === "opt_out" ? "opt_out_global" : r.decision === "opt_out" ? "opt_out_company" : "opt_in") as ConsentState,
    source: r.src, at: r.at, customer: r.customer, actor: r.actor,
  }));
}

/** Últimos envios BLOQUEADOS e o motivo (a auditoria já guarda só as chaves dos motivos, nunca número). */
export async function recentBlocks(db: DB, actorId: string, companyId: string, limit = 10) {
  await requirePerm(db, actorId, companyId, "whatsapp.read");
  const rows = await db.select({ at: auditLog.createdAt, detail: auditLog.detail }).from(auditLog).where(and(eq(auditLog.companyId, companyId), eq(auditLog.action, "whatsapp.test_blocked"))).orderBy(desc(auditLog.createdAt)).limit(limit);
  return rows.map((r) => ({ at: r.at, reasons: (((r.detail as { reasons?: unknown })?.reasons as string[] | undefined) ?? []).map((k) => BLOCK_REASON_LABEL[k] ?? k) }));
}
