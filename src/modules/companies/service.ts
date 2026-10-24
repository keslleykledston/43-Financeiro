import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "@/lib/db";
import { auditLog, companies } from "@/lib/db/schema";
import { parseDocument, formatDocument } from "@/lib/validators/document";
import { Invalid, requirePerm } from "@/modules/identity/service";

/** Dados cadastrais da própria empresa (E21). Só a diretoria edita; cada alteração é auditada (só os NOMES dos campos, nunca os valores). */
const opt = (max: number, msg: string) => z.preprocess((v) => (v === undefined || (typeof v === "string" && v.trim() === "") ? null : v), z.string().trim().max(max, msg).nullable());
export const companyProfileSchema = z.object({
  name: z.string().trim().min(2, "Informe o nome da empresa").max(120, "Nome muito longo (máximo 120)"),
  legalName: opt(200, "Razão social muito longa (máximo 200)"),
  cnpj: opt(30, "CNPJ inválido"),
  financeEmail: opt(200, "E-mail muito longo").refine((v) => v === null || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "E-mail financeiro inválido"),
});

export const FIELD_LABEL = { name: "nome", legalName: "razão social", cnpj: "CNPJ", financeEmail: "e-mail financeiro" } as const;
const pgCode = (e: unknown) => (e as { code?: string })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;

export async function getCompanyProfile(db: DB, actorId: string, companyId: string) {
  await requirePerm(db, actorId, companyId, "company.manage");
  const [c] = await db.select().from(companies).where(eq(companies.id, companyId));
  if (!c) throw new Invalid("Empresa não encontrada");
  return { name: c.name, legalName: c.legalName, cnpj: c.cnpj, cnpjFormatted: c.cnpj && /^[0-9A-Z]{14}$/i.test(c.cnpj) ? formatDocument("cnpj", c.cnpj.toUpperCase()) : c.cnpj, financeEmail: c.financeEmail };
}

export async function updateCompanyProfile(db: DB, actorId: string, companyId: string, input: unknown) {
  await requirePerm(db, actorId, companyId, "company.manage");
  const p = companyProfileSchema.safeParse(input);
  if (!p.success) throw new Invalid(p.error.issues[0]?.message ?? "Dados inválidos");
  let cnpj: string | null = null;
  if (p.data.cnpj) {
    const d = parseDocument(p.data.cnpj);
    if (!d || d.type !== "cnpj") throw new Invalid("CNPJ inválido (confira os dígitos)");
    cnpj = d.digits;
  }
  try {
    return await db.transaction(async (tx) => {
      const x = tx as unknown as DB;
      const [cur] = await x.select().from(companies).where(eq(companies.id, companyId)).for("update");
      if (!cur) throw new Invalid("Empresa não encontrada");
      const next = { name: p.data.name, legalName: p.data.legalName, cnpj, financeEmail: p.data.financeEmail }; // o endereço da empresa fica na seção "Endereço" (company_fiscal)
      const changed = (Object.keys(next) as (keyof typeof next)[]).filter((k) => (cur[k] ?? null) !== next[k]);
      if (changed.length === 0) return { changed: [] as string[] };
      await x.update(companies).set({ ...next, updatedAt: new Date() }).where(and(eq(companies.id, companyId)));
      await x.insert(auditLog).values({ companyId, actorId, action: "company.updated", detail: { changed: changed.map((k) => FIELD_LABEL[k]).join(", ") } });
      return { changed: changed.map((k) => FIELD_LABEL[k]) };
    });
  } catch (e) {
    if (pgCode(e) === "23505") throw new Invalid("Este CNPJ já está cadastrado em outra empresa");
    if (pgCode(e) === "23514") throw new Invalid("Algum campo passou do tamanho permitido");
    throw e;
  }
}
