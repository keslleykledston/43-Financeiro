import { eq } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "@/lib/db";
import { auditLog, companyFiscal } from "@/lib/db/schema";
import { parseDocument } from "@/lib/validators/document";
import { parsePercent } from "@/modules/commissions/calc";
import { Invalid, requirePerm } from "@/modules/identity/service";

/**
 * E22 — dados da CONTABILIDADE (contador/escritório) e dados FISCAIS da empresa para a NFS-e. Não são segredos.
 * Só a diretoria vê e edita (`company.manage`). O objetivo é a plataforma não depender de ninguém para saber o que falta: o painel mostra, campo a campo,
 * o que ainda precisa ser preenchido (com o contador) antes de a emissão de nota ser possível. Isto NÃO emite nota nem fala com a prefeitura.
 */
export const REGIMES = ["mei", "simples", "presumido", "real"] as const;
export type Regime = (typeof REGIMES)[number];
export const REGIME_LABEL: Record<Regime, string> = { mei: "MEI", simples: "Simples Nacional", presumido: "Lucro presumido", real: "Lucro real" };

const clean = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : v);
const txt = (max: number, what: string) => z.preprocess((v) => { const c = clean(v); return c === "" || c === undefined ? null : c; }, z.string().max(max, `${what}: máximo ${max} caracteres`).nullable());
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type FiscalValues = {
  accountantName: string | null; accountantDocument: string | null; accountantCrc: string | null; accountantContact: string | null; accountantEmail: string | null; accountantPhone: string | null; accountantNotes: string | null;
  taxRegime: Regime | null; municipalRegistration: string | null; cnae: string | null; serviceCode: string | null; issRateBps: number | null; issWithheld: boolean;
  cityName: string | null; cityIbge: string | null; uf: string | null; cep: string | null; street: string | null; streetNumber: string | null; complement: string | null; district: string | null; phone: string | null;
};

/** Só dígitos, com pontuação comum (. - /) e espaços permitidos; qualquer outro caractere é recusado (não "limpa" lixo até sobrar o tamanho certo). */
const digits = (raw: string | null, n: number, what: string): string | null => {
  if (!raw) return null;
  if (!/^[0-9.\-\/ ]+$/.test(raw)) throw new Invalid(`${what}: use só números`);
  const d = raw.replace(/\D/g, "");
  if (d.length !== n) throw new Invalid(`${what} deve ter ${n} dígitos`);
  return d;
};

const schema = z.object({
  accountantName: txt(160, "Nome do contador/escritório"), accountantDocument: txt(30, "CPF/CNPJ do contador"), accountantCrc: txt(30, "CRC"), accountantContact: txt(120, "Contato"),
  accountantEmail: txt(200, "E-mail do contador"), accountantPhone: txt(30, "Telefone do contador"), accountantNotes: txt(500, "Observações"),
  taxRegime: txt(20, "Regime"), municipalRegistration: txt(30, "Inscrição municipal"), cnae: txt(20, "CNAE"), serviceCode: txt(10, "Código do serviço"), issRate: txt(10, "Alíquota"),
  issWithheld: z.preprocess((v) => v === true || v === "on" || v === "true", z.boolean()),
  cityName: txt(80, "Município"), cityIbge: txt(20, "Código IBGE"), uf: txt(2, "UF"), cep: txt(12, "CEP"), street: txt(160, "Logradouro"), streetNumber: txt(20, "Número"), complement: txt(80, "Complemento"), district: txt(80, "Bairro"), phone: txt(30, "Telefone"),
});

export function parseFiscal(input: unknown): FiscalValues {
  const p = schema.safeParse(input);
  if (!p.success) throw new Invalid(p.error.issues[0]?.message ?? "Dados inválidos");
  const d = p.data;
  let accountantDocument: string | null = null;
  if (d.accountantDocument) { const doc = parseDocument(d.accountantDocument); if (!doc) throw new Invalid("CPF/CNPJ do contador inválido (confira os dígitos)"); accountantDocument = doc.digits; }
  if (d.accountantEmail && !EMAIL.test(d.accountantEmail)) throw new Invalid("E-mail do contador inválido");
  if (d.taxRegime && !(REGIMES as readonly string[]).includes(d.taxRegime)) throw new Invalid("Regime tributário inválido");
  let issRateBps: number | null = null;
  if (d.issRate) {
    const r = d.issRate.replace("%", "").trim();
    issRateBps = r === "0" ? 0 : parsePercent(r);
    if (issRateBps === null || issRateBps > 500) throw new Invalid("Alíquota do ISS inválida (de 0% a 5%, ex.: 2 ou 2,5)");
  }
  const uf = d.uf ? d.uf.toUpperCase() : null;
  if (uf && !/^[A-Z]{2}$/.test(uf)) throw new Invalid("UF inválida (2 letras, ex.: AM)");
  const serviceCode = d.serviceCode ? d.serviceCode.replace(",", ".") : null;
  if (serviceCode && !/^\d{1,2}\.\d{2}$/.test(serviceCode)) throw new Invalid("Código do serviço no formato da LC 116 (ex.: 1.07 ou 01.07)");
  return {
    accountantName: d.accountantName, accountantDocument, accountantCrc: d.accountantCrc, accountantContact: d.accountantContact, accountantEmail: d.accountantEmail ? d.accountantEmail.toLowerCase() : null, accountantPhone: d.accountantPhone, accountantNotes: d.accountantNotes,
    taxRegime: (d.taxRegime as Regime | null), municipalRegistration: d.municipalRegistration, cnae: digits(d.cnae, 7, "CNAE"), serviceCode, issRateBps, issWithheld: d.issWithheld,
    cityName: d.cityName, cityIbge: digits(d.cityIbge, 7, "Código IBGE do município"), uf, cep: digits(d.cep, 8, "CEP"), street: d.street, streetNumber: d.streetNumber, complement: d.complement, district: d.district, phone: d.phone,
  };
}

