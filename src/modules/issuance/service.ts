import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { auditLog, billingBatches, issuanceRequests, issuanceSettings } from "@/lib/db/schema";
import { centsFromNumeric } from "@/lib/money";
import { Invalid, requirePerm } from "@/modules/identity/service";
import { localParts } from "@/modules/messaging/window";
import { issuanceTexts } from "./texts";
import { LiveNotAvailable, isBoletoMode, resolveProviders, resolveProvidersForMode, type BoletoProviderMode } from "@/modules/providers/registry";
import type { Providers } from "@/modules/providers/types";

/**
 * E10 — MOTOR de emissão (boleto / NFS-e), SIMULADO. O padrão é o que o envio real exigirá:
 *   1) RESERVAR (transação curta: pendente → enviando, tentativa+1)  2) CHAMAR o provedor FORA de transação  3) REGISTRAR o resultado.
 * Resposta perdida/timeout NÃO vira "falhou" nem reemite: vira `desconhecido` e a próxima rodada RECONSULTA o provedor pela chave de idempotência
 * (find) antes de qualquer nova emissão. A chave é fixa por (empresa, cobrança, tipo), então nunca há duas emissões da mesma cobrança.
 * Começa PAUSADO e o banco só aceita modo "simulado" (CHECK). Emissão real = migração própria + gate em docs/E10_GOLIVE.md.
 */
const audit = (x: DB, companyId: string, actorId: string | null, action: string, detail: Record<string, unknown>) => x.insert(auditLog).values({ companyId, actorId, action, detail });
const uuidOk = (s: string) => /^[0-9a-f-]{36}$/i.test(s);
const lock = (x: DB, companyId: string) => x.execute(sql`select pg_advisory_xact_lock(hashtext(${"issuance:" + companyId}))`);
type Row = Record<string, unknown>;

export type Kind = "boleto" | "nfse";
export const KIND_LABEL: Record<Kind, string> = { boleto: "Boleto", nfse: "NFS-e" };
export const STATUS_LABEL: Record<string, string> = { pendente: "Aguardando", enviando: "Enviando", processando: "Processando no provedor", emitido: "Emitido (simulado)", desconhecido: "Resultado desconhecido: será reconsultado", falhou: "Falhou", cancelado: "Cancelado" };
export const MAX_ATTEMPTS = 5;
const STUCK_MS = 10 * 60_000, UNKNOWN_RETRY_MS = 2 * 60_000;
/** Só códigos curtos em minúsculas vão para o banco/tela; texto livre do provedor (que poderia conter dados do cliente) vira um código genérico. */
const safeCode = (m: string) => (/^[a-z0-9_]{1,40}$/.test(m) ? m : "validacao_provedor");
const backoff = (attempts: number) => Math.min(60, 2 ** attempts) * 60_000; // 2, 4, 8… até 60 min

export { IssuanceRetryable, IssuanceTimeout } from "@/modules/providers/errors";

