/**
 * H1 — análise PURA (sem banco) das linhas da planilha de boletos já gravadas em staging. Não altera nada: só mede e aponta divergências para revisão humana.
 * A aba é o mês do VENCIMENTO (a competência do serviço é o mês anterior). Dinheiro em centavos inteiros.
 */
export type StageRow = {
  sheet: string; row: number; month: string; name: string; documentRaw: string; document: string | null;
  /** valor da cobrança pela regra do bloco (Solutions = bruto; Call = plano + excedente), calculado na importação */
  amountCents: number; netCents: number | null;
  dueOn: string | null; paidOn: string | null;
};

export type DivKind = "vencimento_fora_da_aba" | "vencimento_ausente" | "pagamento_muito_tardio" | "pagamento_futuro" | "sem_documento" | "documento_invalido" | "fora_do_cadastro" | "duplicado_no_mes" | "varias_cobrancas_no_mes" | "pago_sem_liquido" | "liquido_diferente";
export const DIV_LABEL: Record<DivKind, string> = {
  vencimento_fora_da_aba: "Vencimento fora do mês da aba (regra: o mês da aba manda)", vencimento_ausente: "Sem data de vencimento",
  pagamento_muito_tardio: "Pago mais de 120 dias depois do vencimento", pagamento_futuro: "Data de pagamento no futuro",
  sem_documento: "Cliente sem CNPJ/CPF", documento_invalido: "CNPJ/CPF inválido", fora_do_cadastro: "CNPJ/CPF que não está no cadastro de clientes da empresa",
  duplicado_no_mes: "Possível duplicidade: mesmo cliente, mesmo valor e mesmo vencimento na aba", varias_cobrancas_no_mes: "Cliente com mais de uma cobrança na mesma aba (valores ou vencimentos diferentes)", pago_sem_liquido: "Pago, mas sem valor líquido (fica como estimativa, fora do recebido)", liquido_diferente: "Líquido diferente do valor (juros, multa ou desconto)",
};
/** `revisar` = precisa de olho humano antes de qualquer carga; `info` = esperado/explicável (ex.: juros). */
export const DIV_SEVERITY: Record<DivKind, "revisar" | "info"> = {
  vencimento_fora_da_aba: "revisar", vencimento_ausente: "revisar", pagamento_muito_tardio: "revisar", pagamento_futuro: "revisar", sem_documento: "revisar", documento_invalido: "revisar", fora_do_cadastro: "revisar",
  duplicado_no_mes: "revisar", varias_cobrancas_no_mes: "info", pago_sem_liquido: "info", liquido_diferente: "info",
};
export const DIV_ORDER = Object.keys(DIV_LABEL) as DivKind[];
export const LATE_DAYS = 120;

export type Divergence = { kind: DivKind; sheet: string; row: number; month: string; name: string; document: string | null; detail: string };
/** `receivedCents` = só o que tem valor LÍQUIDO informado (confirmado). `assumed*` = pago sem líquido: o valor da cobrança é só uma estimativa e NÃO entra em `receivedCents`. */
export type MonthSummary = { month: string; rows: number; billedCents: number; paidRows: number; receivedCents: number; assumedRows: number; assumedCents: number; openRows: number; openCents: number };
export type Report = {
  rows: number; months: MonthSummary[]; receivedByPayMonth: { month: string; rows: number; cents: number; assumedRows: number; assumedCents: number }[];
  divergences: Divergence[]; counts: Record<DivKind, number>; toReview: number; customers: number;
  totals: { billedCents: number; receivedCents: number; assumedCents: number; assumedRows: number; openCents: number; openRows: number };
};

