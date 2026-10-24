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
import { createContract, decideVersion, getContract, proposeChange, setStatus } from "@/modules/contracts/service";
import { addHoliday, removeHoliday, listHolidays } from "@/modules/billing/service";
import { approveBatch, cancelBatch, generateBatch, getBatch, listBatches, reopenBatch } from "@/modules/billing/batches";

const enabled = !!process.env.POSTGRES_USER;
const CNPJ1 = "11.222.333/0001-81", CNPJ2 = "12.ABC.345/01DE-35";
// competência 2026-09, vencimento em 2026-10; 13–16 → emite dia 1; 1–12 com NF conjunta → dia 1. Data de emissão do teste: 2026-10-01 (quinta).
const D = "2026-10-01";
const terms = (o: Record<string, unknown> = {}) => ({ description: "Monitoramento de redes", monthlyAmount: "2.500,00", startAt: "2026-01-01", endAt: "", dueDay: "14", invoiceJointRequired: false, issueDayOverride: "", ...o });

describe.skipIf(!enabled)("E05 lotes de cobrança: prévia idempotente, aprovação e isolamento (DB de teste)", () => {
  let admin: ReturnType<typeof postgres>, conn: ReturnType<typeof postgres>, db: DB;
  let A: string, B: string, dirA: string, dirB: string, gerA: string, ger2A: string, asstA: string, contA: string, techA: string, cli1: string, cli2: string, cliB: string;

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
    await db.execute(sql`truncate charges, billing_batches, holidays, contract_versions, contracts, integration_conflicts, integration_sync_runs, integration_connections, rate_limits, customer_contacts, vendor_contacts, customers, vendors, audit_log, invitations, memberships, companies, users restart identity cascade`);
    const [a, b] = await db.insert(schema.companies).values([{ name: "A" }, { name: "B" }]).returning();
    A = a.id; B = b.id;
    const mk = async (e: string) => (await db.insert(schema.users).values({ email: e, name: e, passwordHash: "x" }).returning())[0].id;
    dirA = await mk("dir-a@t.com"); dirB = await mk("dir-b@t.com"); gerA = await mk("ger@t.com"); ger2A = await mk("ger2@t.com"); asstA = await mk("asst@t.com"); contA = await mk("cont@t.com"); techA = await mk("tech@t.com");
    await db.insert(schema.memberships).values([
      { userId: dirA, companyId: A, role: "diretoria" }, { userId: dirB, companyId: B, role: "diretoria" }, { userId: gerA, companyId: A, role: "gerente" }, { userId: ger2A, companyId: A, role: "gerente" },
      { userId: asstA, companyId: A, role: "assistente" }, { userId: contA, companyId: A, role: "contabilidade" }, { userId: techA, companyId: A, role: "admin_tecnico" },
    ]);
    cli1 = (await createParty(db, dirA, A, { kind: "cliente", legalName: "Cliente Um", document: CNPJ1 })).id;
    cli2 = (await createParty(db, dirA, A, { kind: "cliente", legalName: "Cliente Dois", document: CNPJ2 })).id;
    cliB = (await createParty(db, dirB, B, { kind: "cliente", legalName: "Cliente B", document: CNPJ1 })).id;
  });

  const active = async (customer: string, t = terms(), co = A, creator = asstA, approver = dirA) => {
    const c = await createContract(db, creator, co, customer, t);
    await decideVersion(db, approver, co, (await getContract(db, approver, co, c.id))!.versions[0].id, "aprovar");
    return c.id;
  };
  const change = async (id: string, t: ReturnType<typeof terms>) => {
    await proposeChange(db, asstA, A, id, t);
    await decideVersion(db, dirA, A, (await getContract(db, dirA, A, id))!.versions[0].id, "aprovar");
  };
  const chargeCount = async () => Number((await db.execute(sql`select count(*)::int n from charges`))[0].n);

  it("gera a prévia (só contratos faturáveis), soma o total e é IDEMPOTENTE", async () => {
    const c1 = await active(cli1), c2 = await active(cli2, terms({ dueDay: "16", monthlyAmount: "1.000,50" }));
    const susp = await active(cli1, terms({ dueDay: "15" })); await setStatus(db, asstA, A, susp, "suspenso");
    await createContract(db, asstA, A, cli1, terms({ dueDay: "15" })); // rascunho: não entra
    await active(cli2, terms({ dueDay: "20" })); // outra data de emissão (dia 8): não entra
    const r1 = await generateBatch(db, asstA, A, D);
    expect(r1).toMatchObject({ created: true, added: 2, updated: 0, removed: 0, skipped: 0 });
    const full = (await getBatch(db, asstA, A, r1.batchId))!;
    expect(full.batch).toMatchObject({ status: "rascunho", issueDate: D, generatedBy: asstA });
    expect(full.charges.map((c) => c.contractId).sort()).toEqual([c1, c2].sort());
    expect(full.totalCents).toBe(250000 + 100050);
    expect(full.charges.every((c) => c.status === "previa" && c.competenceMonth === "2026-09-01" && c.issueDate === D)).toBe(true);
    expect(full.stale.any).toBe(false);
    // reexecutar não duplica
    const r2 = await generateBatch(db, gerA, A, D);
    expect(r2).toMatchObject({ batchId: r1.batchId, created: false, added: 0, updated: 0, removed: 0 });
    expect(await chargeCount()).toBe(2);
    expect(Number((await db.execute(sql`select count(*)::int n from billing_batches`))[0].n)).toBe(1);
    expect((await listBatches(db, contA, A))[0]).toMatchObject({ count: 2, totalCents: 350050 });
  });

  it("prévia acompanha mudança de contrato (valor alterado, contrato novo, contrato suspenso) sem duplicar", async () => {
    const c1 = await active(cli1), c2 = await active(cli2, terms({ dueDay: "16" }));
    const { batchId } = await generateBatch(db, asstA, A, D);
    await change(c1, terms({ monthlyAmount: "3.000,00" }));
    const c3 = await active(cli1, terms({ dueDay: "15" })); await setStatus(db, asstA, A, c2, "suspenso");
    const g = (await getBatch(db, asstA, A, batchId))!;
    expect(g.stale).toMatchObject({ added: 1, removed: 1, changed: 1, any: true });
    await expect(approveBatch(db, dirA, A, batchId, g.hash)).rejects.toThrow(/contratos mudaram/);
    expect(await generateBatch(db, asstA, A, D)).toMatchObject({ added: 1, updated: 1, removed: 1 });
    const after = (await getBatch(db, asstA, A, batchId))!;
    expect(after.charges.map((c) => [c.contractId, c.amountCents]).sort()).toEqual([[c1, 300000], [c3, 250000]].sort());
    expect(after.stale.any).toBe(false); expect(await chargeCount()).toBe(2);
  });

  it("itens em revisão (feriado na emissão) ficam FORA do lote; sem cobranças elegíveis não cria lote", async () => {
    await active(cli1); await active(cli2, terms({ dueDay: "5", invoiceJointRequired: true }));
    await addHoliday(db, gerA, A, { day: D, name: "Feriado municipal" });
    await expect(generateBatch(db, asstA, A, D)).rejects.toThrow(/Nenhuma cobrança prevista/);
    expect(Number((await db.execute(sql`select count(*)::int n from billing_batches`))[0].n)).toBe(0);
    await removeHoliday(db, gerA, A, (await listHolidays(db, gerA, A, 2026)).own[0].id);
    const { batchId } = await generateBatch(db, asstA, A, D);
    expect((await getBatch(db, asstA, A, batchId))!.charges).toHaveLength(2);
    await addHoliday(db, gerA, A, { day: D, name: "Feriado municipal" });
    const g = (await getBatch(db, asstA, A, batchId))!;
    expect(g.exceptions).toHaveLength(2); expect(g.stale).toMatchObject({ removed: 2, any: true });
    await expect(generateBatch(db, asstA, A, "2026-02-30")).rejects.toThrow(/Data inválida/);
  });

  it("aprovação: só gerente/diretoria; não aprova quem gerou (exceto diretoria); exige o conteúdo que o aprovador viu", async () => {
    await active(cli1); await active(cli2, terms({ dueDay: "16" }));
    await expect(generateBatch(db, contA, A, D)).rejects.toBeInstanceOf(Forbidden);   // contabilidade só lê
    await expect(generateBatch(db, techA, A, D)).rejects.toBeInstanceOf(Forbidden);   // admin técnico não lê financeiro
    const { batchId } = await generateBatch(db, asstA, A, D);
    const { hash } = (await getBatch(db, contA, A, batchId))!;                         // contabilidade lê
    await expect(approveBatch(db, asstA, A, batchId, hash)).rejects.toBeInstanceOf(Forbidden);
    await expect(approveBatch(db, contA, A, batchId, hash)).rejects.toBeInstanceOf(Forbidden);
    await expect(approveBatch(db, gerA, A, batchId, "hash-errado")).rejects.toThrow(/prévia mudou/);
    await generateBatch(db, gerA, A, D);                                                // gerente atualizou: agora é o "gerador"
    await expect(approveBatch(db, gerA, A, batchId, hash)).rejects.toBeInstanceOf(Forbidden);
    await approveBatch(db, ger2A, A, batchId, hash);                                    // outro gerente aprova
    const ok = (await getBatch(db, dirA, A, batchId))!;
    expect(ok.batch).toMatchObject({ status: "aprovado", approvedBy: ger2A }); expect(ok.charges.every((c) => c.status === "aprovada")).toBe(true);
    await expect(approveBatch(db, dirA, A, batchId, hash)).rejects.toThrow(/já aprovado/);
  });

  it("diretoria aprova a própria prévia; auditoria sem valores nem nomes", async () => {
    await active(cli1);
    const { batchId } = await generateBatch(db, dirA, A, D);
    await approveBatch(db, dirA, A, batchId, (await getBatch(db, dirA, A, batchId))!.hash);
    const audits = await db.select().from(schema.auditLog).where(sql`action like 'billing.%'`);
    expect(audits.map((a) => a.action).sort()).toEqual(["billing.batch.approved", "billing.batch.generated"]);
    const txt = JSON.stringify(audits); expect(txt).not.toMatch(/Cliente|2500|2\.500|Monitoramento/);
  });

  it("pós-aprovação: reexecutar é inócuo; mudança de contrato exige REABRIR com motivo e nova aprovação", async () => {
    const c1 = await active(cli1);
    const { batchId } = await generateBatch(db, asstA, A, D);
    await approveBatch(db, gerA, A, batchId, (await getBatch(db, gerA, A, batchId))!.hash);
    expect(await generateBatch(db, asstA, A, D)).toMatchObject({ batchId, created: false, added: 0, updated: 0, removed: 0 });
    await change(c1, terms({ monthlyAmount: "4.000,00" }));
    await expect(generateBatch(db, asstA, A, D)).rejects.toThrow(/Reabra o lote/);
    expect((await getBatch(db, gerA, A, batchId))!.stale).toMatchObject({ changed: 1, any: true });
    await expect(reopenBatch(db, asstA, A, batchId, "motivo válido")).rejects.toBeInstanceOf(Forbidden);
    await expect(reopenBatch(db, gerA, A, batchId, "x")).rejects.toThrow(/motivo/i);
    await reopenBatch(db, gerA, A, batchId, "valor do contrato mudou");
    const re = (await getBatch(db, gerA, A, batchId))!;
    expect(re.batch).toMatchObject({ status: "rascunho", approvedBy: null, approvedAt: null, reopenReason: "valor do contrato mudou" });
    expect(re.charges.every((c) => c.status === "previa")).toBe(true);
    await expect(approveBatch(db, gerA, A, batchId, re.hash)).rejects.toBeInstanceOf(Forbidden);   // quem reabriu não aprova
    await generateBatch(db, asstA, A, D);
    const fresh = (await getBatch(db, ger2A, A, batchId))!;
    expect(fresh.charges[0].amountCents).toBe(400000);
    await approveBatch(db, ger2A, A, batchId, fresh.hash);
    await expect(reopenBatch(db, ger2A, A, batchId, "motivo qualquer")).resolves.toBeUndefined();
  });

  it("mudança de data de emissão move a prévia de lote; lote aprovado não duplica", async () => {
    const c1 = await active(cli1);
    const first = await generateBatch(db, asstA, A, D);
    await change(c1, terms({ dueDay: "20" }));                       // 13..: vence 20 → emite dia 8 (2026-10-08)
    const second = await generateBatch(db, asstA, A, "2026-10-08");
    expect(second).toMatchObject({ added: 1, created: true });
    expect(await chargeCount()).toBe(1);                              // uma única cobrança por contrato+competência
    expect((await getBatch(db, asstA, A, first.batchId))!.charges).toHaveLength(0);
    await approveBatch(db, ger2A, A, second.batchId, (await getBatch(db, ger2A, A, second.batchId))!.hash);
    await change(c1, terms({ dueDay: "14" }));                        // volta ao dia 1, mas já está num lote APROVADO
    await expect(generateBatch(db, asstA, A, D)).rejects.toThrow(/já estão em lotes aprovados/);
    expect(await chargeCount()).toBe(1);
  });

  it("P2 Codex: avisos fazem parte do conteúdo aprovado (feriado no vencimento invalida hash e atualidade)", async () => {
    await active(cli1);
    const { batchId } = await generateBatch(db, asstA, A, D);
    const before = (await getBatch(db, asstA, A, batchId))!;
    await addHoliday(db, gerA, A, { day: "2026-10-14", name: "Feriado no vencimento" }); // quarta; só aviso, a emissão (01/10) segue válida
    const mid = (await getBatch(db, asstA, A, batchId))!;
    expect(mid.stale).toMatchObject({ changed: 1, any: true });
    await expect(approveBatch(db, ger2A, A, batchId, before.hash)).rejects.toThrow(/contratos mudaram/);
    await generateBatch(db, asstA, A, D);
    const after = (await getBatch(db, asstA, A, batchId))!;
    expect(after.stale.any).toBe(false); expect(after.hash).not.toBe(before.hash);
    expect(after.charges[0].warnings).toContain("vencimento_feriado");
  });

  it("P1 Codex: mudança concorrente de contrato ou feriado NÃO passa despercebida pela aprovação (esperam o commit)", async () => {
    const c1 = await active(cli1);
    const { batchId } = await generateBatch(db, asstA, A, D);
    const hash = (await getBatch(db, asstA, A, batchId))!.hash;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let release!: () => void; const hold = new Promise<void>((r) => { release = r; });
    // transação concorrente altera o valor do contrato e só confirma depois
    const writer = conn.begin(async (q) => { await q`update contracts set monthly_amount = 9999.00 where id = ${c1}`; await hold; });
    await sleep(150);
    let settled = false;
    const p = approveBatch(db, ger2A, A, batchId, hash); p.then(() => { settled = true; }, () => { settled = true; });
    await sleep(500);
    expect(settled).toBe(false);          // a aprovação espera a alteração concorrente terminar
    release(); await writer;
    await expect(p).rejects.toThrow(/contratos mudaram/);
    expect((await getBatch(db, dirA, A, batchId))!.batch.status).toBe("rascunho");
    // idem para feriado inserido concorrentemente na data de emissão
    await generateBatch(db, asstA, A, D);
    const h2 = (await getBatch(db, asstA, A, batchId))!.hash;
    let release2!: () => void; const hold2 = new Promise<void>((r) => { release2 = r; });
    const writer2 = conn.begin(async (q) => { await q`insert into holidays (company_id, day, name) values (${A}, ${D}, 'Concorrente')`; await hold2; });
    await sleep(150);
    let settled2 = false;
    const p2 = approveBatch(db, ger2A, A, batchId, h2); p2.then(() => { settled2 = true; }, () => { settled2 = true; });
    await sleep(500);
    expect(settled2).toBe(false);
    release2(); await writer2;
    await expect(p2).rejects.toThrow(/contratos mudaram/);
    expect((await getBatch(db, dirA, A, batchId))!.batch.status).toBe("rascunho");
  });

  it("cancelar: só prévia; libera a data para nova prévia", async () => {
    await active(cli1);
    const { batchId } = await generateBatch(db, asstA, A, D);
    await cancelBatch(db, asstA, A, batchId);
    expect(await chargeCount()).toBe(0); expect(await listBatches(db, asstA, A)).toHaveLength(0);
    const again = await generateBatch(db, asstA, A, D);
    expect(again.batchId).not.toBe(batchId);
    await approveBatch(db, gerA, A, again.batchId, (await getBatch(db, gerA, A, again.batchId))!.hash);
    await expect(cancelBatch(db, asstA, A, again.batchId)).rejects.toThrow(/prévia/);
  });

  it("isolamento: outra empresa não vê, aprova, reabre nem cancela; mesma data em duas empresas gera lotes independentes", async () => {
    await active(cli1);
    await active(cliB, terms(), B, dirB, dirB);
    const a = await generateBatch(db, asstA, A, D);
    const b = await generateBatch(db, dirB, B, D);
    expect(a.batchId).not.toBe(b.batchId);
    expect(await getBatch(db, dirB, B, a.batchId)).toBeNull();
    expect((await listBatches(db, dirB, B)).map((x) => x.id)).toEqual([b.batchId]);
    const h = (await getBatch(db, dirA, A, a.batchId))!.hash;
    await expect(approveBatch(db, dirB, B, a.batchId, h)).rejects.toThrow(/não encontrado/);
    await expect(cancelBatch(db, dirB, B, a.batchId)).rejects.toThrow(/prévia/);
    await expect(generateBatch(db, dirA, B, D)).rejects.toBeInstanceOf(Forbidden);      // dirA não é membro de B
    await approveBatch(db, dirA, A, a.batchId, h);
    await expect(reopenBatch(db, dirB, B, a.batchId, "tentativa indevida")).rejects.toThrow(/aprovado/);
    expect((await getBatch(db, dirA, A, a.batchId))!.batch.status).toBe("aprovado");
    expect((await getBatch(db, dirB, B, b.batchId))!.batch.status).toBe("rascunho");
  });

  it("banco: uma cobrança por contrato+competência, aprovação coerente, valor positivo e FK composta por empresa", async () => {
    const c1 = await active(cli1);
    const { batchId } = await generateBatch(db, asstA, A, D);
    const ins = (company: string, batch: string, contract: string, customer: string, amount = "10.00", comp = "2026-09-01") => db.execute(sql`insert into charges (company_id, batch_id, contract_id, customer_id, competence_month, due_date, issue_date, description, amount, base_amount) values (${company}, ${batch}, ${contract}, ${customer}, ${comp}, '2026-10-14', ${D}, 'x', ${amount}, ${amount})`);
    await expect(ins(A, batchId, c1, cli1)).rejects.toThrow();                       // duplicada
    await expect(ins(A, batchId, c1, cli1, "10.00", "2026-08-01")).resolves.toBeDefined();
    await expect(ins(A, batchId, c1, cli1, "0", "2026-07-01")).rejects.toThrow();     // valor > 0
    await expect(ins(A, batchId, c1, cli1, "10.00", "2026-06-15")).rejects.toThrow(); // competência é o dia 1
    await expect(ins(B, batchId, c1, cli1, "10.00", "2026-05-01")).rejects.toThrow();  // lote/contrato de outra empresa (FK composta)
    await expect(db.execute(sql`update billing_batches set status = 'aprovado' where id = ${batchId}`)).rejects.toThrow(); // aprovado sem aprovador
  });
});
