import { notFound } from "next/navigation";
import { requireContext } from "@/lib/security/context";
import { getArticle } from "@/modules/help/service";
import { renderMarkdown } from "@/lib/markdown";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass } from "@/components/k3g/button";

export default async function Artigo({ params }: { params: Promise<{ slug: string }> }) {
  const [{ slug }] = await Promise.all([params, requireContext()]);
  const a = await getArticle(slug);
  if (!a) notFound();
  return (
    <article className="max-w-3xl space-y-3 text-sm">
      <AppLink href="/ajuda" className={buttonClass("ghost", "sm")}>← Todos os artigos</AppLink>
      {renderMarkdown(a.body)}
    </article>
  );
}