export type IssuanceSettings = { paused: boolean; dailyLimit: number; boletoProvider: BoletoProviderMode; autoSettle: boolean };
export async function getIssuanceSettings(db: DB, actorId: string, companyId: string): Promise<IssuanceSettings> {
  await requirePerm(db, actorId, companyId, "issuance.read");
  return load(db, companyId);
}
async function load(x: DB, companyId: string): Promise<IssuanceSettings> {
  const [r] = await x.select().from(issuanceSettings).where(eq(issuanceSettings.companyId, companyId));
  return r ? { paused: r.paused, dailyLimit: r.dailyLimit, boletoProvider: isBoletoMode(r.boletoProvider) ? r.boletoProvider : "simulado", autoSettle: r.autoSettle } : { paused: true, dailyLimit: 20, boletoProvider: "simulado", autoSettle: false };
}
/** `boletoProvider` ausente = mantém o atual (formulários antigos e chamadas existentes não mudam o provedor sem querer). */
export async function saveIssuanceSettings(db: DB, actorId: string, companyId: string, i: { paused: boolean; dailyLimit: unknown; boletoProvider?: unknown; autoSettle?: boolean }) {
  await requirePerm(db, actorId, companyId, "issuance.manage"); // `autoSettle` ausente = mantém o atual (formulários antigos não ligam nem desligam a baixa sem querer)
  const n = Number(i.dailyLimit);
  if (!Number.isInteger(n) || n < 1 || n > 500) throw new Invalid("Limite diário: valor entre 1 e 500");
  if (i.boletoProvider !== undefined && !(typeof i.boletoProvider === "string" && isBoletoMode(i.boletoProvider))) throw new Invalid("Provedor de boleto inválido");
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await lock(x, companyId);
    const prev = await load(x, companyId);
    const provider = (i.boletoProvider as BoletoProviderMode | undefined) ?? prev.boletoProvider;
    if (provider !== prev.boletoProvider && provider !== "simulado") { // TROCAR para o provedor real exige as travas ligadas AGORA (falha fechada)
      await resolveProvidersForMode(x, companyId, provider); // lança LiveNotAvailable se faltar chave ou credencial
    }
    if (provider !== prev.boletoProvider) {
      const [{ open }] = (await x.execute(sql`select count(*)::int open from issuance_requests where company_id = ${companyId} and kind = 'boleto' and status in ('pendente', 'enviando', 'desconhecido')`)) as unknown as { open: number }[];
      if (open > 0) throw new Invalid("Há boletos em andamento (aguardando, enviando ou a reconsultar). Conclua ou cancele-os antes de trocar o provedor");
    }
    const auto = i.autoSettle === undefined ? prev.autoSettle : i.autoSettle === true;
    if (auto && provider === "simulado") throw new Invalid("A baixa automática só vale com um provedor da Cora (testes ou produção)");
    await x.insert(issuanceSettings).values({ companyId, paused: i.paused === true, dailyLimit: n, boletoProvider: provider, autoSettle: auto, updatedBy: actorId })
      .onConflictDoUpdate({ target: issuanceSettings.companyId, set: { paused: i.paused === true, dailyLimit: n, boletoProvider: provider, autoSettle: auto, updatedBy: actorId, updatedAt: new Date() } });
    await audit(x, companyId, actorId, "issuance.settings.saved", { paused: i.paused === true, dailyLimit: n, boletoProvider: provider, autoSettle: auto, ...(provider !== prev.boletoProvider ? { providerChangedFrom: prev.boletoProvider } : {}) });
  });
}

/** Cobrança elegível: aprovada, em lote aprovado e ainda com saldo (quitada não precisa de boleto). */
const ELIGIBLE = (companyId: string) => sql`c.company_id = ${companyId} and c.status = 'aprovada' and b.status = 'aprovado'
  and coalesce((select sum(p.amount) from payments p where p.company_id = c.company_id and p.charge_id = c.id and p.status = 'ativo'), 0) < c.amount`;

/** Chave de idempotência por cobrança+tipo. Depois que um boleto já EMITIDO foi cancelado, a próxima emissão usa uma chave nova (geração), senão o provedor devolveria o boleto cancelado. */
async function keyFor(x: DB, companyId: string, chargeId: string, kind: string): Promise<string> {
  const [{ n }] = (await x.execute(sql`select count(*)::int n from issuance_requests where company_id = ${companyId} and charge_id = ${chargeId} and kind = ${kind} and status = 'cancelado' and external_ref is not null`)) as unknown as { n: number }[];
  return n > 0 ? `${kind}:${chargeId}:g${n}` : `${kind}:${chargeId}`;
}

