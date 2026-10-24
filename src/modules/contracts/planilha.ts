import { parseMoneyToCents } from "@/lib/money";
import { parseDocument } from "@/lib/validators/document";
import { toCsv } from "@/lib/csv";

/**
 * Conversor puro "planilha de boletos" → linhas de contrato (CSV de importação).
 * Não toca em banco nem em arquivo: recebe as abas já lidas como matrizes de células.
 * Layout tolerante: acha a linha de cabeçalho pelos rótulos (CLIENTE, CNPJ, VALOR BRUTO, PLANO…), separa os
 * blocos K3G Solutions / K3G Call pelas colunas "CLIENTE" e pelos títulos acima do cabeçalho.
 */
export type Cell = string | number | boolean | Date | null | undefined;
export type Sheet = { name: string; rows: Cell[][] };
export type Block = "solutions" | "call";

export type Entry = {
  block: Block; month: string; // YYYY-MM da aba
  name: string; documentRaw: string; grossCents: number | null; netCents: number | null; planoCents: number | null; excedenteCents: number | null;
  dueDay: number | null; service: string; obs: string; email: string; contact: string;
};

const MONTHS: Record<string, string> = { JAN: "01", FEV: "02", MAR: "03", ABR: "04", MAI: "05", JUN: "06", JUL: "07", AGO: "08", SET: "09", OUT: "10", NOV: "11", DEZ: "12" };
export const norm = (v: Cell): string => String(v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toUpperCase();
const text = (v: Cell): string => (v instanceof Date ? "" : String(v ?? "").replace(/\s+/g, " ").trim());

type Field = "name" | "doc" | "due" | "gross" | "net" | "paid" | "obs" | "email" | "contact" | "service" | "plano" | "excedente";
function fieldOf(label: string): Field | null {
  if (label === "CLIENTE") return "name";
  if (label === "CNPJ" || label === "CNPJ/CPF" || label === "CPF/CNPJ") return "doc";
  if (label === "VENCIMENTO") return "due";
  if (label === "VALOR BRUTO" || label === "BRUTO") return "gross";
  if (label === "LIQUIDO" || label === "VALOR LIQUIDO") return "net";
  if (label.startsWith("DATA PG") || label === "DATA PAGAMENTO") return "paid";
  if (label.startsWith("OBSERVAC")) return "obs";
  if (label === "E-MAIL" || label === "EMAIL") return "email";
  if (label.startsWith("CONTATO")) return "contact";
  if (label === "SERVICO") return "service";
  if (label === "PLANO") return "plano";
  if (label === "EXCEDENTE") return "excedente";
  return null;
}

/** "JAN", "Jan/2026", "janeiro" → "2026-01". */
export function monthOfSheet(name: string, year: number): string | null {
  const key = norm(name).slice(0, 3);
  const m = MONTHS[key];
  return m ? `${year}-${m}` : null;
}

export function cents(v: Cell): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? Math.round(v * 100) : null;
  if (typeof v === "string") {
    const s = v.replace(/R\$/gi, "").replace(/\s/g, "");
    if (!s || s === "-") return null;
    return parseMoneyToCents(s);
  }
  return null;
}

/** Dia do mês de um vencimento: Date, "dd/mm/aaaa", "aaaa-mm-dd" ou número de série do Excel. */
export function dayOf(v: Cell): number | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.getUTCDate();
  if (typeof v === "number" && v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 86400000)).getUTCDate();
  if (typeof v === "string") {
    const a = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(v.trim());
    if (a) return Number(a[1]);
    const b = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim());
    if (b) return Number(b[3]);
  }
  return null;
}

export function readSheet(sheet: Sheet, year: number): Entry[] {
  const month = monthOfSheet(sheet.name, year);
  if (!month) return [];
  const out: Entry[] = [];
  const rows = sheet.rows;
  const headers: number[] = [];
  rows.forEach((r, i) => { if (r.some((c) => norm(c) === "CLIENTE") && r.filter((c) => fieldOf(norm(c))).length >= 3) headers.push(i); });
  headers.forEach((h, hi) => {
    const end = hi + 1 < headers.length ? headers[hi + 1] : rows.length;
    const head = rows[h];
    // títulos "K3G SOLUTIONS"/"K3G CALL" em qualquer linha acima do cabeçalho (ou nele)
    const titles: { col: number; block: Block }[] = [];
    for (let i = hi > 0 ? headers[hi - 1] + 1 : 0; i <= h; i++) rows[i].forEach((c, col) => {
      const n = norm(c);
      if (/K3G\s*SOLUTIONS/.test(n)) titles.push({ col, block: "solutions" });
      else if (/K3G\s*CALL/.test(n)) titles.push({ col, block: "call" });
    });
    // cada coluna CLIENTE abre um bloco; os rótulos seguintes pertencem a ele até o próximo CLIENTE
    const starts = head.map((c, col) => (norm(c) === "CLIENTE" ? col : -1)).filter((c) => c >= 0);
    let claimedTo = -1; // última coluna usada pelo bloco anterior: o que vem depois (e antes do próximo CLIENTE) é do bloco seguinte
    starts.forEach((s, si) => {
      const stop = si + 1 < starts.length ? starts[si + 1] : head.length;
      const cols = new Map<Field, number>();
      // QUANT./VENCIMENTO costumam vir ANTES de CLIENTE: o bloco começa onde o anterior terminou
      for (let col = si === 0 ? 0 : claimedTo + 1; col < stop; col++) { const f = fieldOf(norm(head[col])); if (f && !cols.has(f)) cols.set(f, col); }
      claimedTo = Math.max(claimedTo, ...cols.values());
      const title = [...titles].reverse().find((t) => t.col <= s);
      const block: Block = title?.block ?? (cols.has("plano") ? "call" : starts.length > 1 && si > 0 ? "call" : "solutions");
      for (let i = h + 1; i < end; i++) {
        const r = rows[i];
        const get = (f: Field) => (cols.has(f) ? r[cols.get(f)!] : undefined);
        const name = text(get("name"));
        if (!name || /^TOTAL/.test(norm(name))) continue;
        const gross = cents(get("gross")), plano = cents(get("plano")), net = cents(get("net"));
        if (block === "solutions" && gross === null) continue; // linha sem valor não é cobrança
        if (block === "call" && plano === null && cents(get("excedente")) === null && net === null) continue;
        out.push({
          block, month, name, documentRaw: text(get("doc")), grossCents: gross, netCents: net, planoCents: plano, excedenteCents: cents(get("excedente")),
          dueDay: dayOf(get("due")), service: text(get("service")), obs: text(get("obs")), email: text(get("email")), contact: text(get("contact")),
        });
      }
    });
  });
  return out;
}

