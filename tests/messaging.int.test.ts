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
import { approveBatch, cancelBatch, generateBatch, getBatch, reopenBatch } from "@/modules/billing/batches";
import { activateVersion, ensureDefaultTemplates, listQueue, listTemplates, processQueue, saveDraft, scheduleQueue } from "@/modules/messaging/service";

const enabled = !!process.env.POSTGRES_USER;
const CNPJ1 = "11.222.333/0001-81", CNPJ2 = "12.ABC.345/01DE-35";
// competência 2026-09, vencimento 2026-10-14, emissão 2026-10-01. Régua: 10-01, 10-11, 10-14, 10-17, 10-21 (+ revisão 10-29).
const D = "2026-10-01";
const terms = (o: Record<string, unknown> = {}) => ({ description: "Monitoramento de redes", monthlyAmount: "2.500,00", startAt: "2026-01-01", endAt: "", dueDay: "14", invoiceJointRequired: false, issueDayOverride: "", ...o });

describe.skipIf(!enabled)("E06 modelos e fila simulada (DB de teste)", () => {
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
    await db.execute(sql`truncate message_queue, message_template_versions, message_templates, charges, billing_batches, holidays, contract_versions, contracts, integration_conflicts, integration_sync_runs, integration_connections, rate_limits, customer_contacts, vendor_contacts, customers, vendors, audit_log, invitations, memberships, companies, users restart identity cascade`);
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
    // Cliente Um: contato financeiro com e-mail e telefone. Cliente Dois: só e-mail.
    await db.insert(schema.customerContacts).values([
      { companyId: A, partyId: cli1, name: "Fin Um", email: "fin1@exemplo.com", phone: "92999990001", isFinancial: true },
      { companyId: A, partyId: cli2, name: "Fin Dois", email: "fin2@exemplo.com", isFinancial: true },
    ]);
  });

  const activeContract = async (customer: string, t = terms()) => {
    const c = await createContract(db, asstA, A, customer, t);
    await decideVersion(db, dirA, A, (await getContract(db, dirA, A, c.id))!.versions[0].id, "aprovar");
    return c.id;
  };
  const approvedBatch = async () => {
    await activeContract(cli1); await activeContract(cli2, terms({ dueDay: "14" }));
    const { batchId } = await generateBatch(db, asstA, A, D);
    const g = (await getBatch(db, asstA, A, batchId))!;
    await approveBatch(db, dirA, A, batchId, g.hash);
    return batchId;
  };
  const n = async (q: string) => Number((await db.execute(sql.raw(`select count(*)::int n from ${q}`)))[0].n);

  it("modelos padrão: só quem tem permissão cria; 10 modelos ativos; idempotente", async () => {
    await expect(ensureDefaultTemplates(db, asstA, A)).rejects.toThrow(Forbidden);
    await expect(ensureDefaultTemplates(db, contA, A)).rejects.toThrow(Forbidden);
    expect(await ensureDefaultTemplates(db, gerA, A)).toEqual({ created: 10 });
    expect(await ensureDefaultTemplates(db, dirA, A)).toEqual({ created: 0 });
    const ts = await listTemplates(db, contA, A);
    expect(ts).toHaveLength(10);
    expect(ts.every((t) => t.active?.state === "ativa" && t.active.activatedBy === gerA)).toBe(true);
    await expect(listTemplates(db, techA, A)).rejects.toThrow(Forbidden);
    expect(await listTemplates(db, dirB, B)).toHaveLength(0);
  });

  it("rascunho → ativação: versões numeradas, uma só ativa, rascunho reaproveitado, texto inválido barrado", async () => {
    await ensureDefaultTemplates(db, dirA, A);
    await expect(saveDraft(db, asstA, A, "d0", "email", "Assunto", "Corpo")).rejects.toThrow(Forbidden);
    await expect(saveDraft(db, dirA, A, "d0", "email", "Assunto", "Oi {{senha}}")).rejects.toThrow(/Campo desconhecido/);
    await expect(saveDraft(db, dirA, A, "d0", "email", "Assunto", "<b>oi</b>")).rejects.toThrow(/HTML/);
    await expect(saveDraft(db, dirA, A, "d0", "email", "A\nB", "Corpo")).rejects.toThrow(Invalid);
    await expect(saveDraft(db, dirA, A, "xx", "email", "A", "B")).rejects.toThrow(/inválido/);
    const d1 = await saveDraft(db, dirA, A, "d0", "email", "Vence {{vencimento}}", "Olá {{cliente}}, versão 2");
    const d1b = await saveDraft(db, dirA, A, "d0", "email", "Vence {{vencimento}}", "Olá {{cliente}}, versão 2 editada");
    expect(d1b).toEqual(d1); expect(d1.version).toBe(2);
    expect(await n("message_template_versions")).toBe(11);
    await expect(activateVersion(db, dirB, B, d1.versionId)).rejects.toThrow(/não encontrada/); // outra empresa
    await activateVersion(db, gerA, A, d1.versionId);
    const t = (await listTemplates(db, dirA, A)).find((x) => x.kind === "d0" && x.channel === "email")!;
    expect(t.active).toMatchObject({ version: 2, body: "Olá {{cliente}}, versão 2 editada" });
    expect(t.versions.map((v) => [v.version, v.state])).toEqual([[2, "ativa"], [1, "arquivada"]]);
    await expect(activateVersion(db, gerA, A, d1.versionId)).rejects.toThrow(/já está ativa/);
    // reativar a antiga (rollback do texto) arquiva a atual
    const v1 = t.versions.find((v) => v.version === 1)!;
    await activateVersion(db, gerA, A, v1.id);
    expect((await listTemplates(db, dirA, A)).find((x) => x.kind === "d0" && x.channel === "email")!.versions.map((v) => [v.version, v.state])).toEqual([[2, "arquivada"], [1, "ativa"]]);
    await expect(db.execute(sql`update message_template_versions set state = 'ativa' where version = 2`)).rejects.toThrow(); // índice: uma ativa por modelo
  });

  it("programar: só cobranças APROVADAS; bloqueia sem contato; idempotente; não agenda o passado", async () => {
    await activeContract(cli1); await activeContract(cli2);
    const { batchId } = await generateBatch(db, asstA, A, D); // prévia: ainda não vale
    await ensureDefaultTemplates(db, dirA, A);
    expect(await scheduleQueue(db, asstA, A, D)).toMatchObject({ charges: 0, created: 0 });
    const g = (await getBatch(db, asstA, A, batchId))!;
    await approveBatch(db, dirA, A, batchId, g.hash);
    const r = await scheduleQueue(db, asstA, A, D);
    // 2 cobranças × (5 etapas × 2 canais + 1 revisão) = 22; Cliente Dois sem telefone → 5 WhatsApp bloqueados
    expect(r).toMatchObject({ charges: 2, created: 22, blocked: 5, semModelo: 0, passado: 0 });
    expect(await scheduleQueue(db, asstA, A, D)).toMatchObject({ created: 0, blocked: 0 });
    expect(await n("message_queue")).toBe(22);
    const q = await listQueue(db, contA, A);
    expect(q.counts).toMatchObject({ pendente: 17, bloqueado: 5 });
    expect(q.items.filter((i) => i.status === "bloqueado").every((i) => i.channel === "whatsapp" && i.customerName === "Cliente Dois" && i.blockedReason === "Sem contato financeiro com telefone")).toBe(true);
    expect(q.items.filter((i) => i.channel === "interno").map((i) => [i.kind, i.scheduledFor])).toEqual([["revisao_d15", "2026-10-29"], ["revisao_d15", "2026-10-29"]]);
    // contato novo destrava o item bloqueado
    await db.insert(schema.customerContacts).values({ companyId: A, partyId: cli2, name: "Zap", phone: "92988880000", isFinancial: true });
    expect(await scheduleQueue(db, asstA, A, D)).toMatchObject({ created: 0, unblocked: 5 });
    expect((await listQueue(db, contA, A)).counts).toMatchObject({ pendente: 22 });
    // permissões
    await expect(scheduleQueue(db, contA, A, D)).rejects.toThrow(Forbidden);
    await expect(processQueue(db, contA, A, D)).rejects.toThrow(Forbidden);
    await expect(listQueue(db, techA, A)).rejects.toThrow(Forbidden);
  });

  it("não agenda datas passadas e conta o que falta de modelo ativo", async () => {
    await approvedBatch();
    // hoje = 12/10, sem modelos: emissão e D-3 já passaram (2 cobranças × 2 canais × 2 etapas); D0/D+3/D+7 sem modelo (2×2×3); só a revisão interna entra
    expect(await scheduleQueue(db, asstA, A, "2026-10-12")).toMatchObject({ created: 2, passado: 8, semModelo: 12 });
    await ensureDefaultTemplates(db, dirA, A);
    expect(await scheduleQueue(db, asstA, A, "2026-10-12")).toMatchObject({ created: 12, passado: 8, semModelo: 0 }); // 2 cobranças × 3 etapas × 2 canais
    expect(await n("message_queue")).toBe(14);
  });

  it("processar (simulação): só vencidos, texto renderizado sem campos soltos, nada duplica, bloqueados e futuros ficam", async () => {
    await approvedBatch(); await ensureDefaultTemplates(db, dirA, A);
    await scheduleQueue(db, asstA, A, D);
    expect(await processQueue(db, asstA, A, "2026-09-30")).toMatchObject({ processed: 0 });
    // 14/10: emissão, D-3 e D0 → 3 etapas × 2 canais × 2 cobranças − 3 WhatsApp bloqueados do Cliente Dois = 9
    expect(await processQueue(db, asstA, A, "2026-10-14")).toMatchObject({ processed: 9 });
    expect(await processQueue(db, asstA, A, "2026-10-14")).toMatchObject({ processed: 0 });
    const sim = (await listQueue(db, contA, A, "simulado")).items;
    expect(sim).toHaveLength(9);
    for (const i of sim) { expect(i.renderedBody).not.toMatch(/\{\{|\}\}/); expect(i.processedBy).toBe(asstA); }
    const em = sim.find((i) => i.kind === "emissao" && i.channel === "email" && i.customerName === "Cliente Um")!;
    expect(em.renderedSubject).toBe("Cobrança Empresa A — vencimento 14/10/2026");
    expect(em.renderedBody).toContain("Olá, Cliente Um.");
    expect(em.renderedBody).toContain("R$ 2.500,00");
    expect(em.renderedBody).toContain("competência 09/2026");
    expect(sim.filter((i) => i.channel === "whatsapp").every((i) => i.renderedSubject === "")).toBe(true);
    expect((await listQueue(db, contA, A)).counts).toMatchObject({ simulado: 9, pendente: 8, bloqueado: 5 });
    // revisão D+15 vira tarefa interna, não mensagem
    await processQueue(db, asstA, A, "2026-10-29");
    const rev = (await listQueue(db, contA, A, "simulado")).items.find((i) => i.kind === "revisao_d15")!;
    expect(rev.renderedBody).toContain("15 dias em atraso"); expect(rev.channel).toBe("interno");
  });

  it("parar ao reabrir/cancelar: itens abertos são cancelados, os simulados ficam, reaprovar reprograma sem duplicar", async () => {
    const batchId = await approvedBatch(); await ensureDefaultTemplates(db, dirA, A);
    await scheduleQueue(db, asstA, A, D); await processQueue(db, asstA, A, D); // emissão (4 itens, 1 bloqueado de WhatsApp... Cliente Dois tem só e-mail)
    const before = (await listQueue(db, contA, A)).counts;
    expect(before.simulado).toBe(3);
    await reopenBatch(db, gerA, A, batchId, "Valor do contrato mudou");
    const after = (await listQueue(db, contA, A, "cancelado")).items;
    expect(after.length).toBe(22 - 3); // tudo que estava aberto
    expect((await listQueue(db, contA, A)).counts).toMatchObject({ simulado: 3 });
    expect(await scheduleQueue(db, asstA, A, D)).toMatchObject({ charges: 0, created: 0 }); // prévia não programa
    const g = (await getBatch(db, asstA, A, batchId))!;
    await approveBatch(db, dirA, A, batchId, g.hash);
    const re = await scheduleQueue(db, asstA, A, D);
    expect(re.created).toBe(22 - 3); // o que já foi simulado não é refeito
    const dup = await db.execute(sql`select count(*)::int n from (select 1 from message_queue where status <> 'cancelado' group by charge_id, kind, channel having count(*) > 1) x`);
    expect(Number(dup[0].n)).toBe(0);
  });

  it("cobrança que deixou de estar aprovada cancela o item em vez de enviar (parar ao pagar/cancelar)", async () => {
    await approvedBatch(); await ensureDefaultTemplates(db, dirA, A);
    await scheduleQueue(db, asstA, A, D);
    await db.execute(sql`update charges set status = 'cancelada' where customer_id = ${cli1}`);
    const r = await processQueue(db, asstA, A, "2026-10-14");
    expect(r.cancelled).toBeGreaterThan(0);
    const sim = (await listQueue(db, contA, A, "simulado")).items;
    expect(sim.every((i) => i.customerName === "Cliente Dois")).toBe(true);
  });

  it("cancelar lote depois de reabrir não quebra com histórico na fila", async () => {
    const batchId = await approvedBatch(); await ensureDefaultTemplates(db, dirA, A);
    await scheduleQueue(db, asstA, A, D); await processQueue(db, asstA, A, D);
    await reopenBatch(db, gerA, A, batchId, "Cancelar este lote");
    await cancelBatch(db, asstA, A, batchId);
    expect(await n("charges")).toBe(0); expect(await n("message_queue")).toBe(0);
  });

  it("banco: sem duplicata, canal interno só na revisão, bloqueio exige motivo", async () => {
    await approvedBatch(); await ensureDefaultTemplates(db, dirA, A);
    await scheduleQueue(db, asstA, A, D);
    const [q] = await db.select().from(schema.messageQueue).limit(1);
    const row = { companyId: A, chargeId: q.chargeId, customerId: q.customerId };
    await expect(db.insert(schema.messageQueue).values({ ...row, kind: q.kind, channel: q.channel, scheduledFor: D })).rejects.toThrow();
    await expect(db.insert(schema.messageQueue).values({ ...row, kind: "d0", channel: "interno", scheduledFor: D })).rejects.toThrow();
    await expect(db.insert(schema.messageQueue).values({ ...row, kind: "revisao_d15", channel: "email", scheduledFor: D })).rejects.toThrow();
    await expect(db.update(schema.messageQueue).set({ status: "bloqueado" })).rejects.toThrow();
    await expect(db.insert(schema.messageQueue).values({ ...row, companyId: B, kind: "d0", channel: "email", scheduledFor: D })).rejects.toThrow(); // FK composta: cobrança de outra empresa
  });

  it("isolamento e auditoria: outra empresa não vê nem mexe; auditoria só com ids e contagens", async () => {
    await approvedBatch(); await ensureDefaultTemplates(db, dirA, A);
    await scheduleQueue(db, asstA, A, D); await processQueue(db, asstA, A, "2026-10-14");
    expect((await listQueue(db, dirB, B)).items).toHaveLength(0);
    expect(await scheduleQueue(db, dirB, B, D)).toMatchObject({ charges: 0, created: 0 });
    await expect(listQueue(db, dirB, A)).rejects.toThrow(Forbidden);
    const logs = await db.select().from(schema.auditLog).where(sql`${schema.auditLog.action} like 'messages.%'`);
    expect(logs.length).toBeGreaterThan(3);
    const txt = JSON.stringify(logs.map((l) => l.detail));
    for (const bad of ["Cliente Um", "Cliente Dois", "fin1@exemplo.com", "2.500", "Olá", "9299999"]) expect(txt).not.toContain(bad);
  });

  it("concorrência: duas programações simultâneas não duplicam a fila", async () => {
    await approvedBatch(); await ensureDefaultTemplates(db, dirA, A);
    await Promise.all([scheduleQueue(db, asstA, A, D), scheduleQueue(db, gerA, A, D), scheduleQueue(db, dirA, A, D)]);
    expect(await n("message_queue")).toBe(22);
  });
});