export async function requestIssuance(db: DB, actorId: string, companyId: string, chargeId: string, kind: string) {
  await requirePerm(db, actorId, companyId, "issuance.request");
  if (kind !== "boleto" && kind !== "nfse") throw new Invalid("Tipo de emissão inválido");
  if (!uuidOk(chargeId)) throw new Invalid("Cobrança não encontrada");
  return db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await lock(x, companyId);
    const [ok] = (await x.execute(sql`select c.id from charges c join billing_batches b on b.company_id = c.company_id and b.id = c.batch_id where c.id = ${chargeId} and ${ELIGIBLE(companyId)}`)) as unknown as Row[];
    if (!ok) throw new Invalid("Cobrança não encontrada, não aprovada ou já quitada");
    const [dup] = await x.select({ id: issuanceRequests.id }).from(issuanceRequests).where(and(eq(issuanceRequests.companyId, companyId), eq(issuanceRequests.chargeId, chargeId), eq(issuanceRequests.kind, kind), sql`${issuanceRequests.status} <> 'cancelado'`));
    if (dup) throw new Invalid(`Já existe uma solicitação de ${KIND_LABEL[kind]} para esta cobrança`);
    const [r] = await x.insert(issuanceRequests).values({ companyId, chargeId, kind, idempotencyKey: await keyFor(x, companyId, chargeId, kind), requestedBy: actorId }).returning({ id: issuanceRequests.id });
    await audit(x, companyId, actorId, "issuance.requested", { requestId: r.id, chargeId, kind });
    return r.id;
  });
}

/** Solicita para todas as cobranças elegíveis do lote aprovado que ainda não têm solicitação. */
export async function requestBatchIssuance(db: DB, actorId: string, companyId: string, batchId: string, kind: string) {
  await requirePerm(db, actorId, companyId, "issuance.request");
  if (kind !== "boleto" && kind !== "nfse") throw new Invalid("Tipo de emissão inválido");
  if (!uuidOk(batchId)) throw new Invalid("Lote não encontrado");
  return db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await lock(x, companyId);
    const [b] = await x.select({ s: billingBatches.status }).from(billingBatches).where(and(eq(billingBatches.id, batchId), eq(billingBatches.companyId, companyId)));
    if (!b || b.s !== "aprovado") throw new Invalid("Só lotes aprovados podem ter emissão solicitada");
    const rows = (await x.execute(sql`select c.id from charges c join billing_batches b on b.company_id = c.company_id and b.id = c.batch_id
      where c.batch_id = ${batchId} and ${ELIGIBLE(companyId)}
        and not exists (select 1 from issuance_requests r where r.company_id = c.company_id and r.charge_id = c.id and r.kind = ${kind} and r.status <> 'cancelado')`)) as unknown as Row[];
    for (const r of rows) await x.insert(issuanceRequests).values({ companyId, chargeId: String(r.id), kind, idempotencyKey: await keyFor(x, companyId, String(r.id), kind), requestedBy: actorId });
    await audit(x, companyId, actorId, "issuance.batch_requested", { batchId, kind, created: rows.length });
    return { created: rows.length };
  });
}

export async function cancelIssuance(db: DB, actorId: string, companyId: string, requestId: string) {
  await requirePerm(db, actorId, companyId, "issuance.request");
  if (!uuidOk(requestId)) throw new Invalid("Solicitação não encontrada");
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    const res = await x.update(issuanceRequests).set({ status: "cancelado", updatedAt: new Date() })
      .where(and(eq(issuanceRequests.id, requestId), eq(issuanceRequests.companyId, companyId), eq(issuanceRequests.status, "pendente"))).returning({ id: issuanceRequests.id });
    if (res.length === 0) throw new Invalid("Só é possível cancelar uma solicitação que ainda não foi enviada");
    await audit(x, companyId, actorId, "issuance.cancelled", { requestId });
  });
}

export type RunResult = { claimed: number; issued: number; processing: number; unknown: number; retry: number; failed: number; skipped: number; recovered: number; waiting?: string };

/**
 * Uma rodada do motor. Manual (o agendador de emissão só será ligado no gate real). Respeita pausa e limite diário, e recusa com chave real ligada.
 */
