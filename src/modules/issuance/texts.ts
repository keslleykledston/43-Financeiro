import { formatBRL } from "@/lib/format";
import { render, type Vars } from "@/modules/messaging/templates";

/**
 * E26 — textos da NOTA FISCAL e do BOLETO por cliente. Puro. O texto do cliente aceita os mesmos campos {{…}} dos modelos de mensagem
 * (cliente, empresa, valor, vencimento, competencia, descricao, emissao). NFS-e: texto do cliente se houver, senão a descrição do contrato.
 */
export type TextInput = { nfText: string | null; boletoText: string | null; contractDescription: string; customerName: string; companyName: string; amountCents: number; dueDate: string; competenceMonth: string; issueDate: string };
const br = (d: string) => d.slice(0, 10).split("-").reverse().join("/");

export function issuanceTexts(i: TextInput): { nfDescription: string; boletoInstructions: string | undefined } {
  const vars: Vars = { cliente: i.customerName, empresa: i.companyName, valor: formatBRL(i.amountCents), vencimento: br(i.dueDate), competencia: `${i.competenceMonth.slice(5, 7)}/${i.competenceMonth.slice(0, 4)}`, descricao: i.contractDescription, emissao: br(i.issueDate) };
  const nf = i.nfText?.trim() ? render(i.nfText, vars).slice(0, 1000) : i.contractDescription;
  return { nfDescription: nf || i.contractDescription, boletoInstructions: i.boletoText?.trim() ? render(i.boletoText, vars).slice(0, 400) : undefined };
}
