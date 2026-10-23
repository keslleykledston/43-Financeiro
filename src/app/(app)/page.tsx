import { AlertTriangle } from "lucide-react";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { getGroupOverview, getOverview, type Overview } from "@/modules/insights/service";
import { QUALITY_LABEL } from "@/modules/insights/calc";
import { Callout, Money, PageHeader, SectionCard, SeverityBadge, StatusPill } from "@/components/k3g/primitives";
import { EmptyState } from "@/components/k3g/states";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass } from "@/components/k3g/button";
import { ForecastBars, PairedBars } from "@/components/k3g/charts";
import { formatBRL } from "@/lib/format";

const br = (d: string) => d.split("-").reverse().join("/");
const pct = (r: number) => `${Math.round(r * 100)}%`;

function Kpi({ label, children, sub, href, tone }: { label: string; children: React.ReactNode; sub?: React.ReactNode; href?: string; tone?: "negative" | "positive" }) {
  const body = (
    <>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`num mt-2 text-2xl font-semibold ${tone === "negative" ? "text-negative-foreground" : tone === "positive" ? "text-positive-foreground" : ""}`}>{children}</p>
      {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
    </>
  );
  return href ? <AppLink href={href} className="block rounded-lg border bg-card p-4 transition-colors hover:bg-muted/40 focus-visible:outline-2">{body}</AppLink> : <div className="rounded-lg border bg-card p-4">{body}</div>;
}

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ visao?: string }> }) {
  const [sp, ctx] = await Promise.all([searchParams, requireContext()]);
  const current = ctx.current!;
  const role = await activeRole(db, ctx.user.id, current.id);
  if (!role || !can(role, "finance.read")) {
    return (
      <div className="space-y-6">
        <PageHeader title="Visão executiva" description={current.name} />
        <Callout tone="info">Seu papel ({role ?? "sem papel"}) gerencia acessos e não vê números financeiros. Use o menu para as áreas que você administra.</Callout>
      </div>
    );
  }
  const canGroup = ctx.companies.length > 1;
  const group = canGroup && sp.visao === "grupo";
  const [o, g] = await Promise.all([group ? Promise.resolve(null) : getOverview(db, ctx.user.id, current.id), group ? getGroupOverview(db, ctx.user.id, ctx.companies) : Promise.resolve(null)]);
  const view = o ?? g!.companies.find((c) => c.company.id === current.id) ?? g!.companies[0];
  if (!view) return <div className="space-y-6"><PageHeader title="Visão executiva" description="Grupo" /><Callout tone="warning">Você não tem acesso financeiro em nenhuma das empresas.</Callout></div>;
  const mes = (view?.month ?? "").slice(0, 7);
  const t = g?.total;
  const series = (g?.series ?? o!.series).map((p) => ({ month: p.month, a: p.billedCents, b: p.receivedCents }));
  const weeks = g?.weeks ?? o?.forecast?.weeks ?? [];
  const overdueOut = g ? g.overdueCents : o?.forecast?.overdueCents ?? 0;
  const alerts = g ? g.companies.flatMap((c) => c.alerts.map((a) => ({ ...a, company: c.company.name }))) : o!.alerts.map((a) => ({ ...a, company: "" }));
  const notes = [...new Set((g ? g.companies : [o!]).flatMap((c: Overview) => c.notes))];
  const val = {
    open: t?.openCents ?? o?.receivables?.openCents, overdue: t?.overdueCents ?? o?.receivables?.overdueCents, ratio: t?.delinquencyRatio ?? o?.receivables?.delinquencyRatio,
    billed: t?.billedMonthCents ?? o?.billed?.monthCents, received: t?.receivedMonthCents ?? o?.received?.monthCents, balance: t?.balanceCents ?? (o?.bank && o.bank.accounts > 0 ? o.bank.balanceCents : undefined),
    pending: t?.pendingCents ?? o?.bank?.pendingCents,
  };
  const noBank = g ? g.companies.every((c) => !c.bank || c.bank.accounts === 0) : !o!.bank || o!.bank.accounts === 0;

  return (
    <div className="space-y-6">
      <PageHeader title="Visão executiva" description={`${group ? "Grupo (empresas que você acessa)" : current.name} · números reais · hoje ${br(view.today)}`}
        actions={canGroup ? (
          <nav aria-label="Visão" className="flex gap-2">
            <AppLink href="/" className={buttonClass(group ? "ghost" : "outline", "sm")}>{current.name}</AppLink>
            <AppLink href="/?visao=grupo" className={buttonClass(group ? "outline" : "ghost", "sm")}>Grupo</AppLink>
          </nav>
        ) : undefined} />
      {g && g.skipped.length > 0 && <Callout tone="warning">Sem acesso financeiro em: {g.skipped.join(", ")}. Essas empresas ficam fora do consolidado.</Callout>}

      <section aria-label="Indicadores" className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 lg:grid-cols-3">
        <Kpi label="A receber" href="/contas-a-receber" sub="cobranças aprovadas em aberto">{val.open === undefined ? "—" : formatBRL(val.open)}</Kpi>
        <Kpi label="Vencido" href="/contas-a-receber?status=vencidas" tone={val.overdue ? "negative" : undefined} sub={val.ratio === undefined ? undefined : `${pct(val.ratio)} do valor em aberto`}>{val.overdue === undefined ? "—" : formatBRL(val.overdue)}</Kpi>
        <Kpi label="Emitido no mês" href="/faturamento/lotes" sub="cobranças de lotes aprovados, por data de emissão">{val.billed === undefined ? "—" : formatBRL(val.billed)}</Kpi>
        <Kpi label="Recebido no mês" href={`/contas-a-receber/recebimentos?mes=${mes}`} tone="positive" sub="pagamentos ativos, por data de pagamento">{val.received === undefined ? "—" : formatBRL(val.received)}</Kpi>
        <Kpi label="Saldo pelo extrato" href="/conciliacao" sub={noBank ? "Banco não conectado: nenhuma conta cadastrada" : "saldo inicial + movimentos importados"}>{noBank || val.balance === undefined ? "—" : formatBRL(val.balance)}</Kpi>
        <Kpi label="Créditos a conciliar" href="/conciliacao" sub="entradas do extrato sem cobrança vinculada">{noBank || val.pending === undefined ? "—" : formatBRL(val.pending)}</Kpi>
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <SectionCard title="Emitido × recebido (6 meses)">
          <PairedBars title="Emitido e recebido por mês" data={series} labelA="Emitido" labelB="Recebido" />
          <p className="mt-2 text-xs text-muted-foreground">Emitido = lotes aprovados, pelo mês da emissão. Recebido = pagamentos, pelo mês do pagamento. Meses diferentes são esperados: a cobrança vence no mês seguinte à competência.</p>
        </SectionCard>
        <SectionCard title="Entradas projetadas — 13 semanas" action={<StatusPill tone="info">só entradas</StatusPill>}>
          {weeks.length === 0 ? <EmptyState title="Sem previsão" description="Cadastre e aprove contratos para ver a previsão de entradas." /> : <ForecastBars title="Entradas projetadas por semana" weeks={weeks} />}
          <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
            <li><strong>Qualidade:</strong> {QUALITY_LABEL.alta}; {QUALITY_LABEL.media}.</li>
            {overdueOut > 0 && <li className="text-negative-foreground"><AlertTriangle className="mr-1 inline size-3.5 align-text-bottom" aria-hidden />{formatBRL(overdueOut)} já estão vencidos e <strong>não</strong> entram como entrada projetada (não há como estimar quando serão pagos).</li>}
            <li>Saídas não estão consideradas: contas a pagar ainda não existem.</li>
          </ul>
        </SectionCard>
      </div>

      <SectionCard title="O que precisa de atenção">
        {alerts.length === 0 ? <p className="text-sm text-muted-foreground">Nada pendente agora.</p> : (
          <ul className="divide-y divide-border">
            {alerts.map((a, i) => (
              <li key={`${a.company}-${a.key}-${i}`} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                <div className="flex min-w-0 items-start gap-3"><SeverityBadge severity={a.severity} /><div><p className="font-medium">{a.company ? `${a.company}: ` : ""}{a.title}</p><p className="text-xs text-muted-foreground">{a.detail}</p></div></div>
                <AppLink href={a.href} className={buttonClass("outline", "sm")}>Abrir</AppLink>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {g && (
        <SectionCard title="Por empresa">
          <ul className="divide-y divide-border text-sm">
            {g.companies.map((c) => (
              <li key={c.company.id} className="grid grid-cols-2 gap-2 py-3 sm:grid-cols-5">
                <span className="col-span-2 font-medium sm:col-span-1">{c.company.name}</span>
                <span><span className="block text-xs text-muted-foreground">A receber</span><Money cents={c.receivables?.openCents ?? 0} /></span>
                <span><span className="block text-xs text-muted-foreground">Vencido</span><Money cents={c.receivables?.overdueCents ?? 0} /></span>
                <span><span className="block text-xs text-muted-foreground">Recebido no mês</span><Money cents={c.received?.monthCents ?? 0} /></span>
                <span><span className="block text-xs text-muted-foreground">Saldo pelo extrato</span>{c.bank && c.bank.accounts > 0 ? <Money cents={c.bank.balanceCents} /> : "—"}</span>
              </li>
            ))}
          </ul>
          {(t!.internalInCents > 0 || t!.internalOutCents > 0) && (
            <p className="mt-3 text-xs text-muted-foreground">Transferências entre contas do grupo (classificadas na conciliação): entradas <Money cents={t!.internalInCents} />, saídas <Money cents={t!.internalOutCents} />. Não são receita nem recebimento e se anulam no saldo consolidado.</p>
          )}
        </SectionCard>
      )}

      {notes.length > 0 && (
        <SectionCard title="Dados ausentes e limites desta visão">
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">{notes.map((n) => <li key={n}>{n}</li>)}</ul>
        </SectionCard>
      )}
    </div>
  );
}
