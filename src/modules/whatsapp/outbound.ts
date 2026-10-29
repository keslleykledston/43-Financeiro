import { and, desc, eq, sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { customerContacts, whatsappCompanySettings, whatsappOutbox, whatsappSessionCompanies, whatsappSessions } from "@/lib/db/schema";
import { centsFromNumeric } from "@/lib/money";
import { formatBRL } from "@/lib/format";
import { open as openBox, seal } from "@/lib/security/secretbox";
import { Invalid, requirePerm } from "@/modules/identity/service";
import { getSettings, listTemplates } from "@/modules/messaging/service";
import { WINDOW_REASON, windowState } from "@/modules/messaging/window";
import { render, validateTemplate, type Vars } from "@/modules/messaging/templates";
import { holidays } from "@/lib/db/schema";
import { wahaConfigured } from "@/modules/providers/waha";
import { CAPS, maskPhone, parseBrPhone, refHash, type Check, type ConsentState } from "./domain";
import { hasOpenReply } from "./inbound";
import { audit, bound, clean, clientOf, consentState, deliverViaWaha, envOf, manausDay, moduleOn, refreshSession, sendOn, usedToday, type Deps } from "./service";
import { createHash } from "node:crypto";

/**
 * W3a — cobrança de CLIENTE por WhatsApp, MANUAL e ASSISTIDA (sem régua, sem agendador: a automação é da entrega 4 e continua desligada).
 * Fluxo: o operador escolhe cobrança + modelo → prévia + lista de verificação → «colocar na fila» (texto cifrado, fixado) → «enviar» REVALIDA tudo na hora (cobrança ainda devida, consentimento,
 * opt-out, janela, limites, conexão lida na WAHA) e o texto re-renderizado tem de ser IGUAL ao aprovado. Resultado ambíguo = «desconhecido», nunca reenviado sozinho.
 */
export const SEND_PHRASE = "ENVIAR WHATSAPP A CLIENTES";
const BOX = (companyId: string) => `whatsapp-outbox:${companyId}`;
const MAX_TEXT = 600;
const BOLETO_FIELDS = ["linha_digitavel", "link_boleto", "pix_copia_cola"];
export const OUTBOX_STATUS_LABEL: Record<string, string> = { na_fila: "Na fila", enviando: "Enviando", enviado: "Enviado", desconhecido: "Sem confirmação", falhou: "Falhou", suprimido: "Suprimido", cancelado: "Cancelado" };
export const REASON_LABEL: Record<string, string> = {
  pago_ou_cancelada: "Cobrança paga, cancelada ou não aprovada", sem_consentimento: "Contato sem consentimento", optout: "Contato pediu para parar", modelo_indisponivel: "Modelo desativado ou inválido", sem_telefone: "Sem telefone de celular do contato financeiro",
  aviso_recente: "Já houve aviso a este cliente nos últimos 7 dias", cobranca_alterada: "Cobrança paga ou alterada (baixa, lote reaberto/cancelado)", empresa_desligada: "Cobrança por WhatsApp desligada para a empresa", bloqueado_antes_de_enviar: "Bloqueado no último instante", conexao_nao_conectada: "Conexão não estava conectada",
  conexao_sem_resposta: "WAHA sem resposta", numero_fora_do_whatsapp: "Número não está no WhatsApp", numero_sem_id_canonico: "WhatsApp não devolveu o identificador", numero_divergente: "WhatsApp devolveu outro número", sem_confirmacao: "Sem confirmação da WAHA",
  erro_interno: "Erro interno durante o envio", erro_interno_antes_de_enviar: "Erro interno antes do envio", reserva_abandonada: "Envio interrompido (servidor caiu)", cancelado_pelo_operador: "Cancelado pelo operador", confirmado_enviado: "Confirmado como enviado (conferência humana)", confirmado_nao_enviado: "Confirmado como NÃO enviado (conferência humana)",
};
const br = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

// ---------- configuração por empresa ----------
export type CompanyWaSettings = { sendEnabled: boolean; automationEnabled: boolean; dailyCap: number; reference: string | null; authorizedAt: Date | null };
export async function getCompanySettings(db: DB, actorId: string, companyId: string): Promise<CompanyWaSettings> {
  await requirePerm(db, actorId, companyId, "whatsapp.read");
  return loadCompanySettings(db, companyId);
}
async function loadCompanySettings(x: DB, companyId: string): Promise<CompanyWaSettings> {
  const [r] = await x.select().from(whatsappCompanySettings).where(eq(whatsappCompanySettings.companyId, companyId));
  return r ? { sendEnabled: r.sendEnabled, automationEnabled: r.automationEnabled, dailyCap: r.dailyCap, reference: r.reference, authorizedAt: r.authorizedAt } : { sendEnabled: false, automationEnabled: false, dailyCap: CAPS.companyDaily, reference: null, authorizedAt: null };
}

/** Liga/desliga o envio de COBRANÇA a clientes desta empresa. Ligar exige diretoria, a referência da autorização escrita e a frase digitada. Desligar é imediato. A automação NÃO é tocada (entrega 4). */
export async function saveCompanySettings(db: DB, actorId: string, companyId: string, input: { enable: boolean; reference?: string; dailyCap?: unknown; phrase?: string }) {
  await requirePerm(db, actorId, companyId, "whatsapp.authorize");
  let ref: string | null = null, cap: number = CAPS.companyDaily;
  if (input.enable) {
    if (String(input.phrase ?? "").trim() !== SEND_PHRASE) throw new Invalid(`Para ligar, digite exatamente: ${SEND_PHRASE}`);
    ref = clean(input.reference, 200);
    if (ref.length < 5) throw new Invalid("Informe onde está a autorização escrita da empresa para cobrar clientes por WhatsApp");
    cap = Number(input.dailyCap ?? CAPS.companyDaily);
    if (!Number.isInteger(cap) || cap < 1 || cap > CAPS.companyDaily) throw new Invalid(`O limite diário deve ficar entre 1 e ${CAPS.companyDaily}`);
  }
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await x.execute(sql`select pg_advisory_xact_lock(hashtext(${"whatsapp-settings:" + companyId}))`);
    const now = new Date();
    if (input.enable) {
      await x.insert(whatsappCompanySettings).values({ companyId, sendEnabled: true, dailyCap: cap, reference: ref, authorizedBy: actorId, authorizedAt: now })
        .onConflictDoUpdate({ target: whatsappCompanySettings.companyId, set: { sendEnabled: true, dailyCap: cap, reference: ref, authorizedBy: actorId, authorizedAt: now, updatedAt: now } });
    } else {
      await x.update(whatsappCompanySettings).set({ sendEnabled: false, updatedAt: now }).where(eq(whatsappCompanySettings.companyId, companyId));
      // o que estava aprovado na fila NÃO volta a sair se a empresa for religada depois: suprime agora
      await x.execute(sql`update whatsapp_outbox set status = 'suprimido', reason = 'empresa_desligada', finished_at = now(), updated_at = now() where company_id = ${companyId} and status = 'na_fila'`);
    }
    await audit(x, companyId, actorId, input.enable ? "whatsapp.company_send.enabled" : "whatsapp.company_send.disabled", input.enable ? { dailyCap: cap } : {});
  });
}

