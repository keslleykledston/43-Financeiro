import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { auditLog, billingBatches, charges, customers } from "@/lib/db/schema";
import { isIsoDate } from "@/lib/iso-date";
import { centsFromNumeric, numericFromCents } from "@/lib/money";
import { Forbidden, Invalid, activeRole, requirePerm } from "@/modules/identity/service";
import { cancelQueueForCharges } from "@/modules/messaging/service";
import { loadScheduled, type CalendarItem } from "./service";

/**
 * E05 — lotes de cobrança: PRÉVIA idempotente + APROVAÇÃO humana. Nenhuma operação externa (boleto, NF, e-mail) acontece aqui.
 * Um lote = todas as cobranças previstas para uma data de emissão. A cobrança é um snapshot do contrato no momento da prévia;
 * aprovada, só muda reabrindo o lote (nova validação). Itens "precisa de revisão" (feriado/dia 31) ficam FORA do lote.
 */
export type BatchStatus = "rascunho" | "aprovado" | "cancelado";
type Row = typeof charges.$inferSelect;

const isoDate = isIsoDate;
const sigOf = (v: { dueDate: string; issueDate: string; cents: number; description: string; joint: boolean; warnings: readonly string[] }) => `${v.dueDate}|${v.issueDate}|${v.cents}|${v.description}|${v.joint ? 1 : 0}|${[...v.warnings].sort().join(",")}`;
const keyOf = (contractId: string, competenceMonth: string) => `${contractId}|${competenceMonth.slice(0, 7)}`;
const rowSig = (r: Row) => sigOf({ dueDate: r.dueDate, issueDate: r.issueDate, cents: centsFromNumeric(r.amount), description: r.description, joint: r.jointInvoice, warnings: r.warnings as string[] });
const itemSig = (i: CalendarItem) => sigOf({ dueDate: i.dueDate!, issueDate: i.issueDate!, cents: i.amountCents, description: i.description, joint: i.jointInvoice, warnings: i.warnings });

/** Hash do conteúdo do lote: o aprovador aprova exatamente o que viu. */
export const hashCharges = (rows: Row[]) => createHash("sha256").update(rows.map((r) => `${keyOf(r.contractId, r.competenceMonth)}|${rowSig(r)}`).sort().join("\n")).digest("hex");

async function eligible(x: DB, companyId: string, issueDate: string) {
  const { entries } = await loadScheduled(x, companyId, issueDate.slice(0, 7));
  const seen = new Set<string>(); const items: CalendarItem[] = []; const exceptions: CalendarItem[] = [];
  for (const { item } of entries) {
    if (item.issueDate !== issueDate || !item.dueDate) continue;
    const k = keyOf(item.contractId, item.competenceMonth);
    if (seen.has(k)) continue; seen.add(k);
    (item.review ? exceptions : items).push(item);
  }
  return { items, exceptions };
}

function diff(rows: Row[], items: CalendarItem[]) {
  const cur = new Map(rows.map((r) => [keyOf(r.contractId, r.competenceMonth), rowSig(r)]));
  const live = new Map(items.map((i) => [keyOf(i.contractId, i.competenceMonth), itemSig(i)]));
  let added = 0, removed = 0, changed = 0;
  for (const [k, s] of live) { if (!cur.has(k)) added++; else if (cur.get(k) !== s) changed++; }
  for (const k of cur.keys()) if (!live.has(k)) removed++;
  return { added, removed, changed, any: added + removed + changed > 0 };
}

/**
 * Aprovação atômica com a origem: enquanto o lote é recalculado e aprovado, contratos, clientes e feriados da empresa
 * não podem mudar (as escritas concorrentes esperam o commit). Sem isso, uma alteração entre o recálculo e o commit
 * aprovaria uma prévia já desatualizada.
 */
async function lockSources(x: DB, companyId: string) {
  await x.execute(sql`select 1 from contracts where company_id = ${companyId} for share`);
  await x.execute(sql`select 1 from customers where company_id = ${companyId} for share`);
  await x.execute(sql`lock table holidays in share mode`);
}
const lockCompany = (x: DB, companyId: string) => x.execute(sql`select pg_advisory_xact_lock(hashtext(${"billing-batch:" + companyId}))`);
const audit = (x: DB, companyId: string, actorId: string, action: string, detail: Record<string, unknown>) => x.insert(auditLog).values({ companyId, actorId, action, detail });

