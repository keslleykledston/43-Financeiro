import { ArrowLeft, Download } from "lucide-react";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { getTimeline } from "@/modules/history/service";
import { EVENT_LABEL, type EventKind } from "@/modules/history/timeline";
import { formatBRL } from "@/lib/format";
import { Callout, PageHeader, SectionCard, StatusPill, type StatusTone } from "@/components/k3g/primitives";
import { EmptyState } from "@/components/k3g/states";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass, inputClass, selectClass } from "@/components/k3g/button";

const mes = (m: string) => `${m.slice(5)}/${m.slice(2, 4)}`;
const TONE: Record<EventKind, StatusTone> = { base: "neutral", entrou: "positive", valor_subiu: "positive", valor_baixou: "warning", vencimento: "info", sumiu: "warning", voltou: "info", saiu: "negative", ausente_ultimo: "warning" };
const FILTERS = (Object.keys(EVENT_LABEL) as EventKind[]).filter((k) => k !== "base");

export default async function LinhaDoTempo({ searchParams }: { searchParams: Promise<{ tipo?: string; q?: string }> }) {
  const [sp, ctx] = await Promise.all([searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "history.read")) return <Callout tone="warning">Seu papel não tem acesso ao histórico.</Callout>;
  const { current, timeline: t } = await getTimeline(db, ctx.user.id, ctx.current.id);
  const tipo = FILTERS.find((k) => k === sp.tipo) ?? null;
  const q = (sp.q ?? "").trim().toLowerCase().slice(0, 80);
  const list = (t?.customers ?? []).filter((c) => c.events.some((e) => e.kind !== "base") && (!tipo || c.events.some((e) => e.kind === tipo)) && (!q || c.name.toLowerCase().includes(q)));
  return (
    <div className="max-w-6xl space-y-5">
      <PageHeader title="Linha do tempo dos clientes" description={`${ctx.current.name} · inferida das abas mensais da planilha`} actions={<AppLink href="/historico" className={buttonClass("outline")}><ArrowLeft className="size-4" aria-hidden /> Histórico</AppLink>} />
      <Callout tone="info">É uma <strong>inferência</strong> a partir de quem aparece em cada aba mensal: serve para enxergar entradas, saídas e mudanças de valor. <strong>Não cria nem altera contrato, aditivo, cobrança ou pagamento.</strong> Confira antes de agir: um cliente pode faltar numa aba por esquecimento ou por estar em outro bloco. A aba mais recente pode estar incompleta, por isso quem some só nela aparece como &quot;a confirmar&quot;, não como saída.</Callout>
      {!current || !t || t.months.length === 0 ? <EmptyState title="Sem histórico importado" description="Quando o histórico da planilha for importado (e autorizado), a linha do tempo aparece aqui." /> : (
        <>
          <section aria-label="Resumo" className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            {[["Clientes na planilha", t.totals.customers], ["Entraram", t.totals.entered], ["Saíram", t.totals.left], ["Ausentes no último mês", t.totals.gone], ["Com mudança de valor", t.totals.repriced]].map(([l, n]) => <div key={String(l)} className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">{l}</p><p className="text-xl font-semibold">{n}</p></div>)}
          </section>
          <SectionCard title="Ponte da receita mensal (valor cobrado)">
            <div className="overflow-x-auto"><table className="w-full min-w-[46rem] text-sm">
              <thead><tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground"><th className="py-2 pr-3">Mês</th><th className="pr-3 text-right">Início</th><th className="pr-3 text-right">Novos</th><th className="pr-3 text-right">Voltaram</th><th className="pr-3 text-right">Aumentos</th><th className="pr-3 text-right">Reduções</th><th className="pr-3 text-right">Saídas</th><th className="text-right">Fim</th></tr></thead>
              <tbody className="divide-y divide-border">{t.bridge.map((b) => <tr key={b.month}><td className="py-1.5 pr-3 whitespace-nowrap">{mes(b.month)}{b.provisional && <span className="ml-1 text-xs text-muted-foreground">(provisório)</span>}</td><td className="pr-3 text-right">{formatBRL(b.startCents)}</td><td className="pr-3 text-right text-positive-foreground">{b.newCents ? `+${formatBRL(b.newCents)} (${b.newCount})` : "–"}</td><td className="pr-3 text-right">{b.returningCents ? `+${formatBRL(b.returningCents)} (${b.returningCount})` : "–"}</td><td className="pr-3 text-right text-positive-foreground">{b.expansionCents ? `+${formatBRL(b.expansionCents)}` : "–"}</td><td className="pr-3 text-right text-warning-foreground">{b.contractionCents ? `−${formatBRL(b.contractionCents)}` : "–"}</td><td className="pr-3 text-right text-negative-foreground">{b.churnCents ? `−${formatBRL(b.churnCents)} (${b.churnCount})` : "–"}</td><td className="text-right font-medium">{formatBRL(b.endCents)}</td></tr>)}</tbody></table></div>
            <p className="mt-3 text-xs text-muted-foreground">Início + novos + voltaram + aumentos − reduções − saídas = fim. Usa o valor cobrado na aba de cada mês (sem juros nem desconto). O número entre parênteses é a quantidade de clientes.</p>
          </SectionCard>
          <form method="get" role="search" className="flex flex-wrap items-end gap-2">
            <div><label htmlFor="tipo" className="mb-1 block text-xs text-muted-foreground">Evento</label><select id="tipo" name="tipo" defaultValue={tipo ?? ""} className={selectClass}><option value="">Todos</option>{FILTERS.map((k) => <option key={k} value={k}>{EVENT_LABEL[k]}</option>)}</select></div>
            <div><label htmlFor="q" className="mb-1 block text-xs text-muted-foreground">Cliente</label><input id="q" name="q" defaultValue={q} maxLength={80} className={inputClass} placeholder="parte do nome" /></div>
            <button className={buttonClass("outline")}>Filtrar</button>
            {can(role, "history.read") && <a href="/historico/linha-do-tempo/exportar" className={buttonClass("outline")}><Download className="size-4" aria-hidden /> Baixar CSV</a>}
          </form>
          <SectionCard title={`Clientes com eventos (${list.length})`}>
            {list.length === 0 ? <p className="text-sm text-muted-foreground">Nenhum cliente com esse filtro.</p> : (
              <ul className="divide-y divide-border">
                {list.slice(0, 200).map((c) => (
                  <li key={c.key} className="py-3 text-sm">
                    <div className="flex flex-wrap items-baseline justify-between gap-2"><p className="font-medium">{c.name}</p><p className="text-xs text-muted-foreground">{c.monthsPresent} mês(es) · último valor {formatBRL(c.lastCents)}</p></div>
                    <ul className="mt-1 space-y-0.5">{c.events.filter((e) => e.kind !== "base").map((e, i) => <li key={i} className="flex flex-wrap items-center gap-2"><span className="w-12 text-xs text-muted-foreground">{mes(e.month)}</span><StatusPill tone={TONE[e.kind]}>{EVENT_LABEL[e.kind]}</StatusPill><span className="text-muted-foreground">{e.detail}</span></li>)}</ul>
                  </li>
                ))}
              </ul>
            )}
            {list.length > 200 && <p className="mt-2 text-xs text-muted-foreground">Mostrando 200 de {list.length}. Use o filtro ou baixe o CSV.</p>}
          </SectionCard>
        </>
      )}
    </div>
  );
}
