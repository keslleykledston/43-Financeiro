import { createHash } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { auditLog, chargeInvoices, charges } from "@/lib/db/schema";
import { Invalid, requirePerm } from "@/modules/identity/service";

/**
 * N1 — nota fiscal (NFS-e) ANEXADA à cobrança. A plataforma NÃO emite a nota aqui: a pessoa emite no emissor da prefeitura/contador e anexa o PDF; o e-mail real da cobrança leva o boleto E a nota juntos.
 * Cobrança de cliente que exige «boleto + NF» (contrato → NF junto) NÃO é enviada por e-mail real enquanto não houver nota ativa (a mensagem espera, ninguém recebe boleto sozinho).
 * Uma nota ativa por cobrança; substituir ou remover arquiva a anterior (histórico permanente, trigger no banco).
 */
export const MAX_NF_BYTES = 2_097_152;
const NUMBER = /^[0-9A-Za-z][0-9A-Za-z./-]{0,29}$/;
const CODE = /^[0-9A-Za-z./_-]{1,80}$/;
export type InvoiceInfo = { id: string; chargeId: string; number: string; issuedOn: string; verificationCode: string | null; sizeBytes: number; sha256: string; createdAt: Date };

const todayManaus = () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Manaus" });
const validDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
const cols = { id: chargeInvoices.id, chargeId: chargeInvoices.chargeId, number: chargeInvoices.number, issuedOn: chargeInvoices.issuedOn, verificationCode: chargeInvoices.verificationCode, sizeBytes: chargeInvoices.sizeBytes, sha256: chargeInvoices.pdfSha256, createdAt: chargeInvoices.createdAt };
const audit = (x: DB, companyId: string, actorId: string, action: string, detail: Record<string, unknown>) => x.insert(auditLog).values({ companyId, actorId, action, detail });

/** Nome de arquivo seguro para o anexo (o adaptador de e-mail só aceita [A-Za-z0-9._-]). */
export const invoiceFilename = (number: string) => `nota-fiscal-${number.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "nfse"}.pdf`;

export async function attachInvoice(db: DB, actorId: string, companyId: string, chargeId: string, input: { number: string; issuedOn: string; verificationCode?: string; pdf: Uint8Array }) {
  await requirePerm(db, actorId, companyId, "billing.write");
  const number = String(input.number ?? "").trim(), code = String(input.verificationCode ?? "").trim();
  if (!NUMBER.test(number)) throw new Invalid("Número da nota inválido (até 30 caracteres: letras, números, ponto, barra ou hífen)");
  if (!validDate(input.issuedOn)) throw new Invalid("Data de emissão da nota inválida");
  if (input.issuedOn > todayManaus()) throw new Invalid("A data de emissão da nota não pode ser futura");
  if (code && !CODE.test(code)) throw new Invalid("Código de verificação inválido (letras, números, ponto, barra, hífen ou sublinhado)");
  const pdf = Buffer.from(input.pdf);
  if (pdf.length < 100) throw new Invalid("O arquivo da nota está vazio ou pequeno demais para ser um PDF");
  if (pdf.length > MAX_NF_BYTES) throw new Invalid("O PDF da nota passa de 2 MB");
  if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Invalid("O arquivo da nota precisa ser um PDF");
  const sha = createHash("sha256").update(pdf).digest("hex");
  return db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    const [ch] = await x.select({ id: charges.id, status: charges.status }).from(charges).where(and(eq(charges.id, chargeId), eq(charges.companyId, companyId))).for("update");
    if (!ch) throw new Invalid("Cobrança não encontrada");
    if (ch.status === "cancelada") throw new Invalid("Cobrança cancelada: não recebe nota fiscal");
    const [busy] = (await x.execute(sql`select 1 as n from message_queue where company_id = ${companyId} and charge_id = ${chargeId} and channel = 'email' and status = 'enviando' limit 1`)) as unknown as { n: number }[];
    if (busy) throw new Invalid("Há um e-mail desta cobrança sendo enviado agora. Tente de novo em instantes");
    const closed = await x.update(chargeInvoices).set({ status: "substituida", closedBy: actorId, closedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(chargeInvoices.companyId, companyId), eq(chargeInvoices.chargeId, chargeId), eq(chargeInvoices.status, "ativa"))).returning({ id: chargeInvoices.id });
    const [row] = await x.insert(chargeInvoices).values({ companyId, chargeId, number, issuedOn: input.issuedOn, verificationCode: code || null, source: "manual", pdf, pdfSha256: sha, sizeBytes: pdf.length, createdBy: actorId }).returning({ id: chargeInvoices.id });
    await audit(x, companyId, actorId, "invoice.attached", { chargeId, invoiceId: row.id, replaced: closed.length > 0, sizeBytes: pdf.length, sha: sha.slice(0, 12) });
    return { invoiceId: row.id, replaced: closed.length > 0 };
  });
}

