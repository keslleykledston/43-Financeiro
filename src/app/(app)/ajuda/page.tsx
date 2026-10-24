import { LifeBuoy } from "lucide-react";
import { requireContext } from "@/lib/security/context";
import { listArticles } from "@/modules/help/service";
import { PageHeader, SectionCard } from "@/components/k3g/primitives";
import { EmptyState } from "@/components/k3g/states";
import { AppLink } from "@/components/k3g/app-link";

export default async function Ajuda() {
  await requireContext();
  const articles = await listArticles();
  return (
    <div className="space-y-5">
      <PageHeader title="Ajuda" description="Como usar cada tela, em passos simples. O botão “?” no topo abre o artigo da tela em que você está." />
      <SectionCard title="Artigos">
        {articles.length === 0 ? <EmptyState icon={LifeBuoy} title="Nenhum artigo disponível" description="A central de ajuda está vazia neste ambiente." /> : (
          <ul className="divide-y divide-border">
            {articles.map((a) => (
              <li key={a.slug} className="py-3">
                <AppLink href={`/ajuda/${a.slug}`} className="font-medium hover:underline">{a.title}</AppLink>
                {(a.where || a.who) && <p className="text-xs text-muted-foreground">{a.where}{a.where && a.who ? " · " : ""}{a.who && `Quem acessa: ${a.who}`}</p>}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
