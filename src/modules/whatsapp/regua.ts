import { and, eq, sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { whatsappCompanySettings, whatsappOutbox } from "@/lib/db/schema";
import { centsFromNumeric } from "@/lib/money";
import { Forbidden, Invalid, requirePerm } from "@/modules/identity/service";
import { OFFSET } from "@/modules/messaging/templates";
import { dispatchOutbox, evaluateCustomerSend, queueCustomerMessage, whatsappTemplateOptions } from "./outbound";
import { audit, automationOn, clean, envOf, manausDay, sendOn, type Deps } from "./service";

/**
 * W4 — régua AUTOMÁTICA de WhatsApp (D-3, D0, D+3, D+7). DESLIGADA por padrão em três camadas independentes:
 *  1. chave do servidor `WHATSAPP_AUTOMATION_ENABLED` (junto com envio e módulo);
 *  2. a empresa: cobrança por WhatsApp liberada + régua ligada pela diretoria (referência escrita + frase);
 *  3. cada régua (D-3, D0…) escolhida separadamente.
 * Cada mensagem passa pela MESMA verificação e pelo MESMO envio da cobrança manual (consentimento, pedido de parar, resposta pendente, cobrança ainda devida, janela, limites, 1 aviso por
 * cliente a cada 7 dias, conexão lida na WAHA, texto fixado e conferido). A régua roda EM NOME de quem a ligou e PARA sozinha se essa pessoa perder a permissão.
 * Regras de segurança: só no DIA certo (sem recuperar dia perdido: um «D-3» tardio não faz sentido), só a partir do dia SEGUINTE ao de ligar, no máximo 1 tentativa automática por
 * cobrança e régua (chave de idempotência; falha/«sem confirmação» nunca tenta de novo sozinha) e o que ficou na fila de um dia não sai no dia seguinte.
 */
export const AUTO_KINDS = ["d_menos_3", "d0", "d_mais_3", "d_mais_7"] as const;
export type AutoKind = (typeof AUTO_KINDS)[number];
export const AUTO_PHRASE = "LIGAR RÉGUA DE WHATSAPP";
export const AUTO_LABEL: Record<AutoKind, string> = { d_menos_3: "Lembrete D-3 (3 dias antes do vencimento)", d0: "Vencimento (D0)", d_mais_3: "Atraso D+3", d_mais_7: "Atraso D+7" };
const isKind = (k: string): k is AutoKind => (AUTO_KINDS as readonly string[]).includes(k);
const keyOf = (chargeId: string, kind: AutoKind) => `regua-${chargeId}-${kind}`; // 6 + 36 + 1 + até 9 = 52 (limite do banco: 64)
const PER_TICK = 2;          // no máximo 2 envios automáticos por empresa a cada ciclo (60 s)
const MAX_ROWS = 200;

// ---------- configuração ----------
export type Automation = { enabled: boolean; kinds: AutoKind[]; reference: string | null; authorizedAt: Date | null; authorizedBy: string | null; sendEnabled: boolean; serverOn: boolean };
export async function getAutomation(db: DB, actorId: string, companyId: string, deps?: Deps): Promise<Automation> {
  await requirePerm(db, actorId, companyId, "whatsapp.read");
  const [r] = await db.select().from(whatsappCompanySettings).where(eq(whatsappCompanySettings.companyId, companyId));
  return { enabled: !!r?.automationEnabled, kinds: (r?.automationKinds ?? []).filter(isKind), reference: r?.automationReference ?? null, authorizedAt: r?.automationAuthorizedAt ?? null, authorizedBy: r?.automationAuthorizedBy ?? null, sendEnabled: !!r?.sendEnabled, serverOn: automationOn(envOf(deps)) };
}

/** Liga/desliga a régua da empresa. Ligar: diretoria + cobrança por WhatsApp já liberada + referência escrita + frase + pelo menos uma régua. Desligar é imediato e suprime o que está na fila automática. */
export async function saveAutomation(db: DB, actorId: string, companyId: string, input: { enable: boolean; kinds?: unknown; reference?: string; phrase?: string }) {
  await requirePerm(db, actorId, companyId, "whatsapp.authorize");
  let kinds: AutoKind[] = [], ref: string | null = null;
  if (input.enable) {
    if (String(input.phrase ?? "").trim() !== AUTO_PHRASE) throw new Invalid(`Para ligar, digite exatamente: ${AUTO_PHRASE}`);
    ref = clean(input.reference, 200);
    if (ref.length < 5) throw new Invalid("Informe onde está a aprovação da diretoria para a régua automática");
    const raw = Array.isArray(input.kinds) ? input.kinds : input.kinds ? [input.kinds] : [];
    kinds = [...new Set(raw.map(String))].filter(isKind);
    if (kinds.length === 0 || kinds.length !== new Set(raw.map(String)).size) throw new Invalid("Escolha ao menos uma régua válida (D-3, D0, D+3 ou D+7)");
  }
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await x.execute(sql`select pg_advisory_xact_lock(hashtext(${"whatsapp-settings:" + companyId}))`);
    const [cur] = await x.select().from(whatsappCompanySettings).where(eq(whatsappCompanySettings.companyId, companyId));
    const now = new Date();
    if (input.enable) {
      if (!cur?.sendEnabled) throw new Invalid("Antes, libere a cobrança por WhatsApp da empresa (WhatsApp → Configuração): a régua depende dela");
      await x.update(whatsappCompanySettings).set({ automationEnabled: true, automationKinds: kinds, automationReference: ref, automationAuthorizedBy: actorId, automationAuthorizedAt: now, updatedAt: now }).where(eq(whatsappCompanySettings.companyId, companyId));
    } else if (cur) {
      await x.update(whatsappCompanySettings).set({ automationEnabled: false, updatedAt: now }).where(eq(whatsappCompanySettings.companyId, companyId));
      await x.execute(sql`update whatsapp_outbox set status = 'suprimido', reason = 'regua_desligada', finished_at = now(), updated_at = now() where company_id = ${companyId} and origin = 'regua' and status = 'na_fila'`);
    }
    await audit(x, companyId, actorId, input.enable ? "whatsapp.regua.enabled" : "whatsapp.regua.disabled", input.enable ? { kinds } : {});
  });
}

