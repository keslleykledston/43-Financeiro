import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "@/lib/db";
import { auditLog, contractImports, contractVersions, contracts, customerContacts, customers } from "@/lib/db/schema";
import { parseCsv } from "@/lib/csv";
import { centsFromNumeric } from "@/lib/money";
import { parseDocument } from "@/lib/validators/document";
import { IMPORT_MAX_BYTES, IMPORT_MAX_ROWS, lockModeShared, readCustomerMode } from "@/modules/crm/service";
import { Forbidden, Invalid, activeRole, requirePerm } from "@/modules/identity/service";
import { insertDraft, parseTerms } from "./service";

/**
 * Importação de contratos (CSV gerado pelo conversor da planilha ou preenchido à mão).
 * 1 linha = 1 contrato. Cliente existente (por CNPJ/CPF) recebe o contrato; empresa em modo LOCAL cria o cliente que faltar;
 * empresa em modo CRM não cria cliente (vem do CRM): a linha vira pendência. Contratos nascem RASCUNHO e o lote é aprovado de uma vez.
 */
export const CONTRACT_IMPORT_TEMPLATE = "razao_social;documento;servico;valor_mensal;dia_vencimento;inicio;fim;email_financeiro;contato;parceiro_comissao\r\nEmpresa Exemplo Ltda;11.222.333/0001-81;Link dedicado;2.500,00;10;2026-01-01;;financeiro@exemplo.com;Maria;\r\n";

export type RowStatus = "ok" | "novo_cliente" | "cliente_ausente" | "ja_tem_contrato" | "duplicado" | "erro";
export type PreviewRow = {
  line: number; status: RowStatus; name: string; document?: string; description?: string; amountCents?: number; dueDay?: number;
  startAt?: string; endAt?: string | null; email?: string; contact?: string; commissionPartner?: string; message?: string; warning?: string;
};

const pgCode = (e: unknown): string | undefined => (e as { code?: string })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;
const audit = (db: DB, companyId: string, actorId: string, action: string, detail: Record<string, unknown>) => db.insert(auditLog).values({ companyId, actorId, action, detail });
const REQUIRED = ["razao_social", "documento", "servico", "valor_mensal", "dia_vencimento", "inicio"] as const;

export async function previewContractImport(db: DB, actorId: string, companyId: string, text: string) {
  await requirePerm(db, actorId, companyId, "contracts.write");
  if (Buffer.byteLength(text) > IMPORT_MAX_BYTES) throw new Invalid("Arquivo maior que 500 KB");
  const table = parseCsv(text);
  if (!table.length) throw new Invalid("Arquivo vazio");
  const head = table[0].map((h) => h.trim().toLowerCase());
  const missing = REQUIRED.filter((h) => !head.includes(h));
  if (missing.length) throw new Invalid(`Colunas obrigatórias ausentes: ${missing.join(", ")}`);
  const body = table.slice(1);
  if (body.length > IMPORT_MAX_ROWS) throw new Invalid(`Máximo de ${IMPORT_MAX_ROWS} linhas por importação`);
  const col = (r: string[], n: string) => (r[head.indexOf(n)] ?? "").trim();

  const crmMode = (await readCustomerMode(db, companyId)) === "crm";
  const known = new Map((await db.select({ id: customers.id, document: customers.document, status: customers.status }).from(customers).where(and(eq(customers.companyId, companyId), isNull(customers.archivedAt)))).map((c) => [c.document, c]));
  const withContract = new Set((await db.select({ customerId: contracts.customerId }).from(contracts).where(and(eq(contracts.companyId, companyId), ne(contracts.status, "encerrado")))).map((c) => c.customerId));

  const seen = new Set<string>();
  const rows: PreviewRow[] = body.map((r, i) => {
    const line = i + 2;
    const name = col(r, "razao_social");
    const base: PreviewRow = { line, status: "erro", name, email: col(r, "email_financeiro") || undefined, contact: col(r, "contato") || undefined };
    if (name.length < 2 || name.length > 200) return { ...base, message: "razão social deve ter de 2 a 200 caracteres" };
    const rawDoc = col(r, "documento");
    if (!rawDoc) return { ...base, message: "sem CNPJ/CPF na planilha" };
    const doc = parseDocument(rawDoc);
    if (!doc) return { ...base, message: "CNPJ/CPF inválido" };
    let t;
    try { t = parseTerms({ description: col(r, "servico"), monthlyAmount: col(r, "valor_mensal"), startAt: col(r, "inicio"), endAt: col(r, "fim"), dueDay: col(r, "dia_vencimento"), invoiceJointRequired: false, issueDayOverride: "" }); }
    catch (e) { return { ...base, document: doc.digits, message: e instanceof Invalid ? e.message : "dados do contrato inválidos" }; }
    if (base.email && !z.string().email().safeParse(base.email).success) return { ...base, document: doc.digits, message: "e-mail inválido" };
    const commission = col(r, "parceiro_comissao");
    if (commission && (commission.length < 2 || commission.length > 60)) return { ...base, document: doc.digits, message: "parceiro de comissão deve ter de 2 a 60 caracteres" };
    const ok: PreviewRow = { ...base, document: doc.digits, description: t.description, amountCents: t.monthlyAmountCents, dueDay: t.dueDay, startAt: t.startAt, endAt: t.endAt, commissionPartner: commission || undefined };
    if (seen.has(doc.digits)) return { ...ok, status: "duplicado", message: "documento repetido no arquivo (só a primeira linha vale)" };
    seen.add(doc.digits);
    const c = known.get(doc.digits);
    if (!c) return crmMode
      ? { ...ok, status: "cliente_ausente", message: "cliente não está no CRM desta empresa: cadastre no CRM e importe de novo" }
      : { ...ok, status: "novo_cliente", message: "cliente será criado como cadastro local" };
    if (withContract.has(c.id)) return { ...ok, status: "ja_tem_contrato", message: "o cliente já tem contrato (rascunho, ativo ou suspenso)" };
    return { ...ok, status: "ok", warning: c.status !== "ativo" ? `cliente ${c.status}: o contrato não gera cobrança enquanto o cliente não estiver ativo` : undefined };
  });
  const n = (s: RowStatus) => rows.filter((r) => r.status === s).length;
  return { rows, summary: { ok: n("ok"), novo_cliente: n("novo_cliente"), cliente_ausente: n("cliente_ausente"), ja_tem_contrato: n("ja_tem_contrato"), duplicado: n("duplicado"), erro: n("erro") } };
}