/** Gera ou atualiza a PRÉVIA do lote de uma data de emissão. Idempotente: reexecutar não duplica cobranças. */
export async function generateBatch(db: DB, actorId: string, companyId: string, issueDate: string) {
  await requirePerm(db, actorId, companyId, "billing.write");
  if (!isoDate(issueDate)) throw new Invalid("Data inválida");
  return db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await lockCompany(x, companyId);
    const { items, exceptions } = await eligible(x, companyId, issueDate);
    let [b] = await x.select().from(billingBatches).where(and(eq(billingBatches.companyId, companyId), eq(billingBatches.issueDate, issueDate), ne(billingBatches.status, "cancelado"))).for("update");
    const own = b ? await x.select().from(charges).where(and(eq(charges.companyId, companyId), eq(charges.batchId, b.id))) : [];
    if (b?.status === "aprovado") {
      if (diff(own, items).any) throw new Invalid("Este lote já foi aprovado e os contratos mudaram desde então. Reabra o lote para revalidar.");
      return { batchId: b.id, created: false, added: 0, updated: 0, removed: 0, skipped: 0, exceptions: exceptions.length };
    }
    if (!b && items.length === 0) throw new Invalid("Nenhuma cobrança prevista para esta data de emissão");
    // cobranças do mesmo contrato/competência já existentes em OUTRO lote (a data de emissão do contrato mudou)
    const others = items.length ? await x.select({ c: charges, st: billingBatches.status }).from(charges)
      .innerJoin(billingBatches, and(eq(billingBatches.id, charges.batchId), eq(billingBatches.companyId, charges.companyId)))
      .where(and(eq(charges.companyId, companyId), ne(charges.status, "cancelada"), inArray(charges.contractId, items.map((i) => i.contractId)))) : [];
    const elsewhere = new Map(others.filter((o) => !b || o.c.batchId !== b.id).map((o) => [keyOf(o.c.contractId, o.c.competenceMonth), o]));
    const hadBatch = !!b;
    if (!b) [b] = await x.insert(billingBatches).values({ companyId, issueDate, status: "rascunho", generatedBy: actorId }).returning();
    const ownBy = new Map(own.map((r) => [keyOf(r.contractId, r.competenceMonth), r]));
    let added = 0, updated = 0, removed = 0, skipped = 0;
    const want = new Set<string>();
    for (const i of items) {
      const k = keyOf(i.contractId, i.competenceMonth);
      const other = elsewhere.get(k);
      if (other) {
        if (other.st === "aprovado") { skipped++; continue; } // já está num lote aprovado: não duplica
        await x.delete(charges).where(and(eq(charges.id, other.c.id), eq(charges.companyId, companyId))); // prévia de outro lote: move para este
      }
      want.add(k);
      const cur = ownBy.get(k);
      const values = { dueDate: i.dueDate!, issueDate: i.issueDate!, description: i.description, amount: numericFromCents(i.amountCents), jointInvoice: i.jointInvoice, warnings: i.warnings };
      if (!cur) { await x.insert(charges).values({ companyId, batchId: b.id, contractId: i.contractId, customerId: i.customerId, competenceMonth: `${i.competenceMonth}-01`, ...values, status: "previa" }); added++; }
      else if (rowSig(cur) !== itemSig(i)) { await x.update(charges).set({ ...values, updatedAt: new Date() }).where(and(eq(charges.id, cur.id), eq(charges.companyId, companyId))); updated++; }
    }
    for (const [k, r] of ownBy) if (!want.has(k)) { await x.delete(charges).where(and(eq(charges.id, r.id), eq(charges.companyId, companyId))); removed++; }
    if (items.length > 0 && want.size === 0) throw new Invalid("Todas as cobranças desta data já estão em lotes aprovados");
    await x.update(billingBatches).set({ generatedBy: actorId, updatedAt: new Date() }).where(and(eq(billingBatches.id, b.id), eq(billingBatches.companyId, companyId)));
    await audit(x, companyId, actorId, "billing.batch.generated", { batchId: b.id, issueDate, added, updated, removed, skipped });
    return { batchId: b.id, created: !hadBatch, added, updated, removed, skipped, exceptions: exceptions.length };
  });
}

