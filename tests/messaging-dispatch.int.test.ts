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
import { approveBatch, generateBatch, getBatch } from "@/modules/billing/batches";
import { ensureDefaultTemplates, getSettings, listQueue, processQueue, runScheduled, saveSettings, scheduleQueue, tickAll } from "@/modules/messaging/service";
import { createMockProviders } from "@/modules/providers/mock";
import type { Providers } from "@/modules/providers/types";
import { DEFAULT_SETTINGS } from "@/modules/messaging/window";

const enabled = !!process.env.POSTGRES_USER;
const CNPJ1 = "11.222.333/0001-81", CNPJ2 = "12.ABC.345/01DE-35";
// competência 2026-09, vencimento 2026-10-14, emissão 2026-10-01. Régua: 10-01, 10-11, 10-14, 10-17, 10-21 (+ revisão 10-29).
const D = "2026-10-01";
const terms = (o: Record<string, unknown> = {}) => ({ description: "Monitoramento de redes", monthlyAmount: "2.500,00", startAt: "2026-01-01", endAt: "", dueDay: "14", invoiceJointRequired: false, issueDayOverride: "", ...o });

describe.skipIf(!enabled)("E09 envio simulado: janela, limites, pausa, falhas e agendador (DB de teste)", () => {
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
    await db.execute(sql`truncate messaging_settings, message_queue, message_template_versions, message_templates, charges, billing_batches, holidays, contract_versions, contracts, integration_conflicts, integration_sync_runs, integration_connections, rate_limits, customer_contacts, vendor_contacts, customers, vendors, audit_log, invitations, memberships, companies, users restart identity cascade`);
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
  const wa = () => saveSettings(db, dirA, A, { ...DEFAULT_SETTINGS, whatsappEnabled: true }); // WhatsApp nasce desligado
  const n = async (q: string) => Number((await db.execute(sql.raw(`select count(*)::int n from ${q}`)))[0].n);

  const cfg = (o: Partial<typeof DEFAULT_SETTINGS> = {}, by = dirA, co = A) => saveSettings(db, by, co, { ...DEFAULT_SETTINGS, ...o });
  const setup = async () => { await approvedBatch(); await ensureDefaultTemplates(db, dirA, A); await scheduleQueue(db, asstA, A, D); };
  const OPEN = new Date("2026-10-01T10:00:00-04:00"); // quinta, 10:00 em Manaus

  it("configuração: padrões conservadores, permissão, validação, restrições no banco, auditoria sem PII", async () => {
    expect(await getSettings(db, contA, A)).toMatchObject({ paused: false, autoDispatch: false, whatsappEnabled: false, maxPerRun: 50, maxPerHour: 30, maxLateDays: 2 });
    await expect(cfg({}, asstA)).rejects.toThrow(Forbidden);
    await expect(cfg({ windowEnd: "09:00" }, gerA)).rejects.toThrow(/depois do inicial/);
    await expect(cfg({ maxPerRun: 501 }, gerA)).rejects.toThrow(Invalid);
    await expect(getSettings(db, techA, A)).rejects.toThrow(Forbidden);
    await cfg({ whatsappEnabled: true, windowStart: "08:30", maxPerRun: 7 }, gerA);
    expect(await getSettings(db, contA, A)).toMatchObject({ whatsappEnabled: true, windowStart: "08:30", maxPerRun: 7 });
    expect(await getSettings(db, dirB, B)).toMatchObject({ whatsappEnabled: false, maxPerRun: 50 }); // outra empresa: padrão
    await cfg({ maxPerRun: 9 }, gerA); expect(await n("messaging_settings")).toBe(1); // upsert
    await expect(db.execute(sql`update messaging_settings set window_start = '20:00'`)).rejects.toThrow();
    await expect(db.execute(sql`update messaging_settings set weekdays = '{}'`)).rejects.toThrow();
    await expect(db.execute(sql`update messaging_settings set weekdays = '{7}'`)).rejects.toThrow();
    await expect(db.execute(sql`update messaging_settings set max_per_hour = 0`)).rejects.toThrow();
    const logs = await db.select().from(schema.auditLog).where(sql`${schema.auditLog.action} = 'messages.settings.saved'`);
    expect(logs).toHaveLength(2);
  });

  it("pausa (kill switch) impede o processamento manual e o automático", async () => {
    await setup(); await cfg({ paused: true, autoDispatch: true });
    expect(await processQueue(db, asstA, A, D)).toMatchObject({ processed: 0, waiting: "Envio pausado" });
    expect(await runScheduled(db, A, OPEN)).toMatchObject({ processed: 0, waiting: "Envio pausado" });
    expect(await tickAll(db, OPEN)).toEqual([]); // empresa pausada nem entra no ciclo
    expect(await n("message_queue where status = 'simulado'")).toBe(0);
    await cfg({ paused: false }); expect(await processQueue(db, asstA, A, D)).toMatchObject({ processed: 2 });
  });

  it("canal desligado não processa (WhatsApp nasce desligado); ligar libera", async () => {
    await setup();
    expect(await processQueue(db, asstA, A, D)).toMatchObject({ processed: 2, skipped: 1 }); // e-mail dos 2 clientes; WhatsApp do Cliente Um fica
    expect((await listQueue(db, contA, A)).counts).toMatchObject({ simulado: 2 });
    await cfg({ whatsappEnabled: true });
    expect(await processQueue(db, asstA, A, D)).toMatchObject({ processed: 1, skipped: 0 });
    await cfg({ emailEnabled: false, whatsappEnabled: true });
    expect(await processQueue(db, asstA, A, "2026-10-11")).toMatchObject({ processed: 1, skipped: 2 }); // D-3: só o WhatsApp do Cliente Um; os e-mails ficam
  });

  it("agendador: só com envio automático ligado, dentro da janela, sem usuário e com auditoria própria", async () => {
    await setup();
    expect(await runScheduled(db, A, OPEN)).toMatchObject({ processed: 0, waiting: "Envio automático desligado" });
    await cfg({ autoDispatch: true });
    expect(await runScheduled(db, A, new Date("2026-10-01T20:00:00-04:00"))).toMatchObject({ processed: 0, waiting: "Fora do horário permitido" });
    expect(await runScheduled(db, A, new Date("2026-10-01T08:59:00-04:00"))).toMatchObject({ processed: 0, waiting: "Fora do horário permitido" });
    await db.insert(schema.holidays).values({ companyId: A, day: D, name: "Feriado municipal" });
    expect(await runScheduled(db, A, OPEN)).toMatchObject({ processed: 0, waiting: "Feriado" });
    await db.execute(sql`delete from holidays`);
    expect(await n("message_queue where status = 'simulado'")).toBe(0);
    const r = await runScheduled(db, A, OPEN);
    expect(r.processed).toBe(2); expect(r.waiting).toBeUndefined();
    const q = (await listQueue(db, contA, A, "simulado")).items;
    expect(q.every((i) => i.processedBy === null && /^mock-email-/.test(i.providerRef ?? "") && i.attempts === 1)).toBe(true);
    const log = (await db.select().from(schema.auditLog).where(sql`${schema.auditLog.action} = 'messages.queue.auto_run'`));
    expect(log).toHaveLength(1); expect(log[0].actorId).toBeNull(); expect(log[0].detail).toMatchObject({ processed: 2 });
    expect(await runScheduled(db, A, OPEN)).toMatchObject({ processed: 0 }); // reexecutar não reenvia
    expect(await n("audit_log where action = 'messages.queue.auto_run'")).toBe(1); // execução vazia não polui a auditoria
  });

  it("fim de semana e dia não permitido: o agendador espera", async () => {
    await setup(); await cfg({ autoDispatch: true });
    expect(await runScheduled(db, A, new Date("2026-10-03T10:00:00-04:00"))).toMatchObject({ waiting: "Dia da semana não permitido" });
    await cfg({ autoDispatch: true, weekdays: [1, 2, 3, 4, 5, 6] });
    expect((await runScheduled(db, A, new Date("2026-10-03T10:00:00-04:00"))).waiting).toBeUndefined();
  });

  it("limites: por execução e por hora", async () => {
    await setup(); await cfg({ whatsappEnabled: true, maxPerRun: 2, maxPerHour: 3 });
    expect(await processQueue(db, asstA, A, D)).toMatchObject({ processed: 2, waiting: "Limite de envios atingido nesta execução" });
    // 3º envio cabe no limite de 3/hora; depois o limite horário trava até passar 1 hora
    expect(await processQueue(db, asstA, A, D)).toMatchObject({ processed: 1 });
    expect(await processQueue(db, asstA, A, D)).toMatchObject({ processed: 0, waiting: "Limite de envios por hora atingido" });
    await cfg({ maxPerRun: 50, maxPerHour: 30 });
    expect((await processQueue(db, asstA, A, D)).processed).toBe(0); // já enviou tudo da data D
  });

  it("falha temporária reaparece (até 3 tentativas); definitiva bloqueia na hora; erro sem dado do cliente", async () => {
    await setup();
    await db.update(schema.customerContacts).set({ email: "fin1@falha.test" }).where(eq(schema.customerContacts.partyId, cli1));
    const r1 = await processQueue(db, asstA, A, D);
    expect(r1).toMatchObject({ processed: 1, failed: 1 });
    const open = async () => (await db.select().from(schema.messageQueue).where(sql`customer_id = ${cli1} and kind = 'emissao' and channel = 'email'`))[0];
    expect(await open()).toMatchObject({ status: "pendente", attempts: 1, lastError: "falha_temporaria" });
    await processQueue(db, asstA, A, D);
    expect(await open()).toMatchObject({ status: "pendente", attempts: 2 });
    await processQueue(db, asstA, A, D);
    expect(await open()).toMatchObject({ status: "bloqueado", attempts: 3 });
    expect((await open()).blockedReason).toContain("Falha no envio");
    // destinatário inválido para o provedor: definitivo
    await db.update(schema.customerContacts).set({ email: "fin2@invalido.test" }).where(eq(schema.customerContacts.partyId, cli2));
    await processQueue(db, asstA, A, "2026-10-11"); // D-3 do Cliente Dois (a emissão dele já saiu no 1º ciclo)
    const dois = (await db.select().from(schema.messageQueue).where(sql`customer_id = ${cli2} and kind = 'd_menos_3' and channel = 'email'`))[0];
    expect(dois).toMatchObject({ status: "bloqueado", attempts: 1, lastError: "destinatario_invalido" });
    expect(JSON.stringify(await db.select().from(schema.auditLog))).not.toContain("falha.test");
    // reprogramar não "desbloqueia" falha de envio (só falta de contato)
    await scheduleQueue(db, asstA, A, D);
    expect((await open()).status).toBe("bloqueado");
  });

  it("mensagem que perdeu a data (mais de 2 dias de atraso) não sai: vai para revisão manual", async () => {
    await setup();
    const r = await processQueue(db, asstA, A, "2026-10-04"); // emissão era 01/10
    expect(r).toMatchObject({ processed: 0, blocked: 2 }); // e-mails; o WhatsApp está desligado e apenas espera
    const b = (await listQueue(db, contA, A, "bloqueado")).items.filter((i) => i.kind === "emissao");
    expect(b.length).toBeGreaterThanOrEqual(3); // 2 por data perdida + 1 sem telefone
    expect(b.some((i) => i.blockedReason?.startsWith("Perdeu a data"))).toBe(true);
    await scheduleQueue(db, asstA, A, "2026-10-04");
    expect(await n("message_queue where status = 'simulado'")).toBe(0);
  });

  it("destinatários vêm só dos contatos FINANCEIROS, válidos e sem duplicata; HTML do e-mail é escapado", async () => {
    await setup();
    await db.insert(schema.customerContacts).values([
      { companyId: A, partyId: cli1, name: "Outro", email: "Fin1@Exemplo.com", isFinancial: true }, // duplicado (caixa diferente)
      { companyId: A, partyId: cli1, name: "Técnico", email: "tecnico@exemplo.com", isFinancial: false }, // não financeiro
      { companyId: A, partyId: cli1, name: "Ruim", email: "isto nao e email", isFinancial: true },
    ]);
    const base = createMockProviders(); const seen: { to: string[]; html: string; key: string }[] = [];
    const spy: Providers = { ...base, email: { mode: "mock", send: async (m) => { seen.push({ to: m.to, html: m.html, key: m.idempotencyKey }); return base.email.send(m); } } };
    await db.update(schema.customers).set({ legalName: "Cliente <b>Um</b> & Cia" }).where(eq(schema.customers.id, cli1));
    await processQueue(db, asstA, A, D, spy);
    const um = seen.find((s) => s.to.includes("fin1@exemplo.com"))!;
    expect(um.to).toEqual(["fin1@exemplo.com"]);
    expect(um.html).toContain("Cliente &lt;b&gt;Um&lt;/b&gt; &amp; Cia"); expect(um.html).not.toContain("<b>");
    expect(um.key).toMatch(/^msg-[0-9a-f-]{36}$/);
  });

  it("chave *_LIVE ligada sem adaptador real: recusa e não marca nada como enviado", async () => {
    await setup();
    process.env.CORA_LIVE_ENABLED = "true";
    try {
      await expect(processQueue(db, asstA, A, D)).rejects.toThrow(/adaptador real/);
      await cfg({ autoDispatch: true });
      const t = await tickAll(db, OPEN);
      expect(t).toHaveLength(1); expect(t[0].error).toBe("LiveNotAvailable"); // o ciclo registra o erro e segue vivo
    } finally { delete process.env.CORA_LIVE_ENABLED; }
    expect(await n("message_queue where status = 'simulado'")).toBe(0);
  });

  it("ciclo do agendador: só empresas com automático ligado; uma empresa com erro não derruba as outras", async () => {
    await setup();
    await db.insert(schema.messagingSettings).values({ companyId: B, autoDispatch: true });
    await cfg({ autoDispatch: true });
    const res = await tickAll(db, OPEN);
    expect(res.map((r) => r.companyId).sort()).toEqual([A, B].sort());
    expect(res.find((r) => r.companyId === A)!.result).toMatchObject({ processed: 2 });
    expect(res.find((r) => r.companyId === B)!.result).toMatchObject({ processed: 0 });
    await cfg({ autoDispatch: false });
    expect((await tickAll(db, OPEN)).map((r) => r.companyId)).toEqual([B]);
  });

  it("simultaneidade: dois ciclos ao mesmo tempo não enviam duas vezes", async () => {
    await setup(); await cfg({ autoDispatch: true });
    const [a, b] = await Promise.all([runScheduled(db, A, OPEN), runScheduled(db, A, OPEN)]);
    expect(a.processed + b.processed).toBe(2);
    expect(await n("message_queue where status = 'simulado'")).toBe(2);
  });
});
