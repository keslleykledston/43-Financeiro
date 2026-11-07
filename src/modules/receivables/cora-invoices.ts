import { and, eq, inArray, sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { auditLog, coraInvoices, customers, issuanceRequests } from "@/lib/db/schema";
import { Invalid, requirePerm } from "@/modules/identity/service";
import { CoraHttpError, coraClientFor, docOf, type Invoice, type Transport } from "@/modules/providers/cora-http";
import { isIsoDate } from "@/lib/iso-date";
import { todayManaus } from "@/modules/messaging/service";

/**
 * F1b — boletos que existem NA CORA (de 01/01/2026 em diante, em qualquer situação, atrasados inclusive), trazidos só para LEITURA e acompanhamento.
 * É um espelho: não vira cobrança, não entra em lote, não emite nada e NÃO alimenta a fila de mensagens (nenhum aviso sai a partir daqui).
 * O cliente de cada boleto vem do FILTRO POR CPF/CNPJ da própria Cora (a listagem não traz o cliente): só entra boleto de cliente cadastrado, pelo documento.
 * Cobrança automática dos atrasados: chave POR CLIENTE (`customers.overdue_collection`), desligada; a diretoria liga um a um (fase seguinte usa a chave).
 */
export const SINCE_DEFAULT = "2026-01-01";
export const OPEN_STATES = ["OPEN", "LATE", "IN_PAYMENT", "DRAFT"] as const;
const KNOWN = ["OPEN", "LATE", "IN_PAYMENT", "DRAFT", "PAID", "CANCELLED"] as const;
const ENV = "producao" as const;
const audit = (x: DB, companyId: string, actorId: string | null, action: string, detail: Record<string, unknown>) => x.insert(auditLog).values({ companyId, actorId, action, detail });
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Deps = { transport?: Transport; sleep?: (ms: number) => Promise<void>; now?: Date };
/** A Cora limita pedidos (429): espera e tenta de novo, com teto. Qualquer outro erro sobe. */
async function retry<T>(f: () => Promise<T>, sleep: (ms: number) => Promise<void>): Promise<T> {
  for (let t = 0; ; t++) {
    try { return await f(); } catch (e) { if (e instanceof CoraHttpError && e.status === 429 && t < 6) { await sleep(20_000); continue; } throw e; }
  }
}
const clientOrFail = async (db: DB, companyId: string, transport?: Transport) => {
  try { return await coraClientFor(db, companyId, ENV, transport); } catch { throw new Invalid("Cadastre antes as credenciais da Cora de produção (Integrações)"); }
};
const asStatus = (s: string) => ((KNOWN as readonly string[]).includes(s) ? s : null);

export type ImportResult = { customers: number; fetched: number; inserted: number; updated: number; linked: number; unknownStatus: number; failedCustomers: number; docMismatch: number; ambiguousCustomers: number; incomplete: number };
/** A busca por documento da Cora só responde quando vêm início E fim (só o início devolve vazio): o fim é folgado. */
const rangeEnd = (now: Date) => `${now.getUTCFullYear() + 2}-12-31`;
const PAGE = 200, MAX_PAGES = 60;

/** Importação COMPLETA (por cliente, pelo documento). Idempotente (upsert atômico): rodar de novo só atualiza. Demora (um pedido por cliente): roda por script/agendador, não por clique. */
export async function importCoraInvoices(db: DB, actorId: string | null, companyId: string, o: Deps & { since?: string } = {}): Promise<ImportResult> {
  if (actorId) await requirePerm(db, actorId, companyId, "issuance.run");
  const since = o.since ?? SINCE_DEFAULT;
  if (!isIsoDate(since) || since < "2020-01-01") throw new Invalid("Data inicial inválida");
  const sleep = o.sleep ?? wait, now = o.now ?? new Date(), end = rangeEnd(now);
  const cli = await clientOrFail(db, companyId, o.transport);
  const people = await db.select({ id: customers.id, document: customers.document }).from(customers).where(and(eq(customers.companyId, companyId), sql`${customers.archivedAt} is null`));
  const byDoc = new Map<string, string[]>();
  for (const p of people) { const d = docOf(p.document ?? ""); if (d.length === 11 || d.length === 14) byDoc.set(d, [...(byDoc.get(d) ?? []), p.id]); }
  const mine = new Map(((await db.select({ ref: issuanceRequests.externalRef, charge: issuanceRequests.chargeId }).from(issuanceRequests)
    .where(and(eq(issuanceRequests.companyId, companyId), eq(issuanceRequests.kind, "boleto"), eq(issuanceRequests.mode, "cora_producao"), sql`${issuanceRequests.externalRef} is not null`)))).map((r) => [r.ref!, r.charge]));
  const out: ImportResult = { customers: 0, fetched: 0, inserted: 0, updated: 0, linked: 0, unknownStatus: 0, failedCustomers: 0, docMismatch: 0, ambiguousCustomers: 0, incomplete: 0 };
  const known = new Set((await db.select({ id: coraInvoices.coraId }).from(coraInvoices).where(and(eq(coraInvoices.companyId, companyId), eq(coraInvoices.environment, ENV)))).map((r) => r.id));
  const detail = new Map<string, Invoice>();
  for (const [doc, ids] of byDoc) {
    detail.clear();
    if (ids.length !== 1) { out.ambiguousCustomers += ids.length; continue; } // dois cadastros ativos com o mesmo documento (formatos diferentes): não dá para saber de quem é o boleto
    const customerId = ids[0];
    out.customers++;
    const items: Invoice[] = [];
    try {
      let full = false;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const r = await retry(() => cli.listInvoices({ search: doc, start: since, end, page, perPage: PAGE }), sleep);
        items.push(...r.items);
        if (r.items.length < PAGE) { full = true; break; }
      }
      if (!full) { out.incomplete++; continue; } // mais páginas do que o teto: não grava pela metade
      // A listagem NÃO traz o documento do cliente: o DETALHE de cada boleto NOVO (ainda não espelhado) é consultado e o documento conferido. Qualquer ausência/divergência → NADA deste cliente entra.
      // Os já espelhados não são reconsultados (foram conferidos quando entraram). O detalhe também traz a data do pagamento dos pagos.
      const fresh = items.filter((i) => !known.has(i.id));
      let bad = false;
      for (const i of fresh) {
        const d = await retry(() => cli.getInvoice(i.id), sleep);
        if (d.customerDocument !== doc) { bad = true; break; }
        detail.set(i.id, d);
      }
      if (bad) { out.docMismatch++; continue; }
    } catch { out.failedCustomers++; continue; }
    // Um cliente por transação: ou entra inteiro ou não entra (nenhum espelho pela metade).
    try {
      await db.transaction(async (tx) => {
        const x = tx as unknown as DB;
        for (const i0 of items) {
          const i = detail.get(i0.id) ?? i0;
          out.fetched++;
          const st = asStatus(i.status);
          if (!st) { out.unknownStatus++; continue; }
          if (!i.dueDate || i.dueDate < since || !i.id) continue;
          const chargeId = mine.get(i.id) ?? null;
          if (chargeId) out.linked++;
          const paidOn = i.occurrenceDate ?? ((i.payments.find((p) => p.finalizedAt)?.finalizedAt ?? "").slice(0, 10) || null);
          const values = { companyId, environment: ENV, coraId: i.id, customerId, code: i.code, dueDate: i.dueDate, totalCents: i.totalAmountCents, paidCents: i.totalPaidCents, status: st, paidOn: paidOn && /^\d{4}-\d{2}-\d{2}$/.test(paidOn) ? paidOn : null, digitable: i.digitable, pdfUrl: i.pdfUrl, chargeId, syncedAt: now };
          const [row] = await x.insert(coraInvoices).values(values).onConflictDoUpdate({ target: [coraInvoices.companyId, coraInvoices.environment, coraInvoices.coraId],
            set: { code: values.code, dueDate: values.dueDate, totalCents: values.totalCents, paidCents: values.paidCents, status: values.status, paidOn: sql`coalesce(${values.paidOn}, ${coraInvoices.paidOn})`, digitable: values.digitable, pdfUrl: values.pdfUrl, chargeId: values.chargeId, syncedAt: now, updatedAt: new Date() } // o cliente (customerId) nunca muda no upsert
          }).returning({ created: sql<boolean>`(xmax = 0)` });
          if (row.created) out.inserted++; else out.updated++;
        }
      });
    } catch { out.failedCustomers++; }
  }
  await audit(db, companyId, actorId, "cora.invoices.imported", { since, ...out });
  return out;
}

