import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { eq, sql } from "drizzle-orm";
import { databaseUrl } from "@/lib/db/url";
import * as schema from "@/lib/db/schema";
import type { DB } from "@/lib/db";
import { Forbidden } from "@/modules/identity/service";
import { createParty } from "@/modules/crm/service";
import { createContract, decideVersion, getContract } from "@/modules/contracts/service";
import { approveBatch, generateBatch, getBatch, reopenBatch } from "@/modules/billing/batches";
import { registerPayment, reversePayment } from "@/modules/receivables/service";
import { IssuanceTimeout, processIssuance, requestIssuance, saveIssuanceSettings } from "@/modules/issuance/service";
import { boletoPanel, cancelBoleto, recheckCancellation } from "@/modules/issuance/cancel";
import { createMockProviders } from "@/modules/providers/mock";
import type { Providers } from "@/modules/providers/types";

const enabled = !!process.env.POSTGRES_USER;
const CNPJ1 = "11.222.333/0001-81", CNPJ2 = "12.ABC.345/01DE-35";
// competência 2026-09, vencimento 2026-10-14, emissão 2026-10-01. Régua: 10-01, 10-11, 10-14, 10-17, 10-21 (+ revisão 10-29).
const D = "2026-10-01";
const terms = (o: Record<string, unknown> = {}) => ({ description: "Monitoramento de redes", monthlyAmount: "2.500,00", startAt: "2026-01-01", endAt: "", dueDay: "14", invoiceJointRequired: false, issueDayOverride: "", ...o });

