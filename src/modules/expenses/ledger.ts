import { and, eq, sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { auditLog, expenseCategories, partnerEntries, partners, payables } from "@/lib/db/schema";
import { toCsv } from "@/lib/csv";
import { isIsoDate } from "@/lib/iso-date";
import { centsFromNumeric, centsFromSignedNumeric, numericFromCents, parseMoneyToCents } from "@/lib/money";
import { Invalid, requirePerm } from "@/modules/identity/service";
import { todayManaus } from "@/modules/messaging/service";
import { ensureExpenseDefaults } from "./catalog";

/**
 * D1 — conta-corrente dos sócios com a empresa. É REGISTRO (não paga nada).
 * Saldo = soma com sinal dos lançamentos ATIVOS. Positivo: a empresa deve ao sócio. Negativo: o sócio deve à empresa (retiradas a compensar na distribuição de lucros).
 * Nada se apaga: erro se corrige estornando (com motivo) e lançando de novo.
 */
export const ENTRY_KINDS = {
  retirada: { label: "Retirada (gasto pessoal pago pela empresa)", sign: -1, category: "pessoal" },
  despesa_paga_pelo_socio: { label: "Despesa da empresa paga pelo sócio", sign: 1, category: "empresa" },
  devolucao_do_socio: { label: "Devolução do sócio à empresa", sign: 1, category: null },
  reembolso_ao_socio: { label: "Reembolso da empresa ao sócio", sign: -1, category: null },
  compensacao_lucros: { label: "Compensação na distribuição de lucros", sign: 1, category: null },
} as const;
export type EntryKind = keyof typeof ENTRY_KINDS;
export const isKind = (k: string): k is EntryKind => Object.prototype.hasOwnProperty.call(ENTRY_KINDS, k);

const audit = (x: DB, companyId: string, actorId: string, action: string, detail: Record<string, unknown>) => x.insert(auditLog).values({ companyId, actorId, action, detail });
const uuidOk = (s: string) => /^[0-9a-f-]{36}$/i.test(s ?? "");
type Row = Record<string, unknown>;
const rows = (r: unknown) => r as Row[];
const clean = (s: unknown, max: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export type EntryInput = { partnerId: string; kind: string; amount: string; occurredOn: string; categoryId?: string; description: string; payableId?: string; requestKey?: string };

export async function createEntry(db: DB, actorId: string, companyId: string, i: EntryInput, today = todayManaus()) {
  await requirePerm(db, actorId, companyId, "partners.manage");
  if (!isKind(i.kind ?? "")) throw new Invalid("Escolha o tipo de lançamento");
  const kind = i.kind as EntryKind;
  if (!uuidOk(i.partnerId)) throw new Invalid("Escolha o sócio");
  const cents = parseMoneyToCents(i.amount ?? "");
  if (cents === null || cents <= 0) throw new Invalid("Informe um valor válido, maior que zero");
  const valueCents: number = cents;
  if (!isIsoDate(i.occurredOn ?? "")) throw new Invalid("Data inválida");
  if (i.occurredOn > today) throw new Invalid("A data não pode ser futura");
  const description = clean(i.description, 200);
  if (description.length < 2) throw new Invalid("Descreva o lançamento (2 a 200 caracteres)");
  const requestKey = clean(i.requestKey, 80) || null;
  try { return await insertEntry(); } catch (e) {
    // reenvio concorrente do mesmo formulário: o índice único barra o segundo; devolve o lançamento que já existe
    const c = (e as { cause?: { code?: string; constraint_name?: string } }).cause;
    if (requestKey && c?.code === "23505" && c.constraint_name === "partner_entries_request_key_uq") {
      const [dup] = await db.select({ id: partnerEntries.id }).from(partnerEntries).where(and(eq(partnerEntries.companyId, companyId), eq(partnerEntries.requestKey, requestKey)));
      if (dup) return { id: dup.id, duplicate: true };
    }
    throw e;
  }
  function insertEntry() { return db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await ensureExpenseDefaults(x, companyId);
    const [p] = await x.select({ active: partners.active }).from(partners).where(and(eq(partners.id, i.partnerId), eq(partners.companyId, companyId)));
    if (!p) throw new Invalid("Sócio não encontrado");
    if (!p.active) throw new Invalid("Sócio inativo: reative o cadastro antes de lançar");
    const want = ENTRY_KINDS[kind].category;
    let categoryId: string | null = null;
    if (want) {
      let c;
      if (i.categoryId) {
        if (!uuidOk(i.categoryId)) throw new Invalid("Categoria não encontrada");
        [c] = await x.select().from(expenseCategories).where(and(eq(expenseCategories.id, i.categoryId), eq(expenseCategories.companyId, companyId)));
        if (!c || !c.active) throw new Invalid("Categoria não encontrada ou inativa");
        if (c.kind !== want) throw new Invalid(want === "pessoal" ? "Para retirada, escolha uma categoria de gasto pessoal" : "Para despesa da empresa, escolha uma categoria da empresa");
      } else {
        [c] = await x.select().from(expenseCategories).where(and(eq(expenseCategories.companyId, companyId), eq(expenseCategories.code, want === "pessoal" ? "a_classificar_pessoal" : "a_classificar")));
      }
      categoryId = c?.id ?? null;
    }
    let payableId: string | null = null;
    if (i.payableId) {
      if (kind !== "despesa_paga_pelo_socio") throw new Invalid("Só a despesa paga pelo sócio pode apontar para uma conta a pagar");
      if (!uuidOk(i.payableId)) throw new Invalid("Conta a pagar não encontrada");
      const [pb] = await x.select({ id: payables.id }).from(payables).where(and(eq(payables.id, i.payableId), eq(payables.companyId, companyId)));
      if (!pb) throw new Invalid("Conta a pagar não encontrada");
      payableId = pb.id;
    }
    if (requestKey) { // reenvio do mesmo formulário não duplica
      const [dup] = await x.select({ id: partnerEntries.id }).from(partnerEntries).where(and(eq(partnerEntries.companyId, companyId), eq(partnerEntries.requestKey, requestKey)));
      if (dup) return { id: dup.id, duplicate: true };
    }
    const [e] = await x.insert(partnerEntries).values({ companyId, partnerId: i.partnerId, kind, amount: numericFromCents(valueCents), occurredOn: i.occurredOn, categoryId, description, payableId, requestKey, createdBy: actorId }).returning({ id: partnerEntries.id });
    await audit(x, companyId, actorId, "partner.entry_created", { entryId: e.id, partnerId: i.partnerId, kind });
    return { id: e.id, duplicate: false };
  }); }
}

