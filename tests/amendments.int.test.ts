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
import { createContract, decideVersion, getContract, proposeAndApprove, proposeChange } from "@/modules/contracts/service";
import { listContractAlerts } from "@/modules/contracts/alerts";
import { addNote, listNotes } from "@/modules/notes/service";
import { getCompanyProfile, updateCompanyProfile } from "@/modules/companies/service";

const enabled = !!process.env.POSTGRES_USER;
const CNPJ1 = "11.222.333/0001-81", COMPANY_CNPJ = "12.ABC.345/01DE-35";
const terms = (o: Record<string, unknown> = {}) => ({ description: "Monitoramento", monthlyAmount: "2.500,00", startAt: "2026-01-01", endAt: "", dueDay: "5", invoiceJointRequired: false, issueDayOverride: "", ...o });
const why = (e: unknown) => String((e as { cause?: { message?: string } })?.cause?.message ?? (e as Error)?.message ?? e);
const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Manaus" });

describe.skipIf(!enabled)("E21 — aditivos, comentários e dados da empresa (DB de teste)", () => {
  let admin: ReturnType<typeof postgres>, conn: ReturnType<typeof postgres>, db: DB;
  let A: string, B: string, dirA: string, dirB: string, gerA: string, asstA: string, contA: string, techA: string, cliA: string, cliB: string;

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
    await db.execute(sql`truncate notes, holidays, contract_versions, contracts, integration_conflicts, integration_sync_runs, integration_connections, rate_limits, customer_contacts, vendor_contacts, customers, vendors, audit_log, invitations, memberships, companies, users restart identity cascade`);
    const [a, b] = await db.insert(schema.companies).values([{ name: "A" }, { name: "B" }]).returning();
    A = a.id; B = b.id;
    const mk = async (e: string) => (await db.insert(schema.users).values({ email: e, name: e, passwordHash: "x" }).returning())[0].id;
    dirA = await mk("dir-a@t.com"); dirB = await mk("dir-b@t.com"); gerA = await mk("ger@t.com"); asstA = await mk("asst@t.com"); contA = await mk("cont@t.com"); techA = await mk("tech@t.com");
    await db.insert(schema.memberships).values([
      { userId: dirA, companyId: A, role: "diretoria" }, { userId: dirB, companyId: B, role: "diretoria" }, { userId: gerA, companyId: A, role: "gerente" },
      { userId: asstA, companyId: A, role: "assistente" }, { userId: contA, companyId: A, role: "contabilidade" }, { userId: techA, companyId: A, role: "admin_tecnico" },
    ]);
    cliA = (await createParty(db, dirA, A, { kind: "cliente", legalName: "Cliente A", document: CNPJ1 })).id;
    cliB = (await createParty(db, dirB, B, { kind: "cliente", legalName: "Cliente B", document: CNPJ1 })).id;
  });

  const active = async (t = terms()) => {
    const c = await createContract(db, asstA, A, cliA, t);
    await decideVersion(db, dirA, A, (await getContract(db, dirA, A, c.id))!.versions[0].id, "aprovar");
    return c.id;
  };

  describe("aditivo", () => {
    it("guarda tipo, data de efeito e referência na versão; o contrato só muda na aprovação", async () => {
      const id = await active();
      const v = await proposeChange(db, asstA, A, id, terms({ monthlyAmount: "2.750,00" }), "Reajuste anual", { kind: "reajuste", effectiveOn: "2026-06-01", reference: "2º aditivo, pasta 2026" });
      expect(v).toBe(2);
      let c = (await getContract(db, dirA, A, id))!;
      expect(c.amountCents).toBe(250000);
      expect(c.versions[0]).toMatchObject({ version: 2, state: "pendente", kind: "reajuste", effectiveOn: "2026-06-01", reference: "2º aditivo, pasta 2026" });
      await decideVersion(db, gerA, A, c.versions[0].id, "aprovar");
      c = (await getContract(db, dirA, A, id))!;
      expect(c.amountCents).toBe(275000); expect(c.versions[1]).toMatchObject({ version: 1, kind: "alteracao", effectiveOn: null, reference: null });
      const log = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "contract.change_proposed"));
      expect(log[0].detail).toMatchObject({ contractId: id, version: 2, kind: "reajuste" });
    });

    it("regras: data futura recusada; reajuste/valor exigem valor diferente; prorrogação exige outro fim; tipo inválido", async () => {
      const id = await active();
      const bad = (am: Record<string, unknown>, o: Record<string, unknown>, re: RegExp) => expect(proposeChange(db, asstA, A, id, terms(o), "x", am)).rejects.toThrow(re);
      await bad({ kind: "reajuste", effectiveOn: "2999-01-01" }, { monthlyAmount: "3.000,00" }, /não pode ser futura/);
      await bad({ kind: "reajuste" }, { dueDay: "6" }, /igual ao vigente/);
      await bad({ kind: "valor" }, { dueDay: "6" }, /igual ao vigente/);
      await bad({ kind: "prorrogacao" }, { monthlyAmount: "3.000,00" }, /igual à vigente/);
      await bad({ kind: "x" }, { monthlyAmount: "3.000,00" }, /Tipo de aditivo inválido/);
      await bad({ kind: "outros", reference: "x".repeat(201) }, { monthlyAmount: "3.000,00" }, /muito longa/);
      await expect(proposeChange(db, asstA, A, id, terms({ endAt: "2027-06-30" }), "x", { kind: "prorrogacao", effectiveOn: today() })).resolves.toBe(2);
    });

    it("proposeAndApprove: só diretoria; vigora na hora e registra quem pediu e quem aprovou", async () => {
      const id = await active();
      await expect(proposeAndApprove(db, gerA, A, id, terms({ monthlyAmount: "3.000,00" }), "x", { kind: "valor" })).rejects.toBeInstanceOf(Forbidden);
      await expect(proposeAndApprove(db, asstA, A, id, terms({ monthlyAmount: "3.000,00" }), "x", { kind: "valor" })).rejects.toBeInstanceOf(Forbidden);
      expect((await getContract(db, dirA, A, id))!.versions).toHaveLength(1); // nada ficou pendente
      await proposeAndApprove(db, dirA, A, id, terms({ monthlyAmount: "3.000,00" }), "Ajuste combinado", { kind: "valor", reference: "e-mail 10/10" });
      const c = (await getContract(db, dirA, A, id))!;
      expect(c.amountCents).toBe(300000);
      expect(c.versions[0]).toMatchObject({ state: "aprovada", kind: "valor", requestedBy: dirA, decidedBy: dirA });
    });

    it("alerta de reajuste conta a partir da data de efeito do aditivo", async () => {
      const id = await active(terms({ startAt: "2025-01-01" }));
      await proposeAndApprove(db, dirA, A, id, terms({ startAt: "2025-01-01", monthlyAmount: "3.000,00" }), "x", { kind: "reajuste", effectiveOn: "2026-03-01" });
      const { alerts } = await listContractAlerts(db, dirA, A, "2027-02-10", 60);
      const adj = alerts.find((a) => a.contractId === id && a.kind === "reajuste_proximo");
      expect(adj).toMatchObject({ date: "2027-03-01", since: "2026-03-01" });
    });
  });

  describe("comentários", () => {
    it("contrato: escreve quem altera contratos; contabilidade lê mas não escreve; admin técnico nem lê; texto fora do registro de atividades", async () => {
      const id = await active();
      await addNote(db, asstA, A, { contractId: id }, "  Cliente pediu reajuste só em janeiro.  ");
      await addNote(db, dirA, A, { contractId: id }, "Combinado por telefone.");
      await expect(addNote(db, contA, A, { contractId: id }, "x")).rejects.toBeInstanceOf(Forbidden);
      await expect(addNote(db, techA, A, { contractId: id }, "x")).rejects.toBeInstanceOf(Forbidden);
      await expect(listNotes(db, techA, A, { contractId: id })).rejects.toBeInstanceOf(Forbidden);
      const l = await listNotes(db, contA, A, { contractId: id });
      expect(l.map((n) => n.body)).toEqual(["Combinado por telefone.", "Cliente pediu reajuste só em janeiro."]);
      expect(l[0].author).toBe("dir-a@t.com");
      const log = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "note.added"));
      expect(log).toHaveLength(2);
      expect(JSON.stringify(log)).not.toMatch(/reajuste só|telefone/);
    });

    it("cliente: precisa de crm.write; validações; isolamento entre empresas", async () => {
      await addNote(db, asstA, A, { customerId: cliA }, "Boa pagadora.");
      await expect(addNote(db, contA, A, { customerId: cliA }, "x")).rejects.toBeInstanceOf(Forbidden);
      await expect(addNote(db, asstA, A, { customerId: "nao-uuid" }, "x")).rejects.toBeInstanceOf(Invalid);
      await expect(addNote(db, asstA, A, { customerId: cliB }, "x")).rejects.toThrow(/não encontrado/); // cliente de outra empresa
      await expect(addNote(db, dirB, B, { customerId: cliA }, "x")).rejects.toThrow(/não encontrado/);
      await expect(addNote(db, asstA, A, { customerId: cliA }, "   ")).rejects.toThrow(/Escreva/);
      await expect(addNote(db, asstA, A, { customerId: cliA }, "a".repeat(2001))).rejects.toThrow(/muito longo/);
      expect(await listNotes(db, dirB, B, { customerId: cliA })).toEqual([]);
      expect((await listNotes(db, dirA, A, { customerId: cliA })).map((n) => n.body)).toEqual(["Boa pagadora."]);
    });

    it("o banco recusa editar, apagar e nota sem alvo ou com dois alvos", async () => {
      const id = await active();
      const n = await addNote(db, dirA, A, { contractId: id }, "original");
      await expect(db.execute(sql`update notes set body = 'alterado' where id = ${n.id}`).catch((e) => { throw new Error(why(e)); })).rejects.toThrow(/só de acréscimo/);
      await expect(db.execute(sql`delete from notes where id = ${n.id}`).catch((e) => { throw new Error(why(e)); })).rejects.toThrow(/só de acréscimo/);
      await expect(db.execute(sql`insert into notes (company_id, author_id, body) values (${A}, ${dirA}, 'sem alvo')`).catch((e) => { throw new Error(why(e)); })).rejects.toThrow(/notes_one_target_chk/);
      await expect(db.execute(sql`insert into notes (company_id, contract_id, customer_id, author_id, body) values (${A}, ${id}, ${cliA}, ${dirA}, 'dois')`).catch((e) => { throw new Error(why(e)); })).rejects.toThrow(/notes_one_target_chk/);
      expect((await listNotes(db, dirA, A, { contractId: id }))[0].body).toBe("original");
    });
  });

  describe("dados da empresa", () => {
    it("só a diretoria lê e edita; valida CNPJ e e-mail; grava só os nomes dos campos no registro", async () => {
      for (const u of [gerA, asstA, contA, techA]) { await expect(getCompanyProfile(db, u, A)).rejects.toBeInstanceOf(Forbidden); await expect(updateCompanyProfile(db, u, A, { name: "X" })).rejects.toBeInstanceOf(Forbidden); }
      const bad = (o: Record<string, unknown>, re: RegExp) => expect(updateCompanyProfile(db, dirA, A, { name: "Empresa A", ...o })).rejects.toThrow(re);
      await bad({ name: "" }, /Informe o nome/); await bad({ cnpj: "11.111.111/1111-11" }, /CNPJ inválido/); await bad({ cnpj: "529.982.247-25" }, /CNPJ inválido/); await bad({ financeEmail: "sem-arroba" }, /E-mail financeiro inválido/); await bad({ address: "x".repeat(301) }, /Endereço muito longo/);
      const r = await updateCompanyProfile(db, dirA, A, { name: "K3G Solutions", legalName: "K3G Solutions Ltda", cnpj: "11.222.333/0001-81", financeEmail: "fin@k3g.example", address: "Rua X, 1" });
      expect(r.changed).toEqual(["nome", "razão social", "CNPJ", "e-mail financeiro", "endereço"]);
      const p = await getCompanyProfile(db, dirA, A);
      expect(p).toMatchObject({ name: "K3G Solutions", legalName: "K3G Solutions Ltda", cnpj: "11222333000181", cnpjFormatted: "11.222.333/0001-81", financeEmail: "fin@k3g.example" });
      const log = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "company.updated"));
      expect(log).toHaveLength(1);
      expect(JSON.stringify(log[0].detail)).not.toMatch(/11222333|fin@k3g|Rua X|Ltda/);
      expect((await updateCompanyProfile(db, dirA, A, { name: "K3G Solutions", legalName: "K3G Solutions Ltda", cnpj: "11222333000181", financeEmail: "fin@k3g.example", address: "Rua X, 1" })).changed).toEqual([]); // nada mudou: sem evento novo
      expect(await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "company.updated"))).toHaveLength(1);
    });

    it("CNPJ repetido em outra empresa é recusado; CNPJ alfanumérico vale; limpar o campo zera", async () => {
      await updateCompanyProfile(db, dirA, A, { name: "Empresa A", cnpj: COMPANY_CNPJ });
      await expect(updateCompanyProfile(db, dirB, B, { name: "Empresa B", cnpj: "12.abc.345/01de-35" })).rejects.toThrow(/outra empresa/);
      expect((await getCompanyProfile(db, dirA, A)).cnpj).toBe("12ABC34501DE35");
      await updateCompanyProfile(db, dirA, A, { name: "Empresa A", cnpj: "" });
      expect((await getCompanyProfile(db, dirA, A)).cnpj).toBeNull();
      await expect(getCompanyProfile(db, dirB, A)).rejects.toBeInstanceOf(Forbidden); // diretoria de B não lê A
    });
  });
});
