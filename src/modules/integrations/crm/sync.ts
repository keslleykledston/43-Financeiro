import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { auditLog, customerContacts, customers, integrationConflicts, integrationConnections, integrationSyncRuns } from "@/lib/db/schema";
import { parseDocument } from "@/lib/validators/document";
import { lockModeShared, readCustomerMode } from "@/modules/crm/service";
import { Invalid, requirePerm } from "@/modules/identity/service";
import { crmCustomerSchema, CrmError, MAX_PAGE_ITEMS, type CrmAdapter, type CrmCustomer } from "./types";

const LOCAL_MODE_MSG = "Esta empresa está no modo local. Troque a origem dos clientes para CRM em Integrações.";
export const MAX_ITEMS = 5000;
export const MAX_PAGES = 200;

type Row = typeof customers.$inferSelect;
export type Planned = { externalId: string; legalName: string; document: string; docType: "cpf" | "cnpj"; tradeName?: string; contacts: CrmCustomer["contacts"] };
export type Plan = {
  create: Planned[];
  update: (Planned & { localId: string })[];
  archive: { externalId: string; localId: string; legalName: string }[];
  restore: (Planned & { localId: string })[];
  conflicts: { externalId: string; reason: "duplicate_document" | "document_collision" | "ambiguous_company"; localId?: string; legalName: string; document: string }[];
  stats: { fetched: number; create: number; update: number; archive: number; restore: number; conflict: number; unchanged: number; skipped: number; invalid: number };
};

// ---------- permissões e chave geral ----------
/** Sincronizar altera cadastros: exige gravar clientes E gerir integrações (hoje: diretoria). */
async function requireSync(db: DB, actorId: string, companyId: string) {
  await requirePerm(db, actorId, companyId, "crm.write");
  await requirePerm(db, actorId, companyId, "integrations.manage");
}

export async function getConnection(db: DB, companyId: string) {
  const [c] = await db.select().from(integrationConnections).where(and(eq(integrationConnections.companyId, companyId), eq(integrationConnections.kind, "crm")));
  return c ?? null;
}

export async function saveConnection(db: DB, actorId: string, companyId: string, input: { enabled: boolean; companyRef?: string }) {
  await requirePerm(db, actorId, companyId, "integrations.manage");
  const settings = { companyRef: input.companyRef?.trim().slice(0, 100) || undefined };
  await db.insert(integrationConnections).values({ companyId, kind: "crm", enabled: input.enabled, settings })
    .onConflictDoUpdate({ target: [integrationConnections.companyId, integrationConnections.kind], set: { enabled: input.enabled, settings, updatedAt: new Date() } });
  await db.insert(auditLog).values({ companyId, actorId, action: "crm.connection.saved", detail: { enabled: input.enabled } });
}

/** Chave geral (env) + conexão habilitada da empresa. Padrão: desligado. */
async function assertEnabled(db: DB, companyId: string, env: NodeJS.ProcessEnv = process.env) {
  if (env.CRM_SYNC_ENABLED !== "true") throw new Invalid("Sincronização com o CRM está desativada (chave geral)");
  if ((await readCustomerMode(db, companyId)) !== "crm") throw new Invalid(LOCAL_MODE_MSG);
  const c = await getConnection(db, companyId);
  if (!c?.enabled) throw new Invalid("A integração com o CRM não está ativada para esta empresa");
  return c;
}

// ---------- busca paginada com guardas ----------
async function fetchAll(adapter: CrmAdapter, updatedSince?: string): Promise<unknown[]> {
  const out: unknown[] = []; const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await adapter.listCustomers({ cursor, updatedSince });
    if (r.items.length > MAX_PAGE_ITEMS) throw new CrmError(`Página do CRM com mais de ${MAX_PAGE_ITEMS} itens`);
    out.push(...r.items);
    if (out.length > MAX_ITEMS) throw new CrmError(`CRM devolveu mais de ${MAX_ITEMS} registros; use sincronização incremental`);
    if (!r.nextCursor) return out;
    if (seen.has(r.nextCursor)) throw new CrmError("Paginação do CRM em laço (cursor repetido)");
    seen.add(r.nextCursor); cursor = r.nextCursor;
  }
  throw new CrmError("Paginação do CRM excedeu o limite de páginas");
}

// ---------- plano (função pura sobre o estado do banco + itens do CRM) ----------
const canonContacts = (l: { name: string; email?: string | null; phone?: string | null; isFinancial: boolean }[]) =>
  JSON.stringify(l.map((c) => [c.name, c.email ?? "", c.phone ?? "", c.isFinancial]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));