export async function reverseEntry(db: DB, actorId: string, companyId: string, id: string, reason: string) {
  await requirePerm(db, actorId, companyId, "partners.manage");
  const why = clean(reason, 200);
  if (why.length < 3) throw new Invalid("Informe o motivo do estorno");
  if (!uuidOk(id)) throw new Invalid("Lançamento não encontrado");
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    const [e] = await x.select().from(partnerEntries).where(and(eq(partnerEntries.id, id), eq(partnerEntries.companyId, companyId))).for("update");
    if (!e) throw new Invalid("Lançamento não encontrado");
    if (e.status === "estornado") throw new Invalid("Lançamento já estornado");
    const done = await x.update(partnerEntries).set({ status: "estornado", reversedBy: actorId, reversedAt: new Date(), reverseReason: why, updatedAt: new Date() })
      .where(and(eq(partnerEntries.id, id), eq(partnerEntries.companyId, companyId), eq(partnerEntries.status, "ativo"))).returning({ id: partnerEntries.id });
    if (done.length !== 1) throw new Invalid("Lançamento já estornado");
    await audit(x, companyId, actorId, "partner.entry_reversed", { entryId: id, partnerId: e.partnerId });
  });
}

export type EntryRow = { id: string; partnerId: string; partnerName: string; kind: EntryKind; kindLabel: string; occurredOn: string; amountCents: number; signedCents: number; categoryId: string | null; categoryName: string | null; description: string; status: string; reverseReason: string | null; toClassify: boolean };
export type EntryFilters = { partnerId?: string; month?: string; status?: string };
export async function listEntries(db: DB, actorId: string, companyId: string, f: EntryFilters = {}): Promise<EntryRow[]> {
  await requirePerm(db, actorId, companyId, "partners.read");
  const w = [sql`e.company_id = ${companyId}`];
  if (f.partnerId && uuidOk(f.partnerId)) w.push(sql`e.partner_id = ${f.partnerId}`);
  if (f.month && /^\d{4}-(0[1-9]|1[0-2])$/.test(f.month)) w.push(sql`e.occurred_on >= ${f.month + "-01"}::date and e.occurred_on < (${f.month + "-01"}::date + interval '1 month')`);
  if (f.status === "ativo" || f.status === "estornado") w.push(sql`e.status = ${f.status}`);
  const r = rows(await db.execute(sql`select e.id, e.partner_id, p.name partner_name, e.kind, e.occurred_on::text, e.amount::text, e.category_id, c.name category_name, c.code category_code, e.description, e.status, e.reverse_reason
    from partner_entries e join partners p on p.company_id = e.company_id and p.id = e.partner_id left join expense_categories c on c.company_id = e.company_id and c.id = e.category_id
    where ${sql.join(w, sql` and `)} order by e.occurred_on desc, e.created_at desc, e.id limit 500`));
  return r.map((x) => {
    const kind = String(x.kind) as EntryKind, cents = centsFromNumeric(String(x.amount));
    return { id: String(x.id), partnerId: String(x.partner_id), partnerName: String(x.partner_name), kind, kindLabel: ENTRY_KINDS[kind].label, occurredOn: String(x.occurred_on), amountCents: cents, signedCents: ENTRY_KINDS[kind].sign * cents, categoryId: (x.category_id as string | null) ?? null, categoryName: (x.category_name as string | null) ?? null, description: String(x.description), status: String(x.status), reverseReason: (x.reverse_reason as string | null) ?? null, toClassify: String(x.category_code ?? "").startsWith("a_classificar") };
  });
}