// ---------- candidatos (a MESMA lista na simulação e no agendador) ----------
type Cand = { chargeId: string; kind: AutoKind; due: string; customer: string };
async function candidates(x: DB, companyId: string, day: string, kinds: readonly AutoKind[]): Promise<Cand[]> {
  const out: Cand[] = [];
  for (const kind of kinds) {
    const rows = (await x.execute(sql`select c.id::text id, c.due_date::text due, cu.display_name customer
      from charges c join billing_batches b on b.company_id = c.company_id and b.id = c.batch_id join customers cu on cu.company_id = c.company_id and cu.id = c.customer_id
      where c.company_id = ${companyId} and c.status = 'aprovada' and b.status = 'aprovado' and c.due_date = ${day}::date - ${OFFSET[kind]}::int
        and c.amount > coalesce((select sum(p.amount) from payments p where p.company_id = c.company_id and p.charge_id = c.id and p.status = 'ativo'), 0)
      order by c.due_date, c.id limit ${MAX_ROWS}`)) as unknown as { id: string; due: string; customer: string }[];
    for (const r of rows) out.push({ chargeId: r.id, kind, due: r.due, customer: r.customer });
  }
  return out;
}
async function connectedSession(x: DB, companyId: string): Promise<string | null> {
  const r = (await x.execute(sql`select s.id::text id from whatsapp_sessions s join whatsapp_session_companies sc on sc.session_id = s.id and sc.company_id = ${companyId} and sc.revoked_at is null
    where s.status = 'CONNECTED' and s.paused = false order by s.created_at limit 1`)) as unknown as { id: string }[];
  return r[0]?.id ?? null;
}

