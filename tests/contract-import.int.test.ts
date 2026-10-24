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
import { decideImport, getImport, importContracts, listImports, previewContractImport } from "@/modules/contracts/import";

const enabled = !!process.env.POSTGRES_USER;
const D1 = "11.222.333/0001-81", D2 = "12.ABC.345/01DE-35", D3 = "10.020.030/0001-13", D4 = "20.030.040/0001-93";
const HEAD = "razao_social;documento;servico;valor_mensal;dia_vencimento;inicio;fim;email_financeiro;contato;parceiro_comissao";
const csv = (...rows: string[]) => [HEAD, ...rows].join("\r\n") + "\r\n";
const row = (o: Partial<Record<string, string>> = {}) => [o.nome ?? "Cliente Um", o.doc ?? D1, o.svc ?? "Link dedicado", o.valor ?? "2.500,00", o.dia ?? "10", o.ini ?? "2026-01-01", o.fim ?? "", o.email ?? "", o.contato ?? "", o.com ?? ""].join(";");

describe.skipIf(!enabled)("importação de contratos da planilha (DB de teste)", () => {
  let admin: ReturnType<typeof postgres>, conn: ReturnType<typeof postgres>, db: DB;
  let A: string, B: string, dirA: string, dirB: string, gerA: string, ger2A: string, asstA: string, contA: string;

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
    await db.execute(sql`truncate contract_imports, charge_adjustments, charges, billing_batches, holidays, contract_versions, contracts, integration_conflicts, integration_sync_runs, integration_connections, rate_limits, customer_contacts, vendor_contacts, customers, vendors, audit_log, invitations, memberships, companies, users restart identity cascade`);
    const [a, b] = await db.insert(schema.companies).values([{ name: "Empresa A" }, { name: "Empresa B", customerMode: "crm" }]).returning();
    A = a.id; B = b.id;
    const mk = async (e: string) => (await db.insert(schema.users).values({ email: e, name: e, passwordHash: "x" }).returning())[0].id;
    dirA = await mk("dir-a@t.com"); dirB = await mk("dir-b@t.com"); gerA = await mk("ger@t.com"); ger2A = await mk("ger2@t.com"); asstA = await mk("asst@t.com"); contA = await mk("cont@t.com");
    await db.insert(schema.memberships).values([
      { userId: dirA, companyId: A, role: "diretoria" }, { userId: dirB, companyId: B, role: "diretoria" }, { userId: gerA, companyId: A, role: "gerente" }, { userId: ger2A, companyId: A, role: "gerente" },
      { userId: asstA, companyId: A, role: "assistente" }, { userId: contA, companyId: A, role: "contabilidade" },
    ]);
  });

  const n = async (q: string) => Number((await db.execute(sql.raw(`select count(*)::int n from ${q}`)))[0].n);

  it("prévia: permissão, colunas obrigatórias e classificação linha a linha (nada é gravado)", async () => {
    await createParty(db, dirA, A, { kind: "cliente", legalName: "Cliente Existente", document: D1 });
    await expect(previewContractImport(db, contA, A, csv(row()))).rejects.toThrow(Forbidden);
    await expect(previewContractImport(db, asstA, A, "razao_social;documento\r\nX;Y\r\n")).rejects.toThrow(/Colunas obrigatórias ausentes/);
    await expect(previewContractImport(db, asstA, A, "")).rejects.toThrow(/Arquivo vazio/);
    const { rows, summary } = await previewContractImport(db, asstA, A, csv(
      row(), // existente
      row({ nome: "Cliente Novo", doc: D2 }), // novo local
      row({ nome: "Sem Doc", doc: "" }),
      row({ nome: "Doc Ruim", doc: "11.111.111/1111-11" }),
      row({ nome: "Valor Ruim", doc: D3, valor: "abc" }),
      row({ nome: "Dia Ruim", doc: D3, dia: "40" }),
      row({ nome: "Repetido", doc: D1 }),
      row({ nome: "Email Ruim", doc: D4, email: "isso-nao-e-email" }),
      row({ nome: "Comissão Curta", doc: D4, com: "M" }),
      row({ nome: "Fim Antes", doc: D4, ini: "2026-05-01", fim: "2026-04-30" }),
    ));
    expect(rows.map((r) => r.status)).toEqual(["ok", "novo_cliente", "erro", "erro", "erro", "erro", "duplicado", "erro", "erro", "erro"]);
    expect(rows[2].message).toMatch(/sem CNPJ/);
    expect(rows[3].message).toMatch(/inválido/);
    expect(summary).toMatchObject({ ok: 1, novo_cliente: 1, duplicado: 1, erro: 7 });
    expect(await n("contracts")).toBe(0);
    expect(await n("contract_imports")).toBe(0);
    expect(await n("customers")).toBe(1);
  });

  it("importar: cria o lote, o cliente local, o contato, os contratos em rascunho e a marca de comissão; auditoria só com contagens", async () => {
    await createParty(db, dirA, A, { kind: "cliente", legalName: "Cliente Existente", document: D1 });
    const r = await importContracts(db, asstA, A, csv(row({ com: "Medina" }), row({ nome: "Cliente Novo SA", doc: D2, svc: "Plano K3G Call", valor: "798,00", dia: "5", email: "fin@novo.example", contato: "Maria", fim: "2026-08-31" })));
    expect(r).toMatchObject({ contracts: 2, customersCreated: 1, skipped: 0 });
    const cs = await db.select().from(schema.contracts);
    expect(cs).toHaveLength(2);
    expect(cs.every((c) => c.status === "rascunho" && c.importId === r.importId)).toBe(true);
    const existente = cs.find((c) => c.description === "Link dedicado")!;
    expect(existente).toMatchObject({ commissionPartner: "Medina", monthlyAmount: "2500.00", dueDay: 10, startAt: "2026-01-01" });
    const novo = cs.find((c) => c.description === "Plano K3G Call")!;
    expect(novo).toMatchObject({ commissionPartner: null, monthlyAmount: "798.00", dueDay: 5, endAt: "2026-08-31" });
    const cust = (await db.select().from(schema.customers).where(eq(schema.customers.document, "12ABC34501DE35")))[0];
    expect(cust).toMatchObject({ legalName: "Cliente Novo SA", source: "csv", status: "ativo", companyId: A });
    expect((await db.select().from(schema.customerContacts).where(eq(schema.customerContacts.partyId, cust.id)))[0]).toMatchObject({ name: "Maria", email: "fin@novo.example", isFinancial: true });
    expect(await n("contract_versions where state = 'pendente' and version = 1")).toBe(2);
    const log = JSON.stringify((await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "contract.imported")))[0].detail);
    expect(log).toContain('"contracts":2');
    expect(log).not.toMatch(/Cliente|Medina|fin@|798/); // sem nomes, e-mails nem valores
  });

  it("reimportar o mesmo arquivo não duplica (cliente já tem contrato); lote vazio é recusado", async () => {
    const f = csv(row({ nome: "Cliente Novo SA", doc: D2 }));
    await importContracts(db, asstA, A, f);
    const { rows } = await previewContractImport(db, asstA, A, f);
    expect(rows[0].status).toBe("ja_tem_contrato");
    await expect(importContracts(db, asstA, A, f)).rejects.toThrow(/Nenhuma linha válida/);
    expect(await n("contracts")).toBe(1);
  });

  it("empresa em modo CRM: não cria cliente; só importa contrato de cliente já sincronizado", async () => {
    await db.insert(schema.customers).values({ companyId: B, legalName: "Do CRM", docType: "cnpj", document: "11222333000181", status: "suspenso", source: "crm", externalId: "x1" });
    const { rows } = await previewContractImport(db, dirB, B, csv(row(), row({ nome: "Ausente", doc: D2 })));
    expect(rows.map((r) => r.status)).toEqual(["ok", "cliente_ausente"]);
    expect(rows[0].warning).toMatch(/suspenso/);
    expect(rows[1].message).toMatch(/cadastre no CRM/);
    await importContracts(db, dirB, B, csv(row(), row({ nome: "Ausente", doc: D2 })));
    expect(await n("customers")).toBe(1);
    expect(await n("contracts")).toBe(1);
    await expect(importContracts(db, dirB, B, csv(row({ nome: "Ausente", doc: D2 })))).rejects.toThrow(/Nenhuma linha válida/);
  });

  it("aprovação em lote: importador não aprova o próprio lote (exceto diretoria); tudo ativa de uma vez; sem segunda decisão", async () => {
    const r = await importContracts(db, gerA, A, csv(row(), row({ nome: "Dois", doc: D2 })));
    await expect(decideImport(db, gerA, A, r.importId, "aprovar")).rejects.toThrow(Forbidden);
    await expect(decideImport(db, asstA, A, r.importId, "aprovar")).rejects.toThrow(Forbidden);
    await expect(decideImport(db, contA, A, r.importId, "aprovar")).rejects.toThrow(Forbidden);
    expect(await n("contracts where status = 'rascunho'")).toBe(2);
    expect(await decideImport(db, ger2A, A, r.importId, "aprovar", "conferido")).toBe(2);
    expect(await n("contracts where status = 'ativo'")).toBe(2);
    expect(await n("contract_versions where state = 'aprovada'")).toBe(2);
    await expect(decideImport(db, ger2A, A, r.importId, "aprovar")).rejects.toThrow(/Nada pendente/);
    const d = await getImport(db, contA, A, r.importId);
    expect(d!.items.map((i) => i.status)).toEqual(["ativo", "ativo"]);
    expect((await listImports(db, contA, A))[0].byStatus).toEqual({ ativo: 2 });
  });

  it("diretoria pode aprovar o que ela mesma importou; rejeitar mantém rascunho e histórico", async () => {
    const r1 = await importContracts(db, dirA, A, csv(row({ nome: "Um", doc: D1 })));
    expect(await decideImport(db, dirA, A, r1.importId, "aprovar")).toBe(1);
    const r2 = await importContracts(db, gerA, A, csv(row({ nome: "Dois", doc: D2 })));
    expect(await decideImport(db, ger2A, A, r2.importId, "rejeitar", "valores errados")).toBe(1);
    const c = (await db.select().from(schema.contracts).where(eq(schema.contracts.importId, r2.importId)))[0];
    expect(c.status).toBe("rascunho");
    expect((await db.select().from(schema.contractVersions).where(eq(schema.contractVersions.contractId, c.id)))[0]).toMatchObject({ state: "rejeitada", decisionNote: "valores errados" });
    await expect(decideImport(db, ger2A, A, r2.importId, "aprovar")).rejects.toThrow(/Nada pendente/);
  });

  it("isolamento: outra empresa não vê nem decide o lote", async () => {
    const r = await importContracts(db, gerA, A, csv(row()));
    expect(await getImport(db, dirB, B, r.importId)).toBeNull();
    await expect(decideImport(db, dirB, B, r.importId, "aprovar")).rejects.toThrow(/Lote não encontrado/);
    await expect(decideImport(db, dirB, A, r.importId, "aprovar")).rejects.toThrow(Forbidden); // não é membro de A
    await expect(decideImport(db, dirA, A, "x", "aprovar")).rejects.toThrow(Invalid);
    expect(await listImports(db, dirB, B)).toEqual([]);
  });

  it("o banco protege o lote: não apaga nem altera o resumo; contrato não aponta para lote de outra empresa", async () => {
    const r = await importContracts(db, gerA, A, csv(row()));
    await expect(db.execute(sql`delete from contract_imports`)).rejects.toThrow();
    await expect(db.execute(sql`update contract_imports set summary = '{}'::jsonb`)).rejects.toThrow();
    const c = (await db.select().from(schema.contracts))[0];
    await expect(db.execute(sql`update contracts set company_id = ${B}::uuid where id = ${c.id}::uuid`)).rejects.toThrow(); // FK composta (cliente/lote da empresa A)
    await expect(db.execute(sql`update contracts set commission_partner = 'x' where id = ${c.id}::uuid`)).rejects.toThrow(); // CHECK 2–60
    expect(r.contracts).toBe(1);
  });
});
