import { and, asc, count, desc, eq, ilike, isNotNull, isNull, or, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { DB } from "@/lib/db";
import { auditLog, companies, customerContacts, customers, vendorContacts, vendors } from "@/lib/db/schema";
import { parseCsv, toCsv } from "@/lib/csv";
import { formatDocument, parseDocument } from "@/lib/validators/document";
import { Invalid, requirePerm } from "@/modules/identity/service";

export type Kind = "cliente" | "fornecedor";
export const PAGE_SIZE = 20;
export const IMPORT_MAX_ROWS = 1000;
export const IMPORT_MAX_BYTES = 500_000;

// Desenho original: `customers` + `customer_contacts` e `vendors` (+ contatos). Colunas idênticas,
// então o serviço escolhe a tabela pelo tipo. O cast preserva a tipagem (mesmo formato de colunas).
const tables = (k: Kind) =>
  k === "cliente"
    ? { main: customers, contacts: customerContacts }
    : { main: vendors as unknown as typeof customers, contacts: vendorContacts as unknown as typeof customerContacts };

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

/** Descobre em qual tabela o ID existe — sempre filtrando pela empresa (ID de outra empresa => null). */
async function kindOf(db: DB, companyId: string, id: string): Promise<Kind | null> {
  for (const k of ["cliente", "fornecedor"] as const) {
    const { main } = tables(k);
    const [r] = await db.select({ id: main.id }).from(main).where(and(eq(main.id, id), eq(main.companyId, companyId)));
    if (r) return k;
  }
  return null;
}

// ---------- Modo de origem dos clientes (por empresa) ----------
export type CustomerMode = "local" | "crm";
export const CRM_MODE_MSG = "Nesta empresa os clientes vêm do CRM (somente leitura). Cadastre ou altere no CRM.";

const modeLockKey = (companyId: string) => `cust-mode:${companyId}`;
/** Escritas de cliente tomam a trava COMPARTILHADA; a troca de modo, a EXCLUSIVA. Assim, modo e gravação nunca se cruzam (sem TOCTOU).
 *  Ordem de travas no sistema: `crm-sync:` → `cust-mode:` (nunca o inverso). */
export const lockModeShared = (db: DB, companyId: string) => db.execute(sql`select pg_advisory_xact_lock_shared(hashtext(${modeLockKey(companyId)}))`);
const lockModeExclusive = (db: DB, companyId: string) => db.execute(sql`select pg_advisory_xact_lock(hashtext(${modeLockKey(companyId)}))`);

/** USO INTERNO, sem autorização: quem chama já validou empresa e permissão (ou está dentro de uma transação travada). */
export async function readCustomerMode(db: DB, companyId: string): Promise<CustomerMode> {
  const [c] = await db.select({ m: companies.customerMode }).from(companies).where(eq(companies.id, companyId));
  return c?.m === "crm" ? "crm" : "local";
}

/** Para páginas e ações: só quem é membro da empresa lê o modo. */
export async function getCustomerMode(db: DB, actorId: string, companyId: string): Promise<CustomerMode> {
  await requirePerm(db, actorId, companyId, "crm.read");
  return readCustomerMode(db, companyId);
}

/** Trocar o modo muda a governança dos dados: exige gerir integrações E gravar clientes (hoje: diretoria). Auditado e serializado com as escritas. */
export async function setCustomerMode(db: DB, actorId: string, companyId: string, mode: CustomerMode) {
  await requirePerm(db, actorId, companyId, "integrations.manage");
  await requirePerm(db, actorId, companyId, "crm.write");
  if (mode !== "local" && mode !== "crm") throw new Invalid("Modo inválido");
  await db.transaction(async (tx) => {
    const t = tx as unknown as DB;
    await lockModeExclusive(t, companyId); // espera as escritas em curso; novas escritas esperam esta troca
    const from = await readCustomerMode(t, companyId);
    if (from === mode) return;
    await t.update(companies).set({ customerMode: mode, updatedAt: new Date() }).where(eq(companies.id, companyId));
    await audit(t, companyId, actorId, "company.customer_mode_changed", { from, to: mode });
  });
}

/** No modo CRM, cadastro sincronizado é somente leitura (o CRM é a fonte de verdade; edição local seria desfeita na próxima sincronização).
 *  No modo local, o mesmo cadastro é editável. Chamar DENTRO da transação, depois de `lockModeShared`. */
async function assertNotCrmOwned(db: DB, main: typeof customers, companyId: string, id: string) {
  const [r] = await db.select({ source: main.source }).from(main).where(and(eq(main.id, id), eq(main.companyId, companyId)));
  if (r?.source === "crm" && (await readCustomerMode(db, companyId)) === "crm") throw new Invalid("Este cadastro é sincronizado do CRM e não pode ser alterado aqui. Edite no CRM.");
}

export async function createParty(db: DB, actorId: string, companyId: string, input: unknown) {
  await requirePerm(db, actorId, companyId, "crm.write");
  const v = normalize(input);
  const { main } = tables(v.kind);
  try {
    return await db.transaction(async (tx) => {
      await lockModeShared(tx as unknown as DB, companyId);
      if (v.kind === "cliente" && (await readCustomerMode(tx as unknown as DB, companyId)) === "crm") throw new Invalid(CRM_MODE_MSG); // relido DENTRO da transação travada
      const [p] = await tx.insert(main).values({ companyId, createdBy: actorId, legalName: v.legalName, tradeName: v.tradeName, docType: v.docType, document: v.document }).returning();
      await audit(tx as unknown as DB, companyId, actorId, "party.created", { partyId: p.id, kind: v.kind });
      return { ...p, kind: v.kind };
    });
  } catch (e) { if (pgCode(e) === "23505") throw new Invalid(DUP); throw e; }
}

export async function getParty(db: DB, actorId: string, companyId: string, id: string) {
  await requirePerm(db, actorId, companyId, "crm.read");
  const kind = await kindOf(db, companyId, id);
  if (!kind) return null;
  const { main, contacts } = tables(kind);
  const [p] = await db.select().from(main).where(and(eq(main.id, id), eq(main.companyId, companyId)));
  const list = await db.select().from(contacts)
    .where(and(eq(contacts.partyId, id), eq(contacts.companyId, companyId))).orderBy(asc(contacts.createdAt));
  return { ...p, kind, contacts: list, documentFormatted: formatDocument(p.docType, p.document) };
}

export async function updateParty(db: DB, actorId: string, companyId: string, id: string, input: unknown) {
  await requirePerm(db, actorId, companyId, "crm.write");
  const kind = await kindOf(db, companyId, id);
  if (!kind) throw new Invalid("Cadastro não encontrado");
  const v = normalize({ ...(input as object), kind }); // o tipo não muda na edição
  const { main } = tables(kind);
  try {
    return await db.transaction(async (tx) => {
      await lockModeShared(tx as unknown as DB, companyId);
      await assertNotCrmOwned(tx as unknown as DB, main, companyId, id);
      const [p] = await tx.update(main)
        .set({ legalName: v.legalName, tradeName: v.tradeName ?? null, docType: v.docType, document: v.document, updatedAt: new Date() })
        .where(and(eq(main.id, id), eq(main.companyId, companyId))).returning();
      await audit(tx as unknown as DB, companyId, actorId, "party.updated", { partyId: id });
      return { ...p, kind };
    });
  } catch (e) { if (pgCode(e) === "23505") throw new Invalid(DUP); throw e; }
}

/** Exclusão lógica: preserva histórico e vínculos futuros (contratos/cobranças). */
export async function setArchived(db: DB, actorId: string, companyId: string, id: string, archived: boolean) {
  await requirePerm(db, actorId, companyId, "crm.write");
  const kind = await kindOf(db, companyId, id);
  if (!kind) throw new Invalid("Cadastro não encontrado");
  const { main } = tables(kind);
  try {
    await db.transaction(async (tx) => {
      await lockModeShared(tx as unknown as DB, companyId);
      await assertNotCrmOwned(tx as unknown as DB, main, companyId, id);
      await tx.update(main).set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
        .where(and(eq(main.id, id), eq(main.companyId, companyId)));
      await audit(tx as unknown as DB, companyId, actorId, archived ? "party.archived" : "party.restored", { partyId: id });
    });
  } catch (e) { if (pgCode(e) === "23505") throw new Invalid("Restaurar conflita com outro cadastro ativo de mesmo documento"); throw e; }
}

export async function addContact(db: DB, actorId: string, companyId: string, partyId: string, input: unknown) {
  await requirePerm(db, actorId, companyId, "crm.write");
  const c = contactSchema.safeParse(input);
  if (!c.success) throw new Invalid(firstIssue(c.error));
  const kind = await kindOf(db, companyId, partyId);
  if (!kind) throw new Invalid("Cadastro não encontrado");
  await db.insert(tables(kind).contacts).values({ companyId, partyId, ...c.data });
  await audit(db, companyId, actorId, "party.contact_added", { partyId });
}

export async function removeContact(db: DB, actorId: string, companyId: string, contactId: string) {
  await requirePerm(db, actorId, companyId, "crm.write");
  await db.transaction(async (tx) => {
    const t = tx as unknown as DB;
    await lockModeShared(t, companyId);
    for (const k of ["cliente", "fornecedor"] as const) {
      const { contacts } = tables(k);
      const [c] = await t.select().from(contacts).where(and(eq(contacts.id, contactId), eq(contacts.companyId, companyId)));
      if (!c) continue;
      if (c.source === "crm" && (await readCustomerMode(t, companyId)) === "crm") throw new Invalid("Contato sincronizado do CRM: remova no CRM.");
      await t.delete(contacts).where(eq(contacts.id, contactId));
      await audit(t, companyId, actorId, "party.contact_removed", { partyId: c.partyId });
      return;
    }
    throw new Invalid("Contato não encontrado");
  });
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
  const where = (t: typeof customers) => and(
    eq(t.companyId, companyId),
    query.archived ? isNotNull(t.archivedAt) : isNull(t.archivedAt),
    like ? or(ilike(t.legalName, like), ilike(t.tradeName, like), digits ? ilike(t.document, `%${digits}%`) : undefined) : undefined,
  );
  const sel = (k: Kind) => {
    const { main: t } = tables(k);
    return db.select({
      id: t.id, legalName: t.legalName, tradeName: t.tradeName, docType: t.docType, document: t.document,
      archivedAt: t.archivedAt, source: t.source, kind: sql<Kind>`${sql.raw(`'${k}'`)}::text`.as("kind"),
    }).from(t).where(where(t));
  };
  const kinds: Kind[] = query.kind ? [query.kind] : ["cliente", "fornecedor"];
  let total = 0;
  for (const k of kinds) { const { main: t } = tables(k); total += (await db.select({ n: count() }).from(t).where(where(t)))[0].n; }
  const lists = kinds.map(sel);
  const base = lists.length === 1 ? lists[0] : unionAll(lists[0], lists[1]);
  const rows = await (base as typeof lists[0]).orderBy(asc(sql`legal_name`), asc(sql`id`)).limit(PAGE_SIZE).offset((page - 1) * PAGE_SIZE);
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
  const missing = ["tipo", "razao_social", "documento"].filter((h) => !head.includes(h));
  if (missing.length) throw new Invalid(`Colunas obrigatórias ausentes: ${missing.join(", ")}`);
  const body = table.slice(1);
  if (body.length > IMPORT_MAX_ROWS) throw new Invalid(`Máximo de ${IMPORT_MAX_ROWS} linhas por importação`);
  const col = (r: string[], n: string) => (r[head.indexOf(n)] ?? "").trim();

  const crmMode = (await readCustomerMode(db, companyId)) === "crm";
  const seen = new Set<string>();
  for (const k of ["cliente", "fornecedor"] as const) {
    const { main: t } = tables(k);
    for (const e of await db.select({ document: t.document }).from(t).where(and(eq(t.companyId, companyId), isNull(t.archivedAt)))) seen.add(`${k}:${e.document}`);
  }

  const rows: ImportRow[] = body.map((r, i) => {
    const line = i + 2;
    const kind = col(r, "tipo").toLowerCase();
    const email = col(r, "email_financeiro");
    const base = { line, legalName: col(r, "razao_social"), tradeName: col(r, "nome_fantasia") || undefined, email: email || undefined, phone: col(r, "telefone") || undefined };
    if (kind !== "cliente" && kind !== "fornecedor") return { ...base, status: "erro", message: "tipo deve ser cliente ou fornecedor" };
    if (kind === "cliente" && crmMode) return { ...base, kind, status: "erro", message: "clientes vêm do CRM nesta empresa" };
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
    await lockModeShared(tx as unknown as DB, companyId);
    // a prévia pode estar velha: se a empresa virou CRM no meio do caminho, nenhum cliente é gravado
    if (ok.some((r) => r.kind === "cliente") && (await readCustomerMode(tx as unknown as DB, companyId)) === "crm") throw new Invalid("A origem dos clientes mudou para CRM durante a importação. Revise e tente de novo.");
    for (const r of ok) {
      const { main, contacts } = tables(r.kind!);
      const [p] = await tx.insert(main).values({
        companyId, createdBy: actorId, legalName: r.legalName!, tradeName: r.tradeName,
        docType: parseDocument(r.document!)!.type, document: r.document!, source: "csv",
      }).returning({ id: main.id });
      if (r.email || r.phone) await tx.insert(contacts).values({ companyId, partyId: p.id, name: "Financeiro", email: r.email, phone: r.phone, isFinancial: true });
    }
    await audit(tx as unknown as DB, companyId, actorId, "party.imported", { imported: ok.length, skipped: rows.length - ok.length, source: "csv" });
  }); } catch (e) {
    // colisão concorrente no índice único: nada foi gravado (transação revertida)
    if (pgCode(e) === "23505") throw new Invalid("Outro cadastro com o mesmo documento foi criado durante a importação. Revise e tente de novo.");
    throw e;
  }
  return { imported: ok.length, skipped: rows.length - ok.length };
}

export async function exportParties(db: DB, actorId: string, companyId: string, kind?: Kind) {
  await requirePerm(db, actorId, companyId, "crm.export");
  const out: string[][] = [];
  for (const k of (kind ? [kind] : ["cliente", "fornecedor"]) as Kind[]) {
    const { main, contacts } = tables(k);
    const rows = await db.select().from(main).where(and(eq(main.companyId, companyId), isNull(main.archivedAt)));
    const fin = await db.select().from(contacts).where(and(eq(contacts.companyId, companyId), eq(contacts.isFinancial, true)));
    const byParty = new Map(fin.map((c) => [c.partyId, c]));
    for (const r of rows) out.push([k, r.legalName, r.tradeName ?? "", formatDocument(r.docType, r.document), byParty.get(r.id)?.email ?? "", byParty.get(r.id)?.phone ?? ""]);
  }
  out.sort((a, b) => a[1].localeCompare(b[1], "pt-BR"));
  await audit(db, companyId, actorId, "party.exported", { count: out.length });
  return toCsv([[...HEADERS], ...out]);
}
