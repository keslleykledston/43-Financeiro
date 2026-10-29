import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { auditLog, customerContacts, users, whatsappConsents, whatsappInboundEvents, whatsappSessions } from "@/lib/db/schema";
import { open as openBox, seal } from "@/lib/security/secretbox";
import { SESSION_NAME, type WahaEnv } from "@/modules/providers/waha";
import { Invalid, requirePerm } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { asksAll, classifyInbound, type InboundClass } from "./optout";
import { maskPhone, parseBrPhone, refHash, sameBrNumber } from "./domain";
import { audit, clientOf, recordConsent, syncFromWaha, type Deps } from "./service";

/**
 * W3b — recebimento dos eventos da WAHA (webhook assinado) e tratamento de RESPOSTAS de clientes. Princípios:
 *  - assinatura HMAC-SHA512 sobre o corpo BRUTO (conferida em teste real da WAHA 2026.8.2), comparação em tempo constante, janela de tempo e tamanho máximo; sem chave no servidor = nada é aceito;
 *  - o mesmo evento duas vezes vira um registro só (`event_key` único); guarda só o que usa (texto da resposta CIFRADO), nunca o corpo bruto;
 *  - NENHUMA resposta automática ao cliente (sem robô, sem IA); o pedido de parar é registrado na hora e a fila é suprimida;
 *  - roteamento DETERMINÍSTICO: só vai para uma empresa se houver conversa recente dela com o número (ou contato único); senão TRIAGEM, que nenhuma empresa enxerga;
 *  - evento de estado da conexão e confirmação de entrega só DISPARAM leitura/atualização autenticadas; «conectada» nunca vem do aviso.
 */
export const WEBHOOK_MAX_BYTES = 262_144;
export const WEBHOOK_SKEW_MS = 15 * 60_000;
const ALLOWED_EVENTS = new Set(["message", "message.ack", "session.status"]);
const BODY_MAX = 2000;
const FLOOD_PER_HOUR = 30;
const MAX_ATTEMPTS = 5;
const SYSTEM_EMAIL = "sistema-whatsapp@k3g.invalid";
const BOX = "whatsapp-inbound";

// Tentativas com assinatura INVÁLIDA: contador em MEMÓRIA (nenhuma escrita no banco por requisição de quem não tem a chave). Passou de 60 por minuto: 429 sem mais custo.
let badWindow = { count: 0, resetAt: 0 };
const tooManyBad = (now: number) => { if (now > badWindow.resetAt) badWindow = { count: 0, resetAt: now + 60_000 }; return ++badWindow.count > 60; };
export const __resetHookLimiter = () => { badWindow = { count: 0, resetAt: 0 }; };

/** Lê o corpo em FLUXO e para ao passar do limite (quem não tem a chave não consegue fazer o servidor guardar corpo enorme). null = grande demais. */
export async function readBodyCapped(req: Request, max = WEBHOOK_MAX_BYTES): Promise<Buffer | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  const reader = req.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => undefined); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export type HookHeaders = { hmac: string | null; algorithm: string | null; timestamp: string | null; contentLength: string | null };
export type HookResult = { status: 202 | 400 | 401 | 413 | 429 | 503; code: string };

/** Confere a assinatura (sha512 hex do corpo bruto) em tempo constante. */
export function verifyHmac(raw: Buffer, header: string | null, algorithm: string | null, key: string): boolean {
  if (!header || !/^[0-9a-f]{128}$/i.test(header) || (algorithm ?? "").toLowerCase() !== "sha512") return false;
  const mac = createHmac("sha512", key).update(raw).digest();
  const got = Buffer.from(header, "hex");
  return got.length === mac.length && timingSafeEqual(got, mac);
}

export async function ensureWhatsappSystemUser(db: DB): Promise<string> {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, SYSTEM_EMAIL));
  if (u) return u.id;
  const [n] = await db.insert(users).values({ email: SYSTEM_EMAIL, name: "WhatsApp (automático)", passwordHash: "!sem-login", disabledAt: new Date() }).onConflictDoNothing().returning({ id: users.id });
  if (n) return n.id;
  return (await db.select({ id: users.id }).from(users).where(eq(users.email, SYSTEM_EMAIL)))[0].id;
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const ackOf = (p: { ack?: unknown; ackName?: unknown }): "entregue" | "lido" | null => {
  const n = typeof p.ackName === "string" ? p.ackName.toUpperCase() : ({ 2: "DEVICE", 3: "READ", 4: "PLAYED" } as Record<number, string>)[Number(p.ack)] ?? "";
  return n === "DEVICE" ? "entregue" : n === "READ" || n === "PLAYED" ? "lido" : null;
};

