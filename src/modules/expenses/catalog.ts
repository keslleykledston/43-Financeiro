import { and, asc, eq, sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { auditLog, costCenters, expenseCategories, partners } from "@/lib/db/schema";
import { Invalid, activeRole, requirePerm, Forbidden } from "@/modules/identity/service";
import { can, type Permission } from "@/modules/identity/permissions";

/**
 * D1 — cadastros das despesas: categorias (despesa da empresa e gasto pessoal dos sócios), centros de custo e sócios.
 * Ler: quem pode ler contas a pagar ou a conta-corrente dos sócios. Alterar categorias/centros: `payables.manage`; sócios: `partners.manage` (diretoria).
 * As categorias padrão nascem sozinhas na primeira leitura de cada empresa (código estável; o nome pode ser editado).
 */
const audit = (x: DB, companyId: string, actorId: string, action: string, detail: Record<string, unknown>) => x.insert(auditLog).values({ companyId, actorId, action, detail });

type Def = [code: string, name: string, grp: string, kind: "empresa" | "pessoal"];
export const DEFAULT_CATEGORIES: Def[] = [
  ["salarios", "Salários", "Folha e pessoal", "empresa"], ["vt_va", "VT e VA", "Folha e pessoal", "empresa"], ["ferias_13", "Férias e 13º", "Folha e pessoal", "empresa"],
  ["rescisoes", "Rescisões", "Folha e pessoal", "empresa"], ["fgts", "FGTS", "Folha e pessoal", "empresa"], ["inss_irrf", "INSS e IRRF (DARF)", "Folha e pessoal", "empresa"],
  ["beneficios", "Benefícios e uniformes", "Folha e pessoal", "empresa"],
  ["simples", "Simples Nacional", "Impostos e taxas", "empresa"], ["iptu_taxas", "IPTU, alvarás e taxas", "Impostos e taxas", "empresa"],
  ["telecom", "Telecom e internet", "Operação", "empresa"], ["software", "Software e licenças", "Operação", "empresa"], ["energia", "Energia", "Operação", "empresa"],
  ["agua", "Água", "Operação", "empresa"], ["aluguel", "Aluguel e locações", "Operação", "empresa"], ["veiculos", "Veículos e rastreamento", "Operação", "empresa"],
  ["marketing", "Marketing e brindes", "Operação", "empresa"], ["terceiros", "Serviços de terceiros", "Operação", "empresa"],
  ["contabilidade", "Contabilidade", "Serviços", "empresa"], ["comissoes", "Comissões de parceiros", "Serviços", "empresa"],
  ["emprestimos", "Empréstimos e financiamentos", "Financeiro", "empresa"], ["consorcio", "Consórcio", "Financeiro", "empresa"], ["tarifas_juros", "Tarifas e juros", "Financeiro", "empresa"],
  ["cartao_pj", "Fatura de cartão da empresa", "Financeiro", "empresa"],
  ["outras_empresa", "Outras despesas", "Outros", "empresa"], ["a_classificar", "A classificar", "Outros", "empresa"],
  ["moradia", "Moradia e contas da casa", "Pessoal dos sócios", "pessoal"], ["cartao_pf", "Fatura de cartão pessoal", "Pessoal dos sócios", "pessoal"],
  ["veiculos_pessoais", "Veículos pessoais", "Pessoal dos sócios", "pessoal"], ["educacao", "Educação", "Pessoal dos sócios", "pessoal"], ["saude", "Saúde", "Pessoal dos sócios", "pessoal"],
  ["presentes", "Presentes e compras", "Pessoal dos sócios", "pessoal"], ["dizimos", "Dízimos e ofertas", "Pessoal dos sócios", "pessoal"], ["lazer", "Lazer e outros", "Pessoal dos sócios", "pessoal"],
  ["a_classificar_pessoal", "A classificar (pessoal)", "Pessoal dos sócios", "pessoal"],
];

export async function ensureExpenseDefaults(x: DB, companyId: string) {
  const has = async (d: DB) => ({
    cat: (await d.select({ id: expenseCategories.id }).from(expenseCategories).where(eq(expenseCategories.companyId, companyId)).limit(1)).length > 0,
    center: (await d.select({ id: costCenters.id }).from(costCenters).where(eq(costCenters.companyId, companyId)).limit(1)).length > 0,
  });
  const h = await has(x);
  if (h.cat && h.center) return;
  // primeira leitura da empresa: serializa para duas requisições simultâneas não se atropelarem; confere de novo depois do lock
  await x.transaction(async (tx) => {
    const t = tx as unknown as DB;
    await t.execute(sql`select pg_advisory_xact_lock(hashtext(${"expense-defaults:" + companyId}))`);
    const again = await has(t);
    if (!again.cat) await t.insert(expenseCategories).values(DEFAULT_CATEGORIES.map(([code, name, grp, kind], i) => ({ companyId, code, name, grp, kind, sort: (i + 1) * 10 }))).onConflictDoNothing();
    if (!again.center) await t.insert(costCenters).values({ companyId, code: "operacao", name: "Operação" }).onConflictDoNothing();
  });
}

async function requireAny(db: DB, actorId: string, companyId: string, perms: Permission[]) {
  const role = await activeRole(db, actorId, companyId);
  if (!role || !perms.some((p) => can(role, p))) throw new Forbidden();
}

const clean = (s: unknown, max: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const slug = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 36);
const uuidOk = (s: string) => /^[0-9a-f-]{36}$/i.test(s ?? "");

export type Category = { id: string; code: string; name: string; grp: string; kind: "empresa" | "pessoal"; active: boolean };
export async function listCategories(db: DB, actorId: string, companyId: string, o: { kind?: "empresa" | "pessoal"; all?: boolean } = {}): Promise<Category[]> {
  await requireAny(db, actorId, companyId, ["payables.read", "partners.read"]);
  await ensureExpenseDefaults(db, companyId);
  const w = [eq(expenseCategories.companyId, companyId)];
  if (o.kind) w.push(eq(expenseCategories.kind, o.kind));
  if (!o.all) w.push(eq(expenseCategories.active, true));
  const r = await db.select().from(expenseCategories).where(and(...w)).orderBy(asc(expenseCategories.sort), asc(expenseCategories.name));
  return r.map((c) => ({ id: c.id, code: c.code, name: c.name, grp: c.grp, kind: c.kind as "empresa" | "pessoal", active: c.active }));
}

export async function saveCategory(db: DB, actorId: string, companyId: string, i: { id?: string; name: string; grp?: string; kind?: string }) {
  await requirePerm(db, actorId, companyId, "payables.manage");
  const name = clean(i.name, 60);
  if (name.length < 2) throw new Invalid("Informe o nome da categoria (2 a 60 caracteres)");
  return db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await ensureExpenseDefaults(x, companyId);
    if (i.id) {
      if (!uuidOk(i.id)) throw new Invalid("Categoria não encontrada");
      const grp = clean(i.grp, 40);
      const r = await x.update(expenseCategories).set({ name, ...(grp.length >= 2 ? { grp } : {}), updatedAt: new Date() }).where(and(eq(expenseCategories.id, i.id), eq(expenseCategories.companyId, companyId))).returning({ id: expenseCategories.id });
      if (!r.length) throw new Invalid("Categoria não encontrada");
      await audit(x, companyId, actorId, "expense.category_saved", { categoryId: i.id, created: false });
      return i.id;
    }
    const kind = i.kind === "pessoal" ? "pessoal" : "empresa";
    const grp = clean(i.grp, 40) || (kind === "pessoal" ? "Pessoal dos sócios" : "Outros");
    if (grp.length < 2) throw new Invalid("Informe o grupo");
    const base = slug(name) || "categoria";
    for (let n = 1; n < 50; n++) {
      const code = n === 1 ? base : `${base}_${n}`.slice(0, 40);
      const [c] = await x.insert(expenseCategories).values({ companyId, code, name, grp, kind, sort: 500 }).onConflictDoNothing().returning({ id: expenseCategories.id });
      if (c) { await audit(x, companyId, actorId, "expense.category_saved", { categoryId: c.id, created: true }); return c.id; }
    }
    throw new Invalid("Já existe uma categoria muito parecida");
  });
}

