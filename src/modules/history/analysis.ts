import { checkDocument, formatDocument } from "@/lib/validators/document";
/**
 * H1 — análise PURA (sem banco) das linhas da planilha de boletos já gravadas em staging. Não altera nada: só mede e aponta divergências para revisão humana.
 * A aba é o mês do VENCIMENTO (a competência do serviço é o mês anterior). Dinheiro em centavos inteiros.
 */
export type StageRow = {
  sheet: string; row: number; month: string; name: string; documentRaw: string; document: string | null;
  /** valor da cobrança pela regra do bloco (Solutions = bruto; Call = plano + excedente), calculado na importação */
  amountCents: number; netCents: number | null;
  dueOn: string | null; paidOn: string | null; paidRaw?: string | null;
  /** true quando `document` veio de uma correção registrada pela diretoria/gerência (a linha guardada continua com o que estava na planilha) */
  docFixed?: boolean;
};

export type DivKind = "vencimento_fora_da_aba" | "vencimento_ausente" | "pagamento_muito_tardio" | "pagamento_futuro" | "sem_documento" | "documento_invalido" | "fora_do_cadastro" | "duplicado_no_mes" | "varias_cobrancas_no_mes" | "pago_sem_liquido" | "liquido_diferente" | "data_invertida" | "pagamento_em_texto" | "documento_corrigido";
export const DIV_LABEL: Record<DivKind, string> = {
  vencimento_fora_da_aba: "Vencimento fora do mês da aba (regra: o mês da aba manda)", vencimento_ausente: "Sem data de vencimento",
  pagamento_muito_tardio: "Pago mais de 120 dias depois do vencimento", pagamento_futuro: "Data de pagamento no futuro",
  sem_documento: "Cliente sem CNPJ/CPF", documento_invalido: "CNPJ/CPF inválido", fora_do_cadastro: "CNPJ/CPF que não está no cadastro de clientes da empresa",
  duplicado_no_mes: "Possível duplicidade: mesmo cliente, mesmo valor e mesmo vencimento na aba", varias_cobrancas_no_mes: "Cliente com mais de uma cobrança na mesma aba (valores ou vencimentos diferentes)", pago_sem_liquido: "Pago, mas sem valor líquido (fica como estimativa, fora do recebido)", liquido_diferente: "Líquido diferente do valor (juros, multa ou desconto)",
  data_invertida: "Data com dia e mês trocados (formato americano MM/DD): corrigida só na análise", pagamento_em_texto: "Pagamento escrito como texto (ex.: dois pagamentos): conferir à mão", documento_corrigido: "CNPJ/CPF corrigido por você (a linha guardada mantém o que estava na planilha)",
};
/** `revisar` = precisa de olho humano antes de qualquer carga; `info` = esperado/explicável (ex.: juros). */
export const DIV_SEVERITY: Record<DivKind, "revisar" | "info"> = {
  vencimento_fora_da_aba: "revisar", vencimento_ausente: "revisar", pagamento_muito_tardio: "revisar", pagamento_futuro: "revisar", sem_documento: "revisar", documento_invalido: "revisar", fora_do_cadastro: "revisar",
  duplicado_no_mes: "revisar", varias_cobrancas_no_mes: "info", pago_sem_liquido: "info", liquido_diferente: "info", data_invertida: "info", pagamento_em_texto: "revisar", documento_corrigido: "info",
};
export const DIV_ORDER = Object.keys(DIV_LABEL) as DivKind[];
export const LATE_DAYS = 120;

export type FixCandidate = { nameKey: string; name: string; rows: number; rawDocuments: string[]; suggestions: { digits: string; formatted: string; why: string }[] };
export type Divergence = { kind: DivKind; sheet: string; row: number; month: string; name: string; document: string | null; detail: string };
/** `receivedCents` = só o que tem valor LÍQUIDO informado (confirmado). `assumed*` = pago sem líquido: o valor da cobrança é só uma estimativa e NÃO entra em `receivedCents`. */
export type MonthSummary = { month: string; rows: number; billedCents: number; paidRows: number; receivedCents: number; assumedRows: number; assumedCents: number; openRows: number; openCents: number; textRows: number; textCents: number };
export type Report = {
  rows: number; months: MonthSummary[]; receivedByPayMonth: { month: string; rows: number; cents: number; assumedRows: number; assumedCents: number }[];
  divergences: Divergence[]; counts: Record<DivKind, number>; toReview: number; customers: number; toFix: FixCandidate[];
  totals: { billedCents: number; receivedCents: number; assumedCents: number; assumedRows: number; openCents: number; openRows: number; textRows: number; textCents: number };
};

