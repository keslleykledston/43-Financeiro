import type { ExpenseRow } from "./planilha";
import { effectiveBlock, recurringCandidates, seriesCandidates, suggest, type Nature, type Recurring, type SeriesCandidate } from "./classify";

/** D3 — relatório PURO do staging de despesas: totais, classificação sugerida, o que falta classificar, recorrências, parcelas e divergências. */
export type DivKind = "sem_valor" | "pago_sem_data" | "pago_em_texto" | "vencimento_fora_do_mes" | "pago_diferente" | "pago_parcial" | "tem_aviso" | "e_da_call" | "e_do_k3g2";
export const DIV_LABEL: Record<DivKind, string> = {
  sem_valor: "Linha sem valor", pago_sem_data: "Sem data de pagamento (fica em aberto)", pago_em_texto: "Data de pagamento escrita como texto",
  vencimento_fora_do_mes: "Vencimento fora do mês da aba", pago_diferente: "Valor pago diferente do valor da conta", pago_parcial: "Pago a menos que o valor da conta",
  tem_aviso: "Classificação precisa de confirmação", e_da_call: "Parece ser da K3G Call (não da empresa importada)", e_do_k3g2: "Parece ser do K3G 2 (imóvel de expansão)",
};
export const DIV_SEVERITY: Record<DivKind, "revisar" | "info"> = { sem_valor: "revisar", pago_sem_data: "info", pago_em_texto: "revisar", vencimento_fora_do_mes: "info", pago_diferente: "info", pago_parcial: "revisar", tem_aviso: "revisar", e_da_call: "revisar", e_do_k3g2: "info" };
export const DIV_ORDER = Object.keys(DIV_LABEL) as DivKind[];

export type Divergence = { kind: DivKind; sheet: string; row: number; month: string; block: string; description: string; detail: string };
export type MonthTotal = { month: string; empresaPaidCents: number; empresaAmountCents: number; empresaRows: number; casaPaidCents: number; casaAmountCents: number; casaRows: number };
export type CategoryTotal = { categoryCode: string; nature: Nature; rows: number; paidCents: number; amountCents: number };
export type ToClassify = { description: string; block: "empresa" | "casa"; rows: number; paidCents: number };
export type ExpenseReport = {
  rows: number; byBlock: Record<string, number>; months: MonthTotal[]; categories: CategoryTotal[]; toClassify: ToClassify[];
  recurring: Recurring[]; series: SeriesCandidate[]; divergences: Divergence[]; counts: Record<DivKind, number>;
  totals: { empresaPaidCents: number; casaPaidCents: number; cardReferenceCents: number; tithesRecordedCents: number; callCents: number; k3g2Cents: number; installmentRemainingCents: number };
};

/** Valor PAGO = só quando há data de pagamento (ou ao menos uma data escrita em texto). Sem data, a linha está em aberto e não entra nos totais pagos (regra do dono). */
const eff = (r: ExpenseRow) => (r.paidOn || r.paidRaw ? (r.paidCents ?? 0) : 0);
const monthOfDue = (d: string | null) => (d ? d.slice(0, 7) : null);