// ---------- modelos ----------
export async function whatsappTemplateOptions(db: DB, actorId: string, companyId: string) {
  await requirePerm(db, actorId, companyId, "whatsapp.send");
  const all = await listTemplates(db, actorId, companyId);
  return all.filter((t) => t.channel === "whatsapp" && t.active).map((t) => {
    const body = t.active!.body, issue = templateIssue(body);
    return { versionId: t.active!.id, kind: t.kind, version: t.active!.version, body, usable: issue === null, issue };
  });
}
function templateIssue(body: string): string | null {
  const v = validateTemplate("whatsapp", "", body);
  if (!v.ok) return v.error;
  if (BOLETO_FIELDS.some((f) => body.includes(`{{${f}}}`))) return "Usa dados do boleto (linha digitável/link/Pix): ainda não disponível no WhatsApp";
  return null;
}

// ---------- elegibilidade (a MESMA lista na prévia, ao enfileirar e ao enviar) ----------
type ChargeRow = { id: string; amount: string; due: string; issue: string; competence: string; description: string; cs: string; bs: string; customer_id: string; customer: string; company_name: string; paid: string };
export type SendContext = { chargeId: string; customerId: string; digits: string; phone: string; phoneMasked: string; text: string; sha: string; milestone: string; templateVersionId: string; session: { id: string; providerSession: string } };

