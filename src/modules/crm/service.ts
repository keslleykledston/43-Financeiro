import { and, asc, count, desc, eq, ilike, isNotNull, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "@/lib/db";
import { auditLog, partyContacts, parties } from "@/lib/db/schema";
import { parseCsv, toCsv } from "@/lib/csv";
import { formatDocument, parseDocument } from "@/lib/validators/document";
import { Invalid, requirePerm } from "@/modules/identity/service";

export type Kind = "cliente" | "fornecedor";
export const PAGE_SIZE = 20;
export const IMPORT_MAX_ROWS = 1000;
export const IMPORT_MAX_BYTES = 500_000;

const str = (max: number) => z.string().trim().max(max);
export const partySchema = z.object({
  kind: z.enum(["cliente", "fornecedor"]),
  legalName: str(200).min(2, "Informe a razão social ou nome"),
  tradeName: str(200).optional().transform((v) => v || undefined),
  document: str(30).min(1, "Informe o CPF ou CNPJ"),
});
export const contactSchema = z.object({
  name: str(120).min(1, "Informe o nome do contato"),
  email: str(254).optional().transform((v) => v || undefined).pipe(z.string().email("E-mail inválido").optional()),
  phone: str(40).optional().transform((v) => v || undefined),
  isFinancial: z.boolean().default(false),
});

const firstIssue = (e: z.ZodError) => e.issues[0]?.message ?? "Dados inválidos";
const pgCode = (e: unknown): string | undefined =>
  (e as { code?: string })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;
const DUP = "Já existe um cadastro ativo com este documento nesta empresa";

function normalize(input: unknown) {
  const p = partySchema.safeParse(input);
  if (!p.success) throw new Invalid(firstIssue(p.error));
  const doc = parseDocument(p.data.document);
  if (!doc) throw new Invalid("CPF ou CNPJ inválido");
  return { ...p.data, docType: doc.type, document: doc.digits };
}

const audit = (db: DB, companyId: string, actorId: string, action: string, detail: Record<string, unknown>) =>
  db.insert(auditLog).values({ companyId, actorId, action, detail });

export async function createParty(db: DB, actorId: string, companyId: string, input: unknown) {
  await requirePerm(db, actorId, companyId, "crm.write");
  const v = normalize(input);
  try {
    return await db.transaction(async (tx) => {
      const [p] = await tx.insert(parties).values({ companyId, createdBy: actorId, kind: v.kind, legalName: v.legalName, tradeName: v.tradeName, docType: v.docType, document: v.document }).returning();
      await audit(tx as unknown as DB, companyId, actorId, "party.created", { partyId: p.id, kind: v.kind });
      return p;
    });
  } catch (e) { if (pgCode(e) === "23505") throw new Invalid(DUP); throw e; }
}

export async function getParty(db: DB, actorId: string, companyId: string, id: string) {
  await requirePerm(db, actorId, companyId, "crm.read");
  const [p] = await db.select().from(parties).where(and(eq(parties.id, id), eq(parties.companyId, companyId)));
  if (!p) return null;
  const contacts = await db.select().from(partyContacts)
    .where(and(eq(partyContacts.partyId, id), eq(partyContacts.companyId, companyId))).orderBy(asc(partyContacts.createdAt));
  return { ...p, contacts, documentFormatted: formatDocument(p.docType, p.document) };
}

export async function updateParty(db: DB, actorId: string, companyId: string, id: string, input: unknown) {
  await requirePerm(db, actorId, companyId, "crm.write");
  const v = normalize(input);
  try {
    return await db.transaction(async (tx) => {
      const [p] = await tx.update(parties)
        .set({ kind: v.kind, legalName: v.legalName, tradeName: v.tradeName ?? null, docType: v.docType, document: v.document, updatedAt: new Date() })
        .where(and(eq(parties.id, id), eq(parties.companyId, companyId))).returning();
      if (!p) throw new Invalid("Cadastro não encontrado");
      await audit(tx as unknown as DB, companyId, actorId, "party.updated", { partyId: id });
      return p;
    });
  } catch (e) { if (pgCode(e) === "23505") throw new Invalid(DUP); throw e; }
}

/** Exclusão lógica: preserva histórico e vínculos futuros (contratos/cobranças). */
export async function setArchived(db: DB, actorId: string, companyId: string, id: string, archived: boolean) {
  await requirePerm(db, actorId, companyId, "crm.write");
  try {
    await db.transaction(async (tx) => {
      const r = await tx.update(parties).set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
        .where(and(eq(parties.id, id), eq(parties.companyId, companyId))).returning({ id: parties.id });
      if (!r.length) throw new Invalid("Cadastro não encontrado");
      await audit(tx as unknown as DB, companyId, actorId, archived ? "party.archived" : "party.restored", { partyId: id });
    });
  } catch (e) { if (pgCode(e) === "23505") throw new Invalid("Restaurar conflita com outro cadastro ativo de mesmo documento"); throw e; }
}

export async function addContact(db: DB, actorId: string, companyId: string, partyId: string, input: unknown) {
  await requirePerm(db, actorId, companyId, "crm.write");
  const c = contactSchema.safeParse(input);
  if (!c.success) throw new Invalid(firstIssue(c.error));
  const [p] = await db.select({ id: parties.id }).from(parties).where(and(eq(parties.id, partyId), eq(parties.companyId, companyId)));
  if (!p) throw new Invalid("Cadastro não encontrado");
  await db.insert(partyContacts).values({ companyId, partyId, ...c.data });
  await audit(db, companyId, actorId, "party.contact_added", { partyId });
}

export async function removeContact(db: DB, actorId: string, companyId: string, contactId: string) {
  await requirePerm(db, actorId, companyId, "crm.write");
  const [c] = await db.delete(partyContacts).where(and(eq(partyContacts.id, contactId), eq(partyContacts.companyId, companyId))).returning();
  if (!c) throw new Invalid("Contato não encontrado");
  await audit(db, companyId, actorId, "party.contact_removed", { partyId: c.partyId });
}

export async function history(db: DB, actorId: string, companyId: string, partyId: string) {
  await requirePerm(db, actorId, companyId, "crm.read");
  return db.select({ action: auditLog.action, at: auditLog.createdAt }).from(auditLog)
    .where(and(eq(auditLog.companyId, companyId), sql`${auditLog.detail}->>'partyId' = ${partyId}`))
    .orderBy(desc(auditLog.createdAt)).limit(50);
}

export type ListQuery = { q?: string; kind?: Kind; archived?: boolean; page?: number };

export async function listParties(db: DB, actorId: string, companyId: string, query: ListQuery) {
  await requirePerm(db, actorId, companyId, "crm.read");
  const page = Math.max(1, Math.floor(query.page ?? 1));
  const q = query.q?.trim().slice(0, 100);
  const like = q ? `%${q.replace(/[\\%_]/g, "\\$&")}%` : null;
  const digits = q?.toUpperCase().replace(/[^0-9A-Z]/g, "");
  const where = and(
    eq(parties.companyId, companyId),
    query.archived ? isNotNull(parties.archivedAt) : isNull(parties.archivedAt),
    query.kind ? eq(parties.kind, query.kind) : undefined,
    like ? or(ilike(parties.legalName, like), ilike(parties.tradeName, like), digits ? ilike(parties.document, `%${digits}%`) : undefined) : undefined,
  );
  const [{ total }] = await db.select({ total: count() }).from(parties).where(where);
  const rows = await db.select().from(parties).where(where)
    .orderBy(asc(parties.legalName), asc(parties.id)).limit(PAGE_SIZE).offset((page - 1) * PAGE_SIZE);
  return {
    page, pageSize: PAGE_SIZE, total, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    items: rows.map((r) => ({ ...r, documentFormatted: formatDocument(r.docType, r.document) })),
  };
}

// ---------- Importação CSV (prévia revisável + confirmação; revalidada no servidor) ----------
export type ImportRow = {
  line: number; status: "ok" | "erro" | "duplicado";
  kind?: Kind; legalName?: string; tradeName?: string; document?: string; email?: string; phone?: string; message?: string;
};
const HEADERS = ["tipo", "razao_social", "nome_fantasia", "documento", "email_financeiro", "telefone"] as const;
export const CSV_TEMPLATE = HEADERS.join(";") + "\ncliente;Empresa Exemplo Ltda;Exemplo;11.222.333/0001-81;financeiro@exemplo.com;(92) 99999-0000\n";

export async function previewImport(db: DB, actorId: string, companyId: string, text: string) {
  await requirePerm(db, actorId, companyId, "crm.write");
  if (Buffer.byteLength(text) > IMPORT_MAX_BYTES) throw new Invalid("Arquivo maior que 500 KB");
  const table = parseCsv(text);
  if (!table.length) throw new Invalid("Arquivo vazio");
  const head = table[0].map((h) => h.trim().toLowerCase());
  const missing = HEADERS.filter((h) => !head.includes(h) && h !== "nome_fantasia" && h !== "email_financeiro" && h !== "telefone");
  if (missing.length) throw new Invalid(`Colunas obrigatórias ausentes: ${missing.join(", ")}`);
  const body = table.slice(1);
  if (body.length > IMPORT_MAX_ROWS) throw new Invalid(`Máximo de ${IMPORT_MAX_ROWS} linhas por importação`);
  const col = (r: string[], n: string) => (r[head.indexOf(n)] ?? "").trim();

  const existing = await db.select({ kind: parties.kind, document: parties.document }).from(parties)
    .where(and(eq(parties.companyId, companyId), isNull(parties.archivedAt)));
  const seen = new Set(existing.map((e) => `${e.kind}:${e.document}`));

  const rows: ImportRow[] = body.map((r, i) => {
    const line = i + 2;
    const kind = col(r, "tipo").toLowerCase();
    const email = col(r, "email_financeiro");
    const base = { line, legalName: col(r, "razao_social"), tradeName: col(r, "nome_fantasia") || undefined, email: email || undefined, phone: col(r, "telefone") || undefined };
    if (kind !== "cliente" && kind !== "fornecedor") return { ...base, status: "erro", message: "tipo deve ser cliente ou fornecedor" };
    const p = partySchema.safeParse({ kind, legalName: base.legalName, tradeName: base.tradeName, document: col(r, "documento") });
    if (!p.success) return { ...base, kind, status: "erro", message: firstIssue(p.error) };
    const doc = parseDocument(p.data.document);
    if (!doc) return { ...base, kind, status: "erro", message: "CPF ou CNPJ inválido" };
    if (email && !z.string().email().safeParse(email).success) return { ...base, kind, document: doc.digits, status: "erro", message: "e-mail inválido" };
    const key = `${kind}:${doc.digits}`;
    if (seen.has(key)) return { ...base, kind, document: doc.digits, status: "duplicado", message: "já cadastrado ou repetido no arquivo" };
    seen.add(key);
    return { ...base, kind, document: doc.digits, status: "ok" };
  });
  return {
    rows,
    summary: { ok: rows.filter((r) => r.status === "ok").length, erro: rows.filter((r) => r.status === "erro").length, duplicado: rows.filter((r) => r.status === "duplicado").length },
  };
}

/** Reexecuta a validação no servidor (não confia na prévia do cliente) e grava só as linhas válidas. */
export async function importParties(db: DB, actorId: string, companyId: string, text: string) {
  const { rows } = await previewImport(db, actorId, companyId, text);
  const ok = rows.filter((r) => r.status === "ok");
  try { await db.transaction(async (tx) => {
    for (const r of ok) {
      const [p] = await tx.insert(parties).values({
        companyId, createdBy: actorId, kind: r.kind!, legalName: r.legalName!, tradeName: r.tradeName,
        docType: parseDocument(r.document!)!.type, document: r.document!,
      }).returning({ id: parties.id });
      if (r.email || r.phone) await tx.insert(partyContacts).values({ companyId, partyId: p.id, name: "Financeiro", email: r.email, phone: r.phone, isFinancial: true });
    }
    await audit(tx as unknown as DB, companyId, actorId, "party.imported", { imported: ok.length, skipped: rows.length - ok.length });
  }); } catch (e) {
    // colisão concorrente no índice único: nada foi gravado (transação revertida)
    if (pgCode(e) === "23505") throw new Invalid("Outro cadastro com o mesmo documento foi criado durante a importação. Revise e tente de novo.");
    throw e;
  }
  return { imported: ok.length, skipped: rows.length - ok.length };
}

export async function exportParties(db: DB, actorId: string, companyId: string, kind?: Kind) {
  await requirePerm(db, actorId, companyId, "crm.export");
  const rows = await db.select().from(parties)
    .where(and(eq(parties.companyId, companyId), isNull(parties.archivedAt), kind ? eq(parties.kind, kind) : undefined))
    .orderBy(asc(parties.legalName));
  const contacts = await db.select().from(partyContacts).where(and(eq(partyContacts.companyId, companyId), eq(partyContacts.isFinancial, true)));
  const byParty = new Map(contacts.map((c) => [c.partyId, c]));
  await audit(db, companyId, actorId, "party.exported", { count: rows.length });
  return toCsv([
    [...HEADERS],
    ...rows.map((r) => [r.kind, r.legalName, r.tradeName ?? "", formatDocument(r.docType, r.document), byParty.get(r.id)?.email ?? "", byParty.get(r.id)?.phone ?? ""]),
  ]);
}
