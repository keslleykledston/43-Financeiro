import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { eq, sql } from "drizzle-orm";
import { databaseUrl } from "@/lib/db/url";
import * as schema from "@/lib/db/schema";
import type { DB } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import type { ExpenseRow } from "@/modules/expenses/planilha";
import { analyzeExpenses } from "@/modules/expenses/report";
import { exportExpenseCsv, getExpenseReport, importExpenses, removeExpenseImport, sha256 } from "@/modules/expenses/history";

const enabled = !!process.env.POSTGRES_USER;
const why = (e: unknown) => String((e as { cause?: { message?: string } })?.cause?.message ?? (e as Error)?.message ?? e);
const row = (o: Partial<ExpenseRow> & Pick<ExpenseRow, "description">): ExpenseRow => ({ sheet: "DESPESAS ABR 2026", row: 3, month: "2026-04", block: "empresa", dueOn: "2026-04-03", amountCents: 10000, paidCents: 10000, paidOn: "2026-04-05", paidRaw: null, installmentNo: null, installmentsTotal: null, ...o });
const ROWS: ExpenseRow[] = [
  row({ description: "VIVO CORPORATIVO", row: 3, amountCents: 77356, paidCents: 77356 }),
  row({ description: "EMPRESTIMO / K3G2 / 14/36", row: 4, amountCents: 417003, paidCents: 300000, paidOn: null, paidRaw: "19/04", installmentNo: 14, installmentsTotal: 36 }),
  row({ description: "FGTS / CALL", row: 5, amountCents: 29988, paidCents: 29988 }),
  row({ description: "COISA ESTRANHA", row: 6, amountCents: null, paidCents: null, paidOn: null }),
  row({ description: "=HYPERLINK(\"http://x\")", row: 7, amountCents: 500, paidCents: 500, dueOn: "2026-05-02" }),
  row({ description: "CARTÃO BRADESCO", row: 3, block: "casa", amountCents: 210000, paidCents: 200000, paidOn: null }),
  row({ description: "ÁGUA", row: 4, block: "casa", amountCents: 22419, paidCents: 22419 }),
  row({ description: "NUBANK", row: 3, block: "cartao", amountCents: 174769, paidCents: null, paidOn: null }),
  row({ description: "Elizabete", row: 3, block: "dizimo", amountCents: 100000, paidCents: null, paidOn: null }),
];

describe("D3 — análise pura do histórico de despesas", () => {
  const rep = analyzeExpenses(ROWS);
  it("totais só de empresa/casa (pago), cartão e dízimo à parte", () => {
    expect(rep.totals).toMatchObject({ empresaPaidCents: 77356 + 300000 + 29988 + 500, casaPaidCents: 200000 + 22419, cardReferenceCents: 174769, tithesRecordedCents: 100000, callCents: 29988 });
    expect(rep.byBlock).toEqual({ empresa: 5, casa: 2, cartao: 1, dizimo: 1 });
    expect(rep.months).toHaveLength(1);
  });
  it("divergências e a classificar", () => {
    expect(rep.counts).toMatchObject({ sem_valor: 1, pago_em_texto: 1, pago_parcial: 2, pago_sem_data: 1, e_da_call: 1, e_do_k3g2: 1, vencimento_fora_do_mes: 1 });
    expect(rep.toClassify.map((t) => t.description)).toEqual(expect.arrayContaining(["COISA ESTRANHA"]));
    expect(rep.series[0]).toMatchObject({ lastNo: 14, total: 36, remaining: 22 });
  });
});