async function loadCharge(x: DB, companyId: string, chargeId: string): Promise<ChargeRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(chargeId ?? "")) return null;
  const r = (await x.execute(sql`select c.id::text id, c.amount::text amount, c.due_date::text due, c.issue_date::text issue, c.competence_month::text competence, c.description, c.status cs, b.status bs, cu.id::text customer_id, cu.display_name customer, co.name company_name,
      coalesce((select sum(p.amount) from payments p where p.company_id = c.company_id and p.charge_id = c.id and p.status = 'ativo'), 0)::text paid
    from charges c join billing_batches b on b.company_id = c.company_id and b.id = c.batch_id join customers cu on cu.company_id = c.company_id and cu.id = c.customer_id join companies co on co.id = c.company_id
    where c.company_id = ${companyId} and c.id = ${chargeId}`)) as unknown as ChargeRow[];
  return r[0] ?? null;
}
const openCents = (c: ChargeRow) => centsFromNumeric(c.amount) - centsFromNumeric(c.paid);

export type Eligibility = { checks: Check[]; canSend: boolean; hard: { code: string; label: string } | null; ctx: SendContext | null; preview: { text: string; customer: string; phoneMasked: string | null; milestone: string | null } | null };

/**
 * Tudo que decide se UMA cobrança pode sair AGORA por WhatsApp. `hard` = a mensagem nunca mais deve sair (cobrança paga, sem consentimento, opt-out, modelo desativado...): o envio a suprime.
 * Os demais bloqueios (janela, limites, conexão, chaves) são temporários: a mensagem espera na fila.
 */