/**
 * Recebe UM aviso da WAHA. Retorna o status HTTP a devolver. Falha da assinatura/janela/tamanho = nada é gravado. Evento fora do que usamos, de conversa em grupo, eco da própria conta
 * ou de conexão desconhecida = aceito (202) e descartado sem guardar.
 */
export async function receiveWahaWebhook(db: DB, raw: Buffer, h: HookHeaders, env: WahaEnv = process.env, now = new Date(), deps?: Deps): Promise<HookResult> {
  const key = env.WHATSAPP_HOOK_HMAC_KEY;
  if (!key) return { status: 503, code: "sem_chave" };                                    // falha fechada: sem chave, nada entra
  if ((h.contentLength && Number(h.contentLength) > WEBHOOK_MAX_BYTES) || raw.length > WEBHOOK_MAX_BYTES) return { status: 413, code: "grande_demais" };
  const ts = Number(h.timestamp);
  const good = verifyHmac(raw, h.hmac, h.algorithm, key) && Number.isFinite(ts) && Math.abs(now.getTime() - ts) <= WEBHOOK_SKEW_MS;
  if (!good) {
    if (tooManyBad(now.getTime())) return { status: 429, code: "limite" }; // tentativas inválidas em excesso: 429 (contador em memória: sem escrita no banco)
    return { status: 401, code: "assinatura_invalida" };
  }
  let ev: { id?: unknown; event?: unknown; session?: unknown; timestamp?: unknown; payload?: Record<string, unknown> };
  try { ev = JSON.parse(raw.toString("utf8")); } catch { return { status: 400, code: "json_invalido" }; }
  const id = str(ev?.id, 120), event = str(ev?.event, 40), session = str(ev?.session, 60), p = (ev?.payload ?? {}) as Record<string, unknown>;
  if (!id || !ALLOWED_EVENTS.has(event) || !SESSION_NAME.test(session)) return { status: 202, code: "ignorado" };
  const [sess] = await db.select({ id: whatsappSessions.id }).from(whatsappSessions).where(eq(whatsappSessions.providerSession, session));
  if (!sess) return { status: 202, code: "conexao_desconhecida" };
  const eventAt = Number.isFinite(Number(ev.timestamp)) ? new Date(Number(ev.timestamp)) : now;
  let row: typeof whatsappInboundEvents.$inferInsert = { eventKey: id, eventType: event, providerSession: session, sessionId: sess.id, eventAt };
  if (event === "message") {
    const from = str(p.from, 80), fromMe = p.fromMe === true;
    if (fromMe || !from || /@(g\.us|newsletter|broadcast)$/.test(from) || from.startsWith("status@")) return { status: 202, code: "ignorado" }; // eco, grupo, canal, status
    const body = str(p.body, BODY_MAX).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ");
    const media = p.hasMedia === true || (typeof p.type === "string" && p.type !== "chat" && p.type !== "text");
    row = { ...row, peer: from, kind: media && !body ? "midia" : "texto", bodyEnc: body ? seal(body, BOX) : null };
  } else if (event === "message.ack") {
    const msgId = str(p.id, 160);
    row = { ...row, refHash: msgId ? refHash(msgId) : null, ack: ackOf(p as { ack?: unknown; ackName?: unknown }), kind: "outro" };
  } else row = { ...row, kind: "outro" };
  const ins = await db.insert(whatsappInboundEvents).values(row).onConflictDoNothing().returning({ id: whatsappInboundEvents.id });
  if (ins.length) await processInboundEvent(db, ins[0].id, deps).catch(() => { /* fica pendente: o agendador tenta de novo */ });
  return { status: 202, code: ins.length ? "recebido" : "duplicado" };
}