const dayNum = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86_400_000;
const brl = (c: number) => (c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const br = (d: string) => d.split("-").reverse().join("/");

export function analyze(rows: StageRow[], knownDocuments: ReadonlySet<string>, today: string): Report {
  const divs: Divergence[] = [];
  const add = (r: StageRow, kind: DivKind, detail: string) => divs.push({ kind, sheet: r.sheet, row: r.row, month: r.month, name: r.name, document: r.document ?? (r.documentRaw || null), detail });
  const months = new Map<string, MonthSummary>(), pay = new Map<string, { rows: number; cents: number; assumedRows: number; assumedCents: number }>();
  const seen = new Map<string, StageRow[]>();
  for (const r of rows) {
    const amount = r.amountCents;
    const m = months.get(r.month) ?? { month: r.month, rows: 0, billedCents: 0, paidRows: 0, receivedCents: 0, assumedRows: 0, assumedCents: 0, openRows: 0, openCents: 0 };
    m.rows++; m.billedCents += amount;
    if (r.paidOn) {
      m.paidRows++;
      const p = pay.get(r.paidOn.slice(0, 7)) ?? { rows: 0, cents: 0, assumedRows: 0, assumedCents: 0 };
      if (r.netCents !== null) { m.receivedCents += r.netCents; p.rows++; p.cents += r.netCents; } // confirmado: tem líquido
      else { m.assumedRows++; m.assumedCents += amount; p.assumedRows++; p.assumedCents += amount; } // estimado: não entra no recebido
      pay.set(r.paidOn.slice(0, 7), p);
    } else if (r.dueOn && r.dueOn < today) { m.openRows++; m.openCents += amount; }
    months.set(r.month, m);

    if (!r.dueOn) add(r, "vencimento_ausente", "a célula de vencimento está vazia ou não é uma data");
    else if (r.dueOn.slice(0, 7) !== r.month) add(r, "vencimento_fora_da_aba", `vencimento ${br(r.dueOn)} na aba de ${r.month.slice(5)}/${r.month.slice(0, 4)}`);
    if (r.paidOn && r.dueOn) { const late = dayNum(r.paidOn) - dayNum(r.dueOn); if (late > LATE_DAYS) add(r, "pagamento_muito_tardio", `vencimento ${br(r.dueOn)}, pago em ${br(r.paidOn)} (${late} dias)`); }
    if (r.paidOn && r.paidOn > today) add(r, "pagamento_futuro", `pago em ${br(r.paidOn)}, depois de hoje`);
    if (!r.documentRaw.trim()) add(r, "sem_documento", "documento em branco");
    else if (!r.document) add(r, "documento_invalido", "os dígitos não conferem");
    else if (!knownDocuments.has(r.document)) add(r, "fora_do_cadastro", "cliente ainda não cadastrado nesta empresa");
    if (r.paidOn && r.netCents === null) add(r, "pago_sem_liquido", `cobrança ${brl(amount)}: o valor recebido é desconhecido e aparece só como estimativa, fora do total recebido`);
    if (r.netCents !== null && r.netCents !== amount) add(r, "liquido_diferente", `cobrança ${brl(amount)}, líquido ${brl(r.netCents)} (${r.netCents > amount ? "+" : "−"}${brl(Math.abs(r.netCents - amount))})`);
    const key = `${r.month}|${r.document ?? `nome:${r.name.toUpperCase()}`}`;
    (seen.get(key) ?? seen.set(key, []).get(key)!).push(r);
  }
  for (const list of seen.values()) {
    if (list.length < 2) continue;
    const sig = (r: StageRow) => `${r.amountCents}|${r.dueOn ?? ""}`;
    const exact = new Set([...new Set(list.map(sig))].filter((g) => list.filter((r) => sig(r) === g).length > 1)); // mesmo valor e mesmo vencimento
    for (const r of list) {
      if (exact.has(sig(r))) add(r, "duplicado_no_mes", `linhas ${list.filter((x) => sig(x) === sig(r)).map((x) => x.row).join(", ")} têm o mesmo valor e vencimento`);
      else add(r, "varias_cobrancas_no_mes", `${list.length} linhas deste cliente na aba (linhas ${list.map((x) => x.row).join(", ")})`);
    }
  }
  const counts = Object.fromEntries(DIV_ORDER.map((k) => [k, 0])) as Record<DivKind, number>;
  for (const d of divs) counts[d.kind]++;
  divs.sort((a, b) => DIV_ORDER.indexOf(a.kind) - DIV_ORDER.indexOf(b.kind) || a.month.localeCompare(b.month) || a.row - b.row);
  const ms = [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
  return {
    rows: rows.length, months: ms, receivedByPayMonth: [...pay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, v]) => ({ month, ...v })),
    divergences: divs, counts, toReview: DIV_ORDER.filter((k) => DIV_SEVERITY[k] === "revisar").reduce((s, k) => s + counts[k], 0),
    customers: new Set(rows.map((r) => r.document ?? `nome:${r.name.toUpperCase()}`)).size,
    totals: { billedCents: ms.reduce((s, m) => s + m.billedCents, 0), receivedCents: ms.reduce((s, m) => s + m.receivedCents, 0), assumedCents: ms.reduce((s, m) => s + m.assumedCents, 0), assumedRows: ms.reduce((s, m) => s + m.assumedRows, 0), openCents: ms.reduce((s, m) => s + m.openCents, 0), openRows: ms.reduce((s, m) => s + m.openRows, 0) },
  };
}