export async function evaluateCustomerSend(db: DB, actorId: string, companyId: string, input: { chargeId: string; templateVersionId: string; sessionId: string; contactId?: string; phone?: string }, deps?: Deps, opts: { outboxId?: string; now?: Date } = {}): Promise<Eligibility> {
  await requirePerm(db, actorId, companyId, "whatsapp.send");
  const env = envOf(deps);
  const checks: Check[] = [];
  let hard: Eligibility["hard"] = null;
  const add = (key: string, ok: boolean, label: string, detail?: string, hardCode?: string) => { checks.push({ key, ok, label, detail }); if (!ok && hardCode && !hard) hard = { code: hardCode, label: detail ?? label }; return ok; };
  add("server_flag", sendOn(env), "Envio liberado no servidor", sendOn(env) ? undefined : "A chave WHATSAPP_SEND_ENABLED está desligada");
  add("module", moduleOn(env) && wahaConfigured(env), "Módulo WhatsApp e WAHA configurados", moduleOn(env) && wahaConfigured(env) ? undefined : "Módulo desligado ou WAHA não configurada");
  const cs = await loadCompanySettings(db, companyId);
  add("company_send", cs.sendEnabled, "Cobrança por WhatsApp liberada para esta empresa", cs.sendEnabled ? undefined : "A diretoria ainda não liberou o envio a clientes (WhatsApp → Configuração)");
  let sess: Awaited<ReturnType<typeof bound>> | null = null;
  try { sess = await bound(db, companyId, input.sessionId); } catch { /* sem vínculo */ }
  add("bound", !!sess, "Conexão vinculada a esta empresa", sess ? undefined : "Escolha uma conexão desta empresa");
  if (sess) {
    add("session_active", !sess.s.paused, "Conexão não está pausada", sess.s.paused ? "A conexão está pausada" : undefined);
    add("session_connected", sess.s.status === "CONNECTED", "Conexão conectada", sess.s.status === "CONNECTED" ? undefined : "A conexão não está conectada");
  }
  const st = await getSettings(db, actorId, companyId);
  add("company_active", !st.paused, "Envios da empresa não estão pausados", st.paused ? "Envios pausados em Mensagens → Configuração" : undefined);

  const ch = await loadCharge(db, companyId, input.chargeId);
  const open = !!ch && ch.cs === "aprovada" && ch.bs === "aprovado" && openCents(ch) > 0;
  add("charge_open", open, "Cobrança em aberto", open ? undefined : ch ? "Esta cobrança está paga, cancelada ou não aprovada" : "Cobrança não encontrada", "pago_ou_cancelada");

  // contato financeiro com celular
  let digits: string | null = null;
  if (ch) {
    const contacts = await db.select().from(customerContacts).where(and(eq(customerContacts.companyId, companyId), eq(customerContacts.partyId, ch.customer_id), eq(customerContacts.isFinancial, true)));
    const cands = contacts.filter((c) => !input.contactId || c.id === input.contactId).map((c) => parseBrPhone(c.phone ?? "")).filter((d): d is string => !!d && d.length === 13); // celular (com o 9)
    const wanted = input.phone ? parseBrPhone(input.phone) : null;
    digits = wanted && cands.includes(wanted) ? wanted : wanted ? null : cands[0] ?? null;
  }
  add("contact", !!digits, "Contato financeiro com celular", digits ? `Enviará para ${maskPhone(digits)}` : "O cliente não tem contato financeiro com telefone de celular", "sem_telefone");
  const consent: ConsentState = digits ? (await consentState(db, companyId, digits)).state : "none";
  add("consent", consent === "opt_in", "Consentimento do contato", consent === "opt_in" ? undefined : consent === "none" ? "Sem consentimento registrado (WhatsApp → Consentimentos)" : "Este contato pediu para não receber mensagens", consent === "none" ? "sem_consentimento" : "optout");

  // resposta do cliente ainda não resolvida (ou contestação): suspende a cobrança até alguém resolver na Caixa de entrada (bloqueio TEMPORÁRIO: a mensagem espera na fila)
  const openReply = digits ? await hasOpenReply(db, companyId, digits) : false;
  add("reply_pending", !openReply, "Sem resposta do cliente pendente", openReply ? "O cliente respondeu (ou há contestação) e a conversa não foi resolvida: veja WhatsApp → Caixa de entrada" : undefined);

  // modelo + texto
  let text = "", milestone: string | null = null, tplOk = false;
  const tpls = (await listTemplates(db, actorId, companyId)).filter((t) => t.channel === "whatsapp");
  const tpl = tpls.find((t) => t.active?.id === input.templateVersionId);
  if (tpl?.active) {
    milestone = tpl.kind;
    const issue = templateIssue(tpl.active.body);
    if (!issue && ch) {
      const vars: Vars = { linha_digitavel: "", link_boleto: "", pix_copia_cola: "", cliente: ch.customer, empresa: ch.company_name, valor: formatBRL(openCents(ch)), vencimento: br(ch.due), competencia: `${ch.competence.slice(5, 7)}/${ch.competence.slice(0, 4)}`, descricao: ch.description, emissao: br(ch.issue) };
      text = render(tpl.active.body, vars);
      tplOk = text.length > 0 && text.length <= MAX_TEXT;
      add("template", tplOk, "Modelo ativo e válido", tplOk ? undefined : text.length > MAX_TEXT ? `A mensagem passa de ${MAX_TEXT} caracteres` : "Mensagem vazia", "modelo_indisponivel");
    } else add("template", false, "Modelo ativo e válido", issue ?? "Cobrança não encontrada", "modelo_indisponivel");
  } else add("template", false, "Modelo ativo e válido", "Modelo não está ativo (ou não é de WhatsApp)", "modelo_indisponivel");

  const hol = await db.select().from(holidays).where(eq(holidays.companyId, companyId));
  const w = windowState(opts.now ?? new Date(), st, new Map(hol.map((h) => [h.day, h.name])));
  add("window", w.open, "Dentro da janela de envio", w.open ? undefined : `${WINDOW_REASON[w.reason]} (horário de Manaus)`);
  if (sess) {
    const u = await usedToday(db, companyId, sess.s.id, manausDay(opts.now), opts.outboxId);
    const cap = Math.min(cs.dailyCap, CAPS.companyDaily);
    add("cap_company", u.company < cap, "Limite diário da empresa", u.company < cap ? `${u.company} de ${cap} hoje` : `Limite de ${cap} por dia atingido`);
    add("cap_session", u.session < CAPS.sessionDaily, "Limite diário da conexão", u.session < CAPS.sessionDaily ? undefined : `Limite de ${CAPS.sessionDaily} por dia atingido (soma das empresas)`);
  }
  if (ch) {
    const recent = (await db.execute(sql`select 1 from whatsapp_outbox where company_id = ${companyId} and customer_id = ${ch.customer_id}::uuid and status in ('enviando', 'enviado', 'desconhecido') and coalesce(sent_at, finished_at, updated_at) > now() - interval '7 days' ${opts.outboxId ? sql`and id <> ${opts.outboxId}::uuid` : sql``} limit 1`)) as unknown as unknown[];
    add("recent", recent.length === 0, "No máximo 1 aviso por cliente a cada 7 dias", recent.length === 0 ? undefined : "Já houve aviso a este cliente nos últimos 7 dias", "aviso_recente");
  }
  const canSend = checks.every((c) => c.ok);
  const ctx: SendContext | null = ch && digits && sess && tplOk && milestone ? {
    chargeId: ch.id, customerId: ch.customer_id, digits, phone: digits, phoneMasked: maskPhone(digits), text, sha: createHash("sha256").update(text).digest("hex"), milestone, templateVersionId: input.templateVersionId, session: { id: sess.s.id, providerSession: sess.s.providerSession },
  } : null;
  return { checks, canSend, hard, ctx, preview: ch ? { text, customer: ch.customer, phoneMasked: digits ? maskPhone(digits) : null, milestone } : null };
}