export type RefreshResult = { held: number; updated: number; becamePaid: number; becameCancelled: number; failed: number };
/**
 * Atualização RÁPIDA dos boletos que ainda estão em aberto no espelho: lista a janela de vencimentos deles (poucas páginas) e, para os que sumiram da janela ou viraram pagos, consulta o boleto.
 * Boleto NOVO (de cliente desconhecido na listagem) só entra na importação completa diária.
 */
export async function refreshCoraInvoices(db: DB, actorId: string | null, companyId: string, o: Deps = {}): Promise<RefreshResult> {
  if (actorId) await requirePerm(db, actorId, companyId, "issuance.run");
  const sleep = o.sleep ?? wait;
  const held = await db.select().from(coraInvoices).where(and(eq(coraInvoices.companyId, companyId), eq(coraInvoices.environment, ENV), inArray(coraInvoices.status, [...OPEN_STATES])));
  const out: RefreshResult = { held: held.length, updated: 0, becamePaid: 0, becameCancelled: 0, failed: 0 };
  if (held.length === 0) return out;
  const cli = await clientOrFail(db, companyId, o.transport);
  const start = held.reduce((a, h) => (h.dueDate < a ? h.dueDate : a), held[0].dueDate);
  const seen = new Map<string, Invoice>();
  try {
    for (let page = 1; page <= 25; page++) {
      const r = await retry(() => cli.listInvoices({ start, end: rangeEnd(o.now ?? new Date()), page, perPage: 200 }), sleep);
      for (const i of r.items) seen.set(i.id, i);
      if (r.items.length < 200) break;
    }
  } catch { out.failed++; return out; }
  for (const h of held) {
    let inv = seen.get(h.coraId) ?? null;
    try {
      if (!inv || inv.status === "PAID") inv = await retry(() => cli.getInvoice(h.coraId), sleep); // sumiu da janela ou pagou: o detalhe traz a data do pagamento
    } catch { out.failed++; continue; }
    const st = asStatus(inv.status);
    if (!st) continue;
    const paidOn = inv.occurrenceDate ?? (inv.payments.find((p) => p.finalizedAt)?.finalizedAt ?? "").slice(0, 10);
    if (st === h.status && inv.totalPaidCents === h.paidCents) { await db.update(coraInvoices).set({ syncedAt: o.now ?? new Date() }).where(eq(coraInvoices.id, h.id)); continue; }
    await db.update(coraInvoices).set({ status: st, paidCents: inv.totalPaidCents, paidOn: /^\d{4}-\d{2}-\d{2}$/.test(paidOn) ? paidOn : h.paidOn, digitable: inv.digitable ?? h.digitable, pdfUrl: inv.pdfUrl ?? h.pdfUrl, syncedAt: o.now ?? new Date(), updatedAt: new Date() }).where(eq(coraInvoices.id, h.id));
    out.updated++;
    if (st === "PAID") out.becamePaid++;
    if (st === "CANCELLED") out.becameCancelled++;
  }
  if (out.updated > 0) await audit(db, companyId, actorId, "cora.invoices.refreshed", { ...out });
  return out;
}