/** Revalida no servidor e grava tudo ou nada: cria o lote, os clientes locais que faltam e os contratos em rascunho. */
export async function importContracts(db: DB, actorId: string, companyId: string, text: string) {
  const { rows } = await previewContractImport(db, actorId, companyId, text);
  const todo = rows.filter((r) => r.status === "ok" || r.status === "novo_cliente");
  if (!todo.length) throw new Invalid("Nenhuma linha válida para importar");
  const creates = todo.filter((r) => r.status === "novo_cliente");
  if (creates.length) await requirePerm(db, actorId, companyId, "crm.write");
  try {
    return await db.transaction(async (tx) => {
      const x = tx as unknown as DB;
      await x.execute(sql`select pg_advisory_xact_lock(hashtext(${"contract-import:" + companyId}))`);
      await lockModeShared(x, companyId);
      if (creates.length && (await readCustomerMode(x, companyId)) === "crm") throw new Invalid("A origem dos clientes mudou para CRM durante a importação. Revise e tente de novo.");
      const [imp] = await x.insert(contractImports).values({ companyId, createdBy: actorId, summary: { contracts: todo.length, customersCreated: creates.length, skipped: rows.length - todo.length } }).returning();
      for (const r of todo) {
        let customerId: string;
        const [found] = await x.select({ id: customers.id }).from(customers).where(and(eq(customers.companyId, companyId), eq(customers.document, r.document!), isNull(customers.archivedAt)));
        if (found) {
          customerId = found.id;
          const [dup] = await x.select({ id: contracts.id }).from(contracts).where(and(eq(contracts.companyId, companyId), eq(contracts.customerId, customerId), ne(contracts.status, "encerrado"))).limit(1);
          if (dup) throw new Invalid("Um cliente do arquivo ganhou contrato durante a importação. Revise e tente de novo.");
        } else {
          if (r.status !== "novo_cliente") throw new Invalid("Um cliente do arquivo sumiu durante a importação. Revise e tente de novo.");
          const [c] = await x.insert(customers).values({ companyId, createdBy: actorId, legalName: r.name, docType: parseDocument(r.document!)!.type, document: r.document!, status: "ativo", source: "csv" }).returning({ id: customers.id });
          customerId = c.id;
          if (r.email || r.contact) await x.insert(customerContacts).values({ companyId, partyId: c.id, name: r.contact || "Financeiro", email: r.email, isFinancial: true, source: "csv" });
        }
        const t = parseTerms({ description: r.description, monthlyAmount: (r.amountCents! / 100).toFixed(2).replace(".", ","), startAt: r.startAt, endAt: r.endAt ?? "", dueDay: r.dueDay, invoiceJointRequired: false, issueDayOverride: "" });
        await insertDraft(x, actorId, companyId, customerId, t, "Importado da planilha", { importId: imp.id, commissionPartner: r.commissionPartner ?? null });
      }
      await audit(x, companyId, actorId, "contract.imported", { importId: imp.id, contracts: todo.length, customersCreated: creates.length, skipped: rows.length - todo.length });
      return { importId: imp.id, contracts: todo.length, customersCreated: creates.length, skipped: rows.length - todo.length };
    });
  } catch (e) {
    if (pgCode(e) === "23505") throw new Invalid("Outro cadastro com o mesmo documento foi criado durante a importação. Revise e tente de novo.");
    throw e;
  }
}