// ---------- tratamento ----------
type Evt = typeof whatsappInboundEvents.$inferSelect;
async function resolvePhone(peer: string | null, session: string, deps?: Deps): Promise<string | null> {
  if (!peer) return null;
  const m = /^(\d{10,15})(?::\d+)?@(c\.us|s\.whatsapp\.net)$/.exec(peer);
  if (m) return parseBrPhone(m[1]);
  if (/@lid$/.test(peer)) { try { return await clientOf(deps).resolveLid(session, peer); } catch { throw new Error("lid_indisponivel"); } } // erro de rede: tenta de novo depois (não vira «sem número»)
  return null;
}

/** Empresa dona da conversa — só se for DETERMINÍSTICO: (1) uma única empresa da conexão falou com o número nos últimos 14 dias; (2) senão, um único contato financeiro/cadastro com este telefone entre as empresas da conexão. */
async function attribute(x: DB, sessionId: string, phone: string): Promise<{ companyId: string | null; customerId: string | null; boundCompanies: string[]; why: "conversa" | "contato" | "ambiguo" | "nenhum" }> {
  const bound = ((await x.execute(sql`select company_id::text id from whatsapp_session_companies where session_id = ${sessionId} and revoked_at is null order by created_at`)) as unknown as { id: string }[]).map((r) => r.id);
  if (!bound.length) return { companyId: null, customerId: null, boundCompanies: [], why: "nenhum" };
  const talked = (await x.execute(sql`select company_id::text company, customer_id::text customer, max(coalesce(sent_at, finished_at, updated_at)) at from whatsapp_outbox where phone = ${phone} and session_id = ${sessionId} and status in ('enviado', 'desconhecido', 'enviando') and coalesce(sent_at, finished_at, updated_at) > now() - interval '14 days' group by 1, 2`)) as unknown as { company: string; customer: string }[];
  const companies = [...new Set(talked.map((t) => t.company))].filter((c) => bound.includes(c));
  if (companies.length === 1) { const cs = [...new Set(talked.filter((t) => t.company === companies[0]).map((t) => t.customer))]; return { companyId: companies[0], customerId: cs.length === 1 ? cs[0] : null, boundCompanies: bound, why: "conversa" }; }
  if (companies.length > 1) return { companyId: null, customerId: null, boundCompanies: bound, why: "ambiguo" };
  const contacts = await x.select({ company: customerContacts.companyId, customer: customerContacts.partyId, phone: customerContacts.phone }).from(customerContacts).where(and(inArray(customerContacts.companyId, bound), sql`${customerContacts.phone} is not null`));
  const hits = contacts.filter((c) => { const d = parseBrPhone(c.phone ?? ""); return !!d && sameBrNumber(d, phone); });
  const cos = [...new Set(hits.map((c) => c.company))];
  if (cos.length === 1) { const cu = [...new Set(hits.filter((c) => c.company === cos[0]).map((c) => c.customer))]; return { companyId: cos[0], customerId: cu.length === 1 ? cu[0] : null, boundCompanies: bound, why: "contato" }; }
  return { companyId: null, customerId: null, boundCompanies: bound, why: cos.length > 1 ? "ambiguo" : "nenhum" };
}

/** Registra o pedido de parar como um evento de consentimento DO SISTEMA e suprime a fila. Repetir (já parado) não duplica. */
async function applyOptOut(x: DB, systemUser: string, o: { companyId: string; phone: string; scope: "company" | "global"; eventKey: string }) {
  const [last] = (await x.execute(sql`select decision from whatsapp_consents where phone = ${o.phone} and scope = ${o.scope} ${o.scope === "company" ? sql`and company_id = ${o.companyId}` : sql``} order by created_at desc, id desc limit 1`)) as unknown as { decision: string }[];
  if (last?.decision !== "opt_out") await x.insert(whatsappConsents).values({ companyId: o.companyId, phone: o.phone, decision: "opt_out", scope: o.scope, evidenceSource: "cliente_iniciou", evidenceRef: `resposta no WhatsApp (evento ${o.eventKey.slice(-8)})`, actorId: systemUser });
  // a fila de cobrança deste contato para: «na_fila» vira «suprimido» (empresa; ou todas as empresas se o pedido é global)
  await x.execute(sql`update whatsapp_outbox set status = 'suprimido', reason = 'optout', finished_at = now(), updated_at = now() where phone = ${o.phone} and status = 'na_fila' ${o.scope === "company" ? sql`and company_id = ${o.companyId}` : sql``}`);
}