// ---------- colocar na fila ----------
const IDEM = /^[A-Za-z0-9_-]{8,64}$/;
export async function queueCustomerMessage(db: DB, actorId: string, companyId: string, input: { chargeId: string; templateVersionId: string; sessionId: string; contactId?: string; phone?: string; confirm: boolean; key: string }, deps?: Deps) {
  await requirePerm(db, actorId, companyId, "whatsapp.send");
  if (!input.confirm) throw new Invalid("Confirme que revisou a mensagem e que o cliente aceitou receber");
  if (!IDEM.test(input.key ?? "")) throw new Invalid("Formulário vencido. Recarregue a página e tente de novo");
  const dupe = async (x: DB) => (await x.select({ s: whatsappOutbox.status }).from(whatsappOutbox).where(and(eq(whatsappOutbox.companyId, companyId), eq(whatsappOutbox.idempotencyKey, input.key))))[0];
  { const d = await dupe(db); if (d) throw new Invalid(`Esta solicitação já foi registrada (${OUTBOX_STATUS_LABEL[d.s] ?? d.s}). Nada novo foi feito`); }
  const ev = await evaluateCustomerSend(db, actorId, companyId, input, deps, { now: deps?.now });
  const bad = ev.checks.filter((c) => !c.ok);
  if (bad.length || !ev.ctx) {
    await audit(db, companyId, actorId, "whatsapp.customer_blocked", { reasons: bad.map((b) => b.key) });
    throw new Invalid(`Não pode ir para a fila: ${bad[0]?.detail ?? bad[0]?.label ?? "verifique a lista"}`);
  }
  const c = ev.ctx;
  try {
    return await db.transaction(async (tx) => {
      const x = tx as unknown as DB;
      await x.execute(sql`select pg_advisory_xact_lock(hashtext(${"whatsapp-queue:" + companyId}))`);
      const [row] = await x.insert(whatsappOutbox).values({ companyId, sessionId: c.session.id, chargeId: c.chargeId, customerId: c.customerId, templateVersionId: c.templateVersionId, milestone: c.milestone, phone: c.phone, phoneMasked: c.phoneMasked, bodyEnc: seal(c.text, BOX(companyId)), bodySha: c.sha, idempotencyKey: input.key, requestedBy: actorId }).returning({ id: whatsappOutbox.id });
      await audit(x, companyId, actorId, "whatsapp.customer_queued", { outboxId: row.id, milestone: c.milestone });
      return { outboxId: row.id };
    });
  } catch (e) {
    const code = (e as { cause?: { code?: string; constraint_name?: string } }).cause;
    if (code?.code === "23505") throw new Invalid("Já existe uma mensagem na fila ou enviada para esta cobrança, este modelo e este telefone. Nada novo foi feito");
    throw e;
  }
}

