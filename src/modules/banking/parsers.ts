import { createHash } from "node:crypto";
import { parseCsv } from "@/lib/csv";
import { isIsoDate } from "@/lib/iso-date";
import { MAX_CENTS } from "@/lib/money";

/**
 * E08 — leitura de extratos. Funções PURAS (sem banco, sem rede). Formatos: OFX (1.x SGML e 2.x XML) e CSV genérico.
 * O CSV é um modelo GENÉRICO: o layout real de cada banco (Cora, Caixa, Santander…) precisa ser validado com um arquivo de exemplo antes de depender dele.
 */
export type ParsedRow = { lineNo: number; postedAt: string; amountCents: number; description: string; externalRef: string | null };
export type ParsedStatement = { format: "ofx" | "csv"; rows: ParsedRow[]; ledgerBalanceCents: number | null; ledgerDate: string | null; accountLast4: string | null };
export class ParseError extends Error {}

export const MAX_BYTES = 2 * 1024 * 1024;
export const MAX_ROWS = 5000;
const MAX_DESC = 200;

/** Decodifica o arquivo: UTF-8 estrito; se falhar, Windows-1252 (comum em OFX brasileiro). Recusa binário. */
export function decodeText(bytes: Uint8Array): string {
  if (bytes.byteLength === 0) throw new ParseError("O arquivo está vazio");
  if (bytes.byteLength > MAX_BYTES) throw new ParseError("O arquivo passa de 2 MB");
  if (bytes.includes(0)) throw new ParseError("Arquivo binário: envie OFX ou CSV em texto");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return new TextDecoder("windows-1252").decode(bytes); }
}

export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const cleanDesc = (s: string) => s.replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_DESC);

/** "1.234,56" | "-1234.56" | "R$ 1.234,56" | "(1.234,56)" | "1234" → centavos (com sinal). null se inválido. */
export function parseSignedMoney(raw: string): number | null {
  let s = raw.trim().replace(/R\$\s*/i, "").replace(/\s+/g, "");
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.startsWith("-")) { neg = !neg; s = s.slice(1); } else if (s.startsWith("+")) s = s.slice(1);
  if (s.endsWith("-")) { neg = !neg; s = s.slice(0, -1); } // "123,45-" (alguns bancos)
  let intPart: string, frac = "";
  if (s.includes(",")) {
    const i = s.lastIndexOf(",");
    intPart = s.slice(0, i).replace(/\./g, ""); frac = s.slice(i + 1);
  } else if (/^\d+\.\d{1,2}$/.test(s)) {
    [intPart, frac] = s.split(".");
  } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    intPart = s.replace(/\./g, "");
  } else intPart = s;
  if (!/^\d+$/.test(intPart) || (frac !== "" && !/^\d{1,2}$/.test(frac))) return null;
  const cents = Number(intPart) * 100 + Number(frac.padEnd(2, "0") || "0");
  if (!Number.isSafeInteger(cents) || cents > MAX_CENTS) return null;
  return neg ? -cents : cents;
}

/** dd/mm/aaaa, dd-mm-aaaa, aaaa-mm-dd ou aaaammdd → AAAA-MM-DD. null se inválida. */
export function parseDate(raw: string): string | null {
  const s = raw.trim();
  let m: RegExpExecArray | null, iso: string;
  if ((m = /^(\d{2})[/.-](\d{2})[/.-](\d{4})$/.exec(s))) iso = `${m[3]}-${m[2]}-${m[1]}`;
  else if ((m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s))) iso = `${m[1]}-${m[2]}-${m[3]}`;
  else if ((m = /^(\d{4})(\d{2})(\d{2})/.exec(s))) iso = `${m[1]}-${m[2]}-${m[3]}`;
  else return null;
  return isIsoDate(iso) ? iso : null;
}

// ---------- OFX ----------
const tag = (block: string, name: string) => { const m = new RegExp(`<${name}>([^<\\r\\n]*)`, "i").exec(block); return m ? m[1].trim() : null; };

export function parseOfx(text: string): ParsedStatement {
  const blocks = [...text.matchAll(/<STMTTRN>([\s\S]*?)(?=<\/STMTTRN>|<STMTTRN>|<\/BANKTRANLIST>|<\/STMTRS>|$)/gi)].map((m) => m[1]);
  if (blocks.length === 0) throw new ParseError("Nenhuma transação encontrada no OFX");
  if (blocks.length > MAX_ROWS) throw new ParseError(`O arquivo tem mais de ${MAX_ROWS} transações`);
  const rows: ParsedRow[] = []; const seen = new Set<string>();
  blocks.forEach((b, i) => {
    const line = i + 1;
    const date = parseDate(tag(b, "DTPOSTED") ?? "");
    if (!date) throw new ParseError(`Transação ${line}: data inválida`);
    const amtRaw = tag(b, "TRNAMT") ?? "";
    const cents = /^[+-]?\d+([.,]\d{1,2})?$/.test(amtRaw.replace(/\s/g, "")) ? parseSignedMoney(amtRaw.replace(/\s/g, "")) : null;
    if (cents === null || cents === 0) throw new ParseError(`Transação ${line}: valor inválido ou zero`);
    const fit = tag(b, "FITID");
    const externalRef = fit ? fit.slice(0, 80) : null;
    if (externalRef) { if (seen.has(externalRef)) throw new ParseError("O arquivo repete o mesmo identificador (FITID) em transações diferentes"); seen.add(externalRef); }
    const name = tag(b, "NAME") ?? "", memo = tag(b, "MEMO") ?? "";
    const description = cleanDesc([name, memo].filter((x, k, a) => x && a.indexOf(x) === k).join(" - ")) || "(sem descrição)";
    rows.push({ lineNo: line, postedAt: date, amountCents: cents, description, externalRef });
  });
  const bal = /<LEDGERBAL>([\s\S]*?)(?=<\/LEDGERBAL>|<AVAILBAL>|<\/STMTRS>|$)/i.exec(text)?.[1];
  const balCents = bal ? parseSignedMoney(tag(bal, "BALAMT") ?? "") : null;
  const acct = tag(text, "ACCTID");
  return { format: "ofx", rows, ledgerBalanceCents: balCents, ledgerDate: bal ? parseDate(tag(bal, "DTASOF") ?? "") : null, accountLast4: acct && /\d{4}\s*$/.test(acct) ? acct.replace(/\D/g, "").slice(-4) : null };
}

