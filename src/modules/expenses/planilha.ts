import { isoDateOf, monthOfSheet, norm, type Cell, type Sheet } from "@/modules/contracts/planilha";

/**
 * D3 — leitor PURO da planilha de despesas (Despesas__2026): cada aba mensal tem, lado a lado, "DESPESAS - <empresa>" (colunas A–F), "DESPESAS - CASA" (H–M),
 * a tabela de faturas de cartão (referência, duplica linhas das outras) e "OFERTAS E DÍZIMOS". Não toca em banco nem arquivo.
 * Linhas de TOTAL/resumo são ignoradas (a planilha soma errado em alguns meses; o sistema recalcula).
 */
export type Block = "empresa" | "casa" | "cartao" | "dizimo";
export type ExpenseRow = {
  sheet: string; row: number; month: string; block: Block; description: string;
  dueOn: string | null; amountCents: number | null; paidCents: number | null; paidOn: string | null; paidRaw: string | null;
  installmentNo: number | null; installmentsTotal: number | null;
};

const text = (v: Cell) => (v instanceof Date ? "" : String(v ?? "").replace(/\s+/g, " ").trim());
const money = (v: Cell): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v * 100) : null);
const SUMMARY = /^(TOTAL|DESPESAS\b|ENTRADA|SAIDA|SALDO|CARTOES|OFERTAS|VALOR)/;
const COLABORADORES = /^(SALARIO|VT\b|FGTS|DARF)/; // mini-tabela "DESPESAS / COLABORADORES" que cai nas colunas das faturas

/** "EMPRESTIMO / K3G2 / 14/36" → 14 de 36. "CARRO 20/48" → 20 de 48. Só vale n ≤ N e N ≥ 2 (evita datas como "19/02"). */
export function installmentOf(desc: string): { no: number; total: number } | null {
  const m = /(\d{1,3})\s*\/\s*(\d{1,3})\s*$/.exec(desc);
  if (!m) return null;
  const no = Number(m[1]), total = Number(m[2]);
  return no >= 1 && total >= 2 && total <= 999 && no <= total ? { no, total } : null;
}

/** Texto de pagamento que não é uma data completa ("19/02", "10,15/04"): fica para revisão. */
function paidCell(v: Cell): { on: string | null; raw: string | null } {
  const on = isoDateOf(v);
  if (on) return { on, raw: null };
  if (typeof v === "string") { const t = v.replace(/\s+/g, " ").trim(); if (t && t !== "-") return { on: null, raw: t.slice(0, 40) }; }
  return { on: null, raw: null };
}

const MAX_PARSED = 6000;
export function readExpenseWorkbook(sheets: Sheet[], year: number): ExpenseRow[] {
  const out: ExpenseRow[] = [];
  const seen = new Set<string>(); // duas abas com o mesmo nome (depois do trim) não podem repetir a mesma posição
  for (const sh of sheets) {
    const month = monthOfSheet(sh.name, year);
    if (!month) continue;
    const rows = sh.rows;
    const header = rows.findIndex((r) => r.some((c) => norm(c) === "QUANT."));
    const start = header >= 0 ? header + 1 : 2;
    // posição da tabela de dízimos pelo cabeçalho; sem ele, as duas últimas colunas
    const hdr = rows[header >= 0 ? header : 1] ?? [];
    const dz = hdr.findIndex((c) => norm(c).startsWith("OFERTAS/DIZIMOS"));
    const push = (r: Cell[], i: number, block: Block, cols: { due: number; desc: number; amount: number; paid: number; paidOn: number }, requireNumber = true) => {
      const description = text(r[cols.desc]);
      if (!description || SUMMARY.test(norm(description))) return;
      const amountCents = money(r[cols.amount]), paidCents = cols.paid >= 0 ? money(r[cols.paid]) : null;
      if (requireNumber && amountCents === null && paidCents === null && block !== "empresa" && block !== "casa") return;
      const pd = cols.paidOn >= 0 ? paidCell(r[cols.paidOn]) : { on: null, raw: null };
      const inst = block === "empresa" || block === "casa" ? installmentOf(description) : null;
      const pos = `${sh.name.trim()}|${i}|${block}`;
      if (seen.has(pos) || out.length >= MAX_PARSED) return;
      seen.add(pos);
      out.push({ sheet: sh.name.trim().slice(0, 60), row: i + 1, month, block, description: description.slice(0, 200), dueOn: cols.due >= 0 ? isoDateOf(r[cols.due]) : null, amountCents, paidCents, paidOn: pd.on, paidRaw: pd.raw, installmentNo: inst?.no ?? null, installmentsTotal: inst?.total ?? null });
    };
    for (let i = start; i < rows.length; i++) {
      const r = rows[i] ?? [];
      push(r, i, "empresa", { due: 1, desc: 2, amount: 3, paid: 4, paidOn: 5 });
      push(r, i, "casa", { due: 8, desc: 9, amount: 10, paid: 11, paidOn: 12 });
      for (const c of [14, 15, 16]) { // fatura de cartão: data, nome, valor
        if (r[c] instanceof Date || isoDateOf(r[c])) {
          const d = text(r[c + 1]);
          if (d && !COLABORADORES.test(norm(d)) && !SUMMARY.test(norm(d)) && typeof r[c + 2] === "number") {
            push(r, i, "cartao", { due: c, desc: c + 1, amount: c + 2, paid: -1, paidOn: -1 });
            break;
          }
        }
      }
      const labelCol = dz >= 0 ? dz : r.length >= 22 ? r.length - 2 : -1; // sem cabeçalho só vale em aba larga (as duas últimas colunas); abas estreitas não têm dízimos
      if (labelCol >= 1 && typeof r[labelCol + 1] === "number" && text(r[labelCol]) && !SUMMARY.test(norm(text(r[labelCol])))) push(r, i, "dizimo", { due: labelCol - 1, desc: labelCol, amount: labelCol + 1, paid: -1, paidOn: -1 });
    }
  }
  return out;
}