/** Aviso (webhook) de um boleto que está no espelho: reconsulta SÓ esse. Devolve false se o boleto não é do espelho. */
export async function refreshOneCoraInvoice(db: DB, companyId: string, coraId: string, o: Deps = {}): Promise<boolean> {
  const [h] = await db.select().from(coraInvoices).where(and(eq(coraInvoices.companyId, companyId), eq(coraInvoices.environment, ENV), eq(coraInvoices.coraId, coraId)));
  if (!h) return false;
  const cli = await clientOrFail(db, companyId, o.transport);
  const inv = await retry(() => cli.getInvoice(coraId), o.sleep ?? wait);
  const st = asStatus(inv.status);
  if (!st) return true;
  const paidOn = inv.occurrenceDate ?? (inv.payments.find((p) => p.finalizedAt)?.finalizedAt ?? "").slice(0, 10);
  await db.update(coraInvoices).set({ status: st, paidCents: inv.totalPaidCents, paidOn: /^\d{4}-\d{2}-\d{2}$/.test(paidOn) ? paidOn : h.paidOn, syncedAt: o.now ?? new Date(), updatedAt: new Date() }).where(eq(coraInvoices.id, h.id));
  return true;
}

// ---------- Leitura para a tela ----------
export const VIEW_FILTERS = ["atrasados", "a_vencer", "pagos", "cancelados", "todos"] as const;
export type ViewFilter = (typeof VIEW_FILTERS)[number];
export const FILTER_LABEL: Record<ViewFilter, string> = { atrasados: "Em atraso", a_vencer: "A vencer", pagos: "Pagos", cancelados: "Cancelados", todos: "Todos" };
const IN: Record<ViewFilter, readonly string[]> = { atrasados: ["LATE"], a_vencer: ["OPEN", "IN_PAYMENT", "DRAFT"], pagos: ["PAID"], cancelados: ["CANCELLED"], todos: KNOWN };