export type SimRow = { chargeId: string; customer: string; due: string; kind: AutoKind; armed: boolean; outcome: "sairia" | "espera" | "nunca" | "ja_tratada"; why: string | null };
/** Simulação (não envia nada): o que a régua faria no dia, com o motivo de cada bloqueio. Vale mesmo com a régua desligada (é a prévia para decidir ligar). */
export async function simulateRegua(db: DB, actorId: string, companyId: string, input: { day?: string; kinds?: AutoKind[] } = {}, deps?: Deps): Promise<{ day: string; rows: SimRow[]; truncated: boolean; note: string | null }> {
  await requirePerm(db, actorId, companyId, "whatsapp.send");
  await requirePerm(db, actorId, companyId, "whatsapp.history");
  const day = /^\d{4}-\d{2}-\d{2}$/.test(input.day ?? "") ? input.day! : manausDay(deps?.now);
  const auto = await getAutomation(db, actorId, companyId, deps);
  const kinds = input.kinds?.length ? input.kinds.filter(isKind) : [...AUTO_KINDS];
  const cands = await candidates(db, companyId, day, kinds);
  const sid = await connectedSession(db, companyId);
  const tpls = await whatsappTemplateOptions(db, actorId, companyId);
  const done = new Set(((await db.execute(sql`select idempotency_key k from whatsapp_outbox where company_id = ${companyId} and idempotency_key like 'regua-%'`)) as unknown as { k: string }[]).map((r) => r.k));
  const rows: SimRow[] = [];
  for (const c of cands.slice(0, MAX_ROWS)) {
    const base = { chargeId: c.chargeId, customer: c.customer, due: c.due, kind: c.kind, armed: auto.enabled && auto.kinds.includes(c.kind) };
    if (done.has(keyOf(c.chargeId, c.kind))) { rows.push({ ...base, outcome: "ja_tratada", why: "A régua já tratou esta cobrança neste marco (não tenta de novo)" }); continue; }
    const tpl = tpls.find((t) => t.kind === c.kind && t.usable);
    if (!tpl) { rows.push({ ...base, outcome: "nunca", why: "Sem modelo de WhatsApp ativo para este marco" }); continue; }
    if (!sid) { rows.push({ ...base, outcome: "espera", why: "Nenhuma conexão conectada e liberada para esta empresa" }); continue; }
    const ev = await evaluateCustomerSend(db, actorId, companyId, { chargeId: c.chargeId, templateVersionId: tpl.versionId, sessionId: sid }, deps, { now: deps?.now });
    if (ev.canSend) rows.push({ ...base, outcome: "sairia", why: null });
    else if (ev.hard) rows.push({ ...base, outcome: "nunca", why: ev.hard.label });
    else { const f = ev.checks.find((k) => !k.ok); rows.push({ ...base, outcome: "espera", why: f?.detail ?? f?.label ?? null }); }
  }
  const note = !auto.serverOn ? "A chave de automação do servidor está desligada: nada sai sozinho, mesmo com a régua ligada." : null;
  return { day, rows, truncated: cands.length > MAX_ROWS, note };
}

// ---------- agendador ----------
export type RunCount = { companyId: string; queued: number; sent: number; waiting: number; failed: number; stale: number; paused: string | null };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Um ciclo da régua para TODAS as empresas com a régua ligada. Chamado pelo agendador a cada minuto; sem chave no servidor, não faz nada. */
export async function runWhatsappAutomation(db: DB, deps: Deps & { pauseMs?: () => number } = {}): Promise<RunCount[]> {
  const env = envOf(deps);
  if (!automationOn(env)) return [];
  const day = manausDay(deps.now);
  const cos = await db.select().from(whatsappCompanySettings).where(and(eq(whatsappCompanySettings.automationEnabled, true), eq(whatsappCompanySettings.sendEnabled, true)));
  const out: RunCount[] = [];
  for (const cs of cos) {
    const r: RunCount = { companyId: cs.companyId, queued: 0, sent: 0, waiting: 0, failed: 0, stale: 0, paused: null };
    out.push(r);
    try { await runCompany(db, cs, day, r, deps); } catch { r.paused = "erro"; } // uma empresa com problema não para as outras
  }
  return out;
}