/** Trata UM evento pendente (idempotente: só quem o «reivindica» processa). Chamado na hora do recebimento e, para o que ficou pendente, pelo agendador. */
export async function processInboundEvent(db: DB, eventId: string, deps?: Deps): Promise<void> {
  const claimed = await db.update(whatsappInboundEvents).set({ attempts: sql`${whatsappInboundEvents.attempts} + 1`, updatedAt: new Date() })
    .where(and(eq(whatsappInboundEvents.id, eventId), eq(whatsappInboundEvents.routing, "pendente"), sql`${whatsappInboundEvents.attempts} < ${MAX_ATTEMPTS}`, sql`(${whatsappInboundEvents.updatedAt} < now() - interval '60 seconds' or ${whatsappInboundEvents.attempts} = 0)`)).returning();
  const ev: Evt | undefined = claimed[0];
  if (!ev) return;
  const done = (set: Partial<typeof whatsappInboundEvents.$inferInsert>) => db.update(whatsappInboundEvents).set({ ...set, processedAt: new Date(), error: null, updatedAt: new Date() }).where(and(eq(whatsappInboundEvents.id, ev.id), eq(whatsappInboundEvents.routing, "pendente")));
  try {
    if (ev.eventType === "session.status") {
      // o aviso só DISPARA a leitura autenticada do estado (nunca é a fonte da verdade)
      const [s] = await db.select().from(whatsappSessions).where(eq(whatsappSessions.providerSession, ev.providerSession));
      if (s) await syncFromWaha(db, s.id, s.providerSession, (w) => w.getSession(s.providerSession), deps);
      await done({ classification: "sessao", routing: "ignorada" }); return;
    }
    if (ev.eventType === "message.ack") {
      // confirmação de entrega/leitura: só vale casando com uma mensagem NOSSA enviada (hash do id)
      if (ev.refHash && ev.ack) await db.execute(sql`update whatsapp_outbox set delivery = ${ev.ack}, ${ev.ack === "lido" ? sql`read_at = coalesce(read_at, now()), delivered_at = coalesce(delivered_at, now())` : sql`delivered_at = coalesce(delivered_at, now())`}, updated_at = now() where provider_ref = ${ev.refHash} and status = 'enviado' and (delivery is null or (delivery = 'entregue' and ${ev.ack} = 'lido'))`);
      await done({ classification: "ack", routing: "ignorada" }); return;
    }
    // ----- mensagem recebida
    const phone = await resolvePhone(ev.peer, ev.providerSession, deps);
    if (!phone) { await done({ classification: "sem_numero", routing: "triagem", needsReview: true }); return; }
    const flood = (await db.execute(sql`select count(*)::int n from whatsapp_inbound_events where phone = ${phone} and created_at > now() - interval '1 hour'`)) as unknown as { n: number }[];
    if (Number(flood[0].n) > FLOOD_PER_HOUR) { await done({ phone, phoneMasked: maskPhone(phone), classification: "ignorada", routing: "ignorada" }); return; } // enxurrada de um só número
    const text = ev.bodyEnc ? openBox(ev.bodyEnc, BOX) : "";
    const cls: InboundClass = ev.kind === "texto" ? classifyInbound(text) : "resposta";
    const where = await attribute(db, ev.sessionId!, phone);
    const base = { phone, phoneMasked: maskPhone(phone), classification: cls as string };
    if (cls === "resposta") {
      if (where.companyId) await done({ ...base, companyId: where.companyId, customerId: where.customerId, routing: "atribuida", handling: "novo" });
      else await done({ ...base, routing: "triagem", handling: "novo", needsReview: true });
      return;
    }
    // pedido de parar (inequívoco ou ambíguo): registra NA HORA. Na dúvida, bloqueia mais amplamente
    const sys = await ensureWhatsappSystemUser(db);
    const global = !where.companyId || asksAll(text);
    const companyForRecord = where.companyId ?? where.boundCompanies[0];
    if (!companyForRecord) { await done({ ...base, routing: "triagem", needsReview: true }); return; }
    await db.transaction(async (tx) => {
      const x = tx as unknown as DB;
      await x.execute(sql`select pg_advisory_xact_lock(hashtext(${"whatsapp-consent:" + (global ? "all" : companyForRecord) + ":" + phone}))`); // mesma trava do registro manual de consentimento
      // 1º fecha o EVENTO (só quem o encontra ainda pendente segue): processamento duplicado (inline + agendador) não repete consentimento nem auditoria
      const won = await x.update(whatsappInboundEvents).set({
        ...base, companyId: where.companyId, customerId: where.customerId, routing: where.companyId ? "atribuida" : "triagem", optoutApplied: global ? "global" : "company",
        needsReview: cls === "opt_out_ambiguo" || !where.companyId || (global && !asksAll(text)), handling: cls === "opt_out" && where.companyId ? "resolvido" : "novo", processedAt: new Date(), error: null, updatedAt: new Date(),
      }).where(and(eq(whatsappInboundEvents.id, ev.id), eq(whatsappInboundEvents.routing, "pendente"))).returning({ id: whatsappInboundEvents.id });
      if (!won.length) return;
      await applyOptOut(x, sys, { companyId: companyForRecord, phone, scope: global ? "global" : "company", eventKey: ev.eventKey });
      await audit(x, companyForRecord, null, "whatsapp.inbound_optout", { eventId: ev.id, scope: global ? "global" : "company", ambiguous: cls === "opt_out_ambiguo" });
    });
  } catch (e) {
    await db.update(whatsappInboundEvents).set({ error: String((e as Error).message ?? "erro").slice(0, 60), updatedAt: new Date() }).where(and(eq(whatsappInboundEvents.id, ev.id), eq(whatsappInboundEvents.routing, "pendente")));
    if (ev.attempts + 1 >= MAX_ATTEMPTS) await db.update(whatsappInboundEvents).set({ routing: "triagem", needsReview: true, classification: ev.classification ?? "ignorada", processedAt: new Date() }).where(and(eq(whatsappInboundEvents.id, ev.id), eq(whatsappInboundEvents.routing, "pendente"))); // esgotou: um humano vê
  }
}

