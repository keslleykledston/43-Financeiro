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
import { approveBatch, generateBatch, getBatch, reopenBatch } from "@/modules/billing/batches";
import { addAdjustment, listCompetence, removeAdjustment } from "@/modules/billing/adjustments";

const enabled = !!process.env.POSTGRES_USER;
const CNPJ1 = "11.222.333/0001-81", CNPJ2 = "12.ABC.345/01DE-35";
const D = "2026-10-01"; // competência 2026-09, vencimento 14/10, emissão 01/10
const COMP = "2026-09";
const terms = (o: Record<string, unknown> = {}) => ({ description: "Plano call center", monthlyAmount: "2.500,00", startAt: "2026-01-01", endAt: "", dueDay: "14", invoiceJointRequired: false, issueDayOverride: "", ...o });

describe.skipIf(!enabled)("E05c ajustes da competência (excedente/acréscimo/desconto) no valor da cobrança (DB de teste)", () => {
  let admin: ReturnType<typeof postgres>, conn: ReturnType<typeof postgres>, db: DB;
  let A: string, B: string, dirA: string, dirB: string, gerA: string, asstA: string, contA: string, techA: string, cli1: string, cli2: string, k1: string, k2: string;

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
    await db.execute(sql`truncate charge_adjustments, charges, billing_batches, holidays, contract_versions, contracts, integration_conflicts, integration_sync_runs, integration_connections, rate_limits, customer_contacts, vendor_contacts, customers, vendors, audit_log, invitations, memberships, companies, users restart identity cascade`);
    const [a, b] = await db.insert(schema.companies).values([{ name: "Empresa A" }, { name: "Empresa B" }]).returning();
    A = a.id; B = b.id;
    const mk = async (e: string) => (await db.insert(schema.users).values({ email: e, name: e, passwordHash: "x" }).returning())[0].id;
    dirA = await mk("dir-a@t.com"); dirB = await mk("dir-b@t.com"); gerA = await mk("ger@t.com"); asstA = await mk("asst@t.com"); contA = await mk("cont@t.com"); techA = await mk("tech@t.com");
    await db.insert(schema.memberships).values([
      { userId: dirA, companyId: A, role: "diretoria" }, { userId: dirB, companyId: B, role: "diretoria" }, { userId: gerA, companyId: A, role: "gerente" },
      { userId: asstA, companyId: A, role: "assistente" }, { userId: contA, companyId: A, role: "contabilidade" }, { userId: techA, companyId: A, role: "admin_tecnico" },
    ]);
    cli1 = (await createParty(db, dirA, A, { kind: "cliente", legalName: "Cliente Um", document: CNPJ1 })).id;
    cli2 = (await createParty(db, dirA, A, { kind: "cliente", legalName: "Cliente Dois", document: CNPJ2 })).id;
    const mkc = async (customer: string, t = terms()) => { const c = await createContract(db, asstA, A, customer, t); await decideVersion(db, dirA, A, (await getContract(db, dirA, A, c.id))!.versions[0].id, "aprovar"); return c.id; };
    k1 = await mkc(cli1); k2 = await mkc(cli2, terms({ monthlyAmount: "1.000,00" }));
  });

  const adj = (o: Record<string, unknown> = {}, by = asstA) => addAdjustment(db, by, A, { contractId: k1, competence: COMP, kind: "excedente", description: "Excedente de minutos", amount: "412,64", ...o } as never);
  const chargeOf = async (contract: string) => (await db.select().from(schema.charges).where(eq(schema.charges.contractId, contract)))[0];
  const n = async (q: string) => Number((await db.execute(sql.raw(`select count(*)::int n from ${q}`)))[0].n);

  it("lançar excedente: permissão, validação, só contrato faturável na competência", async () => {
    await expect(adj({}, contA)).rejects.toThrow(Forbidden);
    await expect(adj({}, techA)).rejects.toThrow(Forbidden);
    await expect(adj({ kind: "multa" })).rejects.toThrow(/Tipo de ajuste/);
    await expect(adj({ description: "x" })).rejects.toThrow(/Descreva/);
    await expect(adj({ amount: "0" })).rejects.toThrow(/valor válido/);
    await expect(adj({ amount: "abc" })).rejects.toThrow(/valor válido/);
    await expect(adj({ competence: "2026-13" })).rejects.toThrow(/Competência inválida/);
    await expect(adj({ contractId: "x" })).rejects.toThrow(/Contrato não encontrado/);
    expect(await adj()).toMatch(/^[0-9a-f-]{36}$/); // contrato válido na competência: aceito
  });

  it("composição do valor: base + excedente + acréscimo − desconto; a prévia mostra e o banco confere", async () => {
    await adj({ amount: "412,64" });
    await adj({ kind: "acrescimo", description: "Instalação extra", amount: "100,00" });
    await adj({ kind: "desconto", description: "Abatimento negociado", amount: "50,00" });
    const comp = await listCompetence(db, contA, A, COMP);
    const row = comp.find((r) => r.contractId === k1)!;
    expect(row).toMatchObject({ baseCents: 250000, adjustmentCents: 41264 + 10000 - 5000, totalCents: 250000 + 46264, locked: false });
    expect(row.adjustments.map((a) => a.kind)).toEqual(["excedente", "acrescimo", "desconto"]);
    expect(comp.find((r) => r.contractId === k2)).toMatchObject({ baseCents: 100000, adjustmentCents: 0 });
    const { batchId } = await generateBatch(db, asstA, A, D);
    const c = await chargeOf(k1);
    expect(c).toMatchObject({ amount: "2962.64", baseAmount: "2500.00", adjustmentAmount: "462.64" });
    const g = (await getBatch(db, asstA, A, batchId))!;
    expect(g.totalCents).toBe(296264 + 100000);
    const ch = g.charges.find((x) => x.contractId === k1)!;
    expect(ch).toMatchObject({ baseCents: 250000, adjustmentCents: 46264 });
    expect(ch.adjustments.map((a) => [a.kind, a.amountCents])).toEqual([["excedente", 41264], ["acrescimo", 10000], ["desconto", 5000]]);
    // o banco garante base + ajuste = valor
    await expect(db.execute(sql`update charges set amount = 1 where id = ${c.id}`)).rejects.toThrow();
  });

  it("ajuste depois da prévia deixa o lote DESATUALIZADO (não dá para aprovar sem atualizar); atualizar aplica; hash muda", async () => {
    const { batchId } = await generateBatch(db, asstA, A, D);
    const h0 = (await getBatch(db, asstA, A, batchId))!.hash;
    await adj();
    const g = (await getBatch(db, asstA, A, batchId))!;
    expect(g.stale).toMatchObject({ changed: 1, any: true });
    await expect(approveBatch(db, dirA, A, batchId, g.hash)).rejects.toThrow(/contratos mudaram/);
    expect(await generateBatch(db, asstA, A, D)).toMatchObject({ updated: 1 });
    const g2 = (await getBatch(db, asstA, A, batchId))!;
    expect(g2.stale.any).toBe(false); expect(g2.hash).not.toBe(h0);
    expect(g2.charges.find((x) => x.contractId === k1)!.amountCents).toBe(291264);
    // trocar por outro ajuste de mesmo total ainda é detectado como mudança (composição faz parte da assinatura)
    const id = (await listCompetence(db, contA, A, COMP)).find((r) => r.contractId === k1)!.adjustments[0].id;
    await removeAdjustment(db, asstA, A, id); await adj({ kind: "acrescimo", description: "Outro motivo", amount: "412,64" });
    expect((await getBatch(db, asstA, A, batchId))!.stale.any).toBe(false); // mesmo total e mesmo líquido: nada mudou para cobrar
  });

  it("aprovado trava: não adiciona, não remove, nem por SQL; reabrir libera; valor final nunca zera", async () => {
    await adj({ amount: "100,00" });
    const { batchId } = await generateBatch(db, asstA, A, D);
    await approveBatch(db, dirA, A, batchId, (await getBatch(db, asstA, A, batchId))!.hash);
    expect((await listCompetence(db, contA, A, COMP)).find((r) => r.contractId === k1)).toMatchObject({ locked: true, chargeStatus: "aprovada" });
    await expect(adj()).rejects.toThrow(/já está em lote aprovado/);
    const aid = (await db.select().from(schema.chargeAdjustments))[0].id;
    await expect(removeAdjustment(db, asstA, A, aid)).rejects.toThrow(/já está em lote aprovado/);
    await expect(db.execute(sql`delete from charge_adjustments`)).rejects.toThrow(); // trigger
    await expect(db.insert(schema.chargeAdjustments).values({ companyId: A, contractId: k1, competenceMonth: "2026-09-01", kind: "excedente", description: "por fora", amount: "1.00", createdBy: asstA })).rejects.toThrow();
    await expect(db.execute(sql`update charge_adjustments set amount = 1`)).rejects.toThrow();
    expect((await chargeOf(k1)).amount).toBe("2600.00");
    await reopenBatch(db, gerA, A, batchId, "valor do excedente veio errado");
    await removeAdjustment(db, asstA, A, aid);
    await expect(adj({ kind: "desconto", description: "desconto total", amount: "2.500,00" })).rejects.toThrow(/maior que zero/); // zeraria a cobrança
    await adj({ kind: "desconto", description: "desconto parcial", amount: "2.499,99" });
    expect((await listCompetence(db, contA, A, COMP)).find((r) => r.contractId === k1)!.totalCents).toBe(1);
  });

  it("limite por contrato/competência e fora do período do contrato", async () => {
    for (let i = 0; i < 10; i++) await adj({ description: `Excedente ${i}`, amount: "1,00" });
    await expect(adj({ description: "11º" })).rejects.toThrow(/No máximo 10/);
    await expect(db.insert(schema.chargeAdjustments).values({ companyId: A, contractId: k1, competenceMonth: "2026-09-01", kind: "excedente", description: "por fora", amount: "1.00", createdBy: asstA })).rejects.toThrow(); // trigger também limita
    await expect(addAdjustment(db, asstA, A, { contractId: k1, competence: "2025-06", kind: "excedente", description: "antes da vigência", amount: "1,00" })).rejects.toThrow(/não é faturável/);
  });

  it("isolamento e auditoria sem descrição, nomes ou valores", async () => {
    await expect(addAdjustment(db, dirB, B, { contractId: k1, competence: COMP, kind: "excedente", description: "de outra empresa", amount: "1,00" })).rejects.toThrow(/Contrato não encontrado/);
    expect(await listCompetence(db, dirB, B, COMP)).toEqual([]);
    const id = await adj({ description: "SEGREDO do cliente", amount: "412,64" });
    await removeAdjustment(db, asstA, A, id);
    await expect(removeAdjustment(db, dirB, B, id)).rejects.toThrow(/não encontrado/);
    const logs = await db.select().from(schema.auditLog).where(sql`${schema.auditLog.action} like 'billing.adjustment.%'`);
    expect(logs.map((l) => l.action)).toEqual(["billing.adjustment.added", "billing.adjustment.removed"]);
    const txt = JSON.stringify(logs.map((l) => l.detail));
    for (const bad of ["SEGREDO", "412", "Cliente Um", "Excedente de minutos"]) expect(txt).not.toContain(bad);
    expect(await n("charge_adjustments")).toBe(0);
  });

  it("aprovação × ajuste simultâneo: o ajuste espera a aprovação e depois é recusado (nunca fica ajuste sem cobrança correspondente)", async () => {
    const { batchId } = await generateBatch(db, asstA, A, D);
    let release!: () => void; const hold = new Promise<void>((r) => { release = r; });
    let locked!: () => void; const ready = new Promise<void>((r) => { locked = r; });
    // "aprovação" em curso: tem o lock de empresa dos lotes e ainda não confirmou
    const approving = conn.begin(async (q) => {
      await q`select pg_advisory_xact_lock(hashtext(${"billing-batch:" + A}))`;
      await q`update billing_batches set status = 'aprovado', approved_by = ${dirA}, approved_at = now() where id = ${batchId}`;
      await q`update charges set status = 'aprovada' where batch_id = ${batchId}`;
      locked(); await hold;
    });
    await ready;
    const late = adj({ amount: "50,00" });
    await new Promise((r) => setTimeout(r, 300));
    release(); await approving;
    await expect(late).rejects.toThrow(/já está em lote aprovado/);
    expect(await n("charge_adjustments")).toBe(0);
  });
});