export async function processIssuance(db: DB, actorId: string, companyId: string, now = new Date(), providers?: Providers): Promise<RunResult> {
  await requirePerm(db, actorId, companyId, "issuance.run");
  const out: RunResult = { claimed: 0, issued: 0, processing: 0, unknown: 0, retry: 0, failed: 0, skipped: 0, recovered: 0 };
  const prov = resolveProviders(providers); // falha FECHADA antes de reservar qualquer coisa
  // E10b-1: provedores por MODO de boleto (simulado = o de cima; cora_homologacao = adaptador da Cora de testes). Um modo real só entra se TODAS as travas estiverem ligadas.
  const byMode = new Map<string, Providers>([["simulado", prov]]);
  let liveError: unknown = null;
  const wanted = (await load(db, companyId)).boletoProvider;
  const rowModes = (await db.execute(sql`select distinct mode from issuance_requests where company_id = ${companyId} and kind = 'boleto' and status in ('pendente', 'enviando', 'desconhecido', 'emitido')`)) as unknown as { mode: string }[];
  for (const m of new Set([wanted, ...rowModes.map((r) => r.mode)])) {
    if (byMode.has(m)) continue;
    try { byMode.set(m, await resolveProvidersForMode(db, companyId, m)); } catch (e) { if (m === wanted) liveError = e; } // modo de linhas antigas indisponível: essas linhas ficam paradas, não bloqueiam as demais
  }

  // 1) RESERVAR (transação curta)
  const claimed = await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await lock(x, companyId);
    const st = await load(x, companyId);
    if (st.paused) { out.waiting = "Emissão pausada"; return []; }
    // O provedor foi resolvido ANTES desta transação. Se a configuração mudou nesse intervalo, o modo que seria gravado não bate com o provedor em mãos: não reserva nada, a próxima rodada recomeça.
    if (st.boletoProvider !== wanted) { out.waiting = "O provedor de boleto foi alterado durante a rodada. Processe de novo"; return []; }
    if (liveError) throw liveError; // o provedor escolhido para a empresa está indisponível (chave desligada ou sem credencial): falha fechada, nada é reservado
    if (!byMode.has(st.boletoProvider)) throw new LiveNotAvailable([st.boletoProvider], "Provedor de boleto indisponível. Nada será emitido.");
    const modes = [...byMode.keys()];
    // travadas em "enviando" (processo caiu no meio): resultado desconhecido → reconsulta antes de qualquer nova emissão
    const stuck = await x.update(issuanceRequests).set({ status: "desconhecido", nextAttemptAt: now, updatedAt: now })
      .where(and(eq(issuanceRequests.companyId, companyId), eq(issuanceRequests.status, "enviando"), sql`${issuanceRequests.claimedAt} < ${new Date(now.getTime() - STUCK_MS).toISOString()}::timestamptz`)).returning({ id: issuanceRequests.id });
    out.recovered = stuck.length;
    const today = localParts(now).date;
    const [{ n }] = (await x.execute(sql`select count(*)::int n from issuance_requests where company_id = ${companyId} and claimed_at is not null and (claimed_at at time zone 'America/Manaus')::date = ${today}::date and attempts > 0`)) as unknown as { n: number }[];
    const budget = Math.max(0, st.dailyLimit - Number(n));
    // consultas de status (NFS-e "processando") não gastam o limite de emissão
    const poll = await x.select().from(issuanceRequests).where(and(eq(issuanceRequests.companyId, companyId), eq(issuanceRequests.status, "processando"), eq(issuanceRequests.kind, "nfse"))).limit(50);
    const due = budget === 0 ? [] : await x.select().from(issuanceRequests)
      .where(and(eq(issuanceRequests.companyId, companyId), inArray(issuanceRequests.status, ["pendente", "desconhecido"]), inArray(issuanceRequests.mode, modes), sql`${issuanceRequests.nextAttemptAt} <= ${now.toISOString()}::timestamptz`))
      .orderBy(asc(issuanceRequests.nextAttemptAt), asc(issuanceRequests.createdAt)).limit(Math.min(budget, 20)).for("update", { skipLocked: true });
    if (budget === 0) out.waiting = "Limite diário de emissões atingido";
    // O modo do boleto é fixado na PRIMEIRA reserva (a partir da configuração da empresa) e nunca muda: reconsulta e cancelamento falam sempre com o provedor que emitiu.
    for (const r of due) {
      const mode = r.kind === "boleto" && r.status === "pendente" ? st.boletoProvider : r.mode;
      await x.update(issuanceRequests).set({ status: "enviando", claimedAt: now, attempts: r.attempts + 1, mode, updatedAt: now }).where(eq(issuanceRequests.id, r.id));
      r.mode = mode;
    }
    return [...poll.map((r) => ({ r, mode: "poll" as const })), ...due.map((r) => ({ r: { ...r, attempts: r.attempts + 1 }, mode: (r.status === "desconhecido" ? "recheck" : "issue") as "recheck" | "issue" }))];
  });
  out.claimed = claimed.filter((c) => c.mode !== "poll").length;

  // 2) CHAMAR o provedor FORA de transação, 3) REGISTRAR cada resultado em transação curta
  for (const { r, mode } of claimed) {
    const record = (set: Partial<typeof issuanceRequests.$inferInsert>, from: string[]) => db.update(issuanceRequests).set({ ...set, updatedAt: new Date() })
      .where(and(eq(issuanceRequests.id, r.id), eq(issuanceRequests.companyId, companyId), inArray(issuanceRequests.status, from))).returning({ id: issuanceRequests.id });
    try {
      if (mode === "poll") {
        const s = await prov.nfse.status(r.externalRef!);
        if (s === "emitida") { await record({ status: "emitido", externalStatus: s }, ["processando"]); out.issued++; }
        else if (s === "rejeitada") { await record({ status: "falhou", externalStatus: s, lastError: "nfse_rejeitada" }, ["processando"]); out.failed++; }
        continue;
      }
      const bp = byMode.get(r.mode) ?? prov; // linhas só chegam aqui com modo disponível (filtrado na reserva)
      const [d] = (await db.execute(sql`select c.amount::text, c.due_date::text, c.competence_month::text, c.description, c.status cs, cu.legal_name, cu.document, cu.nf_text, cu.boleto_text, cu.cep, cu.street, cu.street_number, cu.complement, cu.district, cu.city_name, cu.city_ibge, cu.uf, c.issue_date::text issue_date, (select name from companies where id = c.company_id) company_name, coalesce((select sum(p.amount) from payments p where p.company_id = c.company_id and p.charge_id = c.id and p.status = 'ativo'), 0) >= c.amount settled
        from charges c join customers cu on cu.company_id = c.company_id and cu.id = c.customer_id where c.company_id = ${companyId} and c.id = ${r.chargeId}`)) as unknown as Row[];
      if (!d || d.cs !== "aprovada" || d.settled) { await record({ status: "cancelado", lastError: "cobranca_indisponivel" }, ["enviando"]); out.skipped++; continue; } // quitou/cancelou entre a solicitação e o envio
      // reconsulta ANTES de reemitir (resposta anterior se perdeu)
      if (mode === "recheck") {
        const found = r.kind === "boleto" ? await bp.boleto.find(r.idempotencyKey, { customerDocument: String(d.document ?? ""), dueDate: String(d.due_date) }) : await prov.nfse.find(r.idempotencyKey);
        if (found) {
          const fin = r.kind === "nfse" && (found as { status: string }).status === "processando" ? "processando" : "emitido";
          await record({ status: fin, externalRef: found.providerRef, externalStatus: (found as { status: string }).status, lastError: null }, ["enviando"]);
          if (fin === "emitido") out.issued++; else out.processing++;
          continue;
        }
      }
      const cents = centsFromNumeric(String(d.amount));
      // E26: texto da nota e do boleto deste cliente (campos {{…}} preenchidos); sem texto, vale a descrição do contrato
      const texts = issuanceTexts({ nfText: d.nf_text == null ? null : String(d.nf_text), boletoText: d.boleto_text == null ? null : String(d.boleto_text), contractDescription: String(d.description), customerName: String(d.legal_name), companyName: String(d.company_name), amountCents: cents, dueDate: String(d.due_date), competenceMonth: String(d.competence_month), issueDate: String(d.issue_date) });
      if (r.kind === "boleto") {
        const res = await bp.boleto.issue({ idempotencyKey: r.idempotencyKey, amountCents: cents, dueDate: String(d.due_date), customerName: String(d.legal_name), customerDocument: String(d.document ?? ""), instructions: texts.boletoInstructions });
        await record({ status: "emitido", externalRef: res.providerRef, externalStatus: res.status, lastError: null }, ["enviando"]); out.issued++;
      } else {
        const s = (k: string) => (d[k] == null ? null : String(d[k]));
        const res = await prov.nfse.issue({ idempotencyKey: r.idempotencyKey, amountCents: cents, competence: String(d.competence_month).slice(0, 7), customerName: String(d.legal_name), customerDocument: String(d.document ?? ""), description: texts.nfDescription,
          customerAddress: { cep: s("cep"), street: s("street"), number: s("street_number"), complement: s("complement"), district: s("district"), city: s("city_name"), cityIbge: s("city_ibge"), uf: s("uf") } });
        const fin = res.status === "emitida" ? "emitido" : res.status === "processando" ? "processando" : "falhou";
        await record({ status: fin, externalRef: res.providerRef, externalStatus: res.status, lastError: fin === "falhou" ? "nfse_rejeitada" : null }, ["enviando"]);
        if (fin === "emitido") out.issued++; else if (fin === "processando") out.processing++; else out.failed++;
      }
    } catch (e) {
      const name = (e as Error).name;
      if (e instanceof RangeError) { // validação do provedor: não adianta repetir
        await record({ status: "falhou", lastError: safeCode((e as Error).message) }, ["enviando"]); out.failed++;
      } else if (name === "IssuanceRetryable") { // nada foi criado: repetir com backoff
        if (r.attempts >= MAX_ATTEMPTS) { await record({ status: "falhou", lastError: "tentativas_esgotadas" }, ["enviando"]); out.failed++; }
        else { await record({ status: "pendente", nextAttemptAt: new Date(now.getTime() + backoff(r.attempts)), lastError: "retryable" }, ["enviando"]); out.retry++; }
      } else if (r.attempts >= MAX_ATTEMPTS) { // continua sem resposta conclusiva: um humano confere no provedor
        await record({ status: "falhou", lastError: "resultado_desconhecido_revisar" }, ["enviando"]); out.failed++;
      } else { // qualquer outro erro (timeout, conexão caída, erro inesperado): PODE ter emitido → reconsultar, nunca reemitir às cegas
        await record({ status: "desconhecido", nextAttemptAt: new Date(now.getTime() + UNKNOWN_RETRY_MS), lastError: name === "IssuanceTimeout" ? "timeout" : "erro_desconhecido" }, ["enviando"]); out.unknown++;
      }
    }
  }
  if (out.claimed + out.issued + out.failed + out.recovered > 0) await audit(db, companyId, actorId, "issuance.run", { boletoProvider: wanted, claimed: out.claimed, issued: out.issued, processing: out.processing, unknown: out.unknown, retry: out.retry, failed: out.failed, skipped: out.skipped, recovered: out.recovered });
  return out;
}