/** Reprocessa o que ficou pendente (agendador). */
export async function processPendingInbound(db: DB, deps?: Deps, limit = 50) {
  const ids = await db.select({ id: whatsappInboundEvents.id }).from(whatsappInboundEvents).where(and(eq(whatsappInboundEvents.routing, "pendente"), sql`${whatsappInboundEvents.attempts} < ${MAX_ATTEMPTS}`)).orderBy(whatsappInboundEvents.createdAt).limit(limit);
  for (const r of ids) await processInboundEvent(db, r.id, deps);
  return ids.length;
}

// ---------- caixa de entrada (por empresa) e triagem ----------
const COMPANY_ROUTES = ["atribuida", "atribuida_manual"];
export type InboxItem = { id: string; at: Date; phone: string | null; customer: string | null; classification: string; handling: string; dispute: boolean; needsReview: boolean; optoutApplied: string | null; kind: string; body: string };
const row2item = (r: { id: string; created_at: Date; phone_masked: string | null; customer: string | null; classification: string | null; handling: string; dispute: boolean; needs_review: boolean; optout_applied: string | null; kind: string; body_enc: string | null }): InboxItem =>
  ({ id: r.id, at: new Date(r.created_at), phone: r.phone_masked, customer: r.customer, classification: r.classification ?? "resposta", handling: r.handling, dispute: r.dispute, needsReview: r.needs_review, optoutApplied: r.optout_applied, kind: r.kind, body: r.body_enc ? openBox(r.body_enc, BOX) : "" });

/** Respostas atribuídas a ESTA empresa (nunca triagem, nunca de outra empresa). Só diretoria/gerência (dado de cliente). */
export async function listInbox(db: DB, actorId: string, companyId: string, limit = 100): Promise<InboxItem[]> {
  await requirePerm(db, actorId, companyId, "whatsapp.history");
  const rows = (await db.execute(sql`select e.id::text id, e.created_at, e.phone_masked, cu.display_name customer, e.classification, e.handling, e.dispute, e.needs_review, e.optout_applied, e.kind, e.body_enc
    from whatsapp_inbound_events e left join customers cu on cu.company_id = e.company_id and cu.id = e.customer_id
    where e.company_id = ${companyId} and e.routing in ('atribuida', 'atribuida_manual') and e.event_type = 'message' order by (e.handling = 'resolvido'), e.created_at desc limit ${limit}`)) as unknown as Parameters<typeof row2item>[0][];
  return rows.map(row2item);
}

