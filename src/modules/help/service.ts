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