export async function listImports(db: DB, actorId: string, companyId: string) {
  await requirePerm(db, actorId, companyId, "contracts.read");
  const rows = await db.select().from(contractImports).where(eq(contractImports.companyId, companyId)).orderBy(desc(contractImports.createdAt)).limit(50);
  const counts = rows.length ? await db.select({ importId: contracts.importId, status: contracts.status, n: sql<number>`count(*)::int` }).from(contracts).where(and(eq(contracts.companyId, companyId), inArray(contracts.importId, rows.map((r) => r.id)))).groupBy(contracts.importId, contracts.status) : [];
  return rows.map((r) => ({ id: r.id, createdAt: r.createdAt, summary: r.summary as { contracts: number; customersCreated: number; skipped: number }, byStatus: Object.fromEntries(counts.filter((c) => c.importId === r.id).map((c) => [c.status, c.n])) as Record<string, number> }));
}

export async function getImport(db: DB, actorId: string, companyId: string, id: string) {
  await requirePerm(db, actorId, companyId, "contracts.read");
  if (!z.string().uuid().safeParse(id).success) return null;
  const [imp] = await db.select().from(contractImports).where(and(eq(contractImports.id, id), eq(contractImports.companyId, companyId)));
  if (!imp) return null;
  const items = await db.select({ c: contracts, customerName: customers.displayName, version: sql<string | null>`(select v.state from contract_versions v where v.contract_id = ${contracts.id} order by v.version desc limit 1)` }).from(contracts)
    .innerJoin(customers, and(eq(customers.id, contracts.customerId), eq(customers.companyId, contracts.companyId))).where(and(eq(contracts.companyId, companyId), eq(contracts.importId, id))).orderBy(customers.displayName);
  return { id: imp.id, createdAt: imp.createdAt, createdBy: imp.createdBy, summary: imp.summary as { contracts: number; customersCreated: number; skipped: number },
    items: items.map((r) => ({ id: r.c.id, customerName: r.customerName, description: r.c.description, amountCents: centsFromNumeric(r.c.monthlyAmount), dueDay: r.c.dueDay, startAt: r.c.startAt, endAt: r.c.endAt, status: r.c.status, commissionPartner: r.c.commissionPartner, lastVersionState: r.version })) };
}

/** Aprova ou rejeita de uma vez as versões iniciais ainda pendentes do lote (tudo ou nada). Mesmas regras do contrato individual: quem importou não aprova (exceto diretoria). */
export async function decideImport(db: DB, actorId: string, companyId: string, importId: string, decision: "aprovar" | "rejeitar", note?: string) {
  await requirePerm(db, actorId, companyId, "contracts.approve");
  const role = await activeRole(db, actorId, companyId);
  if (!z.string().uuid().safeParse(importId).success) throw new Invalid("Lote inválido");
  return db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await x.execute(sql`select pg_advisory_xact_lock(hashtext(${"contract-import:" + companyId}))`);
    const [imp] = await x.select().from(contractImports).where(and(eq(contractImports.id, importId), eq(contractImports.companyId, companyId)));
    if (!imp) throw new Invalid("Lote não encontrado");
    // ordem de travas: contratos → versões (a mesma de proposeChange/decideVersion), sempre por id
    const locked = await x.select({ id: contracts.id }).from(contracts).where(and(eq(contracts.companyId, companyId), eq(contracts.importId, importId), eq(contracts.status, "rascunho"))).orderBy(contracts.id).for("update");
    const pend = locked.length ? await x.select({ v: contractVersions, c: contracts }).from(contractVersions)
      .innerJoin(contracts, and(eq(contracts.id, contractVersions.contractId), eq(contracts.companyId, contractVersions.companyId)))
      .where(and(eq(contracts.companyId, companyId), inArray(contracts.id, locked.map((l) => l.id)), eq(contractVersions.state, "pendente"))).orderBy(contractVersions.id).for("update", { of: contractVersions }) : [];
    if (!pend.length) throw new Invalid("Nada pendente neste lote");
    if (decision === "aprovar" && role !== "diretoria" && pend.some(({ v }) => v.requestedBy === actorId)) throw new Forbidden("Quem importou ou editou estes contratos não pode aprová-los (exige outro gerente ou a diretoria)");
    const now = new Date();
    for (const { v, c } of pend) {
      if (decision === "aprovar") await x.update(contracts).set({ status: "ativo", updatedAt: now }).where(eq(contracts.id, c.id));
      await x.update(contractVersions).set({ state: decision === "aprovar" ? "aprovada" : "rejeitada", decidedBy: actorId, decidedAt: now, decisionNote: note?.trim().slice(0, 500) || null, updatedAt: now }).where(eq(contractVersions.id, v.id));
    }
    await audit(x, companyId, actorId, decision === "aprovar" ? "contract.import_approved" : "contract.import_rejected", { importId, contracts: pend.length });
    return pend.length;
  });
}
