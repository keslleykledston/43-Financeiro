import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { renderMarkdown } from "@/lib/markdown";
import { getArticle, listArticles, searchArticles } from "@/modules/help/service";
import { HELP_ROUTES, helpSlugFor } from "@/modules/help/routes";

const html = (md: string) => renderToStaticMarkup(createElement("div", null, renderMarkdown(md)));

describe("renderizador de Markdown da ajuda", () => {
  it("títulos, negrito, itálico, código e parágrafos", () => {
    const h = html("# Título\n\nUm **forte**, um *leve* e `código`.\nsegunda linha.\n\n## Seção");
    expect(h).toContain("<h1");
    expect(h).toContain("<strong>forte</strong>");
    expect(h).toContain("<em>leve</em>");
    expect(h).toContain("<code");
    expect(h).toContain("Um <strong>");
    expect(h).toContain("<h2");
    expect(h).toContain("código</code>.");
    expect(h).toContain("segunda linha.");
  });

  it("listas numeradas, com marcadores e um nível aninhado", () => {
    const h = html("1. um\n2. dois\n   - sub a\n   - sub b\n3. três\n\n- x\n- y");
    expect(h.match(/<ol/g)).toHaveLength(1);
    expect(h.match(/<ul/g)).toHaveLength(2); // aninhada + a lista seguinte
    expect(h).toMatch(/<li>dois<ul[^>]*><li>sub a<\/li><li>sub b<\/li><\/ul><\/li>/);
    expect(h).toContain("<li>três</li>");
  });

  it("tabela, citação e linha horizontal", () => {
    const h = html("| A | B |\n|---|---|\n| 1 | **2** |\n\n> aviso **importante**\n\n---");
    expect(h).toContain("<th");
    expect(h).toMatch(/<td[^>]*>1<\/td><td[^>]*><strong>2<\/strong><\/td>/);
    expect(h).toContain("<blockquote");
    expect(h).toContain("<hr");
  });

  it("links: artigo vira /ajuda/slug; https abre fora com noopener; o resto vira só texto", () => {
    const h = html("[a](contratos-e-calendario.md) [b](https://exemplo.com/x) [c](javascript:alert(1)) [d](../etc/passwd) [e](//evil.com)");
    expect(h).toContain('href="/ajuda/contratos-e-calendario"');
    expect(h).toContain('href="https://exemplo.com/x"');
    expect(h).toContain('rel="noopener noreferrer"');
    expect(h).not.toContain("javascript:");
    expect(h).not.toContain("passwd");
    expect(h).not.toContain("evil.com");
    expect(h.replace(/<!-- -->/g, "")).toMatch(/c\)? d e/); // o ")" sobrando de alert(1) vira texto inofensivo
  });

  it("HTML bruto vira texto escapado (sem XSS)", () => {
    const h = html("<script>alert(1)</script> e <img src=x onerror=alert(2)>\n\n**<b>x</b>**");
    expect(h).not.toContain("<script");
    expect(h).not.toContain("<img");
    expect(h).toContain("&lt;script&gt;");
    expect(h).not.toContain("<b>");
  });
});

describe("artigos de ajuda (pasta help/)", () => {
  it("lista os artigos reais sem o README e traz título e 'quem acessa'", async () => {
    const list = await listArticles();
    expect(list.length).toBeGreaterThanOrEqual(14);
    expect(list.some((a) => a.slug === "readme")).toBe(false);
    const imp = list.find((a) => a.slug === "importar-contratos")!;
    expect(imp.title).toBe("Importar contratos da planilha");
    expect(imp.who).toContain("assistente");
    expect(imp.where).toContain("Contratos");
  });

  it("só abre slug válido e existente (sem travessia de pasta)", async () => {
    expect(await getArticle("importar-contratos")).not.toBeNull();
    for (const bad of ["../package", "..%2Fpackage", "README", "readme", "a/b", "", "nao-existe", "x.md", ".env"]) expect(await getArticle(bad)).toBeNull();
  });

  it("toda tela mapeada aponta para um artigo que existe; links entre artigos não quebram", async () => {
    const slugs = new Set((await listArticles()).map((a) => a.slug));
    for (const [, slug] of HELP_ROUTES) expect(slugs.has(slug)).toBe(true);
    expect(slugs.has(helpSlugFor("/")!)).toBe(true);
    expect(helpSlugFor("/contratos/importar")).toBe("importar-contratos");
    expect(helpSlugFor("/contratos/abc")).toBe("contratos-e-calendario");
    expect(helpSlugFor("/contasbrancas")).toBeNull();
    expect(helpSlugFor("/contas-a-pagar/novo")).toBe("contas-a-pagar");
    for (const a of await listArticles()) {
      const body = (await getArticle(a.slug))!.body;
      for (const m of body.matchAll(/\]\(([a-z0-9-]+)\.md(?:#[\w-]*)?\)/g)) expect(slugs.has(m[1]), `${a.slug} → ${m[1]}`).toBe(true);
    }
  });
});

describe("busca na ajuda", () => {
  it("ignora acento e maiúsculas, exige todos os termos e traz um trecho", async () => {
    const a = await searchArticles("VERIFICACAO duas etapas");
    expect(a.map((h) => h.slug)).toContain("usuarios-e-acessos");
    expect(a[0].snippet.length).toBeGreaterThan(20);
    expect((await searchArticles("verificação")).length).toBeGreaterThan(0);
    expect(await searchArticles("zzzxyznaoexiste")).toEqual([]);
    expect(await searchArticles("verificacao zzzxyznaoexiste")).toEqual([]);
  });
  it("consulta vazia, curta, com símbolos ou gigante não quebra nem devolve tudo", async () => {
    for (const q of ["", " ", "a", "!!", "../../etc/passwd", "x".repeat(5000)]) expect(Array.isArray(await searchArticles(q))).toBe(true);
    expect(await searchArticles("")).toEqual([]);
    expect((await searchArticles("../../etc/passwd")).every((h) => /^[a-z0-9-]+$/.test(h.slug))).toBe(true);
  });
  it("título pesa mais que o corpo", async () => {
    const a = await searchArticles("contas a pagar");
    expect(a[0].title.toLowerCase()).toContain("contas a pagar");
  });
});
