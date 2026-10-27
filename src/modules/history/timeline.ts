import { nameKeyOf, type StageRow } from "./analysis";

/**
 * H2 — linha do tempo dos clientes inferida das abas mensais da planilha (staging). PURO, sem banco; NÃO cria nem altera contrato, aditivo, cobrança ou pagamento.
 * Cada aba é um mês de vencimento. Um cliente "existe" num mês se tem linha na aba. Inferências (sempre sugestões para a diretoria conferir):
 *  entrou · valor subiu/baixou · dia de vencimento mudou · sumiu e voltou · saiu. O ÚLTIMO mês pode estar incompleto (aba em preenchimento):
 *  quem some só no último mês aparece como "ausente (a confirmar)", nunca como saída. A ponte de receita recorrente (MRR) usa o valor cobrado do mês.
 */
export type EventKind = "base" | "entrou" | "valor_subiu" | "valor_baixou" | "vencimento" | "sumiu" | "voltou" | "saiu" | "ausente_ultimo";
export const EVENT_LABEL: Record<EventKind, string> = {
  base: "Já existia no início da planilha", entrou: "Entrou", valor_subiu: "Valor subiu", valor_baixou: "Valor baixou", vencimento: "Vencimento mudou",
  sumiu: "Sumiu da planilha", voltou: "Voltou", saiu: "Saiu", ausente_ultimo: "Ausente no último mês (a confirmar)",
};
export type TlEvent = { month: string; kind: EventKind; detail: string };
export type CustomerTimeline = { key: string; name: string; document: string | null; block: string | null; firstMonth: string; lastMonth: string; monthsPresent: number; lastCents: number; events: TlEvent[] };
export type BridgeMonth = { month: string; provisional: boolean; startCents: number; newCents: number; returningCents: number; expansionCents: number; contractionCents: number; churnCents: number; endCents: number; newCount: number; returningCount: number; churnCount: number };
export type Timeline = { months: string[]; customers: CustomerTimeline[]; bridge: BridgeMonth[]; lastMonthPartial: boolean; totals: { customers: number; entered: number; left: number; gone: number; repriced: number } };

