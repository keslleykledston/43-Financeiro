import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { eq, sql } from "drizzle-orm";
import { databaseUrl } from "@/lib/db/url";
import * as schema from "@/lib/db/schema";
import type { DB } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import { createParty } from "@/modules/crm/service";
import { createContract, decideVersion, getContract } from "@/modules/contracts/service";
import { generateBatch } from "@/modules/billing/batches";
import { activeInvoicePdf, attachInvoice, getInvoiceFile, invoiceFilename, invoiceHistory, invoicesForCharges, removeInvoice } from "@/modules/invoices/service";

const enabled = !!process.env.POSTGRES_USER;
const pdf = (tag = "nf") => new Uint8Array(Buffer.from(`%PDF-1.4\n% ${tag} ${"x".repeat(200)}\n%%EOF`));
const in2 = { number: "2026/55", issuedOn: "2026-10-01", verificationCode: "ABCD-1234" };

describe.skipIf(!enabled)("N1 — nota fiscal anexada à cobrança (DB de teste)", () => {
  let admin: ReturnType<typeof postgres>, conn: ReturnType<typeof postgres>, db: DB;
  let A: string, B: string, dirA: string, dirB: string, asstA: string, contabA: string, chA: string;

  beforeAll(async () => {
    const base = databaseUrl();
    admin = postgres(base.replace(/\/k3gfinance$/, "/postgres"), { max: 1 });
    if (!(await admin`select 1 from pg_database where datname = 'k3gfinance_test'`).length) await admin.unsafe("create database k3gfinance_test");
    conn = postgres(base.replace(/\/k3gfinance$/, "/k3gfinance_test"), { max: 4 });
    db = drizzle(conn, { schema });
    await migrate(db, { migrationsFolder: "./drizzle" });
  });
  afterAll(async () => { await conn?.end(); await admin?.end(); });

  beforeEach(async () => {
    await db.execute(sql`truncate charge_invoices, message_queue, message_template_versions, message_templates, charges, billing_batches, holidays, contract_versions, contracts, customer_contacts, customers, audit_log, memberships, companies, users restart identity cascade`);
    const [a, b] = await db.insert(schema.companies).values([{ name: "Empresa A" }, { name: "Empresa B" }]).returning();
    A = a.id; B = b.id;
    const mk = async (e: string) => (await db.insert(schema.users).values({ email: e, name: e, passwordHash: "x" }).returning())[0].id;
    dirA = await mk("dir-a@t.com"); dirB = await mk("dir-b@t.com"); asstA = await mk("asst@t.com"); contabA = await mk("contab@t.com");
    await db.insert(schema.memberships).values([{ userId: dirA, companyId: A, role: "diretoria" }, { userId: dirB, companyId: B, role: "diretoria" }, { userId: asstA, companyId: A, role: "assistente" }, { userId: contabA, companyId: A, role: "contabilidade" }]);
    const cli = (await createParty(db, dirA, A, { kind: "cliente", legalName: "Cliente Um", document: "11.222.333/0001-81" })).id;
    const k = await createContract(db, asstA, A, cli, { description: "Monitoramento", monthlyAmount: "2.500,00", startAt: "2026-01-01", endAt: "", dueDay: "14", invoiceJointRequired: true, issueDayOverride: "" });
    await decideVersion(db, dirA, A, (await getContract(db, dirA, A, k.id))!.versions[0].id, "aprovar");
    const { batchId } = await generateBatch(db, asstA, A, "2026-10-01");
    chA = (await db.select().from(schema.charges).where(eq(schema.charges.batchId, batchId)))[0].id;
  });

  it("anexa, lê (sem o PDF na listagem), baixa e audita sem dado pessoal", async () => {
    const r = await attachInvoice(db, asstA, A, chA, { ...in2, pdf: pdf() });
    expect(r.replaced).toBe(false);
    const m = await invoicesForCharges(db, contabA, A, [chA]);
    expect(m.get(chA)).toMatchObject({ number: "2026/55", issuedOn: "2026-10-01", verificationCode: "ABCD-1234" });
    expect(JSON.stringify([...m.values()])).not.toContain("%PDF");
    const f = await getInvoiceFile(db, contabA, A, r.invoiceId);
    expect(f!.filename).toBe("nota-fiscal-2026-55.pdf"); expect(Buffer.from(f!.pdf).subarray(0, 5).toString()).toBe("%PDF-");
    const au = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "invoice.attached"));
    expect(au).toHaveLength(1); expect(JSON.stringify(au)).not.toMatch(/2026\/55|ABCD/);
  });

  it("valida número, data, tamanho e tipo do arquivo", async () => {
    const bad = (o: Partial<{ number: string; issuedOn: string; verificationCode: string; pdf: Uint8Array }>) => attachInvoice(db, asstA, A, chA, { ...in2, pdf: pdf(), ...o });
    await expect(bad({ number: "" })).rejects.toThrow(Invalid);
    await expect(bad({ number: "<script>" })).rejects.toThrow(Invalid);
    await expect(bad({ issuedOn: "2026-13-40" })).rejects.toThrow(/inválida/);
    await expect(bad({ issuedOn: "2999-01-01" })).rejects.toThrow(/futura/);
    await expect(bad({ verificationCode: "a b;c" })).rejects.toThrow(Invalid);
    await expect(bad({ pdf: new Uint8Array(Buffer.from("MZ" + "x".repeat(300))) })).rejects.toThrow(/PDF/);
    await expect(bad({ pdf: new Uint8Array(10) })).rejects.toThrow(/vazio|pequeno/);
    await expect(bad({ pdf: new Uint8Array(Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(2_100_000)])) })).rejects.toThrow(/2 MB/);
    expect((await invoicesForCharges(db, dirA, A, [chA])).size).toBe(0);
  });

  it("só quem pode escrever anexa/remove; outra empresa não vê nem baixa; cobrança alheia é recusada", async () => {
    await expect(attachInvoice(db, contabA, A, chA, { ...in2, pdf: pdf() })).rejects.toThrow(Forbidden);
    await expect(attachInvoice(db, dirB, B, chA, { ...in2, pdf: pdf() })).rejects.toThrow(/não encontrada/);
    const r = await attachInvoice(db, asstA, A, chA, { ...in2, pdf: pdf() });
    expect(await getInvoiceFile(db, dirB, B, r.invoiceId)).toBeNull();
    expect((await invoicesForCharges(db, dirB, B, [chA])).size).toBe(0);
    await expect(removeInvoice(db, contabA, A, chA)).rejects.toThrow(Forbidden);
    expect(await getInvoiceFile(db, dirA, A, "nao-e-uuid")).toBeNull();
  });

  it("substituir arquiva a anterior (uma ativa); remover encerra; histórico permanece e é imutável no banco", async () => {
    const a = await attachInvoice(db, asstA, A, chA, { ...in2, pdf: pdf("v1") });
    const b = await attachInvoice(db, asstA, A, chA, { ...in2, number: "2026/56", pdf: pdf("v2") });
    expect(b.replaced).toBe(true);
    expect((await invoicesForCharges(db, dirA, A, [chA])).get(chA)!.number).toBe("2026/56");
    expect((await invoiceHistory(db, dirA, A, chA)).map((h) => h.status).sort()).toEqual(["ativa", "substituida"]);
    expect(await getInvoiceFile(db, dirA, A, a.invoiceId)).not.toBeNull(); // a antiga continua baixável
    await removeInvoice(db, asstA, A, chA);
    expect((await invoicesForCharges(db, dirA, A, [chA])).size).toBe(0);
    expect(await activeInvoicePdf(db, A, chA)).toBeNull();
    await expect(removeInvoice(db, asstA, A, chA)).rejects.toThrow(/não tem nota/);
    await expect(db.execute(sql`delete from charge_invoices`)).rejects.toThrow();
    await expect(db.execute(sql`update charge_invoices set number = 'X' where id = ${b.invoiceId}`)).rejects.toThrow();
    await expect(db.execute(sql`update charge_invoices set status = 'ativa', closed_at = null where id = ${b.invoiceId}`)).rejects.toThrow();
  });

  it("cobrança cancelada não recebe nota; PDF adulterado no banco nunca é anexado", async () => {
    const r = await attachInvoice(db, asstA, A, chA, { ...in2, pdf: pdf() });
    expect((await activeInvoicePdf(db, A, chA))!.pdf.length).toBeGreaterThan(100);
    await db.execute(sql`alter table charge_invoices disable trigger charge_invoices_guard_trg`);
    await expect(db.execute(sql`update charge_invoices set pdf = pdf || decode('41', 'hex'), size_bytes = size_bytes + 1 where id = ${r.invoiceId}`)).rejects.toThrow(); // o banco recusa PDF cujo hash não confere
    await db.execute(sql`alter table charge_invoices enable trigger charge_invoices_guard_trg`);
    await db.execute(sql`update charges set status = 'cancelada' where id = ${chA}`);
    await expect(attachInvoice(db, asstA, A, chA, { ...in2, pdf: pdf() })).rejects.toThrow(/cancelada/);
  });

  it("inserção direta no banco só aceita PDF íntegro, nasce ativa e com número/código válidos", async () => {
    const ins = (o: { pdf?: Buffer; sha?: string; number?: string; status?: string } = {}) => {
      const body = o.pdf ?? Buffer.from(`%PDF-1.4 ${"y".repeat(200)}`);
      const sha = o.sha ?? createHash("sha256").update(body).digest("hex");
      return db.insert(schema.chargeInvoices).values({ companyId: A, chargeId: chA, number: o.number ?? "77", issuedOn: "2026-10-01", pdf: body, pdfSha256: sha, sizeBytes: body.length, status: o.status ?? "ativa", ...(o.status && o.status !== "ativa" ? { closedAt: new Date() } : {}) });
    };
    await expect(ins({ pdf: Buffer.from("MZ" + "z".repeat(300)) })).rejects.toThrow();
    await expect(ins({ sha: "0".repeat(64) })).rejects.toThrow();
    await expect(ins({ number: "<b>" })).rejects.toThrow();
    await expect(ins({ status: "removida" })).rejects.toThrow();
    await ins(); // o caso válido passa
    expect((await invoicesForCharges(db, dirA, A, [chA])).get(chA)!.number).toBe("77");
  });

  it("nota não pode ser removida nem trocada enquanto um e-mail da cobrança está sendo enviado", async () => {
    await attachInvoice(db, asstA, A, chA, { ...in2, pdf: pdf() });
    const ch = (await db.select().from(schema.charges).where(eq(schema.charges.id, chA)))[0];
    await db.insert(schema.messageQueue).values({ companyId: A, chargeId: chA, customerId: ch.customerId, kind: "emissao", channel: "email", scheduledFor: "2026-10-01", status: "enviando" });
    await expect(removeInvoice(db, asstA, A, chA)).rejects.toThrow(/sendo enviado/);
    await expect(attachInvoice(db, asstA, A, chA, { ...in2, number: "2026/99", pdf: pdf("v2") })).rejects.toThrow(/sendo enviado/);
    await db.execute(sql`update message_queue set status = 'enviado'`);
    await removeInvoice(db, asstA, A, chA);
  });

  it("nome de arquivo do anexo é sempre seguro", () => {
    expect(invoiceFilename("12/3")).toBe("nota-fiscal-12-3.pdf");
    expect(invoiceFilename("../../x")).toMatch(/^nota-fiscal-[A-Za-z0-9._-]+\.pdf$/);
  });
});