describe.skipIf(!enabled)("E20 cancelar boleto (simulado): só diretoria, tudo registrado, reconsulta, imutável (DB de teste)", () => {
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
    await db.execute(sql`truncate boleto_cancellations, issuance_requests, issuance_settings, payments, messaging_settings, message_queue, message_template_versions, message_templates, charges, billing_batches, holidays, contract_versions, contracts, integration_conflicts, integration_sync_runs, integration_connections, rate_limits, customer_contacts, vendor_contacts, customers, vendors, audit_log, invitations, memberships, companies, users restart identity cascade`);
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
    const id = await requestIssuance(db, gerA, A, c.id, "boleto");
    await processIssuance(db, gerA, A, NOW, p);
    return { chargeId: c.id, requestId: id };
  };
  /** provedor simulado com a chamada de cancelamento controlada pelo teste */
  const prov = (cancel?: (ref: string, n: number) => Promise<void>) => {
    const base = createMockProviders(); const calls = { cancel: 0, status: 0 };
    const p: Providers = { ...base, boleto: { ...base.boleto,
      cancel: async (r) => { calls.cancel++; if (cancel) await cancel(r, calls.cancel); await base.boleto.cancel(r); },
      status: async (r) => { calls.status++; return base.boleto.status(r); } } };
    return { p, calls, base };
  };
  const ok = (chargeId: string, o: { reason?: string; confirm?: boolean } = {}) => ({ chargeId, reason: "valor errado na cobrança", confirm: true, ...o });
  const rows = () => db.select().from(schema.boletoCancellations);
  const why = async (q: ReturnType<typeof sql>) => { try { await db.execute(q); return ""; } catch (e) { return (e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message; } };

  it("só a diretoria da própria empresa cancela; quem pode ler o painel vê o histórico", async () => {
    const { p } = prov(); const { chargeId } = await issued(cli1, p);
    for (const u of [gerA, asstA, contA, techA]) await expect(cancelBoleto(db, u, A, ok(chargeId), p)).rejects.toBeInstanceOf(Forbidden);
    await expect(cancelBoleto(db, dirB, A, ok(chargeId), p)).rejects.toBeInstanceOf(Forbidden);
    await expect(recheckCancellation(db, gerA, A, "00000000-0000-0000-0000-000000000000", p)).rejects.toBeInstanceOf(Forbidden);
    await expect(boletoPanel(db, techA, A, chargeId)).rejects.toBeInstanceOf(Forbidden);
    expect(await rows()).toHaveLength(0);
  });

  it("validações: motivo, confirmação, boleto emitido, sem pagamento, id", async () => {
    const { p, calls } = prov();
    const c = await chargeOf(cli1);
    await expect(cancelBoleto(db, dirA, A, ok(c.id), p)).rejects.toThrow(/não tem boleto emitido/);              // nada solicitado
    await requestIssuance(db, gerA, A, c.id, "boleto");
    await expect(cancelBoleto(db, dirA, A, ok(c.id), p)).rejects.toThrow(/não tem boleto emitido/);              // solicitado mas não emitido
    await processIssuance(db, gerA, A, NOW, p);
    await expect(cancelBoleto(db, dirA, A, ok(c.id, { reason: "ab" }), p)).rejects.toThrow(/motivo/);
    await expect(cancelBoleto(db, dirA, A, ok(c.id, { reason: "x".repeat(201) }), p)).rejects.toThrow(/motivo/);
    await expect(cancelBoleto(db, dirA, A, ok(c.id, { confirm: false }), p)).rejects.toThrow(/Confirme/);
    await expect(cancelBoleto(db, dirA, A, { chargeId: "xyz", reason: "motivo ok", confirm: true }, p)).rejects.toThrow(/não encontrada/);
    const pay = await registerPayment(db, asstA, A, c.id, { amount: "100,00", paidAt: "2026-10-15", method: "pix" }, "2026-10-20");
    await expect(cancelBoleto(db, dirA, A, ok(c.id), p)).rejects.toThrow(/pagamento registrado/);
    await reversePayment(db, gerA, A, pay.paymentId, "lançado no cliente errado");
    expect(calls.cancel).toBe(0);                                                                                   // nenhuma validação chegou ao provedor
    await expect(cancelBoleto(db, dirA, A, ok(c.id), p)).resolves.toMatchObject({ status: "cancelado" });        // sem pagamento ativo: pode
  });

  it("fluxo feliz: registro completo, solicitação encerrada, auditoria sem o motivo, e nova emissão com chave nova", async () => {
    const { p, base } = prov(); const { chargeId, requestId } = await issued(cli1, p);
    const oldRef = (await db.select().from(schema.issuanceRequests).where(eq(schema.issuanceRequests.id, requestId)))[0].externalRef!;
    const r = await cancelBoleto(db, dirA, A, ok(chargeId, { reason: "  valor   errado\nna cobrança " }), p);
    expect(r.status).toBe("cancelado");
    const [c] = await rows();
    expect(c).toMatchObject({ companyId: A, chargeId, requestId, externalRef: oldRef, mode: "simulado", reason: "valor errado na cobrança", status: "cancelado", attempts: 1, requestedBy: dirA, lastError: null });
    expect(c.resolvedAt).toBeInstanceOf(Date);
    expect(await base.boleto.status(oldRef)).toBe("cancelado");
    const [req] = await db.select().from(schema.issuanceRequests).where(eq(schema.issuanceRequests.id, requestId));
    expect(req).toMatchObject({ status: "cancelado", externalStatus: "cancelado" });
    const audits = await db.select().from(schema.auditLog).where(sql`action like 'boleto.%'`);
    expect(audits.map((a) => a.action).sort()).toEqual(["boleto.cancel_requested", "boleto.cancelled"]);
    expect(audits.every((a) => a.actorId === dirA)).toBe(true);
    expect(JSON.stringify(audits.map((a) => a.detail))).not.toMatch(/valor errado|Cliente/);
    await expect(cancelBoleto(db, dirA, A, ok(chargeId), p)).rejects.toThrow(/não tem boleto emitido/);            // não cancela duas vezes
    // nova emissão: chave de idempotência nova → o provedor emite OUTRO boleto
    const again = await requestIssuance(db, gerA, A, chargeId, "boleto");
    const [nreq] = await db.select().from(schema.issuanceRequests).where(eq(schema.issuanceRequests.id, again));
    expect(nreq.idempotencyKey).toBe(`boleto:${chargeId}:g1`);
    await processIssuance(db, gerA, A, NOW, p);
    const [done] = await db.select().from(schema.issuanceRequests).where(eq(schema.issuanceRequests.id, again));
    expect(done.status).toBe("emitido"); expect(done.externalRef).not.toBe(oldRef);
    const panel = await boletoPanel(db, contA, A, chargeId);
    expect(panel.request).toMatchObject({ id: again, status: "emitido" });
    expect(panel.history).toHaveLength(1); expect(panel.history[0]).toMatchObject({ by: "dir-a", status: "cancelado", reason: "valor errado na cobrança" });
  });

  it("provedor diz que o boleto já foi pago: não cancela, registra a falha e marca o pagamento no provedor", async () => {
    const { p } = prov(async () => { throw new Error("boleto_pago"); }); const { chargeId, requestId } = await issued(cli1, p);
    await expect(cancelBoleto(db, dirA, A, ok(chargeId), p)).resolves.toMatchObject({ status: "falhou" });
    const [c] = await rows();
    expect(c).toMatchObject({ status: "falhou", lastError: "boleto_pago" }); expect(c.resolvedAt).not.toBeNull();
    const [req] = await db.select().from(schema.issuanceRequests).where(eq(schema.issuanceRequests.id, requestId));
    expect(req).toMatchObject({ status: "emitido", externalStatus: "pago" });
    expect((await db.select().from(schema.auditLog).where(sql`action = 'boleto.cancel_failed'`))).toHaveLength(1);
  });

  it("sem resposta (timeout): fica 'desconhecido'; reconsulta resolve sem pedir duas vezes; resposta perdida após cancelar", async () => {
    // (a) o pedido nem chegou: a reconsulta vê o boleto emitido e pede de novo
    const a = prov(async (_r, n) => { if (n === 1) throw new IssuanceTimeout(); });
    const { chargeId } = await issued(cli1, a.p);
    expect(await cancelBoleto(db, dirA, A, ok(chargeId), a.p)).toMatchObject({ status: "desconhecido" });
    let [c] = await rows();
    expect(c).toMatchObject({ status: "desconhecido", lastError: "timeout", attempts: 1, resolvedAt: null });
    await expect(cancelBoleto(db, dirA, A, ok(chargeId), a.p)).rejects.toThrow(/andamento ou concluído/);          // não abre outro enquanto este não for decidido
    await expect(recheckCancellation(db, gerA, A, c.id, a.p)).rejects.toBeInstanceOf(Forbidden);
    expect(await recheckCancellation(db, dirA, A, c.id, a.p)).toMatchObject({ status: "cancelado" });
    [c] = await rows();
    expect(c).toMatchObject({ status: "cancelado", attempts: 2 });
    await expect(recheckCancellation(db, dirA, A, c.id, a.p)).rejects.toThrow(/já foi decidido/);

    // (b) o provedor cancelou mas a resposta se perdeu: a reconsulta enxerga 'cancelado' e NÃO pede de novo
    await db.execute(sql`truncate boleto_cancellations, issuance_requests, audit_log`);
    const b = prov(async () => { throw new IssuanceTimeout(); });
    const i2 = await issued(cli2, b.p);
    await b.base.boleto.cancel((await db.select().from(schema.issuanceRequests).where(eq(schema.issuanceRequests.id, i2.requestId)))[0].externalRef!);   // cancelou "por fora"
    b.calls.cancel = 0;
    expect(await cancelBoleto(db, dirA, A, ok(i2.chargeId), b.p)).toMatchObject({ status: "desconhecido" });
    const [c2] = await rows();
    expect(await recheckCancellation(db, dirA, A, c2.id, b.p)).toMatchObject({ status: "cancelado" });
    expect(b.calls.cancel).toBe(1);                                                                                // só a tentativa original
  });

  it("tentativas esgotadas viram 'falhou'; preso em 'enviando' só é retomado depois de 10 minutos", async () => {
    const { p } = prov(async () => { throw new IssuanceTimeout(); }); const { chargeId } = await issued(cli1, p);
    await cancelBoleto(db, dirA, A, ok(chargeId), p);
    const [c] = await rows();
    for (let i = 0; i < 3; i++) await recheckCancellation(db, dirA, A, c.id, p);                                    // tentativas 2, 3, 4
    expect((await rows())[0]).toMatchObject({ status: "desconhecido", attempts: 4 });
    await recheckCancellation(db, dirA, A, c.id, p);                                                                // tentativa 5 = limite
    expect((await rows())[0]).toMatchObject({ status: "falhou", lastError: "tentativas_esgotadas", attempts: 5 });

    await db.execute(sql`truncate boleto_cancellations`);
    await db.execute(sql`insert into boleto_cancellations (company_id, charge_id, request_id, external_ref, reason, requested_by, status) select company_id, charge_id, id, external_ref, 'preso no meio', ${dirA}, 'enviando' from issuance_requests limit 1`);
    const [s] = await rows();
    await expect(recheckCancellation(db, dirA, A, s.id, p)).rejects.toThrow(/ainda está em andamento/);
    await db.execute(sql`update boleto_cancellations set updated_at = now() - interval '11 minutes'`);
    const ok2 = prov(); // este provedor cancela normalmente
    const base = ok2.base;
    expect(await recheckCancellation(db, dirA, A, s.id, { ...ok2.p, boleto: { ...ok2.p.boleto, status: async () => "emitido", cancel: async () => { await base.boleto.cancel((await db.select().from(schema.issuanceRequests))[0].externalRef!).catch(() => undefined); } } }, new Date())).toMatchObject({ status: "cancelado" });
  });

  it("pagamento e cancelamento não se cruzam: baixa durante o cancelamento é recusada; baixa antes impede o cancelamento", async () => {
    // (a) a chamada ao provedor está em andamento (sem resposta): a baixa espera
    const { p } = prov(async () => { throw new IssuanceTimeout(); }); const { chargeId } = await issued(cli1, p);
    await cancelBoleto(db, dirA, A, ok(chargeId), p);
    await expect(registerPayment(db, asstA, A, chargeId, { amount: "100,00", paidAt: "2026-10-15", method: "pix" }, "2026-10-20")).rejects.toThrow(/cancelamento de boleto em andamento/);
    // (b) durante a chamada ao provedor, outra sessão tenta registrar a baixa: bloqueada pelo registro "enviando"
    await db.execute(sql`truncate boleto_cancellations, issuance_requests, audit_log`);
    const gate: { release?: () => void } = {};
    const slow = prov(async () => { await new Promise<void>((res) => { gate.release = res; }); });
    const i2 = await issued(cli2, slow.p);
    const running = cancelBoleto(db, dirA, A, ok(i2.chargeId), slow.p);
    while (!gate.release) await new Promise((r) => setTimeout(r, 20));                                              // o provedor está "pensando"
    await expect(registerPayment(db, asstA, A, i2.chargeId, { amount: "100,00", paidAt: "2026-10-15", method: "pix" }, "2026-10-20")).rejects.toThrow(/cancelamento de boleto em andamento/);
    gate.release(); await running;
    expect((await rows())[0]).toMatchObject({ status: "cancelado" });
    expect(await db.select().from(schema.payments)).toHaveLength(0);                                                // nenhum pagamento escapou
  });

  it("reconsulta concorrente: só vale o resultado da tentativa mais recente; boleto pago no provedor para a régua", async () => {
    const gate: { release?: () => void } = {};
    const first = prov(async (_r, n) => { if (n === 1) await new Promise<void>((res) => { gate.release = res; }); });
    const { chargeId } = await issued(cli1, first.p);
    const orig = cancelBoleto(db, dirA, A, ok(chargeId), first.p);                                                  // tentativa 1 fica pendurada no provedor
    while (!gate.release) await new Promise((r) => setTimeout(r, 20));
    const [c] = await rows();
    await db.execute(sql`update boleto_cancellations set updated_at = now() - interval '11 minutes'`);
    const second = prov();                                                                                           // tentativa 2 (reconsulta): vê o boleto emitido e cancela
    expect(await recheckCancellation(db, dirA, A, c.id, { ...second.p, boleto: { ...second.p.boleto, status: async () => "emitido", cancel: async () => undefined } })).toMatchObject({ status: "cancelado" });
    gate.release(); await orig;                                                                                     // a tentativa 1 termina depois: seu resultado é descartado
    expect((await rows())[0]).toMatchObject({ status: "cancelado", attempts: 2 });
    expect(await db.select().from(schema.auditLog).where(sql`action = 'boleto.cancelled'`)).toHaveLength(1);        // um único registro de "cancelado"

    // boleto pago no provedor → falhou + régua parada + evento próprio
    const pago = prov(async () => { throw new Error("boleto_pago"); });
    const i2 = await issued(cli2, pago.p);
    await cancelBoleto(db, dirA, A, ok(i2.chargeId), pago.p);
    expect(await db.select().from(schema.auditLog).where(sql`action = 'boleto.paid_at_provider'`)).toHaveLength(1);
  });

  it("o banco protege o registro: sem apagar, sem alterar quem/por quê, cancelado é definitivo, um só ativo por boleto", async () => {
    const { p } = prov(); const { chargeId, requestId } = await issued(cli1, p);
    await cancelBoleto(db, dirA, A, ok(chargeId), p);
    const [c] = await rows();
    expect(await why(sql`delete from boleto_cancellations where id = ${c.id}`)).toMatch(/não pode ser apagado/);
    expect(await why(sql`update boleto_cancellations set reason = 'outro motivo' where id = ${c.id}`)).toMatch(/imutáveis/);
    expect(await why(sql`update boleto_cancellations set requested_by = ${gerA} where id = ${c.id}`)).toMatch(/imutáveis/);
    expect(await why(sql`update boleto_cancellations set created_at = now() + interval '1 day' where id = ${c.id}`)).toMatch(/imutáveis/);
    expect(await why(sql`update boleto_cancellations set status = 'falhou' where id = ${c.id}`)).toMatch(/definitivo/);
    expect(await why(sql`insert into boleto_cancellations (company_id, charge_id, request_id, external_ref, reason, requested_by, status) values (${A}, ${chargeId}, ${requestId}, 'x', 'duplicado', ${dirA}, 'enviando')`)).toMatch(/boleto_cancellations_one_active_uq|duplicate key/);
    expect(await why(sql`insert into boleto_cancellations (company_id, charge_id, request_id, external_ref, reason, requested_by, mode) values (${A}, ${chargeId}, ${requestId}, 'x', 'modo real', ${dirA}, 'real')`)).toMatch(/mode_chk|violates check/);
  });
});