export type Balance = { partnerId: string; name: string; active: boolean; balanceCents: number; withdrawnYearCents: number; withdrawnMonthCents: number; toClassifyCount: number; toClassifyCents: number };
export async function partnerBalances(db: DB, actorId: string, companyId: string, today = todayManaus()): Promise<Balance[]> {
  await requirePerm(db, actorId, companyId, "partners.read");
  const ym = today.slice(0, 7), y = today.slice(0, 4);
  const r = rows(await db.execute(sql`select p.id, p.name, p.active,
      coalesce(sum(case e.kind when 'retirada' then -e.amount when 'reembolso_ao_socio' then -e.amount else e.amount end) filter (where e.status = 'ativo'), 0)::text balance,
      coalesce(sum(e.amount) filter (where e.status = 'ativo' and e.kind = 'retirada' and e.occurred_on >= ${y + "-01-01"}::date and e.occurred_on < (${y + "-01-01"}::date + interval '1 year')), 0)::text year_w,
      coalesce(sum(e.amount) filter (where e.status = 'ativo' and e.kind = 'retirada' and e.occurred_on >= ${ym + "-01"}::date and e.occurred_on < (${ym + "-01"}::date + interval '1 month')), 0)::text month_w,
      count(*) filter (where e.status = 'ativo' and c.code like 'a\_classificar%')::int tc_n,
      coalesce(sum(e.amount) filter (where e.status = 'ativo' and c.code like 'a\_classificar%'), 0)::text tc_c
    from partners p left join partner_entries e on e.company_id = p.company_id and e.partner_id = p.id left join expense_categories c on c.company_id = e.company_id and c.id = e.category_id
    where p.company_id = ${companyId} group by p.id, p.name, p.active order by p.name`));
  return r.map((x) => ({ partnerId: String(x.id), name: String(x.name), active: Boolean(x.active), balanceCents: centsFromSignedNumeric(String(x.balance)), withdrawnYearCents: centsFromNumeric(String(x.year_w)), withdrawnMonthCents: centsFromNumeric(String(x.month_w)), toClassifyCount: Number(x.tc_n), toClassifyCents: centsFromNumeric(String(x.tc_c)) }));
}

export async function exportEntries(db: DB, actorId: string, companyId: string, f: EntryFilters = {}) {
  await requirePerm(db, actorId, companyId, "partners.read");
  const items = await listEntries(db, actorId, companyId, f);
  await audit(db, companyId, actorId, "partner.exported", { count: items.length });
  return toCsv([["data", "socio", "tipo", "categoria", "descricao", "valor", "efeito_no_saldo", "situacao"],
    ...items.map((e) => [e.occurredOn, e.partnerName, e.kindLabel, e.categoryName ?? "", e.description, (e.amountCents / 100).toFixed(2).replace(".", ","), (e.signedCents / 100).toFixed(2).replace(".", ","), e.status])]);
}
