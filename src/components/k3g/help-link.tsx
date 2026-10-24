"use client";
import { CircleHelp } from "lucide-react";
import { usePathname } from "next/navigation";
import { helpSlugFor } from "@/modules/help/routes";
import { AppLink } from "./app-link";
import { buttonClass } from "./button";

/** "?" do cabeçalho: abre o artigo da tela atual (ou a lista de artigos). */
export function HelpLink() {
  const slug = helpSlugFor(usePathname() ?? "/");
  return (
    <AppLink href={slug ? `/ajuda/${slug}` : "/ajuda"} aria-label="Ajuda desta tela" title="Ajuda desta tela" className={buttonClass("ghost", "md", "px-2")}>
      <CircleHelp className="size-5" aria-hidden />
    </AppLink>
  );
}