async function runCompany(db: DB, cs: typeof whatsappCompanySettings.$inferSelect, day: string, r: RunCount, deps: Deps & { pauseMs?: () => number }) {
  const companyId = cs.companyId, actor = cs.automationAuthorizedBy;
  // sem quem ligou, ou se essa pessoa perdeu a permissão: a régua PARA (o painel mostra)
  if (!actor || !cs.automationAuthorizedAt) { r.paused = "sem_responsavel"; return; }
  try { await requirePerm(db, actor, companyId, "whatsapp.authorize"); await requirePerm(db, actor, companyId, "whatsapp.send"); } catch (e) { if (e instanceof Forbidden) { r.paused = "responsavel_sem_permissao"; return; } throw e; }
  // o que ficou na fila automática de um dia anterior NÃO sai (o marco já passou)
  const st = await db.execute(sql`update whatsapp_outbox set status = 'suprimido', reason = 'fora_do_dia', finished_at = now(), updated_at = now()
    where company_id = ${companyId} and origin = 'regua' and status = 'na_fila' and (created_at at time zone 'America/Manaus')::date < ${day}::date`);
  r.stale = st.count as number;
  // ritmo COMPARTILHADO entre instâncias: conta o que a régua já tentou enviar no último minuto (no banco), não só em memória
  const [recent] = (await db.execute(sql`select count(*)::int n from whatsapp_outbox where company_id = ${companyId} and origin = 'regua' and status in ('enviando', 'enviado', 'desconhecido', 'falhou') and coalesce(sent_at, finished_at, updated_at) > now() - interval '60 seconds'`)) as unknown as { n: number }[];
  let budget = Math.max(0, PER_TICK - Number(recent.n));
  if (budget <= 0) return;
  const pause = async () => { const ms = deps.pauseMs ? deps.pauseMs() : 3000 + Math.floor(Math.random() * 5000); if (ms > 0) await sleep(ms); };
  const attempt = async (outboxId: string) => {
    try { await dispatchOutbox(db, actor, companyId, outboxId, deps); r.sent++; }
    catch { const [o] = await db.select({ s: whatsappOutbox.status }).from(whatsappOutbox).where(eq(whatsappOutbox.id, outboxId)); if (o?.s === "na_fila") r.waiting++; else r.failed++; }
    budget--; if (budget > 0) await pause();
  };
  // 1) o que já está na fila de hoje (esperava janela, limite ou conexão)
  const pending = (await db.select({ id: whatsappOutbox.id }).from(whatsappOutbox).where(and(eq(whatsappOutbox.companyId, companyId), eq(whatsappOutbox.origin, "regua"), eq(whatsappOutbox.status, "na_fila"))).limit(PER_TICK));
  for (const p of pending) { if (budget <= 0) break; await attempt(p.id); }
  if (budget <= 0) return;
  // 2) novos do dia: só a partir do dia SEGUINTE ao de ligar
  if (day <= manausDay(cs.automationAuthorizedAt)) return;
  const kinds = (cs.automationKinds ?? []).filter(isKind);
  if (!kinds.length) return;
  const sid = await connectedSession(db, companyId);
  if (!sid) return;
  const tpls = await whatsappTemplateOptions(db, actor, companyId);
  const existing = new Set(((await db.execute(sql`select idempotency_key k from whatsapp_outbox where company_id = ${companyId} and idempotency_key like 'regua-%'`)) as unknown as { k: string }[]).map((x) => x.k));
  for (const c of await candidates(db, companyId, day, kinds)) {
    if (budget <= 0) break;
    const key = keyOf(c.chargeId, c.kind);
    if (existing.has(key)) continue;
    const tpl = tpls.find((t) => t.kind === c.kind && t.usable);
    if (!tpl) continue;
    const ev = await evaluateCustomerSend(db, actor, companyId, { chargeId: c.chargeId, templateVersionId: tpl.versionId, sessionId: sid }, deps, { now: deps.now });
    if (!ev.canSend) continue; // bloqueio definitivo ou temporário: tenta de novo no próximo ciclo (some quando o dia acaba); nada é gravado
    let id: string;
    try { id = (await queueCustomerMessage(db, actor, companyId, { chargeId: c.chargeId, templateVersionId: tpl.versionId, sessionId: sid, confirm: true, key, origin: "regua" }, deps)).outboxId; }
    catch { continue; } // já existe equivalente (manual) ou mudou entre a verificação e a fila
    r.queued++; existing.add(key);
    await audit(db, companyId, actor, "whatsapp.regua.queued", { outboxId: id, kind: c.kind });
    await attempt(id);
  }
}