const dayNum = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86_400_000;
/** Troca dia e mês ("2026-05-01" → "2026-01-05"). null quando o dia não cabe como mês (>12) ou a data não existe. */
export function swapDayMonth(d: string): string | null {
  const y = +d.slice(0, 4), m = +d.slice(5, 7), day = +d.slice(8, 10);
  if (day > 12) return null;
  return `${y}-${String(day).padStart(2, "0")}-${String(m).padStart(2, "0")}`;
}
const brl = (c: number) => (c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const br = (d: string) => d.split("-").reverse().join("/");

export const nameKeyOf = (name: string) => name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().toUpperCase();

export function analyze(rows: StageRow[], knownDocuments: ReadonlySet<string>, today: string, registryByName: ReadonlyMap<string, string> = new Map()): Report {
  const divs: Divergence[] = [];
  const add = (r: StageRow, kind: DivKind, detail: string) => divs.push({ kind, sheet: r.sheet, row: r.row, month: r.month, name: r.name, document: r.document ?? (r.documentRaw || null), detail });
  const months = new Map<string, MonthSummary>(), pay = new Map<string, { rows: number; cents: number; assumedRows: number; assumedCents: number }>();
  const seen = new Map<string, StageRow[]>();
  for (const raw of rows) {
    // Formato americano (MM/DD): o Excel leu "05/01" digitado como 5 de janeiro como 1º de maio. Evidência: vencimento fora da aba cuja troca de dia/mês cai DENTRO da aba.
    // Corrige SÓ na análise (o staging fica como veio) e lista a linha. Pagamento: troca só se o original fica absurdo (antes de -20 ou depois de 120 dias) e a troca fica plausível.
    let r = raw; const fixes: string[] = [];
    if (r.dueOn && r.dueOn.slice(0, 7) !== r.month) { const sw = swapDayMonth(r.dueOn); if (sw && sw.slice(0, 7) === r.month) { fixes.push(`vencimento ${br(r.dueOn)} → ${br(sw)}`); r = { ...r, dueOn: sw }; } }
    if (r.paidOn && r.dueOn && fixes.length > 0) { // pagamento só é corrigido na MESMA linha em que o vencimento foi (evidência: Date lido como MM/DD); sozinho, não (evita trocar data certa)
      const gap = (x: string) => dayNum(x) - dayNum(r.dueOn!);
      const sw = swapDayMonth(r.paidOn);
      if ((gap(r.paidOn) < -20 || gap(r.paidOn) > LATE_DAYS) && sw && gap(sw) >= -20 && gap(sw) <= LATE_DAYS) { fixes.push(`pagamento ${br(r.paidOn)} → ${br(sw)}`); r = { ...r, paidOn: sw }; }
    }
    if (fixes.length) add(raw, "data_invertida", fixes.join("; "));
    if (r.docFixed) add(raw, "documento_corrigido", `usado ${r.document}`);
    if (!r.paidOn && r.paidRaw) add(raw, "pagamento_em_texto", `a célula de pagamento diz "${r.paidRaw}"; fica "a conferir" (fora do em aberto e do recebido)`);
    const amount = r.amountCents;
    const m = months.get(r.month) ?? { month: r.month, rows: 0, billedCents: 0, paidRows: 0, receivedCents: 0, assumedRows: 0, assumedCents: 0, openRows: 0, openCents: 0, textRows: 0, textCents: 0 };
    m.rows++; m.billedCents += amount;
    if (r.paidOn) {
      m.paidRows++;
      const p = pay.get(r.paidOn.slice(0, 7)) ?? { rows: 0, cents: 0, assumedRows: 0, assumedCents: 0 };
      if (r.netCents !== null) { m.receivedCents += r.netCents; p.rows++; p.cents += r.netCents; } // confirmado: tem líquido
      else { m.assumedRows++; m.assumedCents += amount; p.assumedRows++; p.assumedCents += amount; } // estimado: não entra no recebido
      pay.set(r.paidOn.slice(0, 7), p);
    } else if (r.paidRaw) { m.textRows++; m.textCents += amount; } // pagamento escrito como texto (ex.: dois pagamentos): nem "em aberto" nem recebido; fica "a conferir"
    else if (r.dueOn && r.dueOn < today) { m.openRows++; m.openCents += amount; }
    months.set(r.month, m);

    if (!r.dueOn) add(r, "vencimento_ausente", "a célula de vencimento está vazia ou não é uma data");
    else if (r.dueOn.slice(0, 7) !== r.month) add(r, "vencimento_fora_da_aba", `vencimento ${br(r.dueOn)} na aba de ${r.month.slice(5)}/${r.month.slice(0, 4)}`);
    if (r.paidOn && r.dueOn) { const late = dayNum(r.paidOn) - dayNum(r.dueOn); if (late > LATE_DAYS) add(r, "pagamento_muito_tardio", `vencimento ${br(r.dueOn)}, pago em ${br(r.paidOn)} (${late} dias)`); }
    if (r.paidOn && r.paidOn > today) add(r, "pagamento_futuro", `pago em ${br(r.paidOn)}, depois de hoje`);
    if (!r.document) { if (!r.documentRaw.trim()) add(r, "sem_documento", "documento em branco"); else add(r, "documento_invalido", "os dígitos não conferem"); } // depois de uma correção registrada o documento existe
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
  // clientes cujo CNPJ/CPF falta ou não confere (depois das correções): agrupados por nome, com sugestões
  const bad = rows.filter((r) => !r.document);
  const byName = new Map<string, StageRow[]>();
  for (const r of bad) (byName.get(nameKeyOf(r.name)) ?? byName.set(nameKeyOf(r.name), []).get(nameKeyOf(r.name))!).push(r);
  const toFix: FixCandidate[] = [...byName.entries()].map(([nameKey, list]) => {
    const sug = new Map<string, { digits: string; formatted: string; why: string }>();
    const same = new Map<string, number>();
    for (const r of rows) if (r.document && nameKeyOf(r.name) === nameKey) same.set(r.document, (same.get(r.document) ?? 0) + 1);
    for (const [digits, n] of [...same.entries()].sort((a, b) => b[1] - a[1])) sug.set(digits, { digits, formatted: formatDocument(digits.length === 11 ? "cpf" : "cnpj", digits), why: `é o que a planilha usa em ${n} outra(s) linha(s) deste cliente` });
    const reg = registryByName.get(nameKey); if (reg && !sug.has(reg)) sug.set(reg, { digits: reg, formatted: formatDocument(reg.length === 11 ? "cpf" : "cnpj", reg), why: "é o documento do cliente de mesmo nome já cadastrado" });
    const raws = [...new Set(list.map((r) => r.documentRaw.trim()).filter(Boolean))];
    for (const raw of raws) { const c = checkDocument(raw); if (c.state === "invalido") for (const x of c.suggestions) if (!sug.has(x.digits)) sug.set(x.digits, x); }
    return { nameKey, name: list[0].name, rows: list.length, rawDocuments: raws, suggestions: [...sug.values()] };
  }).sort((a, b) => b.rows - a.rows || a.name.localeCompare(b.name, "pt-BR"));
  const counts = Object.fromEntries(DIV_ORDER.map((k) => [k, 0])) as Record<DivKind, number>;
  for (const d of divs) counts[d.kind]++;
  divs.sort((a, b) => DIV_ORDER.indexOf(a.kind) - DIV_ORDER.indexOf(b.kind) || a.month.localeCompare(b.month) || a.row - b.row);
  const ms = [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
  return {
    rows: rows.length, months: ms, receivedByPayMonth: [...pay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, v]) => ({ month, ...v })),
    divergences: divs, counts, toReview: DIV_ORDER.filter((k) => DIV_SEVERITY[k] === "revisar").reduce((s, k) => s + counts[k], 0),
    toFix,
    customers: new Set(rows.map((r) => r.document ?? `nome:${r.name.toUpperCase()}`)).size,
    totals: { billedCents: ms.reduce((s, m) => s + m.billedCents, 0), receivedCents: ms.reduce((s, m) => s + m.receivedCents, 0), assumedCents: ms.reduce((s, m) => s + m.assumedCents, 0), assumedRows: ms.reduce((s, m) => s + m.assumedRows, 0), openCents: ms.reduce((s, m) => s + m.openCents, 0), openRows: ms.reduce((s, m) => s + m.openRows, 0), textRows: ms.reduce((s, m) => s + m.textRows, 0), textCents: ms.reduce((s, m) => s + m.textCents, 0) },
  };
}