export function buildPlan(rows: Row[], ignored: Set<string>, raw: unknown[], companyRef?: string, crmContacts: Map<string, string> = new Map()): Plan {
  const plan: Plan = { create: [], update: [], archive: [], restore: [], conflicts: [], stats: { fetched: raw.length, create: 0, update: 0, archive: 0, restore: 0, conflict: 0, unchanged: 0, skipped: 0, invalid: 0 } };
  const byExt = new Map(rows.filter((r) => r.source === "crm" && r.externalId).map((r) => [r.externalId!, r]));
  const activeByDoc = new Map(rows.filter((r) => !r.archivedAt).map((r) => [r.document, r]));
  const seenExt = new Set<string>();
  const claimedDocs = new Set<string>(); // documento já usado por item anterior deste mesmo lote

  const conflict = (c: CrmCustomer, reason: Plan["conflicts"][number]["reason"], doc: string, localId?: string) => {
    if (ignored.has(`${c.externalId}|${reason}|${localId ?? ""}`)) { plan.stats.skipped++; return; }
    plan.conflicts.push({ externalId: c.externalId, reason, localId, legalName: c.legalName, document: doc });
  };

  for (const item of raw) {
    const p = crmCustomerSchema.safeParse(item);
    if (!p.success) { plan.stats.invalid++; continue; }
    const c = p.data;
    if (seenExt.has(c.externalId)) { plan.stats.invalid++; continue; } // repetido no próprio CRM
    seenExt.add(c.externalId);
    const doc = parseDocument(c.document);
    if (!doc) { plan.stats.invalid++; continue; }
    if (companyRef) {
      if (c.companyRef === undefined) { conflict(c, "ambiguous_company", doc.digits); continue; }
      if (c.companyRef !== companyRef) { plan.stats.skipped++; continue; } // pertence a outra empresa
    }
    const planned: Planned = { externalId: c.externalId, legalName: c.legalName, tradeName: c.tradeName, document: doc.digits, docType: doc.type, contacts: c.contacts };
    const existing = byExt.get(c.externalId);

    if (existing) {
      if (!c.active) { if (!existing.archivedAt) plan.archive.push({ externalId: c.externalId, localId: existing.id, legalName: existing.legalName }); else plan.stats.unchanged++; continue; }
      const other = activeByDoc.get(doc.digits);
      if (other && other.id !== existing.id) { conflict(c, "document_collision", doc.digits, other.id); continue; }
      if (claimedDocs.has(doc.digits)) { conflict(c, "document_collision", doc.digits); continue; }
      claimedDocs.add(doc.digits);
      if (existing.archivedAt) { plan.restore.push({ ...planned, localId: existing.id }); continue; }
      const changed = existing.legalName !== c.legalName || (existing.tradeName ?? undefined) !== (c.tradeName || undefined) || existing.document !== doc.digits
        || canonContacts(c.contacts) !== (crmContacts.get(existing.id) ?? "[]"); // mudança só nos contatos também conta
      if (changed) plan.update.push({ ...planned, localId: existing.id }); else plan.stats.unchanged++;
      continue;
    }
    if (!c.active) { plan.stats.skipped++; continue; } // inativo e nunca importado
    const other = activeByDoc.get(doc.digits);
    if (other) { conflict(c, "duplicate_document", doc.digits, other.id); continue; }
    if (claimedDocs.has(doc.digits)) { conflict(c, "document_collision", doc.digits); continue; }
    claimedDocs.add(doc.digits);
    plan.create.push(planned);
  }
  const s = plan.stats;
  s.create = plan.create.length; s.update = plan.update.length; s.archive = plan.archive.length; s.restore = plan.restore.length; s.conflict = plan.conflicts.length;
  return plan;
}

async function loadState(db: DB, companyId: string) {
  const rows = await db.select().from(customers).where(eq(customers.companyId, companyId));
  const ign = await db.select().from(integrationConflicts).where(and(eq(integrationConflicts.companyId, companyId), eq(integrationConflicts.status, "ignored")));
  const ignored = new Set(ign.map((c) => `${c.externalId}|${c.reason}|${c.localId ?? ""}`));
  const cc = await db.select().from(customerContacts).where(and(eq(customerContacts.companyId, companyId), eq(customerContacts.source, "crm")));
  const byParty = new Map<string, typeof cc>();
  for (const c of cc) byParty.set(c.partyId, [...(byParty.get(c.partyId) ?? []), c]);
  const crmContacts = new Map([...byParty].map(([id, l]) => [id, canonContacts(l)]));
  return { rows, ignored, crmContacts };
}

const PREVIEW_ROWS = 200;