// ---------- painel ----------
export type Overview = {
  days: number; status: { serverOn: boolean; sendServerOn: boolean; companyEnabled: boolean; automationEnabled: boolean; kinds: AutoKind[]; actorOk: boolean | null; connected: boolean };
  totals: { queued: number; sent: number; delivered: number; read: number; failed: number; unknown: number; suppressed: number; byOrigin: { manual: number; regua: number } };
  suppressedBy: { reason: string; n: number }[]; optOuts: number; replies: { total: number; open: number; disputes: number }; paidAfterNotice: { charges: number; cents: number };
};
export async function reguaOverview(db: DB, actorId: string, companyId: string, days = 30, deps?: Deps): Promise<Overview> {
  await requirePerm(db, actorId, companyId, "whatsapp.history");
  const n = Math.min(Math.max(Math.trunc(days) || 30, 1), 180);
  const a = await getAutomation(db, actorId, companyId, deps);
  let actorOk: boolean | null = null;
  if (a.enabled && a.authorizedBy) { try { await requirePerm(db, a.authorizedBy, companyId, "whatsapp.authorize"); await requirePerm(db, a.authorizedBy, companyId, "whatsapp.send"); actorOk = true; } catch { actorOk = false; } }
  const rows = (await db.execute(sql`select origin, status, coalesce(delivery, '') delivery, coalesce(reason, '') reason, count(*)::int n from whatsapp_outbox where company_id = ${companyId} and created_at >= now() - make_interval(days => ${n}) group by 1, 2, 3, 4`)) as unknown as { origin: string; status: string; delivery: string; reason: string; n: number }[];
  const sum = (f: (r: (typeof rows)[number]) => boolean) => rows.filter(f).reduce((s, r) => s + r.n, 0);
  const supp = new Map<string, number>();
  for (const r of rows.filter((x) => x.status === "suprimido")) supp.set(r.reason || "outro", (supp.get(r.reason || "outro") ?? 0) + r.n);
  const [oo] = (await db.execute(sql`select count(*)::int n from whatsapp_consents where company_id = ${companyId} and decision = 'opt_out' and created_at >= now() - make_interval(days => ${n})`)) as unknown as { n: number }[];
  const [rp] = (await db.execute(sql`select count(*)::int total, count(*) filter (where handling <> 'resolvido')::int open, count(*) filter (where dispute)::int disputes from whatsapp_inbound_events where company_id = ${companyId} and event_type = 'message' and classification in ('resposta', 'opt_out_ambiguo') and routing in ('atribuida', 'atribuida_manual') and created_at >= now() - make_interval(days => ${n})`)) as unknown as { total: number; open: number; disputes: number }[];
  // «pagas depois do aviso»: CORRELAÇÃO (pagamento ativo até 7 dias depois de uma mensagem enviada), nunca causa
  const [pa] = (await db.execute(sql`select count(*)::int charges, coalesce(sum(x.amt), 0)::text amount from (
      select (select coalesce(sum(p.amount), 0) from payments p where p.company_id = o.company_id and p.charge_id = o.charge_id and p.status = 'ativo' and p.paid_at >= o.d1 and p.paid_at <= o.d2 + 7) amt
      from (select company_id, charge_id, min((sent_at at time zone 'America/Manaus')::date) d1, max((sent_at at time zone 'America/Manaus')::date) d2 from whatsapp_outbox
            where company_id = ${companyId} and status = 'enviado' and sent_at >= now() - make_interval(days => ${n}) group by 1, 2) o) x where x.amt > 0`)) as unknown as { charges: number; amount: string }[];
  const [conn] = (await db.execute(sql`select count(*)::int n from whatsapp_sessions s join whatsapp_session_companies sc on sc.session_id = s.id and sc.company_id = ${companyId} and sc.revoked_at is null where s.status = 'CONNECTED' and s.paused = false`)) as unknown as { n: number }[];
  return {
    days: n, status: { serverOn: a.serverOn, sendServerOn: sendOn(envOf(deps)), companyEnabled: a.sendEnabled, automationEnabled: a.enabled, kinds: a.kinds, actorOk, connected: Number(conn.n) > 0 },
    totals: { queued: sum((r) => r.status === "na_fila" || r.status === "enviando"), sent: sum((r) => r.status === "enviado"), delivered: sum((r) => r.status === "enviado" && (r.delivery === "entregue" || r.delivery === "lido")), read: sum((r) => r.status === "enviado" && r.delivery === "lido"), failed: sum((r) => r.status === "falhou"), unknown: sum((r) => r.status === "desconhecido"), suppressed: sum((r) => r.status === "suprimido"), byOrigin: { manual: sum((r) => r.origin === "manual"), regua: sum((r) => r.origin === "regua") } },
    suppressedBy: [...supp.entries()].map(([reason, c]) => ({ reason, n: c })).sort((x, y) => y.n - x.n), optOuts: Number(oo.n), replies: { total: Number(rp.total), open: Number(rp.open), disputes: Number(rp.disputes) }, paidAfterNotice: { charges: Number(pa.charges), cents: centsFromNumeric(pa.amount) },
  };
}