// ---------- CSV genérico ----------
const norm = (h: string) => h.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const H = {
  date: ["data", "date", "data lancamento", "data movimento", "data da transacao"],
  desc: ["descricao", "historico", "description", "lancamento", "memo", "detalhes"],
  amount: ["valor", "amount", "valor r", "valor rs"],
  credit: ["credito", "entrada", "entradas"], debit: ["debito", "saida", "saidas"],
  id: ["id", "identificador", "codigo", "fitid", "id transacao", "documento"],
};
const find = (hdr: string[], names: string[]) => hdr.findIndex((h) => names.includes(h));

export function parseCsvStatement(text: string): ParsedStatement {
  const table = parseCsv(text);
  if (table.length < 2) throw new ParseError("O CSV precisa de cabeçalho e ao menos uma linha");
  const hdr = table[0].map(norm);
  const iDate = find(hdr, H.date), iDesc = find(hdr, H.desc), iAmt = find(hdr, H.amount), iCr = find(hdr, H.credit), iDb = find(hdr, H.debit), iId = find(hdr, H.id);
  if (iDate < 0 || iDesc < 0 || (iAmt < 0 && (iCr < 0 || iDb < 0))) throw new ParseError("Cabeçalho não reconhecido. Use as colunas: Data; Descrição; Valor (ou Crédito e Débito) e, opcionalmente, Id");
  const body = table.slice(1);
  if (body.length > MAX_ROWS) throw new ParseError(`O arquivo tem mais de ${MAX_ROWS} linhas`);
  const rows: ParsedRow[] = []; const seen = new Set<string>();
  body.forEach((r, i) => {
    const line = i + 2;
    const date = parseDate(r[iDate] ?? "");
    if (!date) throw new ParseError(`Linha ${line}: data inválida`);
    let cents: number | null;
    if (iAmt >= 0) cents = parseSignedMoney(r[iAmt] ?? "");
    else {
      const c = (r[iCr] ?? "").trim() ? parseSignedMoney(r[iCr]) : 0, d = (r[iDb] ?? "").trim() ? parseSignedMoney(r[iDb]) : 0;
      cents = c === null || d === null ? null : Math.abs(c) - Math.abs(d);
    }
    if (cents === null || cents === 0) throw new ParseError(`Linha ${line}: valor inválido ou zero`);
    const ref = iId >= 0 ? (r[iId] ?? "").trim().slice(0, 80) || null : null;
    if (ref) { if (seen.has(ref)) throw new ParseError("O arquivo repete o mesmo identificador em linhas diferentes"); seen.add(ref); }
    rows.push({ lineNo: line, postedAt: date, amountCents: cents, description: cleanDesc(r[iDesc] ?? "") || "(sem descrição)", externalRef: ref });
  });
  return { format: "csv", rows, ledgerBalanceCents: null, ledgerDate: null, accountLast4: null };
}

export function parseStatement(bytes: Uint8Array): ParsedStatement {
  const text = decodeText(bytes);
  const head = text.slice(0, 2000);
  if (/OFXHEADER|<OFX[\s>]/i.test(head) || /<STMTTRN>/i.test(text)) return parseOfx(text);
  return parseCsvStatement(text);
}

// ---------- chave de deduplicação ----------
const normDesc = (d: string) => d.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
/**
 * Chave estável de cada linha: o identificador do banco (FITID/Id) quando existe; senão hash de (data, valor, histórico) + nº da ocorrência
 * dentro do arquivo — duas linhas realmente iguais no mesmo arquivo (dois Pix de mesmo valor) são duas transações, não duplicata.
 */
export function withRefKeys(rows: ParsedRow[]): (ParsedRow & { refKey: string })[] {
  const count = new Map<string, number>();
  return rows.map((r) => {
    if (r.externalRef) return { ...r, refKey: `ref:${r.externalRef}` };
    const fp = createHash("sha256").update(`${r.postedAt}|${r.amountCents}|${normDesc(r.description)}`).digest("hex").slice(0, 32);
    const n = (count.get(fp) ?? 0) + 1; count.set(fp, n);
    return { ...r, refKey: `fp:${fp}:${n}` };
  });
}

export const CSV_TEMPLATE = "Data;Descrição;Valor;Id\r\n01/10/2026;PIX RECEBIDO CLIENTE EXEMPLO;2500,00;EX0001\r\n02/10/2026;TARIFA MENSAL;-39,90;EX0002\r\n";