export function analyzeExpenses(rawRows: ExpenseRow[]): ExpenseReport {
  const rows = rawRows.map(effectiveBlock); // carro/moto/consórcio da Casa contam como Empresa (igual à aplicação)
  const money = rows.filter((r) => r.block === "empresa" || r.block === "casa");
  const byBlock: Record<string, number> = {};
  for (const r of rows) byBlock[r.block] = (byBlock[r.block] ?? 0) + 1;
  const mm = new Map<string, MonthTotal>();
  for (const r of money) {
    const m = mm.get(r.month) ?? mm.set(r.month, { month: r.month, empresaPaidCents: 0, empresaAmountCents: 0, empresaRows: 0, casaPaidCents: 0, casaAmountCents: 0, casaRows: 0 }).get(r.month)!;
    if (r.block === "empresa") { m.empresaPaidCents += eff(r); m.empresaAmountCents += r.amountCents ?? 0; m.empresaRows++; } else { m.casaPaidCents += eff(r); m.casaAmountCents += r.amountCents ?? 0; m.casaRows++; }
  }
  const cat = new Map<string, CategoryTotal>();
  const tc = new Map<string, ToClassify>();
  const divergences: Divergence[] = [];
  const add = (r: ExpenseRow, kind: DivKind, detail: string) => divergences.push({ kind, sheet: r.sheet, row: r.row, month: r.month, block: r.block, description: r.description, detail });
  let callCents = 0, k3g2Cents = 0;
  for (const r of rows) {
    const s = suggest(r);
    if (r.block === "cartao") continue;
    const key = `${r.block === "dizimo" ? "casa" : r.block}|${s.categoryCode}`;
    const c = cat.get(key) ?? cat.set(key, { categoryCode: s.categoryCode, nature: s.nature, rows: 0, paidCents: 0, amountCents: 0 }).get(key)!;
    c.rows++; c.paidCents += eff(r); c.amountCents += r.amountCents ?? 0;
    if (s.categoryCode.startsWith("a_classificar") && (r.block === "empresa" || r.block === "casa")) {
      const t = tc.get(`${r.block}|${s.vendorKey}`) ?? tc.set(`${r.block}|${s.vendorKey}`, { description: r.description, block: r.block, rows: 0, paidCents: 0 }).get(`${r.block}|${s.vendorKey}`)!;
      t.rows++; t.paidCents += eff(r);
    }
    if (r.block !== "empresa" && r.block !== "casa") continue;
    if (s.companyHint === "call") { callCents += eff(r); add(r, "e_da_call", "descrição cita a Call"); }
    if (s.centerHint === "k3g2") { k3g2Cents += eff(r); add(r, "e_do_k3g2", "descrição cita K3G 2"); }
    if (s.ambiguous) add(r, "tem_aviso", s.ambiguous);
    if (r.amountCents === null && r.paidCents === null) { add(r, "sem_valor", "nem valor nem valor pago"); continue; }
    if (r.paidCents !== null && r.paidCents > 0 && r.paidOn === null && r.paidRaw === null) add(r, "pago_sem_data", "sem data de pagamento: fica como pendente de pagamento (em aberto) quando o histórico for aplicado");
    if (r.paidRaw) add(r, "pago_em_texto", `data escrita: "${r.paidRaw}"`);
    const dm = monthOfDue(r.dueOn);
    if (dm && dm !== r.month) add(r, "vencimento_fora_do_mes", `vencimento ${r.dueOn!.split("-").reverse().join("/")} na aba de ${r.month.slice(5)}/${r.month.slice(0, 4)}`);
    if (r.amountCents !== null && r.paidCents !== null && r.amountCents !== r.paidCents) add(r, r.paidCents < r.amountCents ? "pago_parcial" : "pago_diferente", `conta ${(r.amountCents / 100).toFixed(2).replace(".", ",")} · pago ${(r.paidCents / 100).toFixed(2).replace(".", ",")}`);
  }
  const counts = Object.fromEntries(DIV_ORDER.map((k) => [k, 0])) as Record<DivKind, number>;
  for (const d of divergences) counts[d.kind]++;
  const series = seriesCandidates(rows);
  const sumBlock = (b: "empresa" | "casa") => money.filter((r) => r.block === b).reduce((a, r) => a + eff(r), 0);
  return {
    rows: rows.length, byBlock, months: [...mm.values()].sort((a, b) => a.month.localeCompare(b.month)),
    categories: [...cat.entries()].map(([k, v]) => ({ ...v, nature: v.nature })).sort((a, b) => b.paidCents - a.paidCents),
    toClassify: [...tc.values()].sort((a, b) => b.paidCents - a.paidCents), recurring: recurringCandidates(rows), series, divergences, counts,
    totals: { empresaPaidCents: sumBlock("empresa"), casaPaidCents: sumBlock("casa"), cardReferenceCents: rows.filter((r) => r.block === "cartao").reduce((a, r) => a + (r.amountCents ?? 0), 0), tithesRecordedCents: rows.filter((r) => r.block === "dizimo").reduce((a, r) => a + (r.amountCents ?? 0), 0), callCents, k3g2Cents, installmentRemainingCents: series.reduce((a, s) => a + (s.remainingCents ?? 0), 0) },
  };
}
