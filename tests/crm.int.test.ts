import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { databaseUrl } from "@/lib/db/url";
import * as schema from "@/lib/db/schema";
import type { DB } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import { addContact, createParty, exportParties, isBillable, getParty, history, importParties, listParties, previewImport, removeContact, setArchived, updateParty } from "@/modules/crm/service";

const enabled = !!process.env.POSTGRES_USER;
const CPF = "529.982.247-25", CNPJ = "11.222.333/0001-81", CNPJ2 = "12.ABC.345/01DE-35";
const novo = (o: Record<string, unknown> = {}) => ({ kind: "cliente", legalName: "Cliente Teste", document: CNPJ, ...o });

describe.skipIf(!enabled)("CRM: isolamento, duplicidade, permissões, busca, import/export (DB de teste)", () => {
  let admin: ReturnType<typeof postgres>, conn: ReturnType<typeof postgres>, db: DB;
  let A: string, B: string, dirA: string, dirB: string, asstA: string, contA: string, techA: string;

  beforeAll(async () => {
    const base = databaseUrl();
    admin = postgres(base.replace(/\/k3gfinance$/, "/postgres"), { max: 1 });
    if (!(await admin`select 1 from pg_database where datname = 'k3gfinance_test'`).length) await admin.unsafe("create database k3gfinance_test");
    conn = postgres(base.replace(/\/k3gfinance$/, "/k3gfinance_test"), { max: 3 });
    db = drizzle(conn, { schema });
    await migrate(db, { migrationsFolder: "./drizzle" });
  });
  afterAll(async () => { await conn?.end(); await admin?.end(); });

  beforeEach(async () => {
    await db.execute(sql`truncate holidays, contract_versions, contracts, rate_limits, customer_contacts, vendor_contacts, customers, vendors, audit_log, invitations, memberships, companies, users restart identity cascade`);
    const [a, b] = await db.insert(schema.companies).values([{ name: "A" }, { name: "B" }]).returning();
    A = a.id; B = b.id;
    const mk = async (e: string) => (await db.insert(schema.users).values({ email: e, name: e, passwordHash: "x" }).returning())[0].id;
    dirA = await mk("dir-a@t.com"); dirB = await mk("dir-b@t.com"); asstA = await mk("asst@t.com"); contA = await mk("cont@t.com"); techA = await mk("tech@t.com");
    await db.insert(schema.memberships).values([
      { userId: dirA, companyId: A, role: "diretoria" }, { userId: dirB, companyId: B, role: "diretoria" },
      { userId: asstA, companyId: A, role: "assistente" }, { userId: contA, companyId: A, role: "contabilidade" }, { userId: techA, companyId: A, role: "admin_tecnico" },
    ]);
  });

  it("isolamento: empresa B não lê, altera, arquiva nem mexe nos contatos de A (mesmo com o ID)", async () => {
    const p = await createParty(db, dirA, A, novo());
    await addContact(db, dirA, A, p.id, { name: "Fin", email: "f@x.com", isFinancial: true });
    const [c] = await db.select().from(schema.customerContacts);
    expect(await getParty(db, dirB, B, p.id)).toBeNull();
    await expect(updateParty(db, dirB, B, p.id, novo({ legalName: "Invadido" }))).rejects.toBeInstanceOf(Invalid);
    await expect(setArchived(db, dirB, B, p.id, true)).rejects.toBeInstanceOf(Invalid);
    await expect(addContact(db, dirB, B, p.id, { name: "X" })).rejects.toBeInstanceOf(Invalid);
    await expect(removeContact(db, dirB, B, c.id)).rejects.toBeInstanceOf(Invalid);
    await expect(listParties(db, dirA, B, {})).rejects.toBeInstanceOf(Forbidden); // não é membro de B
    expect((await listParties(db, dirB, B, {})).total).toBe(0);
    const after = await getParty(db, dirA, A, p.id);
    expect(after?.legalName).toBe("Cliente Teste");
    expect(after?.archivedAt).toBeNull();
    expect(after?.contacts).toHaveLength(1);
  });

  it("documento duplicado: bloqueia na mesma empresa/tipo, permite em outra empresa ou tipo; arquivar libera", async () => {
    const p = await createParty(db, dirA, A, novo());
    await expect(createParty(db, dirA, A, novo({ legalName: "Outro" }))).rejects.toThrow(/já existe/i);
    await createParty(db, dirB, B, novo());                         // outra empresa
    await createParty(db, dirA, A, novo({ kind: "fornecedor" }));   // outro tipo
    await setArchived(db, dirA, A, p.id, true);
    const novoAtivo = await createParty(db, dirA, A, novo({ legalName: "Recriado" })); // arquivado libera o documento
    await expect(setArchived(db, dirA, A, p.id, false)).rejects.toBeInstanceOf(Invalid); // restaurar conflitaria
    expect(novoAtivo.legalName).toBe("Recriado");
  });

  it("validação: documento inválido, nome ausente, CNPJ alfanumérico aceito e normalizado", async () => {
    await expect(createParty(db, dirA, A, novo({ document: "123.456.789-00" }))).rejects.toThrow(/inválido/i);
    await expect(createParty(db, dirA, A, novo({ legalName: "" }))).rejects.toBeInstanceOf(Invalid);
    await expect(createParty(db, dirA, A, novo({ kind: "outro" }))).rejects.toBeInstanceOf(Invalid);
    const p = await createParty(db, dirA, A, novo({ document: CNPJ2.toLowerCase() }));
    expect(p.document).toBe("12ABC34501DE35");
    expect((await createParty(db, dirA, A, novo({ document: CPF, legalName: "Pessoa" }))).docType).toBe("cpf");
    await expect(addContact(db, dirA, A, p.id, { name: "X", email: "nao-e-email" })).rejects.toBeInstanceOf(Invalid);
  });

  it("permissões: assistente grava mas não exporta; contabilidade lê/exporta mas não grava; admin técnico não vê", async () => {
    const p = await createParty(db, asstA, A, novo());
    await expect(exportParties(db, asstA, A)).rejects.toBeInstanceOf(Forbidden);
    await expect(createParty(db, contA, A, novo({ document: CPF }))).rejects.toBeInstanceOf(Forbidden);
    await expect(updateParty(db, contA, A, p.id, novo())).rejects.toBeInstanceOf(Forbidden);
    expect((await listParties(db, contA, A, {})).total).toBe(1);
    expect(await exportParties(db, contA, A)).toContain("Cliente Teste");
    await expect(listParties(db, techA, A, {})).rejects.toBeInstanceOf(Forbidden);
    await expect(getParty(db, techA, A, p.id)).rejects.toBeInstanceOf(Forbidden);
  });

  it("busca, filtro de tipo, arquivados, paginação e escape de curinga", async () => {
    const mkCnpj = (n: number) => { // gera CNPJs numéricos válidos
      const base = String(10000000 + n).padStart(8, "0") + "0001";
      const dv = (b: string, w: number[]) => { const r = [...b].reduce((s, c, i) => s + +c * w[i], 0) % 11; return r < 2 ? 0 : 11 - r; };
      const d1 = dv(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); const d2 = dv(base + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
      return base + d1 + d2;
    };
    for (let i = 0; i < 25; i++) await createParty(db, dirA, A, novo({ legalName: `Empresa ${String(i).padStart(2, "0")}`, document: mkCnpj(i) }));
    const f = await createParty(db, dirA, A, novo({ kind: "fornecedor", legalName: "Fornecedor Único", document: CPF }));
    const p1 = await listParties(db, dirA, A, {});
    expect(p1.total).toBe(26); expect(p1.items).toHaveLength(20); expect(p1.pages).toBe(2);
    expect((await listParties(db, dirA, A, { page: 2 })).items).toHaveLength(6);
    expect((await listParties(db, dirA, A, { kind: "fornecedor" })).items.map((i) => i.id)).toEqual([f.id]);
    expect((await listParties(db, dirA, A, { q: "único" })).total).toBe(1);
    expect((await listParties(db, dirA, A, { q: "529.982" })).total).toBe(1);        // busca por documento com máscara
    expect((await listParties(db, dirA, A, { q: "%" })).total).toBe(0);               // % não é curinga
    await setArchived(db, dirA, A, f.id, true);
    expect((await listParties(db, dirA, A, { archived: true })).total).toBe(1);
    expect((await listParties(db, dirA, A, {})).total).toBe(25);
  });

  it("importação: prévia classifica ok/erro/duplicado; confirmar é idempotente; revalida no servidor", async () => {
    await createParty(db, dirA, A, novo({ document: CNPJ, legalName: "Já existia" }));
    const csv = [
      "tipo;razao_social;nome_fantasia;documento;email_financeiro;telefone",
      `cliente;Novo Cliente;;${CNPJ2};fin@novo.com;(92) 99999-0000`,
      `cliente;Repetido do banco;;${CNPJ};;`,
      `cliente;Repetido no arquivo;;${CNPJ2};;`,
      "cliente;Doc inválido;;123;;",
      `fornecedor;Fornecedor CPF;;${CPF};;`,
      `xyz;Tipo ruim;;${CPF};;`,
      `cliente;Email ruim;;${CPF};nao-e-email;`,
    ].join("\n");
    const pv = await previewImport(db, dirA, A, csv);
    expect(pv.summary).toEqual({ ok: 2, duplicado: 2, erro: 3 });
    expect((await listParties(db, dirA, A, {})).total).toBe(1); // prévia não grava
    expect(await importParties(db, dirA, A, csv)).toEqual({ imported: 2, skipped: 5 });
    expect(await importParties(db, dirA, A, csv)).toEqual({ imported: 0, skipped: 7 }); // reimportar não duplica
    expect((await listParties(db, dirA, A, {})).total).toBe(3);
    const novoC = (await listParties(db, dirA, A, { q: "Novo Cliente" })).items[0];
    expect((await getParty(db, dirA, A, novoC.id))!.contacts[0]).toMatchObject({ email: "fin@novo.com", isFinancial: true });
    expect((await importParties(db, dirB, B, csv)).imported).toBe(3); // outra empresa é independente: o CNPJ "repetido do banco" de A é válido em B
    await expect(importParties(db, contA, A, csv)).rejects.toBeInstanceOf(Forbidden);
    await expect(previewImport(db, dirA, A, "tipo;razao_social\ncliente;X")).rejects.toThrow(/colunas obrigatórias/i);
    await expect(previewImport(db, dirA, A, "x".repeat(500_001))).rejects.toThrow(/500 KB/);
  });

  it("P2: o banco rejeita contato de uma empresa ligado a cadastro de outra (FK composta)", async () => {
    const p = await createParty(db, dirA, A, novo());
    await expect(db.insert(schema.customerContacts).values({ companyId: B, partyId: p.id, name: "Intruso" })).rejects.toThrow();
    await db.insert(schema.customerContacts).values({ companyId: A, partyId: p.id, name: "Legítimo" }); // mesma empresa: ok
  });

  it("exportação: só da própria empresa, neutraliza fórmula e audita", async () => {
    await createParty(db, dirA, A, novo({ legalName: "=HYPERLINK(\"http://x\")" }));
    await createParty(db, dirB, B, novo({ legalName: "Segredo de B" }));
    const csv = await exportParties(db, dirA, A);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).not.toContain("Segredo de B");
    expect(await db.select().from(schema.auditLog).where(sql`action = 'party.exported'`)).toHaveLength(1);
  });

  it("histórico registra criação, alteração e arquivamento — só da própria empresa", async () => {
    const p = await createParty(db, dirA, A, novo());
    await updateParty(db, dirA, A, p.id, novo({ legalName: "Renomeado" }));
    await setArchived(db, dirA, A, p.id, true);
    expect((await history(db, dirA, A, p.id)).map((h) => h.action).sort()).toEqual(["party.archived", "party.created", "party.updated"]);
    expect(await history(db, dirB, B, p.id)).toEqual([]);
  });

  it("P2: voltar a faturar (suspenso/cancelado → ativo) exige gerente ou diretoria; assistente pode suspender/cancelar", async () => {
    const gerA = (await db.insert(schema.users).values({ email: "ger@t.com", name: "g", passwordHash: "x" }).returning())[0].id;
    await db.insert(schema.memberships).values({ userId: gerA, companyId: A, role: "gerente" });
    const c = await createParty(db, asstA, A, novo({ legalName: "Cliente", document: CNPJ }));            // assistente cria como ativo: ok
    const edit = (status: string) => ({ legalName: "Cliente", document: CNPJ, status });
    await updateParty(db, asstA, A, c.id, edit("cancelado"));                                              // reduzir cobrança: ok para assistente
    await expect(updateParty(db, asstA, A, c.id, edit("ativo"))).rejects.toThrow(/gerente ou diretoria/);   // reativar: negado
    expect((await getParty(db, dirA, A, c.id))!.status).toBe("cancelado");                                  // nada mudou
    await updateParty(db, asstA, A, c.id, { legalName: "Renomeado", document: CNPJ });                      // sem tocar na situação: ok
    await updateParty(db, gerA, A, c.id, edit("ativo"));                                                    // gerente pode
    expect((await getParty(db, dirA, A, c.id))!.status).toBe("ativo");
    await updateParty(db, asstA, A, c.id, edit("ativo"));                                                   // ativo→ativo não é reativação
    await updateParty(db, dirA, A, c.id, edit("suspenso"));
    await updateParty(db, dirA, A, c.id, edit("ativo"));                                                    // diretoria pode
    const log = await db.select().from(schema.auditLog).where(sql`action = 'party.updated' and detail ? 'status'`);
    expect(log.length).toBeGreaterThanOrEqual(4);                                                           // mudanças de situação ficam auditadas
  });

  it("situação (local): criar/editar com situação, filtrar, só ativo é faturável, CSV com coluna situacao e exportação", async () => {
    const a = await createParty(db, dirA, A, novo({ legalName: "Ativo SA", document: CNPJ }));
    const s = await createParty(db, dirA, A, novo({ legalName: "Suspenso SA", document: CNPJ2, status: "suspenso" }));
    expect([a.status, s.status]).toEqual(["ativo", "suspenso"]);
    await expect(createParty(db, dirA, A, novo({ document: CPF, status: "inexistente" }))).rejects.toThrow(/Situação inválida/);
    await updateParty(db, dirA, A, s.id, { legalName: "Suspenso SA", document: CNPJ2, status: "cancelado" });
    expect((await getParty(db, dirA, A, s.id))!.status).toBe("cancelado");
    await updateParty(db, dirA, A, s.id, { legalName: "Suspenso SA Renomeado", document: CNPJ2 }); // sem status: mantém
    expect((await getParty(db, dirA, A, s.id))!.status).toBe("cancelado");
    expect((await listParties(db, dirA, A, { status: "ativo" })).total).toBe(1);
    expect((await listParties(db, dirA, A, { status: "cancelado" })).total).toBe(1);
    const rows = (await listParties(db, dirA, A, {})).items;
    expect(rows.filter(isBillable).map((r) => r.legalName)).toEqual(["Ativo SA"]);

    const csv = `tipo;razao_social;documento;situacao\ncliente;Via CSV Suspenso;${CPF};suspenso\ncliente;Sem Coluna Valida;52998224726;ativo\ncliente;Situacao Ruim;${"04.252.011/0001-10"};talvez`;
    const pv = await previewImport(db, dirA, A, csv);
    expect(pv.rows[0]).toMatchObject({ status: "ok", situacao: "suspenso" });
    expect(pv.rows[2]).toMatchObject({ status: "erro" });
    expect(pv.rows[2].message).toMatch(/situacao/);
    await importParties(db, dirA, A, csv);
    expect((await listParties(db, dirA, A, { q: "Via CSV" })).items[0].status).toBe("suspenso");
    const exp = await exportParties(db, dirA, A);
    expect(exp.split("\r\n")[0]).toContain("situacao");
    expect(exp).toContain("cancelado");
  });
});