describe.skipIf(!enabled)("D3 — staging do histórico de despesas (DB de teste)", () => {
  let admin: ReturnType<typeof postgres>, conn: ReturnType<typeof postgres>, db: DB;
  let A: string, B: string, dirA: string, dirB: string, gerA: string, ctbA: string;
  const sha = sha256("arquivo-ficticio-1");

  beforeAll(async () => {
    const base = databaseUrl();
    admin = postgres(base.replace(/\/k3gfinance$/, "/postgres"), { max: 1 });
    if (!(await admin`select 1 from pg_database where datname = 'k3gfinance_test'`).length) await admin.unsafe("create database k3gfinance_test");
    conn = postgres(base.replace(/\/k3gfinance$/, "/k3gfinance_test"), { max: 5 });
    db = drizzle(conn, { schema });
    await migrate(db, { migrationsFolder: "./drizzle" });
  });
  afterAll(async () => { await conn?.end(); await admin?.end(); });

  beforeEach(async () => {
    await db.execute(sql`truncate expense_import_rows, expense_imports, audit_log, invitations, memberships, companies, users restart identity cascade`);
    const [a, b] = await db.insert(schema.companies).values([{ name: "Empresa A" }, { name: "Empresa B" }]).returning();
    A = a.id; B = b.id;
    const mk = async (e: string) => (await db.insert(schema.users).values({ email: e, name: e, passwordHash: "x" }).returning())[0].id;
    dirA = await mk("dir-a@t.com"); dirB = await mk("dir-b@t.com"); gerA = await mk("ger@t.com"); ctbA = await mk("ctb@t.com");
    await db.insert(schema.memberships).values([{ userId: dirA, companyId: A, role: "diretoria" }, { userId: dirB, companyId: B, role: "diretoria" }, { userId: gerA, companyId: A, role: "gerente" }, { userId: ctbA, companyId: A, role: "contabilidade" }]);
  });
  const imp = (o: Partial<Parameters<typeof importExpenses>[3]> = {}) => importExpenses(db, dirA, A, { fileSha256: sha, fileLabel: "Despesas (planilha)", year: 2026, rows: ROWS, ...o });

  it("importa, é idempotente (mesmo arquivo, inclusive simultâneo) e audita só contagens", async () => {
    expect(await imp()).toMatchObject({ rows: 9, already: false });
    expect(await imp()).toMatchObject({ rows: 0, already: true });
    const [r] = await Promise.all([1, 2, 3].map(() => imp({ fileSha256: sha256("outro") })));
    expect(await db.select().from(schema.expenseImports)).toHaveLength(2);
    expect(r).toBeTruthy();
    const log = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "expenses.history_imported"));
    expect(log.length).toBe(2); expect(JSON.stringify(log)).not.toMatch(/VIVO|Elizabete|NUBANK/);
  });

  it("só a diretoria importa e lê; gerente/contabilidade não; outra empresa não vê", async () => {
    await expect(importExpenses(db, gerA, A, { fileSha256: sha, fileLabel: "x", year: 2026, rows: ROWS })).rejects.toBeInstanceOf(Forbidden);
    await expect(importExpenses(db, dirB, A, { fileSha256: sha, fileLabel: "x", year: 2026, rows: ROWS })).rejects.toBeInstanceOf(Forbidden);
    await imp();
    for (const u of [gerA, ctbA]) { await expect(getExpenseReport(db, u, A)).rejects.toBeInstanceOf(Forbidden); await expect(exportExpenseCsv(db, u, A, "classificacao")).rejects.toBeInstanceOf(Forbidden); }
    await expect(getExpenseReport(db, dirB, A)).rejects.toBeInstanceOf(Forbidden);
    expect((await getExpenseReport(db, dirB, B)).report).toBeNull();
    const r = await getExpenseReport(db, dirA, A);
    expect(r.current).toMatchObject({ rows: 9, year: 2026 });
    expect(r.report!.totals.casaPaidCents).toBe(222419);
  });

  it("troca atômica (replace): a nova entra no lugar da antiga; se a nova falhar a antiga fica; o mesmo arquivo não apaga nada", async () => {
    const first = await imp();
    const sha2 = sha256("arquivo-ficticio-2");
    // arquivo novo com duas linhas na mesma posição (viola o índice único): falha e a antiga continua
    const dup = [row({ description: "A", row: 3 }), row({ description: "B", row: 3 })];
    await expect(imp({ fileSha256: sha2, rows: dup, replace: true })).rejects.toThrow(/nada foi gravado e a importação anterior foi mantida/);
    expect((await db.select().from(schema.expenseImports)).map((i) => i.id)).toEqual([first.importId]);
    expect(await db.select().from(schema.expenseImportRows)).toHaveLength(9);
    // mesmo arquivo com replace: "já importado", nada é apagado
    expect(await imp({ replace: true })).toMatchObject({ already: true });
    expect(await db.select().from(schema.expenseImportRows)).toHaveLength(9);
    // arquivo novo válido com replace: troca
    const r = await imp({ fileSha256: sha2, rows: [row({ description: "NOVA", row: 3 })], replace: true });
    expect(r).toMatchObject({ rows: 1, already: false });
    expect((await db.select().from(schema.expenseImports)).map((i) => i.id)).toEqual([r.importId]);
    expect(await db.select().from(schema.expenseImportRows)).toHaveLength(1);
    const acts = (await db.select().from(schema.auditLog)).map((a) => a.action);
    expect(acts.filter((a) => a === "expenses.history_removed")).toHaveLength(1);
  });

  it("validações: hash, vazio, excesso", async () => {
    await expect(imp({ fileSha256: "x" })).rejects.toThrow(/Hash/);
    await expect(imp({ rows: [] })).rejects.toThrow(/Nenhuma linha/);
    await expect(imp({ rows: Array.from({ length: 5001 }, (_, i) => row({ description: "X", row: i + 3 })) })).rejects.toThrow(/Mais de 5000/);
  });

  it("staging é imutável no banco; só 'Desfazer importação' apaga (auditado, só da empresa certa)", async () => {
    const r = await imp();
    expect(String(await db.execute(sql`update expense_import_rows set description = 'x'`).catch(why))).toMatch(/imutável/);
    expect(String(await db.execute(sql`delete from expense_import_rows`).catch(why))).toMatch(/Desfazer importação/);
    expect(String(await db.execute(sql`delete from expense_imports`).catch(why))).toMatch(/Desfazer importação/);
    expect(String(await db.execute(sql`update expense_imports set row_count = 1`).catch(why))).toMatch(/imutável/);
    await expect(removeExpenseImport(db, gerA, A, r.importId)).rejects.toBeInstanceOf(Forbidden);
    await expect(removeExpenseImport(db, dirB, B, r.importId)).rejects.toThrow(/não encontrada/); // importação de A com contexto B
    await expect(removeExpenseImport(db, dirA, A, "x")).rejects.toBeInstanceOf(Invalid);
    await removeExpenseImport(db, dirA, A, r.importId);
    expect(await db.select().from(schema.expenseImportRows)).toHaveLength(0);
    expect((await db.select().from(schema.auditLog)).map((a) => a.action)).toContain("expenses.history_removed");
    expect(await imp()).toMatchObject({ already: false }); // pode importar de novo
  });

  it("CSV: classificação sugerida e divergências, com neutralização de fórmula", async () => {
    await imp();
    const cls = await exportExpenseCsv(db, dirA, A, "classificacao");
    const lines = cls.split("\r\n").map((l) => l.replace(/^﻿/, ""));
    expect(lines[0]).toBe("aba;linha;bloco;descricao;vencimento;valor;pago;pago_em;categoria_sugerida;natureza_sugerida;empresa_sugerida;centro_sugerido;aviso");
    expect(cls).toContain("EMPRESTIMO / K3G2 / 14/36");
    expect(cls).toContain("emprestimos;empresa;;k3g2");
    expect(cls).toContain("fgts;empresa;call");
    expect(cls).toContain("'=HYPERLINK");
    expect(cls).not.toContain("NUBANK"); // fatura de cartão é só referência
    const div = await exportExpenseCsv(db, dirA, A, "divergencias");
    expect(div).toContain("Linha sem valor"); expect(div).toContain("Data de pagamento escrita como texto");
    expect(div).toContain("Parece ser da K3G Call");
    expect((await db.select().from(schema.auditLog)).filter((a) => a.action === "expenses.history_exported")).toHaveLength(2);
  });
});
