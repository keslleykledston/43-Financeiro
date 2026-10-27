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
import { createContract, decideVersion, getContract } from "@/modules/contracts/service";
import { listContractAlerts } from "@/modules/contracts/alerts";
import { addDays, getAdjustmentRule, parsePctBps, saveAdjustmentRule, snoozeAlert, suggestedCents, unsnoozeAlert } from "@/modules/contracts/adjustment";

const enabled = !!process.env.POSTGRES_USER;
const terms = (o: Record<string, unknown> = {}) => ({ description: "Monitoramento", monthlyAmount: "2.500,00", startAt: "2025-03-01", endAt: "", dueDay: "5", invoiceJointRequired: false, issueDayOverride: "", ...o });
const TODAY = "2026-02-20"; // faltam 9 dias para fazer 12 meses em 2026-03-01 (reajuste) / renovação 2026-03-01

describe("E31 — percentual e valor sugerido", () => {
  it("parsePctBps aceita 0–100 com até 2 casas; recusa o resto", () => {
    expect(parsePctBps("4,5")).toBe(450); expect(parsePctBps("4.50%")).toBe(450); expect(parsePctBps("0")).toBe(0); expect(parsePctBps(" 100 ")).toBe(10000);
    for (const bad of ["101", "-1", "abc", "1,234", "", "1e2", "4,5,6"]) expect(() => parsePctBps(bad)).toThrow(/Percentual inválido/);
  });
  it("valor sugerido = atual × (1+%), arredondado ao centavo", () => {
    expect(suggestedCents(9_999_999_999_999, 1)).toBeNull(); expect(suggestedCents(9_999_999_999_999, 0)).toBe(9_999_999_999_999); // teto do contrato
    expect(suggestedCents(250000, 450)).toBe(261250); expect(suggestedCents(100001, 333)).toBe(Math.round(100001 * 1.0333)); expect(suggestedCents(250000, 0)).toBe(250000);
  });
  it("addDays", () => { expect(addDays("2026-02-20", 30)).toBe("2026-03-22"); expect(addDays("2026-12-31", 1)).toBe("2027-01-01"); });
});

