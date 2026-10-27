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
import { registerPayment, reversePayment } from "@/modules/receivables/service";
import { IssuanceTimeout, processIssuance, requestIssuance, saveIssuanceSettings } from "@/modules/issuance/service";
import { cancelBoleto } from "@/modules/issuance/cancel";
import { cancelRequestsForCharge, decideCancelRequest, pendingCancelRequests, requestBoletoCancel, withdrawCancelRequest } from "@/modules/issuance/cancel-request";
import { createMockProviders } from "@/modules/providers/mock";
import type { Providers } from "@/modules/providers/types";

const enabled = !!process.env.POSTGRES_USER;
const CNPJ1 = "11.222.333/0001-81", CNPJ2 = "12.ABC.345/01DE-35";
// competência 2026-09, vencimento 2026-10-14, emissão 2026-10-01. Régua: 10-01, 10-11, 10-14, 10-17, 10-21 (+ revisão 10-29).
const D = "2026-10-01";
const terms = (o: Record<string, unknown> = {}) => ({ description: "Monitoramento de redes", monthlyAmount: "2.500,00", startAt: "2026-01-01", endAt: "", dueDay: "14", invoiceJointRequired: false, issueDayOverride: "", ...o });

describe.skipIf(!enabled)("E30 pedido de cancelamento de boleto: gerente/assistente pedem, só a diretoria decide (DB de teste)", () => {
  let admin: ReturnType<typeof postgres>, conn: ReturnType<typeof postgres>, db: DB;
  let A: string, B: string, dirA: string, dirB: string, gerA: string, asstA: string, contA: string, techA: string, cli1: string, cli2: string;

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
    await db.execute(sql`truncate boleto_cancel_requests, boleto_cancellations, issuance_requests, issuance_settings, payments, messaging_settings, message_queue, message_template_versions, message_templates, charges, billing_batches, holidays, contract_versions, contracts, integration_conflicts, integration_sync_runs, integration_connections, rate_limits, customer_contacts, vendor_contacts, customers, vendors, audit_log, invitations, memberships, companies, users restart identity cascade`);
    const [a, b] = await db.insert(schema.companies).values([{ name: "Empresa A" }, { name: "Empresa B" }]).returning();
    A = a.id; B = b.id;
    const mk = async (e: string) => (await db.insert(schema.users).values({ email: e, name: e.split("@")[0], passwordHash: "x" }).returning())[0].id;
    dirA = await mk("dir-a@t.com"); dirB = await mk("dir-b@t.com"); gerA = await mk("ger@t.com"); asstA = await mk("asst@t.com"); contA = await mk("cont@t.com"); techA = await mk("tech@t.com");
    await db.insert(schema.memberships).values([
      { userId: dirA, companyId: A, role: "diretoria" }, { userId: dirB, companyId: B, role: "diretoria" }, { userId: gerA, companyId: A, role: "gerente" },
      { userId: asstA, companyId: A, role: "assistente" }, { userId: contA, companyId: A, role: "contabilidade" }, { userId: techA, companyId: A, role: "admin_tecnico" },
    ]);
    cli1 = (await createParty(db, dirA, A, { kind: "cliente", legalName: "Cliente Um", document: CNPJ1 })).id;
    cli2 = (await createParty(db, dirA, A, { kind: "cliente", legalName: "Cliente Dois", document: CNPJ2 })).id;
    const active = async (customer: string) => {
      const c = await createContract(db, asstA, A, customer, terms());
      await decideVersion(db, dirA, A, (await getContract(db, dirA, A, c.id))!.versions[0].id, "aprovar");
    };
    await active(cli1); await active(cli2);
    const { batchId } = await generateBatch(db, asstA, A, D);
    await approveBatch(db, dirA, A, batchId, (await getBatch(db, asstA, A, batchId))!.hash);
    await saveIssuanceSettings(db, dirA, A, { paused: false, dailyLimit: 20 });
  });

  const NOW = new Date(Date.now() + 5 * 60_000);
  const chargeOf = async (customer: string) => (await db.select().from(schema.charges).where(eq(schema.charges.customerId, customer)))[0];
  const issued = async (customer: string, p: Providers) => {
    const c = await chargeOf(customer);
    await requestIssuance(db, gerA, A, c.id, "boleto");
    await processIssuance(db, gerA, A, NOW, p);
    return c.id;
  };
  const req = (u: string, chargeId: string, reason = "valor errado na cobrança") => requestBoletoCancel(db, u, A, { chargeId, reason });

  it("gerente e assistente pedem; contabilidade, admin técnico e outra empresa não; validações", async () => {
    const p = createMockProviders();
    const c = await chargeOf(cli1);
    await expect(req(gerA, c.id)).rejects.toThrow(/não tem boleto emitido/);
    await issued(cli1, p);
    for (const u of [contA, techA]) await expect(req(u, c.id)).rejects.toBeInstanceOf(Forbidden);
    await expect(requestBoletoCancel(db, dirB, A, { chargeId: c.id, reason: "motivo ok" })).rejects.toBeInstanceOf(Forbidden);
    await expect(req(gerA, c.id, "ab")).rejects.toThrow(/3 a 200/);
    await expect(req(gerA, "xyz")).rejects.toThrow(/não encontrada/);
    const id = await req(asstA, c.id, "  valor   errado\nna cobrança ");
    const [r] = await db.select().from(schema.boletoCancelRequests);
    expect(r).toMatchObject({ id, companyId: A, chargeId: c.id, reason: "valor errado na cobrança", status: "pendente", requestedBy: asstA, decidedAt: null });
    await expect(req(gerA, c.id)).rejects.toThrow(/Já existe um pedido/); // um por cobrança
    const aud = (await db.select().from(schema.auditLog).where(sql`action like 'boleto.cancel_request%'`));
    expect(aud).toHaveLength(1); expect(JSON.stringify(aud[0].detail)).not.toContain("valor errado"); // auditoria só com ids
  });

  it("com pagamento registrado não pede", async () => {
    const p = createMockProviders(); const id = await issued(cli1, p);
    await registerPayment(db, asstA, A, id, { amount: "100,00", paidAt: "2026-10-15", method: "pix" }, "2026-10-20");
    await expect(req(gerA, id)).rejects.toThrow(/pagamento registrado/);
  });

  it("aprovar: só a diretoria; cancela o boleto de verdade, liga o pedido ao cancelamento e não decide duas vezes", async () => {
    const p = createMockProviders(); const id = await issued(cli1, p);
    const rid = await req(gerA, id);
    for (const u of [gerA, asstA, contA, techA]) await expect(decideCancelRequest(db, u, A, rid, "aprovar", "", p)).rejects.toBeInstanceOf(Forbidden);
    await expect(decideCancelRequest(db, dirB, A, rid, "aprovar", "", p)).rejects.toBeInstanceOf(Forbidden);
    const out = await decideCancelRequest(db, dirA, A, rid, "aprovar", "", p);
    expect(out).toMatchObject({ status: "aprovado", result: "cancelado" });
    const [r] = await db.select().from(schema.boletoCancelRequests);
    expect(r).toMatchObject({ status: "aprovado", decidedBy: dirA }); expect(r.cancellationId).toBeTruthy();
    const [c] = await db.select().from(schema.boletoCancellations);
    expect(c).toMatchObject({ id: r.cancellationId, status: "cancelado", requestedBy: dirA, chargeId: id }); expect(c.reason).toMatch(/^Pedido aprovado: valor errado/);
    await expect(decideCancelRequest(db, dirA, A, rid, "aprovar", "", p)).rejects.toThrow(/já foi decidido/);
    await expect(decideCancelRequest(db, dirA, A, rid, "recusar", "tarde demais", p)).rejects.toThrow(/já foi decidido/);
    const list = await cancelRequestsForCharge(db, gerA, A, id);
    expect(list[0]).toMatchObject({ status: "aprovado", requestedByName: "ger", decidedByName: "dir-a" });
    expect((await db.select().from(schema.auditLog)).map((a) => a.action)).toEqual(expect.arrayContaining(["boleto.cancel_request_created", "boleto.cancel_request_approved", "boleto.cancelled"]));
  });

  it("recusar: exige motivo, não toca no boleto e permite novo pedido", async () => {
    const p = createMockProviders(); const id = await issued(cli1, p);
    const rid = await req(gerA, id);
    await expect(decideCancelRequest(db, dirA, A, rid, "recusar", "ab", p)).rejects.toThrow(/3 a 200/);
    expect(await decideCancelRequest(db, dirA, A, rid, "recusar", "o cliente ainda quer este boleto", p)).toEqual({ status: "recusado" });
    expect(await db.select().from(schema.boletoCancellations)).toHaveLength(0);
    const [ir] = await db.select().from(schema.issuanceRequests).where(eq(schema.issuanceRequests.chargeId, id));
    expect(ir.status).toBe("emitido");
    const list = await cancelRequestsForCharge(db, asstA, A, id);
    expect(list[0]).toMatchObject({ status: "recusado", decisionNote: "o cliente ainda quer este boleto" });
    await expect(req(gerA, id, "novo pedido, agora com o documento")).resolves.toBeTruthy();
  });

  it("retirar: só quem pediu e só enquanto pendente", async () => {
    const p = createMockProviders(); const id = await issued(cli1, p);
    const rid = await req(gerA, id);
    await expect(withdrawCancelRequest(db, asstA, A, rid)).rejects.toBeInstanceOf(Forbidden);
    await expect(withdrawCancelRequest(db, contA, A, rid)).rejects.toBeInstanceOf(Forbidden);
    await withdrawCancelRequest(db, gerA, A, rid);
    expect((await db.select().from(schema.boletoCancelRequests))[0].status).toBe("retirado");
    await expect(withdrawCancelRequest(db, gerA, A, rid)).rejects.toThrow(/já foi decidido/);
    await expect(decideCancelRequest(db, dirA, A, rid, "aprovar", "", p)).rejects.toThrow(/já foi decidido/);
  });

  it("pagamento chegou entre o pedido e a aprovação: a aprovação falha e o pedido volta para a fila", async () => {
    const p = createMockProviders(); const id = await issued(cli1, p);
    const rid = await req(gerA, id);
    await registerPayment(db, asstA, A, id, { amount: "100,00", paidAt: "2026-10-15", method: "pix" }, "2026-10-20");
    await expect(decideCancelRequest(db, dirA, A, rid, "aprovar", "", p)).rejects.toThrow(/pagamento registrado/);
    const [r] = await db.select().from(schema.boletoCancelRequests);
    expect(r).toMatchObject({ status: "pendente", decidedBy: null, decidedAt: null, cancellationId: null });
    expect(await db.select().from(schema.boletoCancellations)).toHaveLength(0);
  });

  it("duas aprovações simultâneas: um único cancelamento", async () => {
    const p = createMockProviders(); const id = await issued(cli1, p);
    const rid = await req(gerA, id);
    const res = await Promise.allSettled([decideCancelRequest(db, dirA, A, rid, "aprovar", "", p), decideCancelRequest(db, dirA, A, rid, "aprovar", "", p)]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.select().from(schema.boletoCancellations)).toHaveLength(1);
  });

  it("processo caiu depois de reservar: passados 10 min a diretoria conclui; antes disso não", async () => {
    const p = createMockProviders(); const id = await issued(cli1, p);
    const rid = await req(gerA, id);
    const t0 = new Date();
    await db.update(schema.boletoCancelRequests).set({ status: "aprovado", decidedBy: dirA, decidedAt: t0 }).where(eq(schema.boletoCancelRequests.id, rid)); // simula a queda
    await expect(decideCancelRequest(db, dirA, A, rid, "aprovar", "", p, new Date(t0.getTime() + 5 * 60_000))).rejects.toThrow(/já foi decidido/);
    expect((await cancelRequestsForCharge(db, dirA, A, id))[0].stuck).toBe(false);
    await db.update(schema.boletoCancelRequests).set({ decidedAt: new Date(t0.getTime() - 11 * 60_000) }).where(eq(schema.boletoCancelRequests.id, rid));
    expect((await cancelRequestsForCharge(db, dirA, A, id))[0].stuck).toBe(true);
    await expect(decideCancelRequest(db, dirA, A, rid, "recusar", "tarde demais", p)).rejects.toThrow(/já foi decidido/); // preso só se conclui, não se recusa
    await expect(decideCancelRequest(db, dirA, A, rid, "aprovar", "", p)).resolves.toMatchObject({ status: "aprovado", result: "cancelado" });
    const [r] = await db.select().from(schema.boletoCancelRequests);
    expect(r.cancellationId).toBeTruthy(); expect((await cancelRequestsForCharge(db, dirA, A, id))[0].stuck).toBe(false);
  });

  it("diretoria cancelou direto com pedido pendente: o pedido não fica preso, pode ser recusado", async () => {
    const p = createMockProviders(); const id = await issued(cli1, p);
    const rid = await req(gerA, id);
    await cancelBoleto(db, dirA, A, { chargeId: id, reason: "cancelado direto pela diretoria", confirm: true }, p);
    await expect(decideCancelRequest(db, dirA, A, rid, "aprovar", "", p)).rejects.toThrow(/não tem boleto emitido/);
    expect((await db.select().from(schema.boletoCancelRequests))[0].status).toBe("pendente"); // voltou à fila, nada duplicado
    expect(await decideCancelRequest(db, dirA, A, rid, "recusar", "já cancelado direto", p)).toEqual({ status: "recusado" });
    expect(await pendingCancelRequests(db, dirA, A)).toEqual([]);
    expect(await db.select().from(schema.boletoCancellations)).toHaveLength(1);
  });

  it("fila da diretoria: só quem pode cancelar enxerga; isolamento entre empresas", async () => {
    const p = createMockProviders(); const id = await issued(cli1, p); await issued(cli2, p);
    await req(gerA, id, "primeiro pedido");
    await expect(pendingCancelRequests(db, gerA, A)).rejects.toBeInstanceOf(Forbidden);
    const q = await pendingCancelRequests(db, dirA, A);
    expect(q).toHaveLength(1); expect(q[0]).toMatchObject({ chargeId: id, requester: "ger", customer: expect.any(String), amount: "2500.00" });
    await expect(pendingCancelRequests(db, dirB, A)).rejects.toBeInstanceOf(Forbidden);
    expect(await pendingCancelRequests(db, dirB, B)).toEqual([]);
    expect(await cancelRequestsForCharge(db, gerA, A, "xyz")).toEqual([]);
    void Invalid;
  });
});
