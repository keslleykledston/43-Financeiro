/** Parser CSV (RFC 4180) com detecção de delimitador (; ou ,) e BOM. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const first = src.split(/\r?\n/, 1)[0] ?? "";
  const delim = (first.match(/;/g)?.length ?? 0) >= (first.match(/,/g)?.length ?? 0) && first.includes(";") ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

/** Protege contra CSV injection (planilha interpreta =,+,-,@ como fórmula). */
const guard = (v: string) => (/^\s*[=+\-@\t\r]/.test(v) ? `'${v}` : v);

export function toCsv(rows: string[][], delim = ";"): string {
  const esc = (v: string) => {
    const g = guard(v);
    return /["\n\r;,]/.test(g) ? `"${g.replace(/"/g, '""')}"` : g;
  };
  return "﻿" + rows.map((r) => r.map(esc).join(delim)).join("\r\n") + "\r\n";
}