describe.skipIf(!enabled)("E31 — regra de reajuste e alertas adiados/ignorados (DB de teste)", () => {
  let admin: ReturnType<typeof postgres>, conn: ReturnType<typeof postgres>, db: DB;
  let A: string, B: string, dirA: string, dirB: string, gerA: string, asstA: string, contA: string, cli: string, k: string;

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
    await db.execute(sql`truncate contract_alert_snoozes, contract_adjustment_rules, contract_versions, contracts, customer_contacts, vendor_contacts, customers, vendors, audit_log, invitations, memberships, companies, users restart identity cascade`);
    const [a, b] = await db.insert(schema.companies).values([{ name: "A" }, { name: "B" }]).returning();
    A = a.id; B = b.id;
    const mk = async (e: string) => (await db.insert(schema.users).values({ email: e, name: e, passwordHash: "x" }).returning())[0].id;
    dirA = await mk("dir-a@t.com"); dirB = await mk("dir-b@t.com"); gerA = await mk("ger@t.com"); asstA = await mk("asst@t.com"); contA = await mk("cont@t.com");
    await db.insert(schema.memberships).values([{ userId: dirA, companyId: A, role: "diretoria" }, { userId: dirB, companyId: B, role: "diretoria" }, { userId: gerA, companyId: A, role: "gerente" }, { userId: asstA, companyId: A, role: "assistente" }, { userId: contA, companyId: A, role: "contabilidade" }]);
    cli = (await createParty(db, dirA, A, { kind: "cliente", legalName: "Cliente A", document: "11.222.333/0001-81" })).id;
    const c = await createContract(db, asstA, A, cli, terms());
    await decideVersion(db, dirA, A, (await getContract(db, dirA, A, c.id))!.versions[0].id, "aprovar");
    k = c.id;
  });

  const alerts = async (today = TODAY) => (await listContractAlerts(db, dirA, A, today, 60));

  it("regra de reajuste: índice ou percentual fixo; só quem escreve contratos; validações e isolamento", async () => {
    expect(await getAdjustmentRule(db, dirA, A, k)).toBeNull();
    await saveAdjustmentRule(db, gerA, A, k, { index: "ipca", note: " índice do mês anterior " });
    expect(await getAdjustmentRule(db, contA, A, k)).toEqual({ indexCode: "ipca", fixedBps: null, note: "índice do mês anterior" });
    await saveAdjustmentRule(db, dirA, A, k, { index: "fixo", fixedPct: "4,5" });
    expect(await getAdjustmentRule(db, dirA, A, k)).toEqual({ indexCode: "fixo", fixedBps: 450, note: null }); // atualiza, não duplica
    expect(await db.select().from(schema.contractAdjustmentRules)).toHaveLength(1);
    await expect(saveAdjustmentRule(db, contA, A, k, { index: "ipca" })).rejects.toBeInstanceOf(Forbidden);
    await expect(saveAdjustmentRule(db, dirB, A, k, { index: "ipca" })).rejects.toBeInstanceOf(Forbidden);
    await expect(saveAdjustmentRule(db, dirB, B, k, { index: "ipca" })).rejects.toThrow(/não encontrado/); // contrato de outra empresa
    await expect(saveAdjustmentRule(db, dirA, A, k, { index: "fixo", fixedPct: "" })).rejects.toThrow(/Percentual inválido/);
    await expect(saveAdjustmentRule(db, dirA, A, k, { index: "xyz" })).rejects.toThrow(/Índice inválido/);
    await expect(saveAdjustmentRule(db, dirA, A, k, { index: "ipca", note: "x".repeat(201) })).rejects.toBeInstanceOf(Invalid);
    expect((await listContractAlerts(db, dirA, A, TODAY)).rules.get(k)).toMatchObject({ indexCode: "fixo", fixedBps: 450 });
  });

  it("ignorar neste ciclo some o alerta; no ciclo seguinte (outra data) ele volta sozinho", async () => {
    const r = await alerts();
    const ren = r.alerts.find((a) => a.kind === "renovacao_proxima")!; expect(ren).toMatchObject({ date: "2026-03-01", withAdjustment: true }); // reajuste e renovação no mesmo dia: um aviso só
    await snoozeAlert(db, gerA, A, { contractId: k, kind: ren.kind, dueDate: ren.date });
    const after = await alerts();
    expect(after.alerts.find((a) => a.kind === "renovacao_proxima")).toBeUndefined();
    expect(after.snoozed.find((a) => a.kind === "renovacao_proxima")).toMatchObject({ until: null });
    expect((await alerts("2026-03-10")).alerts.find((a) => a.kind === "renovacao_proxima")).toBeUndefined(); // "ignorar" não expira com o tempo dentro do ciclo
    // um ano depois o aviso do ciclo seguinte (data diferente) aparece de novo
    const next = await alerts("2027-02-20");
    expect(next.alerts.find((a) => a.kind === "renovacao_proxima")).toMatchObject({ date: "2027-03-01" });
  });

  it("adiar N dias: some até a data e volta depois; reativar traz de volta na hora", async () => {
    const adj = (await alerts()).alerts.find((a) => a.kind === "renovacao_proxima")!;
    await snoozeAlert(db, dirA, A, { contractId: k, kind: adj.kind, dueDate: adj.date, days: 5 }, TODAY);
    expect((await alerts()).alerts.some((a) => a.kind === "renovacao_proxima")).toBe(false);
    expect((await alerts(addDays(TODAY, 5))).alerts.some((a) => a.kind === "renovacao_proxima")).toBe(false); // ainda vale no último dia
    expect((await alerts(addDays(TODAY, 6))).alerts.some((a) => a.kind === "renovacao_proxima")).toBe(true);  // passou: volta
    const sn = (await alerts()).snoozed[0];
    await unsnoozeAlert(db, dirA, A, sn.snoozeId);
    expect((await alerts()).alerts.some((a) => a.kind === "renovacao_proxima")).toBe(true);
    await expect(unsnoozeAlert(db, dirA, A, sn.snoozeId)).rejects.toThrow(/não encontrado/);
  });

  it("validações, permissão, isolamento e auditoria do silêncio", async () => {
    const d = { contractId: k, kind: "reajuste_proximo", dueDate: "2026-03-01" };
    await expect(snoozeAlert(db, contA, A, d)).rejects.toBeInstanceOf(Forbidden);
    await expect(snoozeAlert(db, dirB, A, d)).rejects.toBeInstanceOf(Forbidden);
    await expect(snoozeAlert(db, dirB, B, d)).rejects.toThrow(/não encontrado/);
    await expect(snoozeAlert(db, dirA, A, { ...d, kind: "xyz" })).rejects.toThrow(/Tipo de alerta/);
    await expect(snoozeAlert(db, dirA, A, { ...d, dueDate: "2026-02-31" })).rejects.toThrow(/Data do alerta/);
    await expect(snoozeAlert(db, dirA, A, { ...d, days: 0 })).rejects.toThrow(/Adiar de 1 a 120/);
    await expect(snoozeAlert(db, dirA, A, { ...d, days: 121 })).rejects.toThrow(/Adiar de 1 a 120/);
    await expect(snoozeAlert(db, dirA, A, { ...d, contractId: "xyz" })).rejects.toThrow(/não encontrado/);
    await snoozeAlert(db, dirA, A, d); await snoozeAlert(db, dirA, A, { ...d, days: 10 }, TODAY); // repetir atualiza, não duplica
    const rows = await db.select().from(schema.contractAlertSnoozes);
    expect(rows).toHaveLength(1); expect(rows[0].until).toBe(addDays(TODAY, 10));
    expect((await db.select().from(schema.auditLog)).filter((a) => a.action === "contract.alert_snoozed")).toHaveLength(2);
    await expect(unsnoozeAlert(db, dirB, B, rows[0].id)).rejects.toThrow(/não encontrado/); // outra empresa não apaga
  });
});
