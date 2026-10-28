// E10b-1 — prepara uma EMPRESA FICTÍCIA ("K3G TESTE (fictícia)") com clientes/contratos FICTÍCIOS e um lote em PRÉVIA, para testar a emissão na Cora de TESTES pela tela.
// Não toca nos dados das empresas reais (cada empresa é isolada). Copia a credencial de HOMOLOGAÇÃO (re-cifrada para a nova empresa); nunca a de produção.
// Sem e-mail, telefone ou dado real nos clientes. Emissão nasce PAUSADA, provedor "Cora — testes". A diretoria aprova o lote e libera a emissão pela tela.
// Retomável: rodar de novo completa o que faltar, sem duplicar.
// Uso: docker compose --profile tools run --rm tools pnpm tsx scripts/ops-cora-demo-company.ts
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

const NAME = "K3G TESTE (fictícia)";
const BATCH_DAY = "2026-10-25"; // lote do dia 25 → vencimentos 1–12 do mês seguinte (dueDay 12 → 12/11/2026)
const cnpjDv = (base: string) => { // dígitos verificadores do CNPJ (aceita letras: valor = código ASCII − 48)
  const dv = (s: string) => { const w = s.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]; const t = [...s].reduce((a, c, i) => a + (c.charCodeAt(0) - 48) * w[i], 0) % 11; return t < 2 ? 0 : 11 - t; };
  const d1 = dv(base); return `${base}${d1}${dv(base + d1)}`;
};
const CLIENTS = [
  { legalName: "TESTE CORA CLIENTE UM LTDA", document: cnpjDv("112223330001"), amount: "50,00" },
  { legalName: "TESTE CORA CLIENTE DOIS LTDA", document: cnpjDv("12ABC34501DE"), amount: "73,45" }, // CNPJ alfanumérico (padrão novo)
  { legalName: "TESTE CORA CLIENTE TRES LTDA", document: cnpjDv("445566770001"), amount: "120,00" },
];

(async () => {
  const { db } = await import("../src/lib/db");
  const { and, eq, sql } = await import("drizzle-orm");
  const s = await import("../src/lib/db/schema");
  const { readCoraCredentials } = await import("../src/modules/providers/cora-secrets");
  const { saveCoraCredentials } = await import("../src/modules/providers/cora-config");
  const { createParty } = await import("../src/modules/crm/service");
  const { createContract, decideVersion, getContract } = await import("../src/modules/contracts/service");
  const { generateBatch } = await import("../src/modules/billing/batches");
  const { saveIssuanceSettings } = await import("../src/modules/issuance/service");
  const { parseDocument } = await import("../src/lib/validators/document");

  for (const c of CLIENTS) if (!parseDocument(c.document)) throw new Error(`documento fictício inválido: ${c.document}`);

  // empresa de origem da credencial de testes + diretoria dela
  const src = (await db.execute(sql`select company_id as id from provider_credentials where provider = 'cora' and environment = 'homologacao' and company_id <> coalesce((select id from companies where name = ${NAME}), '00000000-0000-0000-0000-000000000000') limit 1`)) as unknown as { id: string }[];
  if (!src.length) throw new Error("Sem credencial Cora de homologação em outra empresa");
  const dirs = await db.select({ userId: s.memberships.userId }).from(s.memberships).where(and(eq(s.memberships.companyId, src[0].id), eq(s.memberships.role, "diretoria"), eq(s.memberships.status, "active")));
  if (!dirs.length) throw new Error("A empresa de origem não tem diretoria ativa");
  const actor = dirs[0].userId;

  let [co] = await db.select().from(s.companies).where(eq(s.companies.name, NAME));
  if (!co) { [co] = await db.insert(s.companies).values({ name: NAME }).returning(); console.log("1) empresa criada"); } else console.log("1) empresa já existe");
  for (const d of dirs) await db.insert(s.memberships).values({ userId: d.userId, companyId: co.id, role: "diretoria" }).onConflictDoNothing();

  // usuário técnico (sem senha utilizável) que "prepara" contratos e lote, para a diretoria poder aprovar (duas pessoas)
  let [prep] = await db.select().from(s.users).where(eq(s.users.email, "preparo@teste.invalid"));
  if (!prep) [prep] = await db.insert(s.users).values({ email: "preparo@teste.invalid", name: "Preparo (teste)", passwordHash: "x" }).returning();
  await db.insert(s.memberships).values({ userId: prep.id, companyId: co.id, role: "assistente" }).onConflictDoNothing();

  const hasCred = (await db.select({ id: s.providerCredentials.id }).from(s.providerCredentials).where(and(eq(s.providerCredentials.companyId, co.id), eq(s.providerCredentials.provider, "cora"), eq(s.providerCredentials.environment, "homologacao")))).length > 0;
  if (!hasCred) {
    const creds = (await readCoraCredentials(db, src[0].id, "homologacao"))!;
    await saveCoraCredentials(db, actor, co.id, { environment: "homologacao", label: "Cora testes (cópia)", clientId: creds.clientId, certificate: creds.certificate, privateKey: creds.privateKey });
    console.log("2) credencial de testes copiada (cifrada para a nova empresa)");
  } else console.log("2) credencial já existe");

  for (const c of CLIENTS) {
    const exists = await db.select({ id: s.customers.id }).from(s.customers).where(and(eq(s.customers.companyId, co.id), eq(s.customers.legalName, c.legalName)));
    if (exists.length) { console.log(`3) cliente já existe: ${c.legalName}`); continue; }
    const p = await createParty(db, prep.id, co.id, { kind: "cliente", legalName: c.legalName, document: c.document });
    const k = await createContract(db, prep.id, co.id, p.id, { description: "Teste Cora homologação", monthlyAmount: c.amount, startAt: "2026-01-01", endAt: "", dueDay: "12", invoiceJointRequired: false, issueDayOverride: "" });
    await decideVersion(db, actor, co.id, (await getContract(db, actor, co.id, k.id))!.versions[0].id, "aprovar");
    console.log(`3) cliente + contrato aprovado: ${c.legalName} R$ ${c.amount}`);
  }

  await saveIssuanceSettings(db, actor, co.id, { paused: true, dailyLimit: 20, boletoProvider: "cora_homologacao" });
  console.log("4) emissão PAUSADA, provedor Cora — testes");

  const batches = await db.select({ id: s.billingBatches.id }).from(s.billingBatches).where(eq(s.billingBatches.companyId, co.id));
  if (batches.length) console.log("5) já existe lote; nada gerado");
  else { const { batchId } = await generateBatch(db, prep.id, co.id, BATCH_DAY); console.log(`5) lote em PRÉVIA gerado: ${batchId}`); }
  console.log("\nPRONTO. Na tela: trocar para a empresa " + NAME + " → Faturamento → Lotes → aprovar → Emissões.");
  process.exit(0);
})().catch((e) => { console.error("falha:", (e as Error).name, (e as Error).message); process.exit(1); });
