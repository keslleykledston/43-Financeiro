import type { ExpenseRow } from "./planilha";
import { norm } from "@/modules/contracts/planilha";

/**
 * D3 — SUGESTÃO de classificação das linhas da planilha de despesas. PURO. É só sugestão para a pessoa conferir: nada aqui grava categoria, fornecedor nem lançamento.
 * Regras por palavra da descrição, na ordem (a primeira que casa vale). O que não casa fica "A classificar".
 */
export type Nature = "empresa" | "retirada" | "referencia"; // empresa = despesa da empresa; retirada = gasto pessoal pago pela empresa; referencia = fatura de cartão (só detalhe)
export type Suggestion = { categoryCode: string; nature: Nature; companyHint: "solutions" | "call" | null; centerHint: "k3g2" | null; vendorKey: string; ambiguous: string | null };

type Rule = [RegExp, string, string?]; // regex sobre o texto normalizado (sem acento, maiúsculo), código da categoria, aviso opcional
const EMPRESA: Rule[] = [
  [/^SALARIO/, "salarios"], [/^VT\b|^VA\b/, "vt_va"], [/^MULTA FGTS|^FGTS/, "fgts"], [/^RESCIS/, "rescisoes"], [/^FERIAS|^DECIMO|13.? SALARIO/, "ferias_13"],
  [/^DARF|INSS|IRRF/, "inss_irrf"], [/^SIMPLES/, "simples"], [/^IPTU|ALVARA|SUFRAMA|ANUIDADE|TAXA/, "iptu_taxas"],
  [/^MEDINA|COMISS/, "comissoes"], [/CONTADOR/, "contabilidade"],
  [/CONSORCIO/, "consorcio", "consórcio na empresa: confirme de quem é (pode ser pessoal)"],
  [/EMPRESTIMO|GIRO\/CAIXA|GIRO CAIXA/, "emprestimos"],
  [/CAIXA (ELO|VISA) PJ|SANTANDER PJ|CARTAO CAIXA PJ|CARTAO .* PJ|ELO PJ|VISA PJ/, "cartao_pj", "fatura sem detalhe das compras: o que é da empresa e o que é pessoal?"],
  [/VIVO|INTERNET|BOA VISTA|RONDONIA|TELEFON/, "telecom"], [/MOVIDESK|FLOWBIX|PONTOMAIS|SOFTWARE|LICENC/, "software"],
  [/^ENERGIA/, "energia"], [/^AGUA/, "agua"], [/ALUGUEL|GERADOR/, "aluguel"], [/RASTREAMENTO|MOTO/, "veiculos"],
  [/MARKETING|BRINDE|CONFRA/, "marketing"], [/FARDA|UNIFORME|RELOGIO|ODONTO/, "beneficios", "confira se o relógio/presente é benefício da empresa ou compra pessoal"],
  [/DIARISTA|CORREIOS|TERCEIR/, "terceiros"],
  [/CARREFOUR|AMAZON/, "a_classificar", "compra de mercado/loja: da empresa ou pessoal?"],
];
const CASA: Rule[] = [
  [/DIZIMO|OFERTA/, "dizimos"],
  [/NUBANK|MERCADO PAGO|CAIXA (GOLD|ELO)|CARTAO|AMAZON|CARREFOUR|PAO DE ACUCAR|BRADESCO|SANTANDER/, "cartao_pf", "fatura de cartão pessoal sem detalhe das compras"],
  [/CARRO|MOTO|IPVA|CONSORCIO|MULTAS/, "veiculos_pessoais"],
  [/FACULDADE|APMC|BATERIA|MOCHILA|DUNAMIS|POS |ESCOLA/, "educacao"], [/ODONTO|SAUDE|FARMAC/, "saude"],
  [/^AGUA|^ENERGIA|INTERNET|PISO|CASA|COMODA|PANELA|FRIGIDEIRA|VASOS|VENTILADOR|CADEIRA|FORNO/, "moradia"],
  [/PRESENTE|RELOGIO|FONES|GARRAFA|CHALEIRA|MOUSEPAD|JATO|FRALDA|BEMOL|ROUPAS/, "presentes"],
];

