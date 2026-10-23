import { Inbox, Plus } from "lucide-react";
import { Callout, Delta, Money, PageHeader, PartyKindBadge, SectionCard, SeverityBadge, SoonTag, SourceBadge, StatusPill } from "@/components/k3g/primitives";
import { EmptyState, ErrorState, Skeleton, SkeletonRows } from "@/components/k3g/states";
import { buttonClass, inputClass } from "@/components/k3g/button";

const SWATCHES = ["background", "card", "primary", "primary-soft", "muted", "accent", "border", "positive", "negative", "warning", "info", "demo", "brand-panel", "chart-1", "chart-2", "chart-3", "chart-4", "chart-5"];

export const metadata = { title: "Design system — K3G Finance" };

export default function DesignSystem() {
  return (
    <div className="space-y-6">
      <PageHeader title="Design system" description="Tokens, tipografia e componentes. Alterne o tema claro/escuro no cabeçalho para conferir os dois." />

      <SectionCard title="Cores (tokens semânticos)">
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {SWATCHES.map((t) => (
            <li key={t} className="text-xs"><div className="h-12 rounded-md border" style={{ background: `var(--${t})` }} /><p className="mt-1 font-medium">{t}</p></li>
          ))}
        </ul>
      </SectionCard>

      <SectionCard title="Tipografia">
        <p className="font-display text-3xl font-semibold">Space Grotesk — títulos e números</p>
        <p className="mt-2 text-base">IBM Plex Sans — texto corrido, formulários e tabelas.</p>
        <p className="mt-2 text-sm text-muted-foreground">Texto secundário. Valores: <Money cents={123456} className="text-foreground" /> · <Money cents={-98765} className="text-negative-foreground" /> · <Money cents={0} /></p>
      </SectionCard>

      <SectionCard title="Semânticas (sempre ícone + texto)">
        <div className="flex flex-wrap items-center gap-2">
          <SeverityBadge severity="critical" /><SeverityBadge severity="warning" /><SeverityBadge severity="info" /><SeverityBadge severity="positive" />
          <StatusPill tone="positive">Pago</StatusPill><StatusPill tone="negative">Atrasado</StatusPill><StatusPill tone="warning">Pendente</StatusPill><StatusPill tone="info">Em revisão</StatusPill><StatusPill tone="neutral">Rascunho</StatusPill>
          <PartyKindBadge kind="cliente" /><PartyKindBadge kind="fornecedor" /><SourceBadge source="crm" /><SoonTag />
          <Delta ratio={0.124} /><Delta ratio={-0.083} /><Delta ratio={0.05} higherIsBetter={false} />
        </div>
      </SectionCard>

      <SectionCard title="Botões e campos">
        <div className="flex flex-wrap items-center gap-2">
          <button className={buttonClass("primary")}><Plus className="size-4" aria-hidden /> Primário</button>
          <button className={buttonClass("outline")}>Contorno</button>
          <button className={buttonClass("ghost")}>Fantasma</button>
          <button className={buttonClass("success")}>Confirmar</button>
          <button className={buttonClass("danger")}>Arquivar</button>
          <button className={buttonClass("primary")} disabled>Desabilitado</button>
          <button className={buttonClass("outline", "sm")}>Pequeno</button>
        </div>
        <div className="mt-4 grid max-w-md gap-3">
          <label className="text-sm font-medium" htmlFor="ds-input">Campo de texto</label>
          <input id="ds-input" className={inputClass} placeholder="Digite algo" />
        </div>
      </SectionCard>

      <SectionCard title="Avisos">
        <div className="space-y-2">
          <Callout tone="info">Informação: nota neutra para contexto.</Callout>
          <Callout tone="positive" role="status">Sucesso: ação concluída.</Callout>
          <Callout tone="warning">Atenção: confira antes de continuar.</Callout>
          <Callout tone="negative" role="alert">Erro: algo precisa de correção.</Callout>
        </div>
      </SectionCard>

      <SectionCard title="Estados de tela">
        <div className="grid gap-4 lg:grid-cols-2">
          <EmptyState icon={Inbox} title="Nenhum cadastro ainda" description="Cadastre um cliente ou importe um CSV para começar." action={<button className={buttonClass("primary")}>Novo cadastro</button>} />
          <ErrorState action={<button className={buttonClass("outline")}>Tentar novamente</button>} />
        </div>
        <div className="mt-4"><p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Carregando</p><SkeletonRows rows={3} /></div>
        <div className="mt-4 flex gap-3"><Skeleton className="h-8 w-24" /><Skeleton className="h-8 w-40" /></div>
      </SectionCard>
    </div>
  );
}
