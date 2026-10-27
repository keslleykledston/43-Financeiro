import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** Artigos da central de ajuda: help/*.md (na imagem do web, copiados para /app/help). Slug = nome do arquivo, só [a-z0-9-]. */
const DIR = () => join(process.cwd(), "help");
const SLUG = /^[a-z0-9][a-z0-9-]{0,80}$/;
const EXCLUDED = new Set(["readme"]);
const MAX_BYTES = 200_000; // artigo maior que isso é ignorado (a pasta é nossa, mas o limite evita surpresa de memória/CPU)
const readSmall = async (file: string) => ((await stat(file)).size > MAX_BYTES ? null : readFile(file, "utf8"));

export type Article = { slug: string; title: string; who: string | null; where: string | null };
const meta = (md: string, label: string) => new RegExp(`^\\*\\*${label}:\\*\\*\\s*(.+)$`, "m").exec(md)?.[1]?.trim() ?? null;
const strip = (s: string | null) => s?.replace(/\*\*|`/g, "") ?? null;

function toArticle(slug: string, md: string): Article {
  return { slug, title: /^#\s+(.+)$/m.exec(md)?.[1]?.trim() ?? slug, who: strip(meta(md, "Quem acessa")), where: strip(meta(md, "Onde")) };
}

export async function listArticles(): Promise<Article[]> {
  let files: string[] = [];
  try { files = await readdir(DIR()); } catch { return []; }
  const out: Article[] = [];
  for (const f of files) {
    const slug = f.replace(/\.md$/, "");
    if (!f.endsWith(".md") || !SLUG.test(slug) || EXCLUDED.has(slug)) continue;
    const md = await readSmall(join(DIR(), f)).catch(() => null);
    if (md !== null) out.push(toArticle(slug, md));
  }
  return out.sort((a, b) => a.title.localeCompare(b.title, "pt-BR"));
}

/** Lê um artigo pelo slug (validado: sem barras nem pontos, então não escapa da pasta). */
export async function getArticle(slug: string): Promise<(Article & { body: string }) | null> {
  if (!SLUG.test(slug) || EXCLUDED.has(slug)) return null;
  try { const body = await readSmall(join(DIR(), `${slug}.md`)); return body === null ? null : { ...toArticle(slug, body), body }; } catch { return null; }
}

// ---- Busca (sem acento e sem diferença de maiúsculas). Só lê help/*.md; nada do usuário vai para o arquivo nem para o banco. ----
const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const plain = (md: string) => md.replace(/^#+\s*/gm, "").replace(/\*\*|`|\[([^\]]*)\]\([^)]*\)/g, (m, t) => t ?? "").replace(/\s+/g, " ").trim();
export const MAX_QUERY = 100;
export type SearchHit = Article & { snippet: string };

/** Todos os termos (≥ 2 letras, até 6) precisam aparecer no artigo. Título pesa mais. Devolve até 20, com um trecho do texto. */
export async function searchArticles(q: string): Promise<SearchHit[]> {
  const raw = String(q ?? "").slice(0, MAX_QUERY);
  const terms = [...new Set(fold(raw).split(/[^a-z0-9]+/).filter((t) => t.length >= 2))].slice(0, 6);
  if (terms.length === 0) return [];
  let files: string[] = [];
  try { files = await readdir(DIR()); } catch { return []; }
  const hits: (SearchHit & { score: number })[] = [];
  for (const f of files) {
    const slug = f.replace(/\.md$/, "");
    if (!f.endsWith(".md") || !SLUG.test(slug) || EXCLUDED.has(slug)) continue;
    const md = await readSmall(join(DIR(), f)).catch(() => null);
    if (md === null) continue;
    const a = toArticle(slug, md), text = plain(md), t = fold(text), title = fold(a.title);
    if (!terms.every((x) => t.includes(x))) continue;
    const at = Math.max(0, t.indexOf(terms[0]));
    const from = Math.max(0, at - 60), snippet = (from > 0 ? "…" : "") + text.slice(from, from + 200).trim() + (from + 200 < text.length ? "…" : "");
    hits.push({ ...a, snippet, score: terms.reduce((n, x) => n + (title.includes(x) ? 5 : 0) + Math.min(5, t.split(x).length - 1), 0) });
  }
  return hits.sort((x, y) => y.score - x.score || x.title.localeCompare(y.title, "pt-BR")).slice(0, 20).map(({ score, ...h }) => { void score; return h; });
}