// ---------- enviar (revalida tudo) ----------
async function outboxRow(x: DB, companyId: string, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id ?? "")) throw new Invalid("Mensagem não encontrada");
  const [r] = await x.select().from(whatsappOutbox).where(and(eq(whatsappOutbox.id, id), eq(whatsappOutbox.companyId, companyId)));
  if (!r) throw new Invalid("Mensagem não encontrada");
  return r;
}
async function suppress(db: DB, companyId: string, actorId: string, id: string, reason: string) {
  const r = await db.update(whatsappOutbox).set({ status: "suprimido", reason, finishedAt: new Date(), updatedAt: new Date() }).where(and(eq(whatsappOutbox.id, id), eq(whatsappOutbox.companyId, companyId), eq(whatsappOutbox.status, "na_fila"))).returning({ id: whatsappOutbox.id });
  if (r.length) await audit(db, companyId, actorId, "whatsapp.customer_suppressed", { outboxId: id, reason });
}

export async function dispatchOutbox(db: DB, actorId: string, companyId: string, outboxId: string, deps?: Deps) {
  await requirePerm(db, actorId, companyId, "whatsapp.send");
  const row = await outboxRow(db, companyId, outboxId);
  if (row.status !== "na_fila") throw new Invalid(`Esta mensagem já foi processada (${OUTBOX_STATUS_LABEL[row.status] ?? row.status}). Nada foi enviado`);
  const env = envOf(deps);
  if (moduleOn(env) && wahaConfigured(env)) { try { await refreshSession(db, actorId, companyId, row.sessionId, deps); } catch { /* sem vínculo: a lista explica */ } } // estado fresco da conexão antes de decidir
  const ev = await evaluateCustomerSend(db, actorId, companyId, { chargeId: row.chargeId, templateVersionId: row.templateVersionId, sessionId: row.sessionId, phone: row.phone }, deps, { outboxId: row.id, now: deps?.now });
  if (ev.hard) { await suppress(db, companyId, actorId, row.id, ev.hard.code); throw new Invalid(`Mensagem suprimida: ${ev.hard.label}. Nada foi enviado`); }
  const soft = ev.checks.filter((c) => !c.ok);
  if (soft.length || !ev.ctx) throw new Invalid(`Ainda não pode enviar: ${soft[0]?.detail ?? soft[0]?.label ?? "verifique a lista"}. A mensagem continua na fila`);
  if (ev.ctx.sha !== row.bodySha) throw new Invalid("A cobrança ou o modelo mudou depois de a mensagem entrar na fila (valor, vencimento ou texto). Cancele esta e coloque outra: o texto enviado é sempre o que você aprovou");
  const text = openBox(row.bodyEnc, BOX(companyId));
  if (createHash("sha256").update(text).digest("hex") !== row.bodySha) throw new Invalid("O texto guardado não confere. Nada foi enviado");
  // reserva: só uma requisição passa de na_fila para enviando; limites sob trava
  const reserved = await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await x.execute(sql`select pg_advisory_xact_lock(hashtext(${"whatsapp-send:" + row.sessionId}))`);
    await x.execute(sql`select pg_advisory_xact_lock(hashtext(${"whatsapp-send-co:" + companyId}))`);
    const cs = await loadCompanySettings(x, companyId);
    const u = await usedToday(x, companyId, row.sessionId, manausDay(), row.id);
    if (u.company + 1 > Math.min(cs.dailyCap, CAPS.companyDaily) || u.session + 1 > CAPS.sessionDaily) throw new Invalid("Limite diário de envios atingido. A mensagem continua na fila");
    // 1 aviso por cliente a cada 7 dias, REVALIDADO sob a trava (duas cobranças do mesmo cliente enviadas ao mesmo tempo: só uma passa)
    const recent = (await x.execute(sql`select 1 from whatsapp_outbox where company_id = ${companyId} and customer_id = ${row.customerId}::uuid and id <> ${row.id}::uuid and status in ('enviando', 'enviado', 'desconhecido') and coalesce(sent_at, finished_at, updated_at) > now() - interval '7 days' limit 1`)) as unknown as unknown[];
    if (recent.length) return "aviso_recente" as const; // a supressão é gravada FORA desta transação (um throw aqui a desfaria)
    const got = await x.update(whatsappOutbox).set({ status: "enviando", updatedAt: new Date() }).where(and(eq(whatsappOutbox.id, row.id), eq(whatsappOutbox.companyId, companyId), eq(whatsappOutbox.status, "na_fila"))).returning({ id: whatsappOutbox.id });
    if (!got.length) throw new Invalid("Esta mensagem já está sendo processada. Nada foi enviado");
    return "ok" as const;
  });
  if (reserved === "aviso_recente") { await suppress(db, companyId, actorId, row.id, "aviso_recente"); throw new Invalid("Mensagem suprimida: já houve aviso a este cliente nos últimos 7 dias. Nada foi enviado"); }
  const finish = async (r: { status: "enviado" | "falhou" | "desconhecido" | "suprimido"; providerRef?: string | null; reason?: string | null }) => {
    await db.transaction(async (tx) => {
      const x = tx as unknown as DB;
      const now = new Date();
      const upd = await x.update(whatsappOutbox).set({ status: r.status, reason: r.reason ?? null, providerRef: r.providerRef ?? null, ...(r.status === "enviado" ? { sentAt: now } : {}), finishedAt: now, updatedAt: now }).where(and(eq(whatsappOutbox.id, row.id), eq(whatsappOutbox.companyId, companyId), eq(whatsappOutbox.status, "enviando"))).returning({ id: whatsappOutbox.id });
      await audit(x, companyId, actorId, upd.length ? (r.status === "enviado" ? "whatsapp.customer_sent" : "whatsapp.customer_failed") : "whatsapp.customer_late_result", { outboxId: row.id, status: r.status, ...(r.reason ? { reason: r.reason } : {}) });
    });
  };
  // reconferência no instante de sair: tudo que pode mudar entre a prévia e o envio
  const recheck = async (): Promise<string | null> => {
    const [s] = await db.select({ p: whatsappSessions.paused, st: whatsappSessions.status }).from(whatsappSessions).where(eq(whatsappSessions.id, row.sessionId));
    const [b] = await db.select({ id: whatsappSessionCompanies.id }).from(whatsappSessionCompanies).where(and(eq(whatsappSessionCompanies.sessionId, row.sessionId), eq(whatsappSessionCompanies.companyId, companyId), sql`${whatsappSessionCompanies.revokedAt} is null`));
    const cs = await loadCompanySettings(db, companyId);
    const ch = await loadCharge(db, companyId, row.chargeId);
    const consent = await consentState(db, companyId, row.phone);
    const stt = await getSettings(db, actorId, companyId);
    if (await hasOpenReply(db, companyId, row.phone)) return "bloqueado_antes_de_enviar";
    return !sendOn(env) || s?.p !== false || s?.st !== "CONNECTED" || !b || !cs.sendEnabled || stt.paused || !ch || ch.cs !== "aprovada" || ch.bs !== "aprovado" || openCents(ch) <= 0 || consent.state !== "opt_in" ? "bloqueado_antes_de_enviar" : null;
  };
  const out = await deliverViaWaha(db, { session: ev.ctx.session, digits: row.phone, text, deps, recheckBefore: recheck, recheckAfterCheck: recheck });
  if (out.kind === "sent") { await finish({ status: "enviado", providerRef: out.providerRef }); return { outboxId: row.id }; }
  if (out.kind === "abort") { await finish({ status: "suprimido", reason: out.code }); throw new Invalid("O envio foi bloqueado no último instante (cobrança, consentimento, pausa ou conexão mudou). Nada foi enviado"); }
  if (out.kind === "fail") { await finish({ status: "falhou", reason: out.code }); throw new Invalid(out.message); }
  await finish({ status: out.status, reason: out.error });
  throw new Invalid(out.status === "desconhecido" ? "A WAHA não confirmou o envio (a mensagem PODE ter chegado). Confira com o cliente/aparelho; ela NÃO será reenviada sozinha" : `A WAHA recusou o envio (${out.error}). Nada foi enviado`);
}