/** "EMPRESTIMO / K3G2 / 14/36" → "EMPRESTIMO K3G2"; tira parcelas, ordinais (13º), números finais e pontuação: chave para achar recorrências e séries. */
export function vendorKeyOf(desc: string): string {
  return norm(desc).replace(/\b\d{1,3}\s*\/\s*\d{1,3}\b/g, " ").replace(/\b\d{1,3}\s*[ºO°]\b/g, " ").replace(/\b\d+\b/g, " ").replace(/[^A-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Carro, moto e consórcio — mesmo escritos na aba Casa — são despesa da empresa (decisão do dono, 26/10). Palavra inteira: "MOTOR" não casa. */
export const isVehicleExpense = (description: string) => /\b(CARRO|MOTO|CONSORCIO)\b/.test(norm(description));
export const vehicleCategory = (description: string) => (/\bCONSORCIO\b/.test(norm(description)) ? "consorcio" : "veiculos");
/** Aba efetiva: veículo da Casa conta como Empresa. */
export const effectiveBlock = <T extends Pick<ExpenseRow, "block" | "description">>(r: T): T => (r.block === "casa" && isVehicleExpense(r.description) ? { ...r, block: "empresa" as const } : r);

export function suggest(row: Pick<ExpenseRow, "block" | "description">): Suggestion {
  if (row.block === "casa" && isVehicleExpense(row.description)) return { ...suggest({ block: "empresa", description: row.description }), categoryCode: vehicleCategory(row.description) };
  const n = norm(row.description);
  const companyHint = /\bCALL\b|\bN\. CALL\b/.test(n) ? "call" : null;
  const centerHint = /K3G ?2\b/.test(n) ? "k3g2" : null;
  const vendorKey = vendorKeyOf(row.description);
  if (row.block === "cartao") return { categoryCode: "cartao_pj", nature: "referencia", companyHint, centerHint, vendorKey, ambiguous: null };
  const rules = row.block === "casa" || row.block === "dizimo" ? CASA : EMPRESA;
  const hit = row.block === "dizimo" ? ([/./, "dizimos"] as Rule) : rules.find(([re]) => re.test(n));
  const nature: Nature = row.block === "empresa" ? "empresa" : "retirada";
  if (!hit) return { categoryCode: row.block === "empresa" ? "a_classificar" : "a_classificar_pessoal", nature, companyHint, centerHint, vendorKey, ambiguous: null };
  return { categoryCode: hit[1], nature, companyHint, centerHint, vendorKey, ambiguous: hit[2] ?? null };
}

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };

export type Recurring = { vendorKey: string; sample: string; block: "empresa" | "casa"; months: number; firstMonth: string; lastMonth: string; typicalCents: number; typicalDay: number | null; categoryCode: string };
/** Descrições que se repetem em ≥ 3 meses com valores parecidos (±35% da mediana) e SEM parcela "n/N": candidatas a conta recorrente. */
export function recurringCandidates(rows: ExpenseRow[]): Recurring[] {
  const by = new Map<string, ExpenseRow[]>();
  for (const r of rows) {
    if ((r.block !== "empresa" && r.block !== "casa") || r.installmentNo !== null || /\d+\s*[ºO°]\s*$/.test(r.description)) continue;
    const k = `${r.block}|${vendorKeyOf(r.description)}`;
    (by.get(k) ?? by.set(k, []).get(k)!).push(r);
  }
  const out: Recurring[] = [];
  for (const [k, list] of by) {
    const months = [...new Set(list.map((r) => r.month))].sort();
    if (months.length < 3) continue;
    const vals = list.map((r) => r.paidCents ?? r.amountCents).filter((v): v is number => v !== null && v > 0);
    if (vals.length < 3) continue;
    const med = median(vals);
    if (vals.filter((v) => Math.abs(v - med) <= med * 0.35).length < Math.ceil(vals.length * 0.7)) continue; // valor muito instável (cartão, energia variável): ainda assim pode ser recorrente, mas fica de fora da sugestão
    const days = list.map((r) => (r.dueOn ? Number(r.dueOn.slice(8, 10)) : null)).filter((d): d is number => d !== null);
    const [block, vendorKey] = [k.split("|")[0] as "empresa" | "casa", k.slice(k.indexOf("|") + 1)];
    out.push({ vendorKey, sample: list[0].description, block, months: months.length, firstMonth: months[0], lastMonth: months.at(-1)!, typicalCents: med, typicalDay: days.length ? median(days) : null, categoryCode: suggest(list[0]).categoryCode });
  }
  return out.sort((a, b) => b.typicalCents - a.typicalCents);
}

export type SeriesCandidate = { vendorKey: string; sample: string; block: "empresa" | "casa"; lastNo: number; total: number | null; remaining: number | null; lastMonth: string; installmentCents: number; remainingCents: number | null; unknownTotal: boolean };
/** Parcelas "n/N" (total conhecido) e ordinais "13º" (total desconhecido): última parcela vista, quantas restam e quanto. */
export function seriesCandidates(rows: ExpenseRow[]): SeriesCandidate[] {
  const by = new Map<string, ExpenseRow[]>();
  for (const r of rows) {
    if (r.block !== "empresa" && r.block !== "casa") continue;
    const ord = /(\d{1,3})\s*[ºO°]\s*$/.exec(r.description);
    if (r.installmentNo === null && !ord) continue;
    const k = `${r.block}|${vendorKeyOf(r.description)}|${r.installmentsTotal ?? "?"}`;
    (by.get(k) ?? by.set(k, []).get(k)!).push(r);
  }
  const out: SeriesCandidate[] = [];
  for (const [k, list] of by) {
    const no = (r: ExpenseRow) => r.installmentNo ?? Number(/(\d{1,3})\s*[ºO°]\s*$/.exec(r.description)![1]);
    const last = list.reduce((a, b) => (no(b) > no(a) ? b : a));
    const total = last.installmentsTotal;
    const cents = last.paidCents ?? last.amountCents ?? 0;
    const [block, vendorKey] = [k.split("|")[0] as "empresa" | "casa", k.split("|")[1]];
    out.push({ vendorKey, sample: last.description, block, lastNo: no(last), total, remaining: total ? total - no(last) : null, lastMonth: last.month, installmentCents: cents, remainingCents: total ? (total - no(last)) * cents : null, unknownTotal: total === null });
  }
  // série só com ordinal ("10º…13º") que continua depois como "14/36" do MESMO fornecedor: é a mesma dívida, fica só a série com total
  const known = out.filter((s) => !s.unknownTotal);
  const merged = out.filter((s) => !(s.unknownTotal && known.some((k) => k.block === s.block && k.vendorKey === s.vendorKey && k.lastNo >= s.lastNo)));
  return merged.filter((s) => s.remaining === null || s.remaining > 0).sort((a, b) => (b.remainingCents ?? 0) - (a.remainingCents ?? 0));
}