/** Impressão digital do plano. A confirmação só aplica se o plano recalculado for IDÊNTICO ao revisado. */
export function planHash(plan: Plan): string {
  const by = <T extends { externalId: string }>(a: T[]) => [...a].sort((x, y) => x.externalId.localeCompare(y.externalId));
  const pl = (x: Planned) => [x.externalId, x.legalName, x.tradeName ?? "", x.document, canonContacts(x.contacts)];
  const canon = {
    c: by(plan.create).map(pl), u: by(plan.update).map((x) => [...pl(x), x.localId]), r: by(plan.restore).map((x) => [...pl(x), x.localId]),
    a: by(plan.archive).map((x) => [x.externalId, x.localId]), k: by(plan.conflicts).map((x) => [x.externalId, x.reason, x.localId ?? ""]),
  };
  return createHash("sha256").update(JSON.stringify(canon)).digest("hex");
}

/** Prévia: busca no CRM e mostra o que MUDARIA. Não grava nada de negócio. */
export async function previewSync(db: DB, adapter: CrmAdapter, actorId: string, companyId: string, env: NodeJS.ProcessEnv = process.env) {
  await requireSync(db, actorId, companyId);
  const conn = await assertEnabled(db, companyId, env);
  let raw: unknown[];
  try { raw = await fetchAll(adapter); }
  catch (e) { throw new Invalid(`Não foi possível consultar o CRM: ${e instanceof CrmError ? e.message : "falha inesperada"}`); }
  const { rows, ignored, crmContacts } = await loadState(db, companyId);
  const plan = buildPlan(rows, ignored, raw, (conn.settings as { companyRef?: string }).companyRef, crmContacts);
  return {
    planHash: planHash(plan),
    stats: plan.stats,
    sample: {
      create: plan.create.slice(0, PREVIEW_ROWS).map((x) => ({ legalName: x.legalName, document: x.document })),
      update: plan.update.slice(0, PREVIEW_ROWS).map((x) => ({ legalName: x.legalName, document: x.document })),
      archive: plan.archive.slice(0, PREVIEW_ROWS).map((x) => ({ legalName: x.legalName })),
      restore: plan.restore.slice(0, PREVIEW_ROWS).map((x) => ({ legalName: x.legalName, document: x.document })),
      conflicts: plan.conflicts.slice(0, PREVIEW_ROWS).map((x) => ({ legalName: x.legalName, document: x.document, reason: x.reason })),
    },
  };
}

const sameCompanyLock = (companyId: string) => sql`select pg_advisory_xact_lock(hashtext(${"crm-sync:" + companyId}))`;

/** Aplica: refaz a busca e o plano (não confia na prévia), com trava por empresa. Idempotente. */
export async function applySync(db: DB, adapter: CrmAdapter, actorId: string, companyId: string, expectedHash: string, env: NodeJS.ProcessEnv = process.env) {
  await requireSync(db, actorId, companyId);
  const conn = await assertEnabled(db, companyId, env);
  let raw: unknown[];
  try { raw = await fetchAll(adapter); }
  catch (e) {
    const msg = e instanceof CrmError ? e.message : "falha ao consultar o CRM";
    await db.insert(integrationSyncRuns).values({ companyId, kind: "crm", status: "failed", error: msg.slice(0, 300), confirmedBy: actorId, finishedAt: new Date() });
    throw new Invalid(`Não foi possível consultar o CRM: ${msg}`);
  }
  const companyRef = (conn.settings as { companyRef?: string }).companyRef;
  const now = new Date();

  return db.transaction(async (tx) => {
    const t = tx as unknown as DB;
    await t.execute(sameCompanyLock(companyId));
    await lockModeShared(t, companyId); // ordem fixa: crm-sync → cust-mode
    if ((await readCustomerMode(t, companyId)) !== "crm") throw new Invalid(LOCAL_MODE_MSG); // o modo pode ter mudado durante a chamada ao CRM
    const { rows, ignored, crmContacts } = await loadState(t, companyId); // estado lido DEPOIS da trava
    const plan = buildPlan(rows, ignored, raw, companyRef, crmContacts);
    // só aplica exatamente o que foi revisado: se o CRM ou o banco mudaram desde a prévia, exige nova revisão
    if (!expectedHash || planHash(plan) !== expectedHash) throw new Invalid("O CRM ou os cadastros mudaram desde a revisão. Revise a sincronização novamente antes de confirmar.");

    const syncContacts = async (partyId: string, list: CrmCustomer["contacts"]) => {
      await t.delete(customerContacts).where(and(eq(customerContacts.companyId, companyId), eq(customerContacts.partyId, partyId), eq(customerContacts.source, "crm")));
      if (list.length) await t.insert(customerContacts).values(list.map((c) => ({ companyId, partyId, name: c.name, email: c.email, phone: c.phone, isFinancial: c.isFinancial, source: "crm" })));
    };

    for (const p of plan.create) {
      const [row] = await t.insert(customers).values({ companyId, createdBy: actorId, legalName: p.legalName, tradeName: p.tradeName, docType: p.docType, document: p.document, source: "crm", externalId: p.externalId, externalSyncedAt: now }).returning({ id: customers.id });
      await syncContacts(row.id, p.contacts);
    }
    for (const p of [...plan.update, ...plan.restore]) {
      await t.update(customers).set({ legalName: p.legalName, tradeName: p.tradeName ?? null, docType: p.docType, document: p.document, archivedAt: null, externalSyncedAt: now, updatedAt: now })
        .where(and(eq(customers.id, p.localId), eq(customers.companyId, companyId)));
      await syncContacts(p.localId, p.contacts);
    }
    if (plan.archive.length) {
      await t.update(customers).set({ archivedAt: now, externalSyncedAt: now, updatedAt: now })
        .where(and(eq(customers.companyId, companyId), inArray(customers.id, plan.archive.map((a) => a.localId))));
    }
    const [run] = await t.insert(integrationSyncRuns).values({ companyId, kind: "crm", status: "applied", stats: plan.stats, confirmedBy: actorId, finishedAt: now }).returning({ id: integrationSyncRuns.id });
    for (const c of plan.conflicts) {
      await t.insert(integrationConflicts).values({ companyId, runId: run.id, entity: "customer", externalId: c.externalId, reason: c.reason, localId: c.localId, payload: { legalName: c.legalName, document: c.document } }).onConflictDoNothing();
    }
    await t.update(integrationConnections).set({ lastRunAt: now, updatedAt: now }).where(eq(integrationConnections.id, conn.id));
    // auditoria só com contagens (sem PII)
    await t.insert(auditLog).values({ companyId, actorId, action: "crm.sync.applied", detail: plan.stats });
    return plan.stats;
  });
}

