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
import { exportDivergencesCsv, getHistoryReport, importLegacy, removeDocumentFix, removeLegacyImport, saveDocumentFix, sha256 } from "@/modules/history/service";
import type { Entry } from "@/modules/contracts/planilha";

const enabled = !!process.env.POSTGRES_USER;
const SHA = sha256("arquivo de teste"), SHA2 = sha256("outro arquivo");
const why = (e: unknown) => String((e as { cause?: { message?: string } })?.cause?.message ?? (e as Error)?.message ?? e);
const entry = (o: Partial<Entry> = {}): Entry => ({ block: "solutions", month: "2026-01", name: "ALFA REDES LTDA", documentRaw: "11.222.333/0001-81", grossCents: 100000, netCents: 100000, planoCents: null, excedenteCents: null, dueDay: 10, service: "Link", obs: "medina", email: "fin@alfa.example", contact: "Ana", paidRaw: null, sheet: "Boletos JAN 2026", row: 5, dueOn: "2026-01-10", paidOn: "2026-01-11", ...o });

describe.skipIf(!enabled)("H1 — staging do histórico (DB de teste)", () => {
  let admin: ReturnType<typeof postgres>, conn: ReturnType<typeof postgres>, db: DB;
  let A: string, B: string, dirA: string, dirB: string, gerA: string, asstA: string, contA: string, techA: string, cliA: string;
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
    await db.execute(sql`truncate legacy_document_fixes, legacy_billing_rows, legacy_imports, customer_contacts, customers, audit_log, memberships, companies, users restart identity cascade`);
    const [a, b] = await db.insert(schema.companies).values([{ name: "Empresa A" }, { name: "Empresa B" }]).returning();
    A = a.id; B = b.id;
    const mk = async (e: string) => (await db.insert(schema.users).values({ email: e, name: e, passwordHash: "x" }).returning())[0].id;
    dirA = await mk("dir-a@t.com"); dirB = await mk("dir-b@t.com"); gerA = await mk("ger@t.com"); asstA = await mk("asst@t.com"); contA = await mk("cont@t.com"); techA = await mk("tech@t.com");
    await db.insert(schema.memberships).values([{ userId: dirA, companyId: A, role: "diretoria" }, { userId: dirB, companyId: B, role: "diretoria" }, { userId: gerA, companyId: A, role: "gerente" }, { userId: asstA, companyId: A, role: "assistente" }, { userId: contA, companyId: A, role: "contabilidade" }, { userId: techA, companyId: A, role: "admin_tecnico" }]);
    cliA = (await createParty(db, dirA, A, { kind: "cliente", legalName: "Alfa", document: "11.222.333/0001-81" })).id;
  });
  const rows = [entry(), entry({ row: 6, name: "BETA", documentRaw: "99.999.999/0001-91", dueOn: "2026-05-10", paidOn: null, netCents: null }), entry({ row: 7, name: "SEM DOC", documentRaw: "" }), entry({ row: 8, name: "RUIM", documentRaw: "11.111.111/1111-11", paidOn: "2026-06-30" })];
  const count = async () => Number((await db.execute(sql`select count(*)::int n from legacy_billing_rows`))[0].n);

  it("importar: só diretoria; grava linhas como vieram, liga ao cliente existente, é idempotente e audita sem dados", async () => {
    for (const u of [gerA, asstA, contA, techA]) await expect(importLegacy(db, u, A, { fileSha256: SHA, fileLabel: "x", year: 2026, entries: rows })).rejects.toBeInstanceOf(Forbidden);
    await expect(importLegacy(db, dirB, A, { fileSha256: SHA, fileLabel: "x", year: 2026, entries: rows })).rejects.toBeInstanceOf(Forbidden);
    await expect(importLegacy(db, dirA, A, { fileSha256: "xx", fileLabel: "x", year: 2026, entries: rows })).rejects.toThrow(/Hash/);
    await expect(importLegacy(db, dirA, A, { fileSha256: SHA, fileLabel: "x", year: 2026, entries: [] })).rejects.toBeInstanceOf(Invalid);
    const r = await importLegacy(db, dirA, A, { fileSha256: SHA, fileLabel: "Boletos (planilha)", year: 2026, entries: rows });
    expect(r).toMatchObject({ rows: 4, already: false, linked: 1 }); // só ALFA tem cliente com esse documento (BETA: válido mas não cadastrado; SEM DOC e RUIM: sem chave)
    expect(await count()).toBe(4);
    const again = await importLegacy(db, dirA, A, { fileSha256: SHA, fileLabel: "Boletos (planilha)", year: 2026, entries: rows });
    expect(again).toMatchObject({ already: true, importId: r.importId }); expect(await count()).toBe(4);
    const [a] = await db.select().from(schema.legacyBillingRows).where(eq(schema.legacyBillingRows.rowNumber, 5));
    expect(a).toMatchObject({ customerName: "ALFA REDES LTDA", document: "11222333000181", customerId: cliA, grossAmount: "1000.00", netAmount: "1000.00", dueOn: "2026-01-10", paidOn: "2026-01-11", month: "2026-01", sheet: "Boletos JAN 2026" });
    const log = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "history.imported"));
    expect(log).toHaveLength(1); expect(JSON.stringify(log)).not.toMatch(/ALFA|11222333|fin@alfa/);
    // nenhuma tabela operacional foi tocada
    for (const t of ["charges", "payments", "contracts", "billing_batches", "message_queue"]) expect(Number((await db.execute(sql.raw(`select count(*)::int n from ${t}`)))[0].n)).toBe(0);
    expect(Number((await db.execute(sql`select count(*)::int n from customers`))[0].n)).toBe(1); // nenhum cliente criado
  });

  it("relatório: totais, divergências e permissões de leitura; empresa isolada", async () => {
    expect((await getHistoryReport(db, dirA, A, "2026-10-24")).report).toBeNull();
    await importLegacy(db, dirA, A, { fileSha256: SHA, fileLabel: "x", year: 2026, entries: rows });
    for (const u of [dirA, gerA, contA]) expect((await getHistoryReport(db, u, A, "2026-10-24")).report!.rows).toBe(4);
    for (const u of [asstA, techA]) await expect(getHistoryReport(db, u, A, "2026-10-24")).rejects.toBeInstanceOf(Forbidden);
    await expect(getHistoryReport(db, dirB, A, "2026-10-24")).rejects.toBeInstanceOf(Forbidden);
    expect((await getHistoryReport(db, dirB, B, "2026-10-24")).report).toBeNull();
    const { report } = await getHistoryReport(db, dirA, A, "2026-10-24");
    expect(report!.counts).toMatchObject({ vencimento_fora_da_aba: 1, sem_documento: 1, documento_invalido: 1, fora_do_cadastro: 1, pagamento_muito_tardio: 1 });
    expect(report!.totals.billedCents).toBe(400000);
    expect(report!.months[0]).toMatchObject({ rows: 4, paidRows: 3, openRows: 1 });
  });

  it("CSV de divergências: só quem lê; cabeçalho e proteção contra fórmula", async () => {
    await importLegacy(db, dirA, A, { fileSha256: SHA, fileLabel: "x", year: 2026, entries: [entry({ name: "=CMD()", documentRaw: "" })] });
    const csv = await exportDivergencesCsv(db, contA, A, "2026-10-24");
    expect(csv).toContain("tipo;gravidade;aba;linha;mes_da_aba;cliente;documento;detalhe");
    expect(csv).toContain("Cliente sem CNPJ/CPF"); expect(csv).not.toMatch(/;=CMD/);
    await expect(exportDivergencesCsv(db, asstA, A, "2026-10-24")).rejects.toBeInstanceOf(Forbidden);
  });

  it("uma nova importação (outro arquivo) passa a ser a usada; desfazer apaga só o staging", async () => {
    const r1 = await importLegacy(db, dirA, A, { fileSha256: SHA, fileLabel: "v1", year: 2026, entries: rows });
    await new Promise((r) => setTimeout(r, 20));
    const r2 = await importLegacy(db, dirA, A, { fileSha256: SHA2, fileLabel: "v2", year: 2026, entries: [entry()] });
    const cur = await getHistoryReport(db, dirA, A, "2026-10-24");
    expect(cur.imports).toHaveLength(2); expect(cur.current!.id).toBe(r2.importId); expect(cur.report!.rows).toBe(1);
    await expect(removeLegacyImport(db, gerA, A, r2.importId)).rejects.toBeInstanceOf(Forbidden);
    await expect(removeLegacyImport(db, dirB, B, r2.importId)).rejects.toThrow(/não encontrada/); // de outra empresa
    await removeLegacyImport(db, dirA, A, r2.importId);
    expect((await getHistoryReport(db, dirA, A, "2026-10-24")).current!.id).toBe(r1.importId);
    expect(await count()).toBe(4);
    const rm = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "history.import_removed")); expect(rm).toHaveLength(1);
    expect(Number((await db.execute(sql`select count(*)::int n from customers`))[0].n)).toBe(1);
  });

  it("valor da cobrança pela regra do bloco (Solutions = bruto; Call = plano + excedente), guardado na importação (Codex H1 P1)", async () => {
    await importLegacy(db, dirA, A, { fileSha256: SHA, fileLabel: "x", year: 2026, entries: [entry({ row: 10 }), entry({ row: 11, block: "call", grossCents: null, planoCents: 79800, excedenteCents: 12000, netCents: null, paidOn: null })] });
    const r = await db.select({ row: schema.legacyBillingRows.rowNumber, block: schema.legacyBillingRows.block, amount: schema.legacyBillingRows.amount }).from(schema.legacyBillingRows).orderBy(schema.legacyBillingRows.rowNumber);
    expect(r).toEqual([{ row: 10, block: "solutions", amount: "1000.00" }, { row: 11, block: "call", amount: "918.00" }]);
  });

  it("duas importações do MESMO arquivo ao mesmo tempo: uma entra, a outra responde 'já importado' (Codex H1 P2)", async () => {
    const [x, y] = await Promise.all([importLegacy(db, dirA, A, { fileSha256: SHA, fileLabel: "x", year: 2026, entries: rows }), importLegacy(db, dirA, A, { fileSha256: SHA, fileLabel: "x", year: 2026, entries: rows })]);
    expect([x.already, y.already].sort()).toEqual([false, true]); expect(x.importId).toBe(y.importId); expect(await count()).toBe(4);
  });

  it("o banco recusa apagar o histórico fora do fluxo auditado; o fluxo 'Desfazer' funciona (Codex H1 P2)", async () => {
    const r = await importLegacy(db, dirA, A, { fileSha256: SHA, fileLabel: "x", year: 2026, entries: rows });
    const f = (q: ReturnType<typeof sql>) => db.execute(q).catch((e) => { throw new Error(why(e)); });
    await expect(f(sql`delete from legacy_billing_rows`)).rejects.toThrow(/Desfazer importação/);
    await expect(f(sql`delete from legacy_imports`)).rejects.toThrow(/Desfazer importação/);
    expect(await count()).toBe(4);
    await removeLegacyImport(db, dirA, A, r.importId);
    expect(await count()).toBe(0);
    expect((await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "history.import_removed")))).toHaveLength(1);
  });

  it("o banco recusa editar o histórico e linhas inválidas", async () => {
    await importLegacy(db, dirA, A, { fileSha256: SHA, fileLabel: "x", year: 2026, entries: rows });
    const f = (q: ReturnType<typeof sql>) => db.execute(q).catch((e) => { throw new Error(why(e)); });
    await expect(f(sql`update legacy_billing_rows set net_amount = 1`)).rejects.toThrow(/imutável/);
    await expect(f(sql`update legacy_imports set row_count = 1`)).rejects.toThrow(/imutável/);
    await expect(f(sql`update legacy_billing_rows set month = '2026-13' where false`)).resolves.toBeDefined(); // nenhuma linha: sem efeito
    await expect(f(sql`insert into legacy_billing_rows (company_id, import_id, sheet, row_number, month, customer_name, document_raw, block, amount) select company_id, id, 'x', 1, '2026-13', 'n', '', 'solutions', 1 from legacy_imports`)).rejects.toThrow(/month_chk/);
    await expect(f(sql`insert into legacy_billing_rows (company_id, import_id, sheet, row_number, month, customer_name, document_raw, block, amount) select company_id, id, 'Boletos JAN 2026', 5, '2026-01', 'n', '', 'solutions', 1 from legacy_imports`)).rejects.toThrow(/legacy_rows_pos_uq/);
  });

  it("corrigir CNPJ/CPF (ex.: DB Supermercados …-60 → …-06): valida, só gerência/diretoria, não toca no staging nem no cadastro, audita sem dados", async () => {
    const DB = [entry({ row: 20, name: "DB SUPERMERCADOS", documentRaw: "22.991.939/0001-60" }), entry({ row: 21, name: "DB SUPERMERCADOS", documentRaw: "22.991.939/0001-60", dueOn: "2026-01-12", paidOn: "2026-01-13", grossCents: 50000, netCents: 50000 }), entry({ row: 22, month: "2026-02", sheet: "Boletos FEV 2026", name: "DB Supermercados", documentRaw: "22.991.939/0001-06", dueOn: "2026-02-10", paidOn: "2026-02-11" })];
    await importLegacy(db, dirA, A, { fileSha256: SHA, fileLabel: "x", year: 2026, entries: DB });
    const before = await getHistoryReport(db, dirA, A, "2026-10-24");
    expect(before.report!.counts.documento_invalido).toBe(2); expect(before.report!.toFix[0]).toMatchObject({ name: "DB SUPERMERCADOS", rows: 2 });
    expect(before.report!.toFix[0].suggestions.map((s) => s.formatted)).toEqual(["22.991.939/0001-06"]);
    for (const u of [asstA, contA, techA]) await expect(saveDocumentFix(db, u, A, { name: "DB SUPERMERCADOS", document: "22.991.939/0001-06" })).rejects.toBeInstanceOf(Forbidden);
    await expect(saveDocumentFix(db, dirB, A, { name: "DB SUPERMERCADOS", document: "22.991.939/0001-06" })).rejects.toBeInstanceOf(Forbidden);
    await expect(saveDocumentFix(db, gerA, A, { name: "DB SUPERMERCADOS", document: "22.991.939/0001-60" })).rejects.toThrow(/não conferem.*Será que é 22\.991\.939\/0001-06/);
    await expect(saveDocumentFix(db, gerA, A, { name: "DB SUPERMERCADOS", document: "" })).rejects.toThrow(/Informe/);
    await expect(saveDocumentFix(db, gerA, A, { name: "DB SUPERMERCADOS", document: "22.991" })).rejects.toThrow(/incompleto/);
    await expect(saveDocumentFix(db, gerA, A, { name: "NOME QUE NAO EXISTE", document: "22.991.939/0001-06" })).rejects.toThrow(/não encontrado no histórico/);
    const f = await saveDocumentFix(db, gerA, A, { name: "  db  supermercados ", document: "22.991.939/0001-06", note: "conferido no cartão CNPJ" });
    expect(f.formatted).toBe("22.991.939/0001-06");
    const after = await getHistoryReport(db, dirA, A, "2026-10-24");
    expect(after.report!.counts.documento_invalido).toBe(0); expect(after.report!.counts.documento_corrigido).toBe(2); expect(after.report!.toFix).toEqual([]);
    expect(after.fixes).toMatchObject([{ name: "DB SUPERMERCADOS", formatted: "22.991.939/0001-06", note: "conferido no cartão CNPJ" }]);
    // staging intacto (imutável) e nenhum cadastro criado/alterado
    const raw = await db.select({ d: schema.legacyBillingRows.document, r: schema.legacyBillingRows.documentRaw }).from(schema.legacyBillingRows).where(eq(schema.legacyBillingRows.rowNumber, 20));
    expect(raw).toEqual([{ d: null, r: "22.991.939/0001-60" }]);
    expect(Number((await db.execute(sql`select count(*)::int n from customers`))[0].n)).toBe(1);
    const log = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "history.fix_saved"));
    expect(log).toHaveLength(1); expect(JSON.stringify(log)).not.toMatch(/SUPERMERC|22991939|22\.991/);
    // trocar a correção, isolar por empresa e desfazer
    await saveDocumentFix(db, dirA, A, { name: "DB SUPERMERCADOS", document: "529.982.247-25" });
    expect(Number((await db.execute(sql`select count(*)::int n from legacy_document_fixes`))[0].n)).toBe(1);
    expect((await getHistoryReport(db, dirB, B, "2026-10-24")).fixes).toEqual([]);
    const id = (await getHistoryReport(db, dirA, A, "2026-10-24")).fixes[0].id;
    await expect(removeDocumentFix(db, asstA, A, id)).rejects.toBeInstanceOf(Forbidden);
    await expect(removeDocumentFix(db, dirB, B, id)).rejects.toThrow(/não encontrada/);
    await expect(saveDocumentFix(db, dirA, A, { name: "DB SUPERMERCADOS", document: "22.991.939/0001-06", expected: "" })).rejects.toThrow(/Outra pessoa acabou de corrigir/); // concorrência: viu "sem correção", já existe
    await saveDocumentFix(db, dirA, A, { name: "DB SUPERMERCADOS", document: "22.991.939/0001-06", expected: "52998224725" }); // viu o atual: ok
    await saveDocumentFix(db, dirA, A, { name: "DB SUPERMERCADOS", document: "529.982.247-25" });
    await removeDocumentFix(db, gerA, A, id);
    expect((await getHistoryReport(db, dirA, A, "2026-10-24")).report!.toFix).toHaveLength(1);
  });

  it("a correção só vale onde o documento falta: não sobrescreve documento válido de linha de nome parecido (Codex P2)", async () => {
    await importLegacy(db, dirA, A, { fileSha256: SHA, fileLabel: "x", year: 2026, entries: [entry({ row: 30, name: "Padaria Pão", documentRaw: "" }), entry({ row: 31, name: "PADARIA PAO", documentRaw: "11.222.333/0001-81" })] });
    await saveDocumentFix(db, dirA, A, { name: "padaria pao", document: "529.982.247-25" });
    const r = (await getHistoryReport(db, dirA, A, "2026-10-24")).report!;
    expect(r.counts.documento_corrigido).toBe(1); expect(r.counts.sem_documento).toBe(0); // só a linha sem documento foi corrigida; a outra manteve o CNPJ válido
  });
});