export async function removeInvoice(db: DB, actorId: string, companyId: string, chargeId: string) {
  await requirePerm(db, actorId, companyId, "billing.write");
  return db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await x.select({ id: charges.id }).from(charges).where(and(eq(charges.id, chargeId), eq(charges.companyId, companyId))).for("update");
    const [busy] = (await x.execute(sql`select 1 as n from message_queue where company_id = ${companyId} and charge_id = ${chargeId} and channel = 'email' and status = 'enviando' limit 1`)) as unknown as { n: number }[];
    if (busy) throw new Invalid("Há um e-mail desta cobrança sendo enviado agora. Tente de novo em instantes");
    const closed = await x.update(chargeInvoices).set({ status: "removida", closedBy: actorId, closedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(chargeInvoices.companyId, companyId), eq(chargeInvoices.chargeId, chargeId), eq(chargeInvoices.status, "ativa"))).returning({ id: chargeInvoices.id });
    if (closed.length === 0) throw new Invalid("Esta cobrança não tem nota fiscal anexada");
    await audit(x, companyId, actorId, "invoice.removed", { chargeId, invoiceId: closed[0].id });
  });
}

/** Notas ATIVAS das cobranças (sem o PDF). Uso interno do envio e da tela: o chamador já checou a permissão. */
export async function activeInvoices(x: DB, companyId: string, chargeIds: string[]): Promise<Map<string, InvoiceInfo>> {
  const ids = [...new Set(chargeIds)].filter((i) => /^[0-9a-f-]{36}$/i.test(i));
  const out = new Map<string, InvoiceInfo>();
  if (ids.length === 0) return out;
  const rows = await x.select(cols).from(chargeInvoices).where(and(eq(chargeInvoices.companyId, companyId), eq(chargeInvoices.status, "ativa"), inArray(chargeInvoices.chargeId, ids)));
  for (const r of rows) out.set(r.chargeId, r);
  return out;
}

export async function invoicesForCharges(db: DB, actorId: string, companyId: string, chargeIds: string[]) {
  await requirePerm(db, actorId, companyId, "billing.read");
  return activeInvoices(db, companyId, chargeIds);
}

/** PDF da nota ATIVA da cobrança (para anexar ao e-mail). null = não há nota ativa. Uso interno do envio. */
export async function activeInvoicePdf(x: DB, companyId: string, chargeId: string) {
  const [r] = await x.select({ ...cols, pdf: chargeInvoices.pdf }).from(chargeInvoices).where(and(eq(chargeInvoices.companyId, companyId), eq(chargeInvoices.chargeId, chargeId), eq(chargeInvoices.status, "ativa")));
  if (!r) return null;
  if (createHash("sha256").update(r.pdf).digest("hex") !== r.sha256) return null; // conteúdo não confere com o registrado: nunca anexa
  return r;
}

/** Download pela tela (qualquer nota do histórico da empresa). */
export async function getInvoiceFile(db: DB, actorId: string, companyId: string, invoiceId: string) {
  await requirePerm(db, actorId, companyId, "billing.read");
  if (!/^[0-9a-f-]{36}$/i.test(invoiceId)) return null;
  const [r] = await db.select({ number: chargeInvoices.number, pdf: chargeInvoices.pdf }).from(chargeInvoices).where(and(eq(chargeInvoices.id, invoiceId), eq(chargeInvoices.companyId, companyId)));
  return r ? { filename: invoiceFilename(r.number), pdf: r.pdf } : null;
}

export async function invoiceHistory(db: DB, actorId: string, companyId: string, chargeId: string) {
  await requirePerm(db, actorId, companyId, "billing.read");
  return db.select({ ...cols, status: chargeInvoices.status, closedAt: chargeInvoices.closedAt }).from(chargeInvoices).where(and(eq(chargeInvoices.companyId, companyId), eq(chargeInvoices.chargeId, chargeId))).orderBy(desc(chargeInvoices.createdAt));
}