async function inboxRow(x: DB, companyId: string, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id ?? "")) throw new Invalid("Mensagem não encontrada");
  const [r] = await x.select().from(whatsappInboundEvents).where(and(eq(whatsappInboundEvents.id, id), eq(whatsappInboundEvents.companyId, companyId), inArray(whatsappInboundEvents.routing, COMPANY_ROUTES)));
  if (!r) throw new Invalid("Mensagem não encontrada");
  return r;
}

/** Atendimento: marca em atendimento / resolvida, com ou sem contestação (suspende a cobrança até resolver). */
export async function setHandling(db: DB, actorId: string, companyId: string, id: string, o: { handling: "em_atendimento" | "resolvido"; dispute?: boolean }) {
  await requirePerm(db, actorId, companyId, "whatsapp.send");
  if (o.handling !== "em_atendimento" && o.handling !== "resolvido") throw new Invalid("Situação inválida");
  const r = await inboxRow(db, companyId, id);
  await db.update(whatsappInboundEvents).set({ handling: o.handling, ...(o.dispute !== undefined ? { dispute: o.dispute } : {}), needsReview: o.handling === "resolvido" ? false : r.needsReview, updatedAt: new Date() }).where(and(eq(whatsappInboundEvents.id, r.id), eq(whatsappInboundEvents.companyId, companyId)));
  await audit(db, companyId, actorId, "whatsapp.inbox.handled", { eventId: r.id, handling: o.handling, dispute: o.dispute ?? r.dispute });
}

export async function markDispute(db: DB, actorId: string, companyId: string, id: string, dispute: boolean) {
  await requirePerm(db, actorId, companyId, "whatsapp.send");
  const r = await inboxRow(db, companyId, id);
  await db.update(whatsappInboundEvents).set({ dispute, handling: dispute ? "em_atendimento" : r.handling, updatedAt: new Date() }).where(and(eq(whatsappInboundEvents.id, r.id), eq(whatsappInboundEvents.companyId, companyId)));
  await audit(db, companyId, actorId, dispute ? "whatsapp.inbox.dispute" : "whatsapp.inbox.dispute_cleared", { eventId: r.id });
}

/** A pessoa da empresa registra o pedido de parar de uma resposta (empresa; todas só a diretoria). Usa o mesmo registro de consentimento. */
export async function optOutFromInbox(db: DB, actorId: string, companyId: string, id: string, scope: "company" | "global") {
  const r = await inboxRow(db, companyId, id);
  if (!r.phone) throw new Invalid("Esta mensagem não tem número resolvido");
  try { await recordConsent(db, actorId, companyId, { phone: r.phone, decision: "opt_out", scope, evidenceSource: "cliente_iniciou", evidenceRef: "resposta no WhatsApp (caixa de entrada)" }); }
  catch (e) { if (!(e instanceof Invalid) || !/já está registrado/.test(e.message)) throw e; }
  await db.execute(sql`update whatsapp_outbox set status = 'suprimido', reason = 'optout', finished_at = now(), updated_at = now() where phone = ${r.phone} and status = 'na_fila' ${scope === "company" ? sql`and company_id = ${companyId}` : sql``}`);
  await db.update(whatsappInboundEvents).set({ optoutApplied: scope, handling: "resolvido", needsReview: false, updatedAt: new Date() }).where(and(eq(whatsappInboundEvents.id, r.id), eq(whatsappInboundEvents.companyId, companyId)));
}

/** Há resposta de cliente NÃO resolvida (ou contestação) deste telefone nesta empresa? Suspende a cobrança até resolver. */
export async function hasOpenReply(x: DB, companyId: string, phone: string): Promise<boolean> {
  const r = (await x.execute(sql`select 1 from whatsapp_inbound_events where company_id = ${companyId} and phone = ${phone} and event_type = 'message' and routing in ('atribuida', 'atribuida_manual') and (dispute or (handling <> 'resolvido' and classification in ('resposta', 'opt_out_ambiguo'))) limit 1`)) as unknown as unknown[];
  return r.length > 0;
}

