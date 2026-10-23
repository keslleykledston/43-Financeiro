import { and, asc, count, desc, eq, ilike, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "@/lib/db";
import { auditLog, contracts, contractVersions, customers } from "@/lib/db/schema";
import { centsFromNumeric, numericFromCents, parseMoneyToCents } from "@/lib/money";
import { Forbidden, Invalid, activeRole, requirePerm } from "@/modules/identity/service";

export type ContractStatus = "rascunho" | "ativo" | "suspenso" | "encerrado";
export const STATUS_LABEL: Record<ContractStatus, string> = { rascunho: "Rascunho (aguardando aprovação)", ativo: "Ativo", suspenso: "Suspenso", encerrado: "Encerrado" };
export const PAGE_SIZE = 20;

export type Terms = { description: string; monthlyAmountCents: number; startAt: string; endAt: string | null; dueDay: number; invoiceJointRequired: boolean; issueDayOverride: number | null };

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida").refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d, "Data inválida");
const optInt = (min: number, max: number, msg: string) => z.preprocess((v) => (v === "" || v === null || v === undefined ? null : Number(v)), z.number().int(msg).min(min, msg).max(max, msg).nullable());
export const termsSchema = z.object({
  description: z.string().trim().min(2, "Informe o serviço contratado").max(200),
  monthlyAmount: z.string().trim().min(1, "Informe o valor mensal"),
  startAt: iso,
  endAt: z.preprocess((v) => (v === "" || v === undefined ? null : v), iso.nullable()),
  dueDay: z.preprocess((v) => Number(v), z.number({ message: "Dia de vencimento inválido" }).int("Dia de vencimento inválido").min(1, "Dia de vencimento deve ser de 1 a 31").max(31, "Dia de vencimento deve ser de 1 a 31")),
  invoiceJointRequired: z.preprocess((v) => v === true || v === "on" || v === "true", z.boolean()),
  issueDayOverride: optInt(1, 28, "Dia de emissão deve ser de 1 a 28"),
});

export function parseTerms(input: unknown): Terms {
  const p = termsSchema.safeParse(input);
  if (!p.success) throw new Invalid(p.error.issues[0]?.message ?? "Dados inválidos");
  const cents = parseMoneyToCents(p.data.monthlyAmount);
  if (cents === null || cents <= 0) throw new Invalid("Valor mensal inválido (use o formato 2.500,00; máximo 99.999.999.999,99)");
  if (p.data.endAt && p.data.endAt < p.data.startAt) throw new Invalid("O fim da vigência não pode ser anterior ao início");
  if (p.data.issueDayOverride && p.data.issueDayOverride > p.data.dueDay) throw new Invalid("O dia de emissão não pode ser posterior ao dia de vencimento");
  return { description: p.data.description, monthlyAmountCents: cents, startAt: p.data.startAt, endAt: p.data.endAt, dueDay: p.data.dueDay, invoiceJointRequired: p.data.invoiceJointRequired, issueDayOverride: p.data.issueDayOverride };
}

type Row = typeof contracts.$inferSelect;
export const termsOf = (c: Row): Terms => ({ description: c.description, monthlyAmountCents: centsFromNumeric(c.monthlyAmount), startAt: c.startAt, endAt: c.endAt, dueDay: c.dueDay, invoiceJointRequired: c.invoiceJointRequired, issueDayOverride: c.issueDayOverride });
const sameTerms = (a: Terms, b: Terms) => JSON.stringify(a) === JSON.stringify(b);
const columns = (t: Terms) => ({ description: t.description, monthlyAmount: numericFromCents(t.monthlyAmountCents), startAt: t.startAt, endAt: t.endAt, dueDay: t.dueDay, invoiceJointRequired: t.invoiceJointRequired, issueDayOverride: t.issueDayOverride });
const audit = (db: DB, companyId: string, actorId: string, action: string, detail: Record<string, unknown>) => db.insert(auditLog).values({ companyId, actorId, action, detail });
const pgCode = (e: unknown) => (e as { code?: string })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;

/** Elegível para gerar cobrança da competência: contrato ATIVO, cliente ATIVO (não arquivado) e vigência cobrindo o mês. */
export function isContractBillable(c: { status: string; startAt: string; endAt: string | null }, customer: { status: string; archivedAt: Date | null }, competenceMonth: string): boolean {
  if (c.status !== "ativo" || customer.status !== "ativo" || customer.archivedAt) return false;
  const first = `${competenceMonth}-01`;
  const [y, m] = competenceMonth.split("-").map(Number);
  const last = `${competenceMonth}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
  return c.startAt <= last && (c.endAt === null || c.endAt >= first);
}

export async function createContract(db: DB, actorId: string, companyId: string, customerId: string, input: unknown, reason?: string) {
  await requirePerm(db, actorId, companyId, "contracts.write");
  const t = parseTerms(input);
  if (!z.string().uuid().safeParse(customerId).success) throw new Invalid("Cliente inválido");
  try {
    return await db.transaction(async (tx) => {
      const x = tx as unknown as DB;
      const [cu] = await x.select().from(customers).where(and(eq(customers.id, customerId), eq(customers.companyId, companyId)));
      if (!cu || cu.archivedAt) throw new Invalid("Cliente não encontrado ou arquivado nesta empresa");
      const [c] = await x.insert(contracts).values({ companyId, customerId, createdBy: actorId, status: "rascunho", ...columns(t) }).returning();
      await x.insert(contractVersions).values({ companyId, contractId: c.id, version: 1, state: "pendente", terms: t, reason: reason ?? "Contrato inicial", requestedBy: actorId });
      await audit(x, companyId, actorId, "contract.created", { contractId: c.id });
      return c;
    });
  } catch (e) { if (pgCode(e) === "23514") throw new Invalid("Dados do contrato violam uma regra (valor, datas ou dias)"); throw e; }
}

/** Propor alteração: nada vigora até a aprovação. Em rascunho, reenvia a versão inicial. */
export async function proposeChange(db: DB, actorId: string, companyId: string, contractId: string, input: unknown, reason?: string) {
  await requirePerm(db, actorId, companyId, "contracts.write");
  const t = parseTerms(input);
  return db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    const [c] = await x.select().from(contracts).where(and(eq(contracts.id, contractId), eq(contracts.companyId, companyId))).for("update");
    if (!c) throw new Invalid("Contrato não encontrado");
    if (c.status === "encerrado") throw new Invalid("Contrato encerrado não pode ser alterado");
    const vs = await x.select().from(contractVersions).where(and(eq(contractVersions.contractId, contractId), eq(contractVersions.companyId, companyId))).orderBy(desc(contractVersions.version));
    const pending = vs.find((v) => v.state === "pendente");
    if (c.status === "rascunho") {
      if (pending) { // ainda não aprovado: a versão anterior fica no histórico (imutável) como "substituida"
        await x.update(contractVersions).set({ state: "substituida", decidedBy: actorId, decidedAt: new Date(), decisionNote: "Substituída por nova edição do rascunho", updatedAt: new Date() }).where(eq(contractVersions.id, pending.id));
        const version = (vs[0]?.version ?? 0) + 1;
        await x.insert(contractVersions).values({ companyId, contractId, version, state: "pendente", terms: t, reason: reason ?? pending.reason, requestedBy: actorId });
        await x.update(contracts).set({ ...columns(t), updatedAt: new Date() }).where(eq(contracts.id, c.id));
        await audit(x, companyId, actorId, "contract.draft_updated", { contractId, version, replaced: pending.version });
        return version;
      }
    } else {
      if (pending) throw new Invalid("Já existe uma alteração pendente de aprovação para este contrato");
      if (sameTerms(t, termsOf(c))) throw new Invalid("Nenhuma alteração em relação aos termos vigentes");
    }
    const version = (vs[0]?.version ?? 0) + 1;
    await x.insert(contractVersions).values({ companyId, contractId, version, state: "pendente", terms: t, reason: reason ?? null, requestedBy: actorId });
    if (c.status === "rascunho") await x.update(contracts).set({ ...columns(t), updatedAt: new Date() }).where(eq(contracts.id, c.id)); // rascunho reenviado após rejeição
    await audit(x, companyId, actorId, "contract.change_proposed", { contractId, version });
    return version;
  });
}

/** Aprovar/rejeitar. Aprovador ≠ solicitante (exceto diretoria). A aprovação da v1 ativa o contrato. */
export async function decideVersion(db: DB, actorId: string, companyId: string, versionId: string, decision: "aprovar" | "rejeitar", note?: string) {
  await requirePerm(db, actorId, companyId, "contracts.approve");
  const role = await activeRole(db, actorId, companyId);
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    const [v] = await x.select().from(contractVersions).where(and(eq(contractVersions.id, versionId), eq(contractVersions.companyId, companyId))).for("update");
    if (!v || v.state !== "pendente") throw new Invalid("Versão não encontrada ou já decidida");
    if (v.requestedBy === actorId && role !== "diretoria") throw new Forbidden("Quem solicitou a alteração não pode aprová-la (exige outro gerente ou a diretoria)");
    const [c] = await x.select().from(contracts).where(and(eq(contracts.id, v.contractId), eq(contracts.companyId, companyId))).for("update");
    if (decision === "aprovar") {
      if (c.status === "encerrado") throw new Invalid("Contrato encerrado");
      const t = v.terms as Terms;
      await x.update(contracts).set({ ...columns(t), status: c.status === "rascunho" ? "ativo" : c.status, updatedAt: new Date() }).where(eq(contracts.id, c.id));
    }
    await x.update(contractVersions).set({ state: decision === "aprovar" ? "aprovada" : "rejeitada", decidedBy: actorId, decidedAt: new Date(), decisionNote: note?.trim().slice(0, 500) || null, updatedAt: new Date() }).where(eq(contractVersions.id, v.id));
    await audit(x, companyId, actorId, decision === "aprovar" ? "contract.version_approved" : "contract.version_rejected", { contractId: c.id, version: v.version });
  });
}

/** Suspender/encerrar reduz cobrança (qualquer escritor). Voltar a ATIVO muda a cobrança futura: exige aprovação (gerente/diretoria). */
export async function setStatus(db: DB, actorId: string, companyId: string, contractId: string, to: Exclude<ContractStatus, "rascunho">) {
  await requirePerm(db, actorId, companyId, to === "ativo" ? "contracts.approve" : "contracts.write");
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    const [c] = await x.select().from(contracts).where(and(eq(contracts.id, contractId), eq(contracts.companyId, companyId))).for("update");
    if (!c) throw new Invalid("Contrato não encontrado");
    if (c.status === "rascunho") throw new Invalid("Contrato em rascunho: aguarde a aprovação da versão inicial");
    if (c.status === "encerrado") throw new Invalid("Contrato encerrado é definitivo");
    if (c.status === to) return;
    await x.update(contracts).set({ status: to, updatedAt: new Date() }).where(eq(contracts.id, c.id));
    await audit(x, companyId, actorId, "contract.status_changed", { contractId, from: c.status, to });
  });
}

export type ListQuery = { status?: ContractStatus; q?: string; page?: number };
export async function listContracts(db: DB, actorId: string, companyId: string, query: ListQuery) {
  await requirePerm(db, actorId, companyId, "contracts.read");
  const page = Math.max(1, Math.floor(query.page ?? 1));
  const like = query.q?.trim() ? `%${query.q.trim().slice(0, 100).replace(/[\\%_]/g, "\\$&")}%` : null;
  const where = and(eq(contracts.companyId, companyId), query.status ? eq(contracts.status, query.status) : undefined, like ? or(ilike(customers.legalName, like), ilike(contracts.description, like)) : undefined);
  const base = db.select({ n: count() }).from(contracts).innerJoin(customers, and(eq(customers.id, contracts.customerId), eq(customers.companyId, contracts.companyId))).where(where);
  const [{ n: total }] = await base;
  const rows = await db.select({ c: contracts, customerName: customers.legalName, customerStatus: customers.status, pending: sql<boolean>`exists (select 1 from contract_versions v where v.contract_id = ${contracts.id} and v.state = 'pendente')` }).from(contracts)
    .innerJoin(customers, and(eq(customers.id, contracts.customerId), eq(customers.companyId, contracts.companyId))).where(where)
    .orderBy(asc(customers.legalName), asc(contracts.createdAt)).limit(PAGE_SIZE).offset((page - 1) * PAGE_SIZE);
  return { page, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)), total, items: rows.map((r) => ({ ...r.c, amountCents: centsFromNumeric(r.c.monthlyAmount), customerName: r.customerName, customerStatus: r.customerStatus, pending: r.pending })) };
}

export async function getContract(db: DB, actorId: string, companyId: string, id: string) {
  await requirePerm(db, actorId, companyId, "contracts.read");
  if (!z.string().uuid().safeParse(id).success) return null;
  const [r] = await db.select({ c: contracts, cu: customers }).from(contracts).innerJoin(customers, and(eq(customers.id, contracts.customerId), eq(customers.companyId, contracts.companyId)))
    .where(and(eq(contracts.id, id), eq(contracts.companyId, companyId)));
  if (!r) return null;
  const versions = await db.select().from(contractVersions).where(and(eq(contractVersions.contractId, id), eq(contractVersions.companyId, companyId))).orderBy(desc(contractVersions.version));
  return { ...r.c, amountCents: centsFromNumeric(r.c.monthlyAmount), customer: { id: r.cu.id, legalName: r.cu.legalName, status: r.cu.status, archivedAt: r.cu.archivedAt }, versions: versions.map((v) => ({ ...v, terms: v.terms as Terms })) };
}

/** Clientes disponíveis para novos contratos (ativos primeiro; arquivados fora). */
export async function customerOptions(db: DB, actorId: string, companyId: string) {
  await requirePerm(db, actorId, companyId, "contracts.read");
  return db.select({ id: customers.id, name: customers.legalName, status: customers.status }).from(customers)
    .where(and(eq(customers.companyId, companyId), sql`${customers.archivedAt} is null`)).orderBy(asc(customers.legalName)).limit(1000);
}