// ---------- conflitos ----------
export async function listConflicts(db: DB, actorId: string, companyId: string) {
  await requirePerm(db, actorId, companyId, "crm.read");
  return db.select().from(integrationConflicts).where(and(eq(integrationConflicts.companyId, companyId), eq(integrationConflicts.status, "open"))).orderBy(desc(integrationConflicts.createdAt));
}

export async function listRuns(db: DB, actorId: string, companyId: string, limit = 10) {
  await requirePerm(db, actorId, companyId, "crm.read");
  return db.select().from(integrationSyncRuns).where(and(eq(integrationSyncRuns.companyId, companyId), eq(integrationSyncRuns.kind, "crm"))).orderBy(desc(integrationSyncRuns.createdAt)).limit(limit);
}

/** link: adota o cadastro local existente como o do CRM. ignore: mantém separado e não volta a avisar. */
export async function resolveConflict(db: DB, actorId: string, companyId: string, conflictId: string, action: "link" | "ignore") {
  await requireSync(db, actorId, companyId);
  await db.transaction(async (tx) => {
    const t = tx as unknown as DB;
    await t.execute(sameCompanyLock(companyId));
    await lockModeShared(t, companyId);
    if ((await readCustomerMode(t, companyId)) !== "crm") throw new Invalid(LOCAL_MODE_MSG); // vincular ao CRM só no modo CRM
    const [c] = await t.select().from(integrationConflicts).where(and(eq(integrationConflicts.id, conflictId), eq(integrationConflicts.companyId, companyId), eq(integrationConflicts.status, "open")));
    if (!c) throw new Invalid("Conflito não encontrado ou já resolvido");
    if (action === "link") {
      if (!c.localId) throw new Invalid("Este conflito não tem cadastro local para vincular");
      const [local] = await t.select().from(customers).where(and(eq(customers.id, c.localId), eq(customers.companyId, companyId), isNull(customers.archivedAt)));
      if (!local) throw new Invalid("O cadastro local não está mais ativo");
      if (local.externalId) throw new Invalid("O cadastro local já está vinculado a outro registro do CRM");
      await t.update(customers).set({ source: "crm", externalId: c.externalId, externalSyncedAt: new Date(), updatedAt: new Date() }).where(eq(customers.id, local.id));
    }
    await t.update(integrationConflicts).set({ status: action === "link" ? "linked" : "ignored", payload: {}, resolvedBy: actorId, resolvedAt: new Date(), updatedAt: new Date() }) // payload (nome/documento) apagado ao resolver.where(eq(integrationConflicts.id, c.id));
    await t.insert(auditLog).values({ companyId, actorId, action: action === "link" ? "crm.conflict.linked" : "crm.conflict.ignored", detail: { conflictId } });
  });
}