// ---------- triagem (sem empresa): só quem é diretoria em TODAS as empresas da conexão ----------
async function triageSessionIds(db: DB, actorId: string): Promise<{ sessions: Set<string>; companies: Map<string, string[]> }> {
  const mem = ((await db.execute(sql`select m.company_id::text id, m.role from memberships m where m.user_id = ${actorId} and m.status = 'active'`)) as unknown as { id: string; role: string }[]).filter((m) => can(m.role as never, "whatsapp.authorize")).map((m) => m.id);
  const rows = (await db.execute(sql`select session_id::text sid, array_agg(company_id::text) cos from whatsapp_session_companies where revoked_at is null group by 1`)) as unknown as { sid: string; cos: string[] }[];
  const sessions = new Set<string>(), companies = new Map<string, string[]>();
  for (const r of rows) if (r.cos.every((c) => mem.includes(c))) { sessions.add(r.sid); companies.set(r.sid, r.cos); }
  return { sessions, companies };
}
export async function listTriage(db: DB, actorId: string): Promise<(InboxItem & { sessionId: string; companies: { id: string; name: string }[] })[]> {
  const t = await triageSessionIds(db, actorId);
  if (!t.sessions.size) return [];
  const ids = [...t.sessions];
  const rows = (await db.execute(sql`select e.id::text id, e.session_id::text session_id, e.created_at, e.phone_masked, null::text customer, e.classification, e.handling, e.dispute, e.needs_review, e.optout_applied, e.kind, e.body_enc
    from whatsapp_inbound_events e where e.routing = 'triagem' and e.company_id is null and e.event_type = 'message' and e.session_id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)}) order by e.created_at desc limit 100`)) as unknown as (Parameters<typeof row2item>[0] & { session_id: string })[];
  const names = new Map(((await db.execute(sql`select id::text id, name from companies`)) as unknown as { id: string; name: string }[]).map((c) => [c.id, c.name]));
  return rows.map((r) => ({ ...row2item(r), sessionId: r.session_id, companies: (t.companies.get(r.session_id) ?? []).map((c) => ({ id: c, name: names.get(c) ?? "Empresa" })) }));
}
async function triageRow(db: DB, actorId: string, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id ?? "")) throw new Invalid("Mensagem não encontrada");
  const [r] = await db.select().from(whatsappInboundEvents).where(and(eq(whatsappInboundEvents.id, id), eq(whatsappInboundEvents.routing, "triagem"), sql`${whatsappInboundEvents.companyId} is null`));
  const t = await triageSessionIds(db, actorId);
  if (!r || !r.sessionId || !t.sessions.has(r.sessionId)) throw new Invalid("Mensagem não encontrada");
  return { r, bound: t.companies.get(r.sessionId)! };
}
/** A triagem escolhe a empresa: a pessoa precisa ser diretoria em TODAS as empresas da conexão (por isso pode ver a mensagem). */
export async function assignTriage(db: DB, actorId: string, id: string, targetCompanyId: string) {
  const { r, bound } = await triageRow(db, actorId, id);
  if (!bound.includes(targetCompanyId)) throw new Invalid("Escolha uma empresa da conexão");
  await db.update(whatsappInboundEvents).set({ companyId: targetCompanyId, routing: "atribuida_manual", handling: "novo", updatedAt: new Date() }).where(and(eq(whatsappInboundEvents.id, r.id), eq(whatsappInboundEvents.routing, "triagem")));
  await audit(db, targetCompanyId, actorId, "whatsapp.triage.assigned", { eventId: r.id });
}
export async function discardTriage(db: DB, actorId: string, id: string) {
  const { r } = await triageRow(db, actorId, id);
  await db.update(whatsappInboundEvents).set({ routing: "descartada", handling: "resolvido", needsReview: false, updatedAt: new Date() }).where(and(eq(whatsappInboundEvents.id, r.id), eq(whatsappInboundEvents.routing, "triagem")));
  await db.insert(auditLog).values({ companyId: null, actorId, action: "whatsapp.triage.discarded", detail: { eventId: r.id } });
}