export async function coraInvoicesView(db: DB, actorId: string, companyId: string, f: { filter?: string; q?: string } = {}, now = new Date()) {
  await requirePerm(db, actorId, companyId, "receivables.read");
  const filter: ViewFilter = (VIEW_FILTERS as readonly string[]).includes(f.filter ?? "") ? (f.filter as ViewFilter) : "atrasados";
  const q = (f.q ?? "").trim().toLowerCase();
  const totals = (await db.execute(sql`select status, count(*)::int n, coalesce(sum(total_cents),0)::bigint cents from cora_invoices where company_id = ${companyId} and environment = 'producao' group by status`)) as unknown as { status: string; n: number; cents: string }[];
  const t = Object.fromEntries(totals.map((r) => [r.status, { n: r.n, cents: Number(r.cents) }]));
  const sum = (ks: readonly string[]) => ks.reduce((a, k) => ({ n: a.n + (t[k]?.n ?? 0), cents: a.cents + (t[k]?.cents ?? 0) }), { n: 0, cents: 0 });
  const rows = (await db.execute(sql`select i.id, i.cora_id, i.code, i.due_date::text due_date, i.total_cents, i.paid_cents, i.status, i.paid_on::text paid_on, i.charge_id, i.synced_at,
      cu.id customer_id, cu.display_name, cu.overdue_collection
    from cora_invoices i join customers cu on cu.company_id = i.company_id and cu.id = i.customer_id
    where i.company_id = ${companyId} and i.environment = 'producao' and i.status in (${sql.join(IN[filter].map((s) => sql`${s}`), sql`, `)})
      ${q ? sql`and lower(cu.display_name) like ${"%" + q.replace(/[%_\\]/g, "") + "%"}` : sql``}
    order by cu.display_name, i.due_date limit 1500`)) as unknown as { id: string; cora_id: string; code: string | null; due_date: string; total_cents: number; paid_cents: number; status: string; paid_on: string | null; charge_id: string | null; synced_at: Date; customer_id: string; display_name: string; overdue_collection: boolean }[];
  const [last] = (await db.execute(sql`select max(synced_at) at from cora_invoices where company_id = ${companyId} and environment = 'producao'`)) as unknown as { at: Date | null }[];
  const today = todayManaus(), todayMs = new Date(`${today}T00:00:00Z`).getTime();
  return {
    filter, summary: { late: sum(["LATE"]), open: sum(["OPEN", "IN_PAYMENT", "DRAFT"]), paid: sum(["PAID"]), cancelled: sum(["CANCELLED"]) }, lastSyncAt: last?.at ?? null,
    rows: rows.map((r) => ({ ...r, daysLate: r.status === "LATE" ? Math.max(0, Math.round((todayMs - new Date(`${r.due_date}T00:00:00Z`).getTime()) / 86_400_000)) : 0 })),
    truncated: rows.length >= 1500, asOf: now,
  };
}

/** Chave POR CLIENTE da cobrança automática dos atrasados. Só a diretoria. Hoje apenas REGISTRA a escolha (nenhuma mensagem sai de boleto importado). */
export async function setOverdueCollection(db: DB, actorId: string, companyId: string, customerId: string, on: boolean) {
  await requirePerm(db, actorId, companyId, "issuance.manage");
  if (!/^[0-9a-f-]{36}$/i.test(customerId)) throw new Invalid("Cliente não encontrado");
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    const res = await x.update(customers).set({ overdueCollection: on, updatedAt: new Date() }).where(and(eq(customers.id, customerId), eq(customers.companyId, companyId))).returning({ id: customers.id });
    if (res.length === 0) throw new Invalid("Cliente não encontrado");
    await audit(x, companyId, actorId, "customer.overdue_collection", { customerId, on });
  });
}