export function readWorkbook(sheets: Sheet[], year: number): Entry[] {
  return sheets.flatMap((s) => readSheet(s, year));
}

export type Consolidated = {
  block: Block; name: string; documentRaw: string; document: string | null; // document = normalizado quando válido
  description: string; monthlyCents: number; dueDay: number; startAt: string; endAt: string | null;
  email: string; contact: string; commissionPartner: string;
  months: number; distinctValues: number; lastMonth: string; hasExcedente: boolean;
};

const lastDayOf = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
};

/** Agrupa por documento (ou, sem documento, por nome); vale o valor do mês mais recente; vencimento = dia mais comum. */
export function consolidate(entries: Entry[]): Consolidated[] {
  const lastSheetMonth = entries.reduce((m, e) => (e.month > m ? e.month : m), "");
  const groups = new Map<string, Entry[]>();
  for (const e of entries) {
    const doc = parseDocument(e.documentRaw);
    const key = `${e.block}|${doc ? doc.digits : `nome:${norm(e.name)}`}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(e);
  }
  const out: Consolidated[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.month.localeCompare(b.month));
    const last = list[list.length - 1], first = list[0];
    const value = (e: Entry) => (e.block === "call" ? e.planoCents : e.grossCents);
    const latestWithValue = [...list].reverse().find((e) => (value(e) ?? 0) > 0);
    if (!latestWithValue) continue;
    // vencimento = dia mais comum; empate → o mais recente
    const days = new Map<number, { n: number; at: number }>();
    list.forEach((e, i) => { if (e.dueDay) days.set(e.dueDay, { n: (days.get(e.dueDay)?.n ?? 0) + 1, at: i }); });
    const dueDay = [...days.entries()].sort((a, b) => b[1].n - a[1].n || b[1].at - a[1].at)[0]?.[0] ?? 10;
    const doc = parseDocument(last.documentRaw);
    const hasExcedente = list.some((e) => (e.excedenteCents ?? 0) > 0);
    const svc = [...list].reverse().find((e) => e.service)?.service;
    const description = last.block === "call" ? (hasExcedente ? "Plano K3G Call + excedente" : "Plano K3G Call") : svc || "Serviço mensal";
    out.push({
      block: last.block, name: last.name, documentRaw: last.documentRaw, document: doc ? doc.digits : null,
      description: description.slice(0, 200), monthlyCents: value(latestWithValue)!, dueDay, startAt: `${first.month}-01`,
      endAt: last.month < lastSheetMonth ? lastDayOf(last.month) : null, // sumiu das abas mais recentes: vigência termina no último mês cobrado
      email: [...list].reverse().find((e) => e.email)?.email ?? "", contact: [...list].reverse().find((e) => e.contact)?.contact ?? "",
      commissionPartner: list.some((e) => /MEDINA/.test(norm(e.obs))) ? "Medina" : "",
      months: list.length, distinctValues: new Set(list.map(value).filter((v) => v !== null)).size, lastMonth: last.month, hasExcedente,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

export const CONTRACT_CSV_HEADERS = ["razao_social", "documento", "servico", "valor_mensal", "dia_vencimento", "inicio", "fim", "email_financeiro", "contato", "parceiro_comissao"] as const;

export const brl = (c: number) => `${Math.floor(c / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${String(c % 100).padStart(2, "0")}`;

export function toContractCsv(list: Consolidated[]): string {
  return toCsv([[...CONTRACT_CSV_HEADERS], ...list.map((c) => [c.name, c.document ?? c.documentRaw, c.description, brl(c.monthlyCents), String(c.dueDay), c.startAt, c.endAt ?? "", c.email, c.contact, c.commissionPartner])]).replace(/^﻿/, "");
}