export async function listIssuance(db: DB, actorId: string, companyId: string, status?: string) {
  await requirePerm(db, actorId, companyId, "issuance.read");
  const filter = status && Object.keys(STATUS_LABEL).includes(status) ? status : null;
  const rows = (await db.execute(sql`select r.id, r.kind, r.mode, r.status, r.attempts, r.external_ref, r.external_status, r.last_error, r.next_attempt_at, r.created_at, r.charge_id, cu.display_name, c.amount::text, c.due_date::text
    from issuance_requests r join charges c on c.company_id = r.company_id and c.id = r.charge_id join customers cu on cu.company_id = c.company_id and cu.id = c.customer_id
    where r.company_id = ${companyId} ${filter ? sql`and r.status = ${filter}` : sql``} order by r.created_at desc, r.id limit 300`)) as unknown as Row[];
  const counts = (await db.execute(sql`select status, count(*)::int n from issuance_requests where company_id = ${companyId} group by status`)) as unknown as { status: string; n: number }[];
  return {
    items: rows.map((r) => ({ id: String(r.id), kind: r.kind as Kind, mode: String(r.mode), status: String(r.status), attempts: Number(r.attempts), externalRef: (r.external_ref as string | null) ?? null, externalStatus: (r.external_status as string | null) ?? null, lastError: (r.last_error as string | null) ?? null, nextAttemptAt: new Date(String(r.next_attempt_at)), chargeId: String(r.charge_id), customerName: String(r.display_name), amountCents: centsFromNumeric(String(r.amount)), dueDate: String(r.due_date) })),
    counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) as Record<string, number>,
  };
}