export async function setCategoryActive(db: DB, actorId: string, companyId: string, id: string, active: boolean) {
  await requirePerm(db, actorId, companyId, "payables.manage");
  if (!uuidOk(id)) throw new Invalid("Categoria não encontrada");
  const [c] = await db.select().from(expenseCategories).where(and(eq(expenseCategories.id, id), eq(expenseCategories.companyId, companyId)));
  if (!c) throw new Invalid("Categoria não encontrada");
  if (!active && (c.code === "a_classificar" || c.code === "a_classificar_pessoal")) throw new Invalid("A categoria 'A classificar' não pode ser desativada: é onde o que ainda não foi classificado aparece");
  await db.transaction(async (tx) => {
    await tx.update(expenseCategories).set({ active, updatedAt: new Date() }).where(eq(expenseCategories.id, id));
    await audit(tx as unknown as DB, companyId, actorId, "expense.category_active", { categoryId: id, active });
  });
}

export type CostCenter = { id: string; code: string; name: string; active: boolean };
export async function listCostCenters(db: DB, actorId: string, companyId: string, o: { all?: boolean } = {}): Promise<CostCenter[]> {
  await requireAny(db, actorId, companyId, ["payables.read", "partners.read"]);
  await ensureExpenseDefaults(db, companyId);
  const w = [eq(costCenters.companyId, companyId)];
  if (!o.all) w.push(eq(costCenters.active, true));
  return db.select({ id: costCenters.id, code: costCenters.code, name: costCenters.name, active: costCenters.active }).from(costCenters).where(and(...w)).orderBy(asc(costCenters.name));
}

