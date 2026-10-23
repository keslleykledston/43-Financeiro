import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { databaseUrl } from "@/lib/db/url";
import * as schema from "@/lib/db/schema";
import type { DB } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import { createParty } from "@/modules/crm/service";
import { createContract, customerOptions, decideVersion, getContract, listContracts, proposeChange, setStatus } from "@/modules/contracts/service";
import { addHoliday, getBillingCalendar, listHolidays, removeHoliday } from "@/modules/billing/service";

const enabled = !!process.env.POSTGRES_USER;
const CNPJ1 = "11.222.333/0001-81", CNPJ2 = "12.ABC.345/01DE-35", CPF1 = "529.982.247-25";
const terms = (o: Record<string, unknown> = {}) => ({ description: "Monitoramento de redes", monthlyAmount: "2.500,00", startAt: "2026-01-01", endAt: "", dueDay: "5", invoiceJointRequired: false, issueDayOverride: "", ...o });

describe.skipIf(!enabled)("Contratos e calendário de faturamento (DB de teste)", () => {
  let admin: ReturnType<typeof postgres>, conn: ReturnType<typeof postgres>, db: DB;
  let A: string, B: string, dirA: string, dirB: string, gerA: string, ger2A: string, asstA: string, contA: string, techA: string, cliA: string, cliB: string;

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
    await db.execute(sql`truncate holidays, contract_versions, contracts, integration_conflicts, integration_sync_runs, integration_connections, rate_limits, customer_contacts, vendor_contacts, customers, vendors, audit_log, invitations, memberships, companies, users restart identity cascade`);
    const [a, b] = await db.insert(schema.companies).values([{ name: "A" }, { name: "B" }]).returning();
    A = a.id; B = b.id;
    const mk = async (e: string) => (await db.insert(schema.users).values({ email: e, name: e, passwordHash: "x" }).returning())[0].id;
    dirA = await mk("dir-a@t.com"); dirB = await mk("dir-b@t.com"); gerA = await mk("ger@t.com"); ger2A = await mk("ger2@t.com"); asstA = await mk("asst@t.com"); contA = await mk("cont@t.com"); techA = await mk("tech@t.com");
    await db.insert(schema.memberships).values([
      { userId: dirA, companyId: A, role: "diretoria" }, { userId: dirB, companyId: B, role: "diretoria" }, { userId: gerA, companyId: A, role: "gerente" }, { userId: ger2A, companyId: A, role: "gerente" },
      { userId: asstA, companyId: A, role: "assistente" }, { userId: contA, companyId: A, role: "contabilidade" }, { userId: techA, companyId: A, role: "admin_tecnico" },
    ]);
    cliA = (await createParty(db, dirA, A, { kind: "cliente", legalName: "Cliente A", document: CNPJ1 })).id;
    cliB = (await createParty(db, dirB, B, { kind: "cliente", legalName: "Cliente B", document: CNPJ1 })).id;
  });

  /** contrato já aprovado e ativo */
  const active = async (customer = cliA, t = terms(), co = A, creator = asstA, approver = dirA) => {
    const c = await createContract(db, creator, co, customer, t);
    const v = (await getContract(db, approver, co, c.id))!.versions[0];
    await decideVersion(db, approver, co, v.id, "aprovar");
    return c.id;
  };

  it("criar: nasce RASCUNHO com versão 1 pendente; dinheiro em centavos/numeric; validações", async () => {
    const c = await createContract(db, asstA, A, cliA, terms());
    expect(c.status).toBe("rascunho"); expect(c.monthlyAmount).toBe("2500.00");
    const full = (await getContract(db, dirA, A, c.id))!;
    expect(full.amountCents).toBe(250000); expect(full.versions).toHaveLength(1);
    expect(full.versions[0]).toMatchObject({ version: 1, state: "pendente", requestedBy: asstA });
    expect(full.versions[0].terms).toMatchObject({ monthlyAmountCents: 250000, dueDay: 5, endAt: null, issueDayOverride: null });
    const bad = async (o: Record<string, unknown>, re: RegExp) => expect(createContract(db, asstA, A, cliA, terms(o))).rejects.toThrow(re);
    await bad({ monthlyAmount: "2500.50" }, /Valor mensal inválido/); await bad({ monthlyAmount: "0" }, /Valor mensal inválido/); await bad({ dueDay: "32" }, /1 a 31/); await bad({ dueDay: "0" }, /1 a 31/);
    await bad({ endAt: "2025-12-31" }, /anterior ao início/); await bad({ startAt: "2026-02-30" }, /Data inválida/); await bad({ issueDayOverride: "29" }, /1 a 28/); await bad({ dueDay: "5", issueDayOverride: "10" }, /posterior/); await bad({ description: "" }, /serviço/);
  });

  it("permissões: assistente grava mas não aprova; contabilidade só lê; admin técnico não vê", async () => {
    await expect(createContract(db, contA, A, cliA, terms())).rejects.toBeInstanceOf(Forbidden);
    await expect(createContract(db, techA, A, cliA, terms())).rejects.toBeInstanceOf(Forbidden);
    const c = await createContract(db, asstA, A, cliA, terms());
    const v = (await getContract(db, contA, A, c.id))!.versions[0];
    await expect(decideVersion(db, asstA, A, v.id, "aprovar")).rejects.toBeInstanceOf(Forbidden);
    await expect(decideVersion(db, contA, A, v.id, "aprovar")).rejects.toBeInstanceOf(Forbidden);
    await expect(listContracts(db, techA, A, {})).rejects.toBeInstanceOf(Forbidden);
    expect((await listContracts(db, contA, A, {})).total).toBe(1);
  });

  it("aprovação: quem solicitou não aprova (exceto diretoria); a v1 aprovada ativa o contrato", async () => {
    const c = await createContract(db, gerA, A, cliA, terms());
    const v = (await getContract(db, gerA, A, c.id))!.versions[0];
    await expect(decideVersion(db, gerA, A, v.id, "aprovar")).rejects.toThrow(/Quem solicitou/);   // gerente aprovando a própria
    await decideVersion(db, ger2A, A, v.id, "aprovar", "ok");                                       // outro gerente
    expect((await getContract(db, dirA, A, c.id))!).toMatchObject({ status: "ativo" });
    await expect(decideVersion(db, ger2A, A, v.id, "aprovar")).rejects.toThrow(/já decidida/);        // não decide duas vezes
    const c2 = await createContract(db, dirA, A, cliA, terms({ description: "Outro" }));
    await decideVersion(db, dirA, A, (await getContract(db, dirA, A, c2.id))!.versions[0].id, "aprovar"); // diretoria pode aprovar o próprio
    expect((await getContract(db, dirA, A, c2.id))!.status).toBe("ativo");
  });

  it("alteração: nada vigora até aprovar; só uma pendente; sem mudança é recusada; rejeitar mantém os termos", async () => {
    const id = await active();
    await proposeChange(db, asstA, A, id, terms({ monthlyAmount: "3.000,00", dueDay: "10" }), "Reajuste");
    let c = (await getContract(db, dirA, A, id))!;
    expect(c.amountCents).toBe(250000); expect(c.dueDay).toBe(5);                           // termos vigentes intactos
    expect(c.versions.map((v) => [v.version, v.state])).toEqual([[2, "pendente"], [1, "aprovada"]]);
    await expect(proposeChange(db, asstA, A, id, terms({ monthlyAmount: "3.500,00" }))).rejects.toThrow(/pendente de aprovação/);
    await decideVersion(db, dirA, A, c.versions[0].id, "rejeitar", "valor não combinado");
    c = (await getContract(db, dirA, A, id))!;
    expect(c.amountCents).toBe(250000); expect(c.versions[0]).toMatchObject({ state: "rejeitada", decisionNote: "valor não combinado" });
    await expect(proposeChange(db, asstA, A, id, terms())).rejects.toThrow(/Nenhuma alteração/);
    await proposeChange(db, asstA, A, id, terms({ monthlyAmount: "3.000,00", dueDay: "10" }));
    await decideVersion(db, dirA, A, (await getContract(db, dirA, A, id))!.versions[0].id, "aprovar");
    c = (await getContract(db, dirA, A, id))!;
    expect(c).toMatchObject({ amountCents: 300000, dueDay: 10 }); expect(c.versions).toHaveLength(3);
  });

  it("situação: suspender/encerrar é livre para quem grava; voltar a ativo exige aprovação; encerrado é definitivo", async () => {
    const id = await active();
    await setStatus(db, asstA, A, id, "suspenso");
    await expect(setStatus(db, asstA, A, id, "ativo")).rejects.toBeInstanceOf(Forbidden);
    await setStatus(db, gerA, A, id, "ativo");
    await setStatus(db, asstA, A, id, "encerrado");
    await expect(setStatus(db, dirA, A, id, "ativo")).rejects.toThrow(/definitivo/);
    await expect(proposeChange(db, asstA, A, id, terms({ dueDay: "9" }))).rejects.toThrow(/encerrado/);
    const draft = await createContract(db, asstA, A, cliA, terms());
    await expect(setStatus(db, dirA, A, draft.id, "suspenso")).rejects.toThrow(/rascunho/);
  });

  it("isolamento: contrato, cliente e calendário de uma empresa são invisíveis e intocáveis por outra", async () => {
    const id = await active();
    expect(await getContract(db, dirB, B, id)).toBeNull();
    await expect(proposeChange(db, dirB, B, id, terms({ dueDay: "9" }))).rejects.toThrow(/não encontrado/);
    await expect(setStatus(db, dirB, B, id, "suspenso")).rejects.toThrow(/não encontrado/);
    const v = (await getContract(db, dirA, A, id))!.versions[0];
    await expect(decideVersion(db, dirB, B, v.id, "aprovar")).rejects.toThrow(/não encontrada|já decidida/);
    await expect(createContract(db, dirB, B, cliA, terms())).rejects.toThrow(/Cliente não encontrado/);   // cliente de OUTRA empresa
    await expect(createContract(db, dirA, B, cliB, terms())).rejects.toBeInstanceOf(Forbidden);            // dirA não é membro de B
    expect((await listContracts(db, dirB, B, {})).total).toBe(0);
    expect((await getBillingCalendar(db, dirB, B, "2026-10")).days.filter((d) => d.issue.length || d.due.length)).toHaveLength(0);
    // o banco também impede ligar contrato de uma empresa a cliente de outra (FK composta)
    await expect(db.execute(sql`insert into contracts (company_id, customer_id, description, monthly_amount, start_at, due_day) values (${B}, ${cliA}, 'x', 10, '2026-01-01', 5)`)).rejects.toThrow();
    expect((await customerOptions(db, dirB, B)).map((c) => c.name)).toEqual(["Cliente B"]);
  });

  it("DB: uma única alteração pendente por contrato; CHECKs de valor/dia/datas", async () => {
    const id = await active();
    await proposeChange(db, asstA, A, id, terms({ dueDay: "9" }));
    await expect(db.execute(sql`insert into contract_versions (company_id, contract_id, version, state, terms, requested_by) values (${A}, ${id}, 99, 'pendente', '{}'::jsonb, ${asstA})`)).rejects.toThrow();
    await expect(db.execute(sql`update contracts set monthly_amount = 0 where id = ${id}`)).rejects.toThrow();
    await expect(db.execute(sql`update contracts set due_day = 40 where id = ${id}`)).rejects.toThrow();
    await expect(db.execute(sql`update contracts set status = 'qualquer' where id = ${id}`)).rejects.toThrow();
  });

  it("calendário de outubro/2026: emissões e vencimentos certos por lote, só de contratos faturáveis", async () => {
    await active(cliA, terms({ description: "Sem NF dia 5", dueDay: "5" }));
    await active(cliA, terms({ description: "Com NF dia 5", dueDay: "5", invoiceJointRequired: true, monthlyAmount: "1.000,00" }));
    await active(cliA, terms({ description: "Dia 20", dueDay: "20", monthlyAmount: "500,50" }));
    const cal = await getBillingCalendar(db, dirA, A, "2026-10");
    const ev = (d: string) => cal.days.find((x) => x.date === d);
    expect(ev("2026-10-25")!.issue.map((i) => i.description)).toEqual(["Sem NF dia 5"]);         // lote 25 (emite p/ vencer em novembro)
    expect(ev("2026-10-01")!.issue.map((i) => i.description)).toEqual(["Com NF dia 5"]);         // NF conjunta: dia 1
    expect(ev("2026-10-08")!.issue.map((i) => i.description)).toEqual(["Dia 20"]);              // lote 8
    expect(ev("2026-10-05")!.due.map((i) => i.description).sort()).toEqual(["Com NF dia 5", "Sem NF dia 5"]);
    expect(ev("2026-10-20")!.due.map((i) => i.description)).toEqual(["Dia 20"]);
    expect(cal.batches).toEqual([{ batch: 25, count: 1, cents: 250000 }, { batch: 1, count: 1, cents: 100000 }, { batch: 8, count: 1, cents: 50050 }]);
    expect(cal.totals).toMatchObject({ issueCount: 3, issueCents: 400050, dueCount: 3, dueCents: 400050 });
    expect(cal.review).toEqual([]);
    expect(ev("2026-10-12")?.holiday).toBe("Nossa Senhora Aparecida");                          // feriado nacional aparece
  });

  it("calendário: exclui rascunho, contrato suspenso, cliente suspenso/cancelado, fora da vigência; dia 31 e feriado vão para revisão", async () => {
    await createContract(db, asstA, A, cliA, terms({ description: "Rascunho" }));                              // não aprovado
    const susp = await active(cliA, terms({ description: "Contrato suspenso" })); await setStatus(db, dirA, A, susp, "suspenso");
    await active(cliA, terms({ description: "Começa só em dez/2026", startAt: "2026-12-01" }));
    await active(cliA, terms({ description: "Terminou em ago/2026", endAt: "2026-08-31" }));
    const cli2 = (await createParty(db, dirA, A, { kind: "cliente", legalName: "Cliente Cancelado", document: CNPJ2, status: "cancelado" })).id;
    await active(cli2, terms({ description: "Cliente cancelado" }));
    await active(cliA, terms({ description: "Vence dia 31", dueDay: "31" }));
    await active(cliA, terms({ description: "Emite em feriado", dueDay: "26", monthlyAmount: "100,00" }));
    await addHoliday(db, dirA, A, { day: "2026-10-15", name: "Feriado municipal fictício" });                  // emissão do lote 15 (venc. 23–30) cai aqui
    await active(cliA, terms({ description: "Lote 15", dueDay: "26" }));
    const cal = await getBillingCalendar(db, dirA, A, "2026-10");
    const all = cal.days.flatMap((d) => [...d.issue, ...d.due]).map((i) => i.description);
    for (const nao of ["Rascunho", "Contrato suspenso", "Começa só em dez/2026", "Terminou em ago/2026", "Cliente cancelado"]) expect(all).not.toContain(nao);
    expect(cal.review.map((i) => [i.description, i.reason]).sort()).toEqual(expect.arrayContaining([["Vence dia 31", "dia 31 não possui lote confirmado"], ["Lote 15", "feriado; política pendente"]]));
    expect(cal.days.find((d) => d.date === "2026-10-15")).toMatchObject({ holiday: "Feriado municipal fictício" });
    // dezembro/2026: a vigência começa em 01/12, então a 1ª competência faturável é dezembro (vence em janeiro): aparece como EMISSÃO (dia 25, Natal → revisão)
    const dez = await getBillingCalendar(db, dirA, A, "2026-12");
    expect(dez.days.flatMap((d) => d.issue).map((i) => i.description)).toContain("Começa só em dez/2026");
    expect(dez.days.flatMap((d) => d.due).map((i) => i.description)).not.toContain("Começa só em dez/2026"); // nada vence em dez para este contrato
    expect(dez.review.some((i) => i.description === "Começa só em dez/2026" && i.reason === "feriado; política pendente")).toBe(true);
  });

  it("feriados por empresa: só gerente/diretoria cadastram; isolados; auditados", async () => {
    await expect(addHoliday(db, asstA, A, { day: "2026-10-24", name: "Aniversário" })).rejects.toBeInstanceOf(Forbidden);
    await addHoliday(db, gerA, A, { day: "2026-10-24", name: "Aniversário da cidade" });
    await expect(addHoliday(db, gerA, A, { day: "2026-13-40", name: "inválido" })).rejects.toBeInstanceOf(Invalid);
    expect((await listHolidays(db, dirA, A, 2026)).own.map((h) => h.name)).toEqual(["Aniversário da cidade"]);
    expect((await listHolidays(db, dirB, B, 2026)).own).toHaveLength(0);
    const id = (await listHolidays(db, dirA, A, 2026)).own[0].id;
    await expect(removeHoliday(db, dirB, B, id)).rejects.toBeInstanceOf(Invalid);                  // não remove de outra empresa
    await removeHoliday(db, dirA, A, id);
    expect((await listHolidays(db, dirA, A, 2026)).own).toHaveLength(0);
    expect((await listHolidays(db, dirA, A, 2026)).national.some((h) => h.name === "Natal")).toBe(true);
    expect(await db.select().from(schema.auditLog).where(sql`action like 'holiday.%'`)).toHaveLength(2);
  });
});
