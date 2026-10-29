// Operação auditada: preenche os contatos FINANCEIROS (e-mail e telefone para cobrança/WhatsApp) dos clientes ATIVOS a partir da planilha de boletos (colunas «E-MAIL» e «CONTATO FIN.»).
// Regras em src/modules/crm/contact-fill.ts (idempotente; só origem «csv»; contato do CRM nunca é tocado; nada de dado pessoal no log: só contagens).
// Sem OPS_CONFIRM=1 só SIMULA. Pendências (sem correspondência, telefone malformado, sem DDD) vão para arquivo privado (0600), nunca para o log.
// Uso: OPS_XLSX=/in/Boletos__2026.xlsx OPS_USER_EMAIL=... [OPS_PENDING=/out/pendencias.csv] [OPS_CONFIRM=1] docker compose --profile tools run --rm -e ... -v /home/suporte/planilha-privada:/in:ro -v ...:/out tools pnpm tsx scripts/ops-fill-contacts.ts
import { loadEnvConfig } from "@next/env";
import { chmodSync, writeFileSync } from "node:fs";
loadEnvConfig(process.cwd());

const COMPANIES = [{ name: "K3G Solutions", block: "solutions" }, { name: "K3G Call", block: "call" }] as const;
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();

(async () => {
  const xlsx = process.env.OPS_XLSX, email = process.env.OPS_USER_EMAIL;
  if (!xlsx || !email) throw new Error("Defina OPS_XLSX e OPS_USER_EMAIL");
  const { default: readXlsxFile } = await import("read-excel-file/node");
  const { db } = await import("../src/lib/db");
  const { auditLog, companies, customerContacts, customers, users } = await import("../src/lib/db/schema");
  const { and, eq, sql } = await import("drizzle-orm");
  const { readWorkbook } = await import("../src/modules/contracts/planilha");
  const { planContacts, wantedFromEntries } = await import("../src/modules/crm/contact-fill");
  const { toCsv } = await import("../src/lib/csv");

  const [u] = await db.select().from(users).where(eq(sql`lower(${users.email})`, email.toLowerCase()));
  if (!u) throw new Error("Usuário não encontrado");
  const raw = await readXlsxFile(xlsx);
  const entries = readWorkbook(raw.map((s) => ({ name: s.sheet, rows: s.data })), 2026);
  const pendings: string[][] = [["empresa", "cliente", "documento", "motivo"]];
  const confirm = process.env.OPS_CONFIRM === "1";

  for (const co of COMPANIES) {
    const [c] = await db.select().from(companies).where(eq(companies.name, co.name));
    if (!c) { console.log(`${co.name}: empresa não encontrada`); continue; }
    const wanted = wantedFromEntries(entries.filter((e) => e.block === co.block));
    const custs = await db.select({ id: customers.id, legal: customers.legalName, trade: customers.tradeName, display: customers.displayName, doc: customers.document, status: customers.status }).from(customers).where(eq(customers.companyId, c.id));
    const contacts = await db.select().from(customerContacts).where(eq(customerContacts.companyId, c.id));
    const byDoc = new Map(custs.filter((x) => x.doc).map((x) => [x.doc as string, x]));
    const byName = new Map<string, typeof custs>();
    for (const x of custs) for (const n of [x.legal, x.trade, x.display]) if (n) { const k = fold(n); (byName.get(k) ?? byName.set(k, []).get(k)!).push(x); }

    const st = { planilha: wanted.length, ativos_no_sistema: custs.filter((x) => x.status === "ativo").length, casou_documento: 0, casou_nome: 0, sem_correspondencia: 0, ignorado_inativo: 0, sem_dado_novo: 0,
      clientes_alterados: 0, contatos_novos: 0, contatos_atualizados: 0, emails_novos: 0, telefones_celular: 0, telefones_fixo: 0, telefone_pendente: 0, sem_email_na_planilha: 0 };
    const tx: { inserts: { customerId: string; name: string; email: string | null; phone: string | null }[]; updates: { id: string; name?: string; phone?: string }[] } = { inserts: [], updates: [] };
    const touched = new Set<string>();

    for (const w of wanted) {
      let cust = w.document ? byDoc.get(w.document) : undefined;
      if (cust) st.casou_documento++;
      else {
        const m = [...new Set((byName.get(fold(w.name)) ?? []).map((x) => x.id))];
        if (m.length === 1) { cust = custs.find((x) => x.id === m[0]); st.casou_nome++; }
      }
      if (!cust) { st.sem_correspondencia++; pendings.push([co.name, w.name, w.document ?? "", "sem correspondência no cadastro (documento/nome)"]); continue; }
      if (cust.status !== "ativo") { st.ignorado_inativo++; continue; }
      if (w.emails.length === 0) st.sem_email_na_planilha++;
      if (w.issue && w.issue !== "sem_telefone") { st.telefone_pendente++; pendings.push([co.name, w.name, w.document ?? "", `telefone: ${w.issue}`]); }
      if (w.phone) { if (w.phone.mobile) st.telefones_celular++; else st.telefones_fixo++; }
      const acts = planContacts(contacts.filter((x) => x.partyId === cust!.id).map((x) => ({ id: x.id, name: x.name, email: x.email, phone: x.phone, isFinancial: x.isFinancial, source: x.source })), w);
      if (acts.length === 0) { st.sem_dado_novo++; continue; }
      touched.add(cust.id);
      for (const a of acts) {
        if (a.kind === "insert") { tx.inserts.push({ customerId: cust.id, name: a.name, email: a.email, phone: a.phone }); st.contatos_novos++; if (a.email) st.emails_novos++; }
        else { tx.updates.push({ id: a.id, name: a.name, phone: a.phone }); st.contatos_atualizados++; }
      }
    }
    st.clientes_alterados = touched.size;
    console.log(`${co.name}: ${JSON.stringify(st)}`);

    if (confirm && (tx.inserts.length || tx.updates.length)) {
      await db.transaction(async (t) => {
        for (const i of tx.inserts) await t.insert(customerContacts).values({ companyId: c.id, partyId: i.customerId, name: i.name.slice(0, 120), email: i.email, phone: i.phone, isFinancial: true, source: "csv" });
        for (const up of tx.updates) await t.update(customerContacts).set({ ...(up.name ? { name: up.name.slice(0, 120) } : {}), ...(up.phone ? { phone: up.phone } : {}), updatedAt: new Date() }).where(and(eq(customerContacts.id, up.id), eq(customerContacts.companyId, c.id), eq(customerContacts.source, "csv")));
        await t.insert(auditLog).values({ companyId: c.id, actorId: u.id, action: "ops.contacts_filled_from_planilha", detail: { customers: touched.size, inserted: tx.inserts.length, updated: tx.updates.length } });
      });
      console.log(`${co.name}: GRAVADO (${tx.inserts.length} contatos novos, ${tx.updates.length} atualizados)`);
    }
  }
  if (process.env.OPS_PENDING) { writeFileSync(process.env.OPS_PENDING, toCsv(pendings), { mode: 0o600 }); chmodSync(process.env.OPS_PENDING, 0o600); console.log(`pendências em arquivo privado: ${pendings.length - 1}`); }
  if (!confirm) console.log("(SIMULAÇÃO: nada foi gravado; use OPS_CONFIRM=1)");
  process.exit(0);
})().catch((e) => { console.error("falha:", (e as Error).name, (e as Error).message); process.exit(1); });