const EMPTY: FiscalValues = { accountantName: null, accountantDocument: null, accountantCrc: null, accountantContact: null, accountantEmail: null, accountantPhone: null, accountantNotes: null, taxRegime: null, municipalRegistration: null, cnae: null, serviceCode: null, issRateBps: null, issWithheld: false, cityName: null, cityIbge: null, uf: null, cep: null, street: null, streetNumber: null, complement: null, district: null, phone: null };

export const FIELD_LABEL: Record<keyof FiscalValues, string> = {
  accountantName: "contador: nome", accountantDocument: "contador: CPF/CNPJ", accountantCrc: "contador: CRC", accountantContact: "contador: contato", accountantEmail: "contador: e-mail", accountantPhone: "contador: telefone", accountantNotes: "contador: observações",
  taxRegime: "regime tributário", municipalRegistration: "inscrição municipal", cnae: "CNAE", serviceCode: "código do serviço", issRateBps: "alíquota do ISS", issWithheld: "ISS retido",
  cityName: "município", cityIbge: "código IBGE", uf: "UF", cep: "CEP", street: "logradouro", streetNumber: "número", complement: "complemento", district: "bairro", phone: "telefone",
};

/** O que ainda falta para a NFS-e (campos obrigatórios) e para a comunicação com a contabilidade. Puro: sem banco. */
export function fiscalPending(v: FiscalValues): { nfse: string[]; accounting: string[] } {
  const need: [keyof FiscalValues, boolean][] = [
    ["taxRegime", v.taxRegime === null], ["municipalRegistration", !v.municipalRegistration], ["cnae", !v.cnae], ["serviceCode", !v.serviceCode], ["issRateBps", v.issRateBps === null],
    ["cityName", !v.cityName], ["cityIbge", !v.cityIbge], ["uf", !v.uf], ["cep", !v.cep], ["street", !v.street], ["streetNumber", !v.streetNumber], ["district", !v.district],
  ];
  const acc: [keyof FiscalValues, boolean][] = [["accountantName", !v.accountantName], ["accountantEmail", !v.accountantEmail], ["accountantPhone", !v.accountantPhone]];
  return { nfse: need.filter(([, m]) => m).map(([k]) => FIELD_LABEL[k]), accounting: acc.filter(([, m]) => m).map(([k]) => FIELD_LABEL[k]) };
}

export async function getFiscalProfile(db: DB, actorId: string, companyId: string): Promise<FiscalValues> {
  await requirePerm(db, actorId, companyId, "company.manage");
  const [r] = await db.select().from(companyFiscal).where(eq(companyFiscal.companyId, companyId));
  if (!r) return { ...EMPTY };
  return { ...EMPTY, ...Object.fromEntries((Object.keys(EMPTY) as (keyof FiscalValues)[]).map((k) => [k, r[k as keyof typeof r] ?? EMPTY[k]])) } as FiscalValues;
}

/** Usado pelo checklist do portão (só diz se os campos de NFS-e estão completos). Exige a mesma permissão. */
export async function nfseProfileComplete(db: DB, actorId: string, companyId: string): Promise<boolean> {
  return fiscalPending(await getFiscalProfile(db, actorId, companyId)).nfse.length === 0;
}

export async function updateFiscalProfile(db: DB, actorId: string, companyId: string, input: unknown) {
  await requirePerm(db, actorId, companyId, "company.manage");
  const next = parseFiscal(input);
  return db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    const [cur] = await x.select().from(companyFiscal).where(eq(companyFiscal.companyId, companyId)).for("update");
    const before = cur ? ({ ...EMPTY, ...Object.fromEntries((Object.keys(EMPTY) as (keyof FiscalValues)[]).map((k) => [k, cur[k as keyof typeof cur] ?? EMPTY[k]])) } as FiscalValues) : { ...EMPTY };
    const changed = (Object.keys(EMPTY) as (keyof FiscalValues)[]).filter((k) => before[k] !== next[k]);
    if (changed.length === 0) return { changed: [] as string[] };
    await x.insert(companyFiscal).values({ companyId, ...next, updatedBy: actorId }).onConflictDoUpdate({ target: companyFiscal.companyId, set: { ...next, updatedBy: actorId, updatedAt: new Date() } });
    await x.insert(auditLog).values({ companyId, actorId, action: "company.fiscal_updated", detail: { changed: changed.map((k) => FIELD_LABEL[k]).join(", ") } });
    return { changed: changed.map((k) => FIELD_LABEL[k]) };
  });
}
