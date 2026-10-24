import type { ReactNode } from "react";

/**
 * Renderizador mínimo de Markdown → elementos React para a central de ajuda (artigos em help/*.md, escritos por nós).
 * Sem HTML bruto: tudo vira texto do React (nada de dangerouslySetInnerHTML). Links: só artigos (`x.md`) e http(s).
 * Suporta: títulos #–###, parágrafos, listas (com 1 nível de aninhamento por indentação), citações, tabelas, ---, **negrito**, *itálico*, `código`, [texto](link).
 */
const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))/;

function href(url: string): { to: string; external: boolean } | null {
  const m = /^([a-z0-9-]+)\.md(#[\w-]*)?$/.exec(url);
  if (m) return { to: `/ajuda/${m[1]}`, external: false };
  if (/^https?:\/\/[^\s]+$/i.test(url)) return { to: url, external: true };
  return null;
}

function inline(text: string, k = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text, n = 0;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) { out.push(rest); break; }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    const key = `${k}${n++}`, tok = m[0];
    if (m[1]) out.push(<code key={key} className="rounded bg-muted px-1 py-0.5 text-[0.9em]">{tok.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={key}>{inline(tok.slice(2, -2), key)}</strong>);
    else if (m[3]) out.push(<em key={key}>{inline(tok.slice(1, -1), key)}</em>);
    else {
      const [, label, url] = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)!;
      const h = href(url);
      if (!h) out.push(label);
      else if (h.external) out.push(<a key={key} href={h.to} target="_blank" rel="noopener noreferrer" className="text-primary underline">{label}</a>);
      else out.push(<a key={key} href={h.to} className="text-primary underline">{label}</a>);
    }
    rest = rest.slice(m.index + tok.length);
  }
  return out;
}

type Item = { text: string; ordered: boolean; kids: Item[] };
const LIST = /^(\s*)([-*]|\d+\.)\s+(.*)$/;

function list(lines: string[], key: string): ReactNode {
  const root: Item[] = [];
  const base = LIST.exec(lines[0])?.[1].length ?? 0; // 1 nível de aninhamento: indentado além do primeiro item
  let last: Item | undefined;
  for (const line of lines) {
    const m = LIST.exec(line);
    if (!m) { if (last) last.text += " " + line.trim(); continue; } // continuação do item
    const item: Item = { text: m[3], ordered: /\d/.test(m[2]), kids: [] };
    const parent = m[1].length > base ? root.at(-1) : undefined;
    (parent ? parent.kids : root).push(item);
    last = item;
  }
  const render = (items: Item[], k: string): ReactNode => {
    const Tag = items[0]?.ordered ? "ol" : "ul";
    return (
      <Tag key={k} className={`${Tag === "ol" ? "list-decimal" : "list-disc"} space-y-1 pl-6`}>
        {items.map((it, i) => <li key={`${k}-${i}`}>{inline(it.text, `${k}-${i}-`)}{it.kids.length > 0 && render(it.kids, `${k}-${i}k`)}</li>)}
      </Tag>
    );
  };
  return render(root, key);
}

const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

export function renderMarkdown(src: string): ReactNode[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0, b = 0;
  const isBlockStart = (l: string) => /^#{1,3}\s/.test(l) || /^---+$/.test(l) || /^>/.test(l) || /^\|/.test(l) || LIST.test(l);
  while (i < lines.length) {
    const line = lines[i], key = `b${b++}`;
    if (!line.trim()) { i++; continue; }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const cls = level === 1 ? "text-2xl font-semibold" : level === 2 ? "mt-6 text-lg font-semibold" : "mt-4 font-semibold";
      out.push(level === 1 ? <h1 key={key} className={cls}>{inline(h[2], key)}</h1> : level === 2 ? <h2 key={key} className={cls}>{inline(h[2], key)}</h2> : <h3 key={key} className={cls}>{inline(h[2], key)}</h3>);
      i++; continue;
    }
    if (/^---+$/.test(line)) { out.push(<hr key={key} className="my-4 border-border" />); i++; continue; }
    if (line.startsWith(">")) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) buf.push(lines[i++].replace(/^>\s?/, ""));
      out.push(<blockquote key={key} className="rounded-md border-l-4 border-primary bg-primary-soft px-4 py-2 text-sm">{inline(buf.join(" "), key)}</blockquote>);
      continue;
    }
    if (line.startsWith("|")) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].startsWith("|")) buf.push(lines[i++]);
      const head = cells(buf[0]), body = buf.slice(/^[\s|:-]+$/.test(buf[1] ?? "") ? 2 : 1).map(cells);
      out.push(
        <div key={key} className="overflow-x-auto">
          <table className="w-full min-w-max border-collapse text-sm">
            <thead><tr>{head.map((c, j) => <th key={j} className="border-b px-3 py-2 text-left font-medium">{inline(c, `${key}h${j}`)}</th>)}</tr></thead>
            <tbody>{body.map((r, ri) => <tr key={ri}>{r.map((c, j) => <td key={j} className="border-b px-3 py-2 align-top">{inline(c, `${key}r${ri}c${j}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (LIST.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].trim() && (LIST.test(lines[i]) || /^\s+\S/.test(lines[i]))) buf.push(lines[i++]);
      out.push(list(buf, key));
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) buf.push(lines[i++].trim());
    out.push(<p key={key} className="leading-relaxed">{inline(buf.join(" "), key)}</p>);
  }
  return out;
}