export async function listBatches(db: DB, actorId: string, companyId: string) {
  await requirePerm(db, actorId, companyId, "billing.read");
  const rows = await db.select({
    b: billingBatches,
    count: sql<number>`count(${charges.id})::int`,
    total: sql<string>`coalesce(sum(${charges.amount}), 0)::text`,
  }).from(billingBatches)
    .leftJoin(charges, and(eq(charges.batchId, billingBatches.id), eq(charges.companyId, billingBatches.companyId)))
    .where(and(eq(billingBatches.companyId, companyId), ne(billingBatches.status, "cancelado")))
    .groupBy(billingBatches.id).orderBy(desc(billingBatches.issueDate)).limit(120);
  return rows.map((r) => ({ ...r.b, count: r.count, totalCents: centsFromNumeric(r.total) }));
}

export async function getBatch(db: DB, actorId: string, companyId: string, id: string) {
  await requirePerm(db, actorId, companyId, "billing.read");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [b] = await db.select().from(billingBatches).where(and(eq(billingBatches.id, id), eq(billingBatches.companyId, companyId)));
  if (!b) return null;
  const rows = await db.select({ c: charges, customerName: customers.legalName }).from(charges)
    .innerJoin(customers, and(eq(customers.id, charges.customerId), eq(customers.companyId, charges.companyId)))
    .where(and(eq(charges.companyId, companyId), eq(charges.batchId, b.id))).orderBy(asc(customers.legalName));
  const cs = rows.map((r) => r.c);
  const live = b.status === "cancelado" ? { items: [], exceptions: [] } : await eligible(db, companyId, b.issueDate);
  const d = diff(cs, live.items);
  return {
    batch: b,
    charges: rows.map((r) => ({ ...r.c, amountCents: centsFromNumeric(r.c.amount), customerName: r.customerName })),
    totalCents: cs.reduce((s, c) => s + centsFromNumeric(c.amount), 0),
    hash: hashCharges(cs),
    stale: b.status === "cancelado" ? { added: 0, removed: 0, changed: 0, any: false } : d, // contratos mudaram desde a prévia/aprovação
    exceptions: live.exceptions,
  };
}

/** Aprova o lote que o usuário viu (`expectedHash`). Quem gerou a prévia não aprova (exceto diretoria). */
export async function approveBatch(db: DB, actorId: string, companyId: string, batchId: string, expectedHash: string) {
  await requirePerm(db, actorId, companyId, "billing.approve");
  const role = await activeRole(db, actorId, companyId);
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await lockCompany(x, companyId);
    const [b] = await x.select().from(billingBatches).where(and(eq(billingBatches.id, batchId), eq(billingBatches.companyId, companyId))).for("update");
    if (!b) throw new Invalid("Lote não encontrado");
    if (b.status !== "rascunho") throw new Invalid(b.status === "aprovado" ? "Lote já aprovado" : "Lote cancelado");
    const cs = await x.select().from(charges).where(and(eq(charges.companyId, companyId), eq(charges.batchId, b.id)));
    if (cs.length === 0) throw new Invalid("Lote sem cobranças");
    if (b.generatedBy === actorId && role !== "diretoria") throw new Forbidden("Quem gerou a prévia não pode aprová-la (exige outro gerente ou a diretoria)");
    if (hashCharges(cs) !== expectedHash) throw new Invalid("A prévia mudou desde que você a abriu. Revise de novo.");
    await lockSources(x, companyId);
    const live = await eligible(x, companyId, b.issueDate);
    if (diff(cs, live.items).any) throw new Invalid("Os contratos mudaram desde a prévia. Atualize a prévia antes de aprovar.");
    const now = new Date();
    await x.update(billingBatches).set({ status: "aprovado", approvedBy: actorId, approvedAt: now, updatedAt: now }).where(and(eq(billingBatches.id, b.id), eq(billingBatches.companyId, companyId)));
    await x.update(charges).set({ status: "aprovada", updatedAt: now }).where(and(eq(charges.companyId, companyId), eq(charges.batchId, b.id)));
    await audit(x, companyId, actorId, "billing.batch.approved", { batchId: b.id, issueDate: b.issueDate, count: cs.length });
  });
}