export async function cancelOutbox(db: DB, actorId: string, companyId: string, outboxId: string) {
  await requirePerm(db, actorId, companyId, "whatsapp.send");
  const row = await outboxRow(db, companyId, outboxId);
  if (row.status !== "na_fila") throw new Invalid(`Só mensagem na fila pode ser cancelada (esta está: ${OUTBOX_STATUS_LABEL[row.status] ?? row.status})`);
  const r = await db.update(whatsappOutbox).set({ status: "cancelado", reason: "cancelado_pelo_operador", finishedAt: new Date(), updatedAt: new Date() }).where(and(eq(whatsappOutbox.id, row.id), eq(whatsappOutbox.companyId, companyId), eq(whatsappOutbox.status, "na_fila"))).returning({ id: whatsappOutbox.id });
  if (!r.length) throw new Invalid("A mensagem mudou de estado. Atualize a página");
  await audit(db, companyId, actorId, "whatsapp.customer_cancelled", { outboxId: row.id });
}

/** «Sem confirmação» só se resolve por conferência HUMANA (o aparelho/o cliente). Nunca reenvia. Só diretoria. */
export async function resolveUnknown(db: DB, actorId: string, companyId: string, outboxId: string, outcome: "enviado" | "falhou") {
  await requirePerm(db, actorId, companyId, "whatsapp.authorize");
  if (outcome !== "enviado" && outcome !== "falhou") throw new Invalid("Escolha se a mensagem foi enviada ou não");
  const row = await outboxRow(db, companyId, outboxId);
  if (row.status !== "desconhecido") throw new Invalid("Só mensagem «sem confirmação» pode ser conferida");
  const now = new Date();
  const r = await db.update(whatsappOutbox).set({ status: outcome, reason: outcome === "enviado" ? "confirmado_enviado" : "confirmado_nao_enviado", ...(outcome === "enviado" ? { sentAt: now } : {}), finishedAt: now, updatedAt: now }).where(and(eq(whatsappOutbox.id, row.id), eq(whatsappOutbox.companyId, companyId), eq(whatsappOutbox.status, "desconhecido"))).returning({ id: whatsappOutbox.id });
  if (!r.length) throw new Invalid("A mensagem mudou de estado. Atualize a página");
  await audit(db, companyId, actorId, "whatsapp.customer_resolved", { outboxId: row.id, outcome });
}