export async function saveCostCenter(db: DB, actorId: string, companyId: string, i: { id?: string; name: string }) {
  await requirePerm(db, actorId, companyId, "payables.manage");
  const name = clean(i.name, 60);
  if (name.length < 2) throw new Invalid("Informe o nome do centro de custo (2 a 60 caracteres)");
  return db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await ensureExpenseDefaults(x, companyId);
    if (i.id) {
      if (!uuidOk(i.id)) throw new Invalid("Centro de custo não encontrado");
      const r = await x.update(costCenters).set({ name, updatedAt: new Date() }).where(and(eq(costCenters.id, i.id), eq(costCenters.companyId, companyId))).returning({ id: costCenters.id });
      if (!r.length) throw new Invalid("Centro de custo não encontrado");
      await audit(x, companyId, actorId, "expense.cost_center_saved", { costCenterId: i.id, created: false });
      return i.id;
    }
    const base = slug(name) || "centro";
    for (let n = 1; n < 50; n++) {
      const code = n === 1 ? base : `${base}_${n}`.slice(0, 40);
      const [c] = await x.insert(costCenters).values({ companyId, code, name }).onConflictDoNothing().returning({ id: costCenters.id });
      if (c) { await audit(x, companyId, actorId, "expense.cost_center_saved", { costCenterId: c.id, created: true }); return c.id; }
    }
    throw new Invalid("Já existe um centro de custo muito parecido");
  });
}

export async function setCostCenterActive(db: DB, actorId: string, companyId: string, id: string, active: boolean) {
  await requirePerm(db, actorId, companyId, "payables.manage");
  if (!uuidOk(id)) throw new Invalid("Centro de custo não encontrado");
  const [c] = await db.select().from(costCenters).where(and(eq(costCenters.id, id), eq(costCenters.companyId, companyId)));
  if (!c) throw new Invalid("Centro de custo não encontrado");
  if (!active && c.code === "operacao") throw new Invalid("O centro 'Operação' é o padrão e não pode ser desativado");
  await db.transaction(async (tx) => {
    await tx.update(costCenters).set({ active, updatedAt: new Date() }).where(eq(costCenters.id, id));
    await audit(tx as unknown as DB, companyId, actorId, "expense.cost_center_active", { costCenterId: id, active });
  });
}

export type Partner = { id: string; name: string; active: boolean };
export async function listPartners(db: DB, actorId: string, companyId: string, o: { all?: boolean } = {}): Promise<Partner[]> {
  await requirePerm(db, actorId, companyId, "partners.read");
  const w = [eq(partners.companyId, companyId)];
  if (!o.all) w.push(eq(partners.active, true));
  return db.select({ id: partners.id, name: partners.name, active: partners.active }).from(partners).where(and(...w)).orderBy(asc(partners.name));
}

export async function savePartner(db: DB, actorId: string, companyId: string, i: { id?: string; name: string }) {
  await requirePerm(db, actorId, companyId, "partners.manage");
  const name = clean(i.name, 80);
  if (name.length < 2) throw new Invalid("Informe o nome do sócio (2 a 80 caracteres)");
  try {
    return await db.transaction(async (tx) => {
      const x = tx as unknown as DB;
      if (i.id) {
        if (!uuidOk(i.id)) throw new Invalid("Sócio não encontrado");
        const r = await x.update(partners).set({ name, updatedAt: new Date() }).where(and(eq(partners.id, i.id), eq(partners.companyId, companyId))).returning({ id: partners.id });
        if (!r.length) throw new Invalid("Sócio não encontrado");
        await audit(x, companyId, actorId, "partner.saved", { partnerId: i.id, created: false });
        return i.id;
      }
      const [p] = await x.insert(partners).values({ companyId, name }).returning({ id: partners.id });
      await audit(x, companyId, actorId, "partner.saved", { partnerId: p.id, created: true });
      return p.id;
    });
  } catch (e) {
    if ((e as { cause?: { code?: string } }).cause?.code === "23505") throw new Invalid("Já existe um sócio com este nome");
    throw e;
  }
}

export async function setPartnerActive(db: DB, actorId: string, companyId: string, id: string, active: boolean) {
  await requirePerm(db, actorId, companyId, "partners.manage");
  if (!uuidOk(id)) throw new Invalid("Sócio não encontrado");
  await db.transaction(async (tx) => {
    const r = await tx.update(partners).set({ active, updatedAt: new Date() }).where(and(eq(partners.id, id), eq(partners.companyId, companyId))).returning({ id: partners.id });
    if (!r.length) throw new Invalid("Sócio não encontrado");
    await audit(tx as unknown as DB, companyId, actorId, "partner.active", { partnerId: id, active });
  });
}