/** Alteração pós-aprovação exige nova validação: reabrir volta o lote e as cobranças para prévia (gerente/diretoria, com motivo). */
export async function reopenBatch(db: DB, actorId: string, companyId: string, batchId: string, reason: string) {
  await requirePerm(db, actorId, companyId, "billing.approve");
  const why = reason.trim();
  if (why.length < 5 || why.length > 300) throw new Invalid("Informe o motivo (5 a 300 caracteres)");
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await lockCompany(x, companyId);
    const [b] = await x.select().from(billingBatches).where(and(eq(billingBatches.id, batchId), eq(billingBatches.companyId, companyId))).for("update");
    if (!b || b.status !== "aprovado") throw new Invalid("Só é possível reabrir um lote aprovado");
    await x.select({ id: charges.id }).from(charges).where(and(eq(charges.companyId, companyId), eq(charges.batchId, b.id))).for("update"); // mesma ordem de lock da baixa: espera uma baixa em curso e enxerga o resultado
    const [paid] = await x.execute(sql`select count(*)::int n from payments p join charges c on c.company_id = p.company_id and c.id = p.charge_id where c.company_id = ${companyId} and c.batch_id = ${b.id}`) as unknown as { n: number }[];
    if (paid.n > 0) throw new Invalid("Este lote tem pagamentos (ou estornos) registrados em Contas a receber e não pode ser reaberto");
    await x.execute(sql`select pg_advisory_xact_lock(hashtext(${"issuance:" + companyId}))`); // mesmo lock da reserva do motor de emissão: ou a reserva já está confirmada (e é vista abaixo) ou espera a reabertura
    const [iss] = await x.execute(sql`select count(*)::int n from issuance_requests r join charges c on c.company_id = r.company_id and c.id = r.charge_id where c.company_id = ${companyId} and c.batch_id = ${b.id} and r.status in ('enviando', 'processando', 'emitido', 'desconhecido')`) as unknown as { n: number }[];
    if (iss.n > 0) throw new Invalid("Este lote tem emissões em andamento ou concluídas (boleto/NFS-e) e não pode ser reaberto");
    await x.execute(sql`update issuance_requests r set status = 'cancelado', updated_at = now() from charges c where c.company_id = r.company_id and c.id = r.charge_id and c.company_id = ${companyId} and c.batch_id = ${b.id} and r.status in ('pendente', 'falhou')`); // solicitações ainda não enviadas deixam de valer
    const now = new Date();
    await x.update(billingBatches).set({ status: "rascunho", approvedBy: null, approvedAt: null, reopenReason: why, generatedBy: actorId, updatedAt: now }).where(and(eq(billingBatches.id, b.id), eq(billingBatches.companyId, companyId)));
    const ids = (await x.update(charges).set({ status: "previa", updatedAt: now }).where(and(eq(charges.companyId, companyId), eq(charges.batchId, b.id))).returning({ id: charges.id })).map((r) => r.id);
    const queueCancelled = await cancelQueueForCharges(x, companyId, ids); // mensagens ainda não processadas deixam de valer
    await audit(x, companyId, actorId, "billing.batch.reopened", { batchId: b.id, issueDate: b.issueDate, queueCancelled });
  });
}

/** Cancela um lote em prévia (aprovado precisa ser reaberto antes). Libera a data para uma nova prévia. */
export async function cancelBatch(db: DB, actorId: string, companyId: string, batchId: string) {
  await requirePerm(db, actorId, companyId, "billing.write");
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await lockCompany(x, companyId);
    const [b] = await x.select().from(billingBatches).where(and(eq(billingBatches.id, batchId), eq(billingBatches.companyId, companyId))).for("update");
    if (!b || b.status !== "rascunho") throw new Invalid("Só é possível cancelar um lote em prévia");
    await x.delete(charges).where(and(eq(charges.companyId, companyId), eq(charges.batchId, b.id)));
    await x.update(billingBatches).set({ status: "cancelado", updatedAt: new Date() }).where(and(eq(billingBatches.id, b.id), eq(billingBatches.companyId, companyId)));
    await audit(x, companyId, actorId, "billing.batch.cancelled", { batchId: b.id, issueDate: b.issueDate });
  });
}
