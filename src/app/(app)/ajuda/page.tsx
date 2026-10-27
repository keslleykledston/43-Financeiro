import { LifeBuoy } from "lucide-react";
import { requireContext } from "@/lib/security/context";
import { MAX_QUERY, listArticles, searchArticles } from "@/modules/help/service";
import { PageHeader, SectionCard } from "@/components/k3g/primitives";
import { EmptyState } from "@/components/k3g/states";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass, inputClass } from "@/components/k3g/button";

export default async function Ajuda({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const [sp] = await Promise.all([searchParams, requireContext()]);
  const q = (sp.q ?? "").slice(0, MAX_QUERY).trim();
  const found = q ? await searchArticles(q) : null;
  const articles = found ?? (await listArticles());
  return (
    <div className="space-y-5">
      <PageHeader title="Ajuda" description="Como usar cada tela, em passos simples. O botão “?” no topo abre o artigo da tela em que você está." />
      <form role="search" method="get" className="flex max-w-xl gap-2">
        <label htmlFor="q" className="sr-only">Buscar na ajuda</label>
        <input id="q" name="q" type="search" defaultValue={q} maxLength={MAX_QUERY} placeholder="Buscar na ajuda (ex.: boleto, senha, comissão)" className={inputClass} />
        <button className={buttonClass("primary")}>Buscar</button>
      </form>
      <SectionCard title={found ? `Resultados para “${q}” (${found.length})` : "Artigos"}>
        {articles.length === 0 ? <EmptyState icon={LifeBuoy} title={found ? "Nada encontrado" : "Nenhum artigo disponível"} description={found ? "Tente outras palavras (a busca ignora acentos) ou veja a lista completa." : "A central de ajuda está vazia neste ambiente."} /> : (
          <ul className="divide-y divide-border">
            {articles.map((a) => (
              <li key={a.slug} className="py-3">
                <AppLink href={`/ajuda/${a.slug}`} className="font-medium hover:underline">{a.title}</AppLink>
                {"snippet" in a && <p className="text-sm text-muted-foreground">{(a as { snippet: string }).snippet}</p>}
                {(a.where || a.who) && <p className="text-xs text-muted-foreground">{a.where}{a.where && a.who ? " · " : ""}{a.who && `Quem acessa: ${a.who}`}</p>}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