const addMonth = (m: string, n: number) => { const [y, mm] = m.split("-").map(Number); const d = new Date(Date.UTC(y, mm - 1 + n, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };
const brl = (c: number) => (c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const mes = (m: string) => `${m.slice(5)}/${m.slice(0, 4)}`;
const day = (d: string | null) => (d ? Number(d.slice(8, 10)) : null);

type Cell = { cents: number; dueDay: number | null };

export function buildTimeline(rows: (StageRow & { block?: string })[]): Timeline {
  if (rows.length === 0) return { months: [], customers: [], bridge: [], lastMonthPartial: false, totals: { customers: 0, entered: 0, left: 0, gone: 0, repriced: 0 } };
  const sorted = [...new Set(rows.map((r) => r.month))].sort();
  const months: string[] = []; for (let m = sorted[0]; m <= sorted[sorted.length - 1]; m = addMonth(m, 1)) months.push(m); // eixo contínuo: mês sem aba também conta
  const last = months[months.length - 1];
  const idx = new Map(months.map((m, i) => [m, i]));
  const people = new Map<string, { name: string; document: string | null; block: string | null; cells: (Cell | null)[] }>();
  for (const r of rows) {
    const key = r.document ?? `nome:${nameKeyOf(r.name)}`;
    const p = people.get(key) ?? people.set(key, { name: r.name, document: r.document, block: (r as { block?: string }).block ?? null, cells: months.map(() => null) }).get(key)!;
    const i = idx.get(r.month)!;
    const cur = p.cells[i];
    // várias linhas do mesmo cliente na aba: soma os valores; o dia de vencimento é o da maior linha
    if (!cur) p.cells[i] = { cents: r.amountCents, dueDay: day(r.dueOn) };
    else p.cells[i] = { cents: cur.cents + r.amountCents, dueDay: r.amountCents > cur.cents ? day(r.dueOn) : cur.dueDay };
  }
  const customers: CustomerTimeline[] = [];
  for (const [key, p] of people) {
    const ev: TlEvent[] = [];
    let prev: Cell | null = null, seenBefore = false, gapStart: string | null = null;
    const presentIdx = p.cells.flatMap((c, i) => (c ? [i] : []));
    const lastPresent = presentIdx[presentIdx.length - 1];
    p.cells.forEach((c, i) => {
      const m = months[i];
      if (c) {
        if (!seenBefore) ev.push({ month: m, kind: i === 0 ? "base" : "entrou", detail: i === 0 ? `cobrança de ${brl(c.cents)}` : `primeira cobrança: ${brl(c.cents)}` });
        else if (gapStart) { ev.push({ month: m, kind: "voltou", detail: `ausente desde ${mes(gapStart)}; voltou com ${brl(c.cents)}` }); }
        if (prev && !gapStart) {
          if (c.cents > prev.cents) ev.push({ month: m, kind: "valor_subiu", detail: `${brl(prev.cents)} → ${brl(c.cents)} (+${brl(c.cents - prev.cents)})` });
          else if (c.cents < prev.cents) ev.push({ month: m, kind: "valor_baixou", detail: `${brl(prev.cents)} → ${brl(c.cents)} (−${brl(prev.cents - c.cents)})` });
          if (prev.dueDay !== null && c.dueDay !== null && prev.dueDay !== c.dueDay) ev.push({ month: m, kind: "vencimento", detail: `dia ${prev.dueDay} → dia ${c.dueDay}` });
        } else if (prev && gapStart) { // voltou: compara com o último valor conhecido
          if (c.cents !== prev.cents) ev.push({ month: m, kind: c.cents > prev.cents ? "valor_subiu" : "valor_baixou", detail: `${brl(prev.cents)} → ${brl(c.cents)} (comparado ao último valor antes de sumir)` });
        }
        seenBefore = true; prev = c; gapStart = null;
      } else if (seenBefore && !gapStart && i < lastPresent) { gapStart = m; ev.push({ month: m, kind: "sumiu", detail: "não aparece na aba deste mês" }); }
    });
    // depois do último mês presente
    if (lastPresent < months.length - 1) {
      const firstAbsent = months[lastPresent + 1];
      if (firstAbsent === last) ev.push({ month: last, kind: "ausente_ultimo", detail: `última cobrança em ${mes(months[lastPresent])}; a aba de ${mes(last)} pode estar incompleta` });
      else ev.push({ month: firstAbsent, kind: "saiu", detail: `última cobrança em ${mes(months[lastPresent])} (${brl(p.cells[lastPresent]!.cents)})` });
    }
    customers.push({ key, name: p.name, document: p.document, block: p.block, firstMonth: months[presentIdx[0]], lastMonth: months[lastPresent], monthsPresent: presentIdx.length, lastCents: p.cells[lastPresent]!.cents, events: ev });
  }
  // ponte de receita recorrente, mês a mês (a partir do 2º)
  const bridge: BridgeMonth[] = [];
  for (let i = 1; i < months.length; i++) {
    const b: BridgeMonth = { month: months[i], provisional: months[i] === last, startCents: 0, newCents: 0, returningCents: 0, expansionCents: 0, contractionCents: 0, churnCents: 0, endCents: 0, newCount: 0, returningCount: 0, churnCount: 0 };
    for (const p of people.values()) {
      const a = p.cells[i - 1], c = p.cells[i];
      const beforeAny = p.cells.slice(0, i).some(Boolean);
      if (a) b.startCents += a.cents;
      if (c) b.endCents += c.cents;
      if (a && c) { if (c.cents > a.cents) b.expansionCents += c.cents - a.cents; else b.contractionCents += a.cents - c.cents; }
      else if (!a && c) { if (beforeAny) { b.returningCents += c.cents; b.returningCount++; } else { b.newCents += c.cents; b.newCount++; } }
      else if (a && !c) { b.churnCents += a.cents; b.churnCount++; }
    }
    bridge.push(b);
  }
  customers.sort((x, y) => y.events.filter((e) => e.kind !== "base").length - x.events.filter((e) => e.kind !== "base").length || x.name.localeCompare(y.name, "pt-BR"));
  const count = (k: EventKind) => customers.filter((c) => c.events.some((e) => e.kind === k)).length;
  return { months, customers, bridge, lastMonthPartial: months.length > 1, totals: { customers: customers.length, entered: count("entrou"), left: count("saiu"), gone: count("ausente_ultimo"), repriced: customers.filter((c) => c.events.some((e) => e.kind === "valor_subiu" || e.kind === "valor_baixou")).length } };
}
