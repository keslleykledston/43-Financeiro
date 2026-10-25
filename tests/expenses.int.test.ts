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
import { createPayable, exportPayables, getPayable, submitPayable, updatePayable } from "@/modules/payables/service";
import { DEFAULT_CATEGORIES, listCategories, listCostCenters, listPartners, saveCategory, saveCostCenter, savePartner, setCategoryActive, setCostCenterActive, setPartnerActive } from "@/modules/expenses/catalog";
import { createEntry, exportEntries, listEntries, partnerBalances, reverseEntry } from "@/modules/expenses/ledger";

const enabled = !!process.env.POSTGRES_USER;
const TODAY = "2026-10-25";
const why = (e: unknown) => String((e as { cause?: { message?: string } })?.cause?.message ?? (e as Error)?.message ?? e);

describe.skipIf(!enabled)("D1 — categorias, centros, sócios e conta-corrente (DB de teste)", () => {
  let admin: ReturnType<typeof postgres>, conn: ReturnType<typeof postgres>, db: DB;
  let A: string, B: string, dirA: string, dirB: string, gerA: string, asstA: string, ctbA: string, vendor: string, keslley: string, ana: string;

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
    await db.execute(sql`truncate partner_entries, partners, payable_payments, payables, cost_centers, expense_categories, vendor_contacts, vendors, customer_contacts, customers, audit_log, invitations, memberships, companies, users restart identity cascade`);
    const [a, b] = await db.insert(schema.companies).values([{ name: "Empresa A" }, { name: "Empresa B" }]).returning();
    A = a.id; B = b.id;
    const mk = async (e: string) => (await db.insert(schema.users).values({ email: e, name: e, passwordHash: "x" }).returning())[0].id;
    dirA = await mk("dir-a@t.com"); dirB = await mk("dir-b@t.com"); gerA = await mk("ger@t.com"); asstA = await mk("asst@t.com"); ctbA = await mk("ctb@t.com");
    await db.insert(schema.memberships).values([{ userId: dirA, companyId: A, role: "diretoria" }, { userId: dirB, companyId: B, role: "diretoria" }, { userId: gerA, companyId: A, role: "gerente" }, { userId: asstA, companyId: A, role: "assistente" }, { userId: ctbA, companyId: A, role: "contabilidade" }]);
    vendor = (await createParty(db, dirA, A, { kind: "fornecedor", legalName: "Fornecedor Um", document: "11.222.333/0001-81" })).id;
    keslley = await savePartner(db, dirA, A, { name: "Sócio Um" });
    ana = await savePartner(db, dirA, A, { name: "Sócia Dois" });
  });

  it("categorias padrão nascem sozinhas por empresa, com 'A classificar'; gerente lê mas não altera; empresa B não vê A", async () => {
    const cats = await listCategories(db, dirA, A);
    expect(cats).toHaveLength(DEFAULT_CATEGORIES.length);
    expect(cats.filter((c) => c.kind === "pessoal").length).toBeGreaterThan(5);
    expect(cats.some((c) => c.code === "a_classificar") && cats.some((c) => c.code === "a_classificar_pessoal")).toBe(true);
    expect((await listCategories(db, gerA, A)).length).toBe(cats.length);
    await expect(saveCategory(db, gerA, A, { name: "Nova" })).rejects.toBeInstanceOf(Forbidden);
    expect((await listCategories(db, ctbA, A)).length).toBe(cats.length); // contabilidade lê contas a pagar, logo lê as categorias
    await expect(saveCategory(db, asstA, A, { name: "Nova" })).rejects.toBeInstanceOf(Forbidden);
  });

  it("criar/renomear/desativar categoria e centro; 'A classificar' e 'Operação' protegidos; isolamento por empresa", async () => {
    const id = await saveCategory(db, dirA, A, { name: "Seguros e Ñ", grp: "Operação" });
    expect((await listCategories(db, dirA, A)).find((c) => c.id === id)).toMatchObject({ code: "seguros_e_n", kind: "empresa", grp: "Operação" });
    const id2 = await saveCategory(db, dirA, A, { name: "Seguros e Ñ" }); // mesmo slug: código ganha sufixo
    expect(id2).not.toBe(id);
    await saveCategory(db, dirA, A, { id, name: "Seguros" });
    await setCategoryActive(db, dirA, A, id, false);
    expect((await listCategories(db, dirA, A)).some((c) => c.id === id)).toBe(false);
    expect((await listCategories(db, dirA, A, { all: true })).find((c) => c.id === id)).toMatchObject({ name: "Seguros", active: false });
    const ac = (await listCategories(db, dirA, A)).find((c) => c.code === "a_classificar")!;
    await expect(setCategoryActive(db, dirA, A, ac.id, false)).rejects.toThrow(/não pode ser desativada/);
    await listCategories(db, dirB, B);
    await expect(saveCategory(db, dirB, B, { id, name: "Invadida" })).rejects.toBeInstanceOf(Invalid); // categoria de A
    await expect(setCategoryActive(db, dirB, B, id, true)).rejects.toBeInstanceOf(Invalid);
    const cc = await saveCostCenter(db, dirA, A, { name: "K3G 2 — imóvel de expansão" });
    const centers = await listCostCenters(db, dirA, A);
    expect(centers.map((c) => c.code).sort()).toEqual(["k3g_2_imovel_de_expansao", "operacao"]);
    await setCostCenterActive(db, dirA, A, cc, false);
    await expect(setCostCenterActive(db, dirA, A, centers.find((c) => c.code === "operacao")!.id, false)).rejects.toThrow(/padrão/);
    await expect(saveCostCenter(db, gerA, A, { name: "X1" })).rejects.toBeInstanceOf(Forbidden);
  });

  it("sócios: só diretoria; nome único (sem diferenciar maiúsculas); desativar impede novos lançamentos", async () => {
    await expect(savePartner(db, gerA, A, { name: "Alguém" })).rejects.toBeInstanceOf(Forbidden);
    await expect(savePartner(db, dirA, A, { name: "sócio um" })).rejects.toThrow(/Já existe/);
    expect((await listPartners(db, dirA, A)).map((p) => p.name)).toEqual(["Sócia Dois", "Sócio Um"]);
    await expect(listPartners(db, gerA, A)).rejects.toBeInstanceOf(Forbidden);
    await setPartnerActive(db, dirA, A, ana, false);
    await expect(createEntry(db, dirA, A, { partnerId: ana, kind: "retirada", amount: "10,00", occurredOn: TODAY, description: "x1" }, TODAY)).rejects.toThrow(/inativo/);
    expect(await listPartners(db, dirA, A)).toHaveLength(1);
    expect(await listPartners(db, dirA, A, { all: true })).toHaveLength(2);
  });

  it("conta-corrente: saldo com sinal, retirada sem categoria vai para 'A classificar', estorno, idempotência, relatórios e CSV", async () => {
    const cats = await listCategories(db, dirA, A);
    const pessoal = cats.find((c) => c.code === "moradia")!, empresa = cats.find((c) => c.code === "energia")!;
    const r1 = await createEntry(db, dirA, A, { partnerId: keslley, kind: "retirada", amount: "1.000,00", occurredOn: "2026-10-05", description: "Fatura cartão pessoal", requestKey: "k1" }, TODAY);
    const dup = await createEntry(db, dirA, A, { partnerId: keslley, kind: "retirada", amount: "1.000,00", occurredOn: "2026-10-05", description: "Fatura cartão pessoal", requestKey: "k1" }, TODAY);
    expect(dup).toEqual({ id: r1.id, duplicate: true });
    await createEntry(db, dirA, A, { partnerId: keslley, kind: "retirada", amount: "300,50", occurredOn: "2026-10-10", categoryId: pessoal.id, description: "Conta de luz da casa" }, TODAY);
    await createEntry(db, dirA, A, { partnerId: keslley, kind: "despesa_paga_pelo_socio", amount: "200,00", occurredOn: "2026-10-11", categoryId: empresa.id, description: "Compra da empresa no cartão PF" }, TODAY);
    await createEntry(db, dirA, A, { partnerId: keslley, kind: "devolucao_do_socio", amount: "100,00", occurredOn: "2026-10-12", description: "Devolveu" }, TODAY);
    await createEntry(db, dirA, A, { partnerId: ana, kind: "retirada", amount: "50,00", occurredOn: "2026-09-30", description: "Mês passado" }, TODAY);
    const b = await partnerBalances(db, dirA, A, TODAY);
    const k = b.find((x) => x.partnerId === keslley)!, an = b.find((x) => x.partnerId === ana)!;
    expect(k.balanceCents).toBe(-100000 - 30050 + 20000 + 10000); // −1.000 −300,50 +200 +100
    expect(k.withdrawnMonthCents).toBe(130050); expect(k.withdrawnYearCents).toBe(130050);
    expect(k).toMatchObject({ toClassifyCount: 1, toClassifyCents: 100000 });
    expect(an).toMatchObject({ balanceCents: -5000, withdrawnMonthCents: 0, withdrawnYearCents: 5000 });
    const list = await listEntries(db, dirA, A, { partnerId: keslley, month: "2026-10" });
    expect(list).toHaveLength(4);
    expect(list.find((e) => e.id === r1.id)).toMatchObject({ categoryName: "A classificar (pessoal)", toClassify: true, signedCents: -100000 });
    expect(list.find((e) => e.kind === "despesa_paga_pelo_socio")!.signedCents).toBe(20000);
    // estorno: sai do saldo, fica no histórico, não estorna duas vezes
    await expect(reverseEntry(db, dirA, A, r1.id, "x")).rejects.toThrow(/motivo/);
    await reverseEntry(db, dirA, A, r1.id, "lançado no sócio errado");
    await expect(reverseEntry(db, dirA, A, r1.id, "de novo")).rejects.toThrow(/já estornado/);
    expect((await partnerBalances(db, dirA, A, TODAY)).find((x) => x.partnerId === keslley)!.balanceCents).toBe(-30050 + 20000 + 10000 + 0);
    expect((await listEntries(db, dirA, A, { status: "estornado" }))).toHaveLength(1);
    const csv = await exportEntries(db, dirA, A, { month: "2026-10" });
    expect(csv.split("\n")[0]).toContain("efeito_no_saldo");
    expect(csv).toContain("estornado");
    const acts = (await db.select().from(schema.auditLog)).map((a) => a.action);
    expect(acts).toEqual(expect.arrayContaining(["partner.entry_created", "partner.entry_reversed", "partner.exported", "partner.saved"]));
    expect(JSON.stringify(await db.select().from(schema.auditLog))).not.toContain("Fatura cartão pessoal"); // descrição nunca vai para a auditoria
  });

  it("validações: valor, data futura, tipo, categoria do tipo errado, conta a pagar, sócio de outra empresa; só diretoria lança e lê", async () => {
    const cats = await listCategories(db, dirA, A);
    const base = { partnerId: keslley, kind: "retirada", amount: "10,00", occurredOn: TODAY, description: "ok ok" };
    await expect(createEntry(db, dirA, A, { ...base, amount: "0" }, TODAY)).rejects.toThrow(/valor/i);
    await expect(createEntry(db, dirA, A, { ...base, occurredOn: "2026-10-26" }, TODAY)).rejects.toThrow(/futura/);
    await expect(createEntry(db, dirA, A, { ...base, occurredOn: "2026-02-30" }, TODAY)).rejects.toThrow(/Data inválida/);
    await expect(createEntry(db, dirA, A, { ...base, kind: "doacao" }, TODAY)).rejects.toThrow(/tipo/);
    await expect(createEntry(db, dirA, A, { ...base, description: "x" }, TODAY)).rejects.toThrow(/Descreva/);
    await expect(createEntry(db, dirA, A, { ...base, categoryId: cats.find((c) => c.code === "energia")!.id }, TODAY)).rejects.toThrow(/gasto pessoal/); // retirada com categoria da empresa
    await expect(createEntry(db, dirA, A, { ...base, kind: "despesa_paga_pelo_socio", categoryId: cats.find((c) => c.code === "moradia")!.id }, TODAY)).rejects.toThrow(/da empresa/);
    await expect(createEntry(db, dirA, A, { ...base, payableId: "00000000-0000-0000-0000-000000000000" }, TODAY)).rejects.toThrow(/Só a despesa paga pelo sócio/);
    await expect(createEntry(db, dirA, A, { ...base, kind: "despesa_paga_pelo_socio", payableId: "00000000-0000-0000-0000-000000000000" }, TODAY)).rejects.toThrow(/não encontrada/);
    await expect(createEntry(db, dirA, A, { ...base, partnerId: "00000000-0000-0000-0000-000000000000" }, TODAY)).rejects.toThrow(/Sócio não encontrado/);
    await savePartner(db, dirB, B, { name: "Sócio de B" });
    const sB = (await listPartners(db, dirB, B))[0].id;
    await expect(createEntry(db, dirA, A, { ...base, partnerId: sB }, TODAY)).rejects.toThrow(/Sócio não encontrado/); // sócio de outra empresa
    await expect(createEntry(db, dirB, B, { ...base, partnerId: keslley }, TODAY)).rejects.toThrow(/Sócio não encontrado/);
    for (const u of [gerA, asstA, ctbA]) {
      await expect(createEntry(db, u, A, base, TODAY)).rejects.toBeInstanceOf(Forbidden);
      await expect(partnerBalances(db, u, A, TODAY)).rejects.toBeInstanceOf(Forbidden);
      await expect(listEntries(db, u, A)).rejects.toBeInstanceOf(Forbidden);
      await expect(exportEntries(db, u, A)).rejects.toBeInstanceOf(Forbidden);
    }
    await expect(reverseEntry(db, dirA, B, "00000000-0000-0000-0000-000000000000", "motivo")).rejects.toBeInstanceOf(Forbidden);
    const e = await createEntry(db, dirA, A, base, TODAY);
    await expect(reverseEntry(db, dirB, B, e.id, "tentando")).rejects.toThrow(/não encontrado/); // lançamento de A com contexto B
  });

  it("despesa paga pelo sócio pode apontar para uma conta a pagar da mesma empresa", async () => {
    const cats = await listCategories(db, dirA, A);
    const pid = await createPayable(db, dirA, A, { vendorId: vendor, description: "Licença anual", amount: "500,00", dueDate: "2026-11-05", categoryId: cats.find((c) => c.code === "software")!.id });
    const e = await createEntry(db, dirA, A, { partnerId: keslley, kind: "despesa_paga_pelo_socio", amount: "500,00", occurredOn: TODAY, description: "Paguei no cartão PF", payableId: pid }, TODAY);
    expect((await db.select().from(schema.partnerEntries).where(eq(schema.partnerEntries.id, e.id)))[0].payableId).toBe(pid);
  });

  it("contas a pagar com categoria, centro e competência: valida empresa/ativo/tipo, edita no rascunho e trava depois de enviada", async () => {
    const cats = await listCategories(db, dirA, A);
    const energia = cats.find((c) => c.code === "energia")!, moradia = cats.find((c) => c.code === "moradia")!;
    const centro = await saveCostCenter(db, dirA, A, { name: "Imóvel de expansão" });
    const input = { vendorId: vendor, description: "Energia setembro", amount: "100,00", dueDate: "2026-11-05", categoryId: energia.id, costCenterId: centro, competence: "2026-10" };
    await expect(createPayable(db, dirA, A, { ...input, categoryId: moradia.id })).rejects.toThrow(/categoria de despesa da empresa/);
    await expect(createPayable(db, dirA, A, { ...input, competence: "2026-13" })).rejects.toThrow(/competência/);
    await expect(createPayable(db, dirA, A, { ...input, costCenterId: "00000000-0000-0000-0000-000000000000" })).rejects.toThrow(/Centro de custo/);
    await listCategories(db, dirB, B);
    const catB = (await listCategories(db, dirB, B)).find((c) => c.code === "energia")!;
    await expect(createPayable(db, dirA, A, { ...input, categoryId: catB.id })).rejects.toThrow(/Categoria não encontrada/); // categoria de outra empresa
    const id = await createPayable(db, dirA, A, input);
    const p = (await getPayable(db, dirA, A, id, TODAY))!;
    expect(p).toMatchObject({ categoryName: "Energia", costCenterName: "Imóvel de expansão", competence: "2026-10-01" });
    await setCostCenterActive(db, dirA, A, centro, false);
    await expect(updatePayable(db, dirA, A, id, input)).rejects.toThrow(/inativo/); // centro desativado depois: não dá para escolher de novo
    await updatePayable(db, dirA, A, id, { ...input, costCenterId: undefined, competence: "2026-09" });
    expect((await getPayable(db, dirA, A, id, TODAY))).toMatchObject({ costCenterName: null, competence: "2026-09-01" });
    await submitPayable(db, dirA, A, id);
    // depois de enviada, a classificação é imutável também no banco (gatilho)
    const e1 = await db.execute(sql`update payables set competence = '2026-08-01' where id = ${id}`).catch(why);
    expect(String(e1)).toMatch(/payable_immutable/);
    const e2 = await db.execute(sql`update payables set category_id = null where id = ${id}`).catch(why);
    expect(String(e2)).toMatch(/payable_immutable/);
    const legacy = await db.execute(sql`update payables set competence = '2026-08-15' where id = ${id}`).catch(why);
    expect(String(legacy)).toMatch(/payable_immutable|competence_chk/);
  });

  it("CSV de contas a pagar: colunas antigas na mesma ordem, novas no fim, e nome malicioso de categoria/centro sai neutralizado", async () => {
    const energia = (await listCategories(db, dirA, A)).find((c) => c.code === "energia")!;
    await saveCategory(db, dirA, A, { id: energia.id, name: "=HYPERLINK(\"http://x\")" });
    const centro = await saveCostCenter(db, dirA, A, { name: "+cmd|calc" });
    await createPayable(db, dirA, A, { vendorId: vendor, description: "Conta teste", amount: "10,00", dueDate: "2026-11-05", categoryId: energia.id, costCenterId: centro, competence: "2026-10" });
    const csv = await exportPayables(db, dirA, A, { status: "todas" }, false, TODAY);
    const [head, line] = csv.split("\r\n").map((l) => l.replace(/^\uFEFF/, ""));
    expect(head).toBe("Fornecedor;Descrição;Documento;Categoria;Vencimento;Valor;Pago;Saldo;Situação;Dias de atraso;Centro de custo;Competência");
    expect(line).toContain("'=HYPERLINK");
    expect(line).toContain("'+cmd|calc");
    expect(line.endsWith("10/2026")).toBe(true);
    expect(line).not.toMatch(/(^|;)"?[=+@-]/);
  });

  it("estorno exige motivo de verdade também no banco; estorno concorrente não sobrescreve o primeiro", async () => {
    const e = await createEntry(db, dirA, A, { partnerId: keslley, kind: "retirada", amount: "10,00", occurredOn: TODAY, description: "ok ok" }, TODAY);
    expect(String(await db.execute(sql`update partner_entries set status = 'estornado', reversed_by = ${dirA}, reversed_at = now(), reverse_reason = '   ' where id = ${e.id}`).catch(why))).toMatch(/reversal_chk/);
    const r = await Promise.allSettled([reverseEntry(db, dirA, A, e.id, "primeiro motivo"), reverseEntry(db, dirA, A, e.id, "segundo motivo")]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(r.filter((x) => x.status === "rejected")).toHaveLength(1);
    const [row] = await db.select().from(schema.partnerEntries).where(eq(schema.partnerEntries.id, e.id));
    expect(["primeiro motivo", "segundo motivo"]).toContain(row.reverseReason);
  });

  it("padrões das categorias: primeira leitura simultânea não duplica nem deixa faltar", async () => {
    await db.execute(sql`delete from payables where company_id = ${B}`);
    await Promise.all([1, 2, 3, 4].map(() => listCategories(db, dirB, B)));
    expect(await listCategories(db, dirB, B)).toHaveLength(DEFAULT_CATEGORIES.length);
    expect(await listCostCenters(db, dirB, B)).toHaveLength(1);
  });

  it("reenvio concorrente do mesmo formulário (mesma requestKey) cria um lançamento só", async () => {
    const mk = () => createEntry(db, dirA, A, { partnerId: keslley, kind: "retirada", amount: "10,00", occurredOn: TODAY, description: "ok ok", requestKey: "mesma" }, TODAY);
    const r = await Promise.all([mk(), mk(), mk()]);
    expect(new Set(r.map((x) => x.id)).size).toBe(1);
    expect(await db.select().from(schema.partnerEntries)).toHaveLength(1);
  });

  it("gatilhos da conta-corrente: não apaga, não altera valor, estornado é imutável; competência precisa ser dia 1", async () => {
    const e = await createEntry(db, dirA, A, { partnerId: keslley, kind: "retirada", amount: "10,00", occurredOn: TODAY, description: "ok ok" }, TODAY);
    expect(String(await db.execute(sql`delete from partner_entries where id = ${e.id}`).catch(why))).toMatch(/partner_entry_undeletable/);
    expect(String(await db.execute(sql`update partner_entries set amount = 99 where id = ${e.id}`).catch(why))).toMatch(/partner_entry_immutable/);
    expect(String(await db.execute(sql`update partner_entries set status = 'estornado' where id = ${e.id}`).catch(why))).toMatch(/partner_entries_reversal_chk|reversal/);
    await reverseEntry(db, dirA, A, e.id, "motivo ok");
    expect(String(await db.execute(sql`update partner_entries set description = 'outra' where id = ${e.id}`).catch(why))).toMatch(/partner_entry_immutable/);
    expect(String(await db.execute(sql`insert into partner_entries (company_id, partner_id, kind, amount, occurred_on, description, status, created_by) values (${A}, ${keslley}, 'retirada', 1, '2026-10-01', 'xx', 'estornado', ${dirA})`).catch(why))).toMatch(/partner_entry_insert_not_active|reversal/);
  });
});
