import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "@/lib/db";
import { auditLog, customers } from "@/lib/db/schema";
import { Invalid, requirePerm } from "@/modules/identity/service";
import { validateTemplate } from "@/modules/messaging/templates";

/**
 * E26 — ajustes do CLIENTE que ficam só aqui (o CRM não os tem e a sincronização não os toca): endereço (tomador da NFS-e) e os textos da nota fiscal e do boleto.
 * Quem escreve: `crm.write`, inclusive em cliente vindo do CRM (identificação — razão social, CNPJ, situação — continua somente leitura nesse caso).
 * Atualização PARCIAL: só as chaves enviadas mudam (o formulário de endereço e o de textos são separados).
 */
export const ADDRESS_KEYS = ["cep", "street", "streetNumber", "complement", "district", "cityName", "cityIbge", "uf"] as const;
export const TEXT_KEYS = ["nfText", "boletoText"] as const;
export type ExtraKey = (typeof ADDRESS_KEYS)[number] | (typeof TEXT_KEYS)[number];
export const EXTRA_LABEL: Record<ExtraKey, string> = { cep: "CEP", street: "logradouro", streetNumber: "número", complement: "complemento", district: "bairro", cityName: "município", cityIbge: "código IBGE", uf: "UF", nfText: "texto da nota fiscal", boletoText: "texto do boleto" };
export const NF_TEXT_MAX = 1000, BOLETO_TEXT_MAX = 400;

const oneLine = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : v);
const line = (max: number, what: string) => z.preprocess((v) => { const c = oneLine(v); return c === "" ? null : c; }, z.string().max(max, `${what}: máximo ${max} caracteres`).nullable()).optional();
const digits = (n: number, what: string) => z.preprocess((v) => { const c = oneLine(v); return c === "" ? null : c; }, z.string().nullable()).optional().transform((v, ctx) => {
  if (v === undefined || v === null) return v; // ausente continua ausente (atualização parcial); vazio vira null
  if (!/^[0-9.\-\/ ]+$/.test(v)) { ctx.addIssue({ code: "custom", message: `${what}: use só números` }); return z.NEVER; }
  const d = v.replace(/\D/g, ""); if (d.length !== n) { ctx.addIssue({ code: "custom", message: `${what} deve ter ${n} dígitos` }); return z.NEVER; }
  return d;
});
const multiline = (max: number, what: string) => z.preprocess((v) => { if (typeof v !== "string") return v; const t = v.replace(/\r\n/g, "\n").trim(); return t === "" ? null : t; }, z.string().max(max, `${what}: máximo ${max} caracteres`).nullable()).optional();

const schema = z.object({
  cep: digits(8, "CEP"), street: line(160, "Logradouro"), streetNumber: line(20, "Número"), complement: line(80, "Complemento"), district: line(80, "Bairro"), cityName: line(80, "Município"),
  cityIbge: digits(7, "Código IBGE"), uf: line(2, "UF"), nfText: multiline(NF_TEXT_MAX, "Texto da nota fiscal"), boletoText: multiline(BOLETO_TEXT_MAX, "Texto do boleto"),
});
export type Extras = Partial<Record<ExtraKey, string | null>>;

/** Texto simples com os mesmos campos {{…}} dos modelos de mensagem; sem HTML. */
function checkText(t: string | null | undefined, what: string) {
  if (!t) return;
  const v = validateTemplate("whatsapp", "", t); // só o corpo: mesma regra dos modelos (campos permitidos, sem HTML, sem caracteres de controle)
  if (!v.ok) throw new Invalid(`${what}: ${v.error}`);
}

export function parseExtras(input: Record<string, unknown>): Extras {
  const picked = Object.fromEntries(Object.entries(input).filter(([k]) => (ADDRESS_KEYS as readonly string[]).includes(k) || (TEXT_KEYS as readonly string[]).includes(k)));
  const p = schema.safeParse(picked);
  if (!p.success) throw new Invalid(p.error.issues[0]?.message ?? "Dados inválidos");
  const out: Extras = {};
  for (const [k, v] of Object.entries(p.data)) if (v !== undefined) out[k as ExtraKey] = v as string | null;
  if (out.uf) { out.uf = out.uf.toUpperCase(); if (!/^[A-Z]{2}$/.test(out.uf)) throw new Invalid("UF inválida (2 letras, ex.: AM)"); }
  checkText(out.nfText, "Texto da nota fiscal"); checkText(out.boletoText, "Texto do boleto");
  return out;
}

export async function updateCustomerExtras(db: DB, actorId: string, companyId: string, customerId: string, input: Record<string, unknown>) {
  await requirePerm(db, actorId, companyId, "crm.write");
  if (!/^[0-9a-f-]{36}$/i.test(customerId)) throw new Invalid("Cliente inválido");
  const v = parseExtras(input);
  const keys = Object.keys(v) as ExtraKey[];
  if (keys.length === 0) throw new Invalid("Nada para salvar");
  return db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    const [cur] = await x.select().from(customers).where(and(eq(customers.id, customerId), eq(customers.companyId, companyId))).for("update");
    if (!cur) throw new Invalid("Cliente não encontrado");
    if (cur.archivedAt) throw new Invalid("Cliente arquivado: restaure antes de editar");
    const changed = keys.filter((k) => ((cur[k as keyof typeof cur] as string | null) ?? null) !== (v[k] ?? null));
    if (changed.length === 0) return { changed: [] as string[] };
    await x.update(customers).set({ ...Object.fromEntries(changed.map((k) => [k, v[k] ?? null])), updatedAt: new Date() }).where(and(eq(customers.id, customerId), eq(customers.companyId, companyId)));
    await x.insert(auditLog).values({ companyId, actorId, action: "party.extras_updated", detail: { partyId: customerId, changed: changed.map((k) => EXTRA_LABEL[k]).join(", ") } }); // só os NOMES dos campos
    return { changed: changed.map((k) => EXTRA_LABEL[k]) };
  });
}