// ---------- histórico ----------
export async function listOutbox(db: DB, actorId: string, companyId: string, o: { status?: string; limit?: number } = {}) {
  await requirePerm(db, actorId, companyId, "whatsapp.history");
  const rows = (await db.execute(sql`select o.id::text id, o.status, o.reason, o.milestone, o.phone_masked phone, o.delivery, o.created_at, o.sent_at, o.finished_at, o.delivered_at, o.read_at, cu.display_name customer, c.due_date::text due, c.amount::text amount
    from whatsapp_outbox o join customers cu on cu.company_id = o.company_id and cu.id = o.customer_id join charges c on c.company_id = o.company_id and c.id = o.charge_id
    where o.company_id = ${companyId} ${o.status ? sql`and o.status = ${o.status}` : sql``} order by o.created_at desc limit ${Math.min(o.limit ?? 50, 200)}`)) as unknown as { id: string; status: string; reason: string | null; milestone: string; phone: string; delivery: string | null; created_at: Date; sent_at: Date | null; finished_at: Date | null; delivered_at: Date | null; read_at: Date | null; customer: string; due: string; amount: string }[];
  const d = (v: Date | null) => (v ? new Date(v) : null);
  return rows.map((r) => ({ id: r.id, status: r.status, reason: r.reason, milestone: r.milestone, phone: r.phone, delivery: r.delivery, customer: r.customer, due: r.due, amountCents: centsFromNumeric(r.amount), createdAt: new Date(r.created_at), sentAt: d(r.sent_at), finishedAt: d(r.finished_at), deliveredAt: d(r.delivered_at), readAt: d(r.read_at) }));
}
/** Texto enviado (decifrado). Só quem pode ver o histórico, e só da própria empresa. */
export async function outboxBody(db: DB, actorId: string, companyId: string, outboxId: string) {
  await requirePerm(db, actorId, companyId, "whatsapp.history");
  const row = await outboxRow(db, companyId, outboxId);
  return openBox(row.bodyEnc, BOX(companyId));
}
void desc; void refHash; void clientOf;
