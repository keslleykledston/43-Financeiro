import { eq, sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { companyFiscal } from "@/lib/db/schema";
import { centsFromNumeric } from "@/lib/money";
import { requirePerm } from "@/modules/identity/service";
import { issuanceTexts } from "@/modules/issuance/texts";
import { buildDps, dpsProblems, type DpsInput, type Regime } from "./dps";

/**
 * N2a — PRÉVIA da NFS-e de uma cobrança: monta a DPS (Padrão Nacional 1.01) com os dados cadastrados e diz o que falta.
 * Só leitura. NÃO assina, NÃO envia, NÃO emite: o ambiente é SEMPRE «homologação» (tpAmb=2) e número/série são de prévia.
 */
export const PREVIEW_SERIES = 1;
export const PREVIEW_NUMBER = 1;
export const APP_VERSION = "k3gfinance-n2a";

export type NfsePreview = {
  chargeId: string; ready: boolean; problems: string[]; warnings: string[]; xml: string | null; dpsId: string | null;
  summary: { company: string; customer: string; amountCents: number; competence: string; description: string };
};

export async function previewNfse(db: DB, actorId: string, companyId: string, chargeId: string, now: Date = new Date()): Promise<NfsePreview | null> {
  await requirePerm(db, actorId, companyId, "billing.read");
  if (!/^[0-9a-f-]{36}$/i.test(chargeId)) return null;
  const [d] = (await db.execute(sql`select c.amount::text amount, c.competence_month::text competence_month, c.due_date::text due_date, c.issue_date::text issue_date, c.description, cu.legal_name, cu.document, cu.nf_text, cu.boleto_text,
      cu.cep, cu.street, cu.street_number, cu.complement, cu.district, cu.city_ibge, co.cnpj, co.name company_name, coalesce(co.legal_name, co.name) company_legal
    from charges c join customers cu on cu.company_id = c.company_id and cu.id = c.customer_id join companies co on co.id = c.company_id
    where c.company_id = ${companyId} and c.id = ${chargeId}`)) as unknown as Record<string, string | null>[];
  if (!d) return null;
  const [f] = await db.select().from(companyFiscal).where(eq(companyFiscal.companyId, companyId));
  const cents = centsFromNumeric(String(d.amount));
  const texts = issuanceTexts({ nfText: d.nf_text ?? null, boletoText: d.boleto_text ?? null, contractDescription: String(d.description ?? ""), customerName: String(d.legal_name), companyName: String(d.company_name), amountCents: cents, dueDate: String(d.due_date), competenceMonth: String(d.competence_month), issueDate: String(d.issue_date) });
  const input: DpsInput = {
    environment: 2, emittedAt: now, appVersion: APP_VERSION, series: PREVIEW_SERIES, number: PREVIEW_NUMBER, competenceDate: String(d.competence_month).slice(0, 10),
    provider: { cnpj: String(d.cnpj ?? ""), municipalRegistration: f?.municipalRegistration ?? null, regime: (f?.taxRegime as Regime | null) ?? null, issRateBps: f?.issRateBps ?? null, issWithheld: f?.issWithheld ?? false, cityIbge: f?.cityIbge ?? null, tribNacCode: f?.tribNacCode ?? null },
    customer: { document: String(d.document ?? ""), name: String(d.legal_name), address: { cityIbge: d.city_ibge ?? null, cep: d.cep ?? null, street: d.street ?? null, number: d.street_number ?? null, complement: d.complement ?? null, district: d.district ?? null } },
    service: { description: texts.nfDescription, amountCents: cents },
  };
  const summary = { company: String(d.company_legal), customer: String(d.legal_name), amountCents: cents, competence: String(d.competence_month).slice(0, 7), description: texts.nfDescription };
  const problems = dpsProblems(input);
  if (problems.length > 0) return { chargeId, ready: false, problems, warnings: [], xml: null, dpsId: null, summary };
  const r = buildDps(input);
  return { chargeId, ready: true, problems: [], warnings: r.warnings, xml: r.xml, dpsId: r.id, summary };
}
