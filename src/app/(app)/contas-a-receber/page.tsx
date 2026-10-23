import { Wallet } from "lucide-react";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { listReceivables, receivablesSummary } from "@/modules/receivables/service";
import { FILTERS, FILTER_LABEL, SITUATION_LABEL, type Filter, type Situation } from "@/modules/receivables/status";
import { Callout, Money, PageHeader, SectionCard, StatusPill, type StatusTone } from "@/components/k3g/primitives";
import { EmptyState } from "@/components/k3g/states";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass, inputClass, selectClass } from "@/components/k3g/button";

const TONE: Record<Situation, StatusTone> = { quitada: "positive", parcial: "warning", vencida: "negative", a_vencer: "info" };
const br = (d: string) => d.split("-").reverse().join("/");
type SP = { status?: string; q?: string; de?: string; ate?: string; mes?: string };

export default async function ContasAReceber({ searchParams }: { searchParams: Promise<SP> }) {
  const [sp, ctx] = await Promise.all([searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "receivables.read")) return <Callout tone="warning">Seu papel não tem acesso às contas a receber.</Callout>;
  const status: Filter = (FILTERS as readonly string[]).includes(sp.status ?? "") ? (sp.status as Filter) : "abertas";
  const f = { status, q: sp.q, dueFrom: sp.de, dueTo: sp.ate, competence: sp.mes };
  const [sum, rows] = await Promise.all([receivablesSummary(db, ctx.user.id, ctx.current.id), listReceivables(db, ctx.user.id, ctx.current.id, f)]);
  const qs = new URLSearchParams(Object.entries({ status, q: sp.q ?? "", de: sp.de ?? "", ate: sp.ate ?? "", mes: sp.mes ?? "" }).filter(([, v]) => v));
  const maxAging = Math.max(1, ...sum.aging.map((a) => a.cents));

  return (
    <div className="space-y-5">
      <PageHeader title="Contas a receber" description={`${ctx.current.name} · cobranças aprovadas, saldo e baixa manual.`}
        actions={can(role, "receivables.export") ? <a href={`/contas-a-receber/exportar?${qs}`} className={buttonClass("outline")}>Exportar CSV</a> : undefined} />
      <Callout tone="info">Baixa manual: registrar pagamento aqui <strong>não movimenta dinheiro</strong> nem emite nada. A conciliação automática com o extrato é uma fase futura.</Callout>

      <section aria-label="Resumo" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">A receber</p><Money cents={sum.openCents} className="text-xl font-semibold" /><p className="text-xs text-muted-foreground">{sum.openCount} cobrança(s)</p></div>
        <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Vencido</p><Money cents={sum.overdueCents} className="text-xl font-semibold text-negative-foreground" /><p className="text-xs text-muted-foreground">{sum.overdueCount} cobrança(s)</p></div>
        <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Recebido no mês</p><Money cents={sum.receivedMonthCents} className="text-xl font-semibold text-positive-foreground" /><p className="text-xs text-muted-foreground">{sum.receivedMonthCount} pagamento(s)</p></div>
        <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Inadimplência</p><p className="text-xl font-semibold">{sum.openCents > 0 ? Math.round((sum.overdueCents / sum.openCents) * 100) : 0}%</p><p className="text-xs text-muted-foreground">do valor em aberto</p></div>
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <SectionCard title="Envelhecimento do vencido">
          <ul className="space-y-2 text-sm">
            {sum.aging.map((a) => (
              <li key={a.key}><div className="flex justify-between"><span>{a.label}</span><span><Money cents={a.cents} /> <span className="text-xs text-muted-foreground">· {a.count}</span></span></div>
                <div className="mt-1 h-1.5 rounded bg-muted" aria-hidden><div className="h-1.5 rounded bg-negative" style={{ width: `${Math.round((a.cents / maxAging) * 100)}%` }} /></div></li>
            ))}
          </ul>
        </SectionCard>
        <SectionCard title="Maiores devedores (vencido)">
          {sum.topDebtors.length === 0 ? <p className="text-sm text-muted-foreground">Nenhum cliente com valores vencidos.</p> : (
            <ul className="divide-y divide-border text-sm">
              {sum.topDebtors.map((d) => (
                <li key={d.customerId} className="flex items-center justify-between gap-2 py-2"><AppLink href={`/clientes/${d.customerId}`} className="font-medium hover:underline">{d.name}</AppLink><span className="text-right"><Money cents={d.overdueCents} /><span className="block text-xs text-muted-foreground">{d.count} cobrança(s) · há {d.oldestDays} dia(s)</span></span></li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      <SectionCard title="Cobranças">
        <form method="get" className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <div className="lg:col-span-2"><label htmlFor="q" className="mb-1 block text-xs font-medium">Cliente</label><input id="q" name="q" defaultValue={sp.q ?? ""} maxLength={80} placeholder="Nome contém…" className={inputClass} /></div>
          <div><label htmlFor="status" className="mb-1 block text-xs font-medium">Situação</label>
            <select id="status" name="status" defaultValue={status} className={`${selectClass} w-full`}>{FILTERS.map((s) => <option key={s} value={s}>{FILTER_LABEL[s]}</option>)}</select></div>
          <div><label htmlFor="mes" className="mb-1 block text-xs font-medium">Competência</label><input id="mes" name="mes" type="month" defaultValue={sp.mes ?? ""} className={inputClass} /></div>
          <div><label htmlFor="de" className="mb-1 block text-xs font-medium">Vence de</label><input id="de" name="de" type="date" defaultValue={sp.de ?? ""} className={inputClass} /></div>
          <div><label htmlFor="ate" className="mb-1 block text-xs font-medium">até</label><input id="ate" name="ate" type="date" defaultValue={sp.ate ?? ""} className={inputClass} /></div>
          <div className="flex gap-2 sm:col-span-2 lg:col-span-6"><button className={buttonClass("primary", "sm")}>Filtrar</button><AppLink href="/contas-a-receber" className={buttonClass("ghost", "sm")}>Limpar</AppLink></div>
        </form>
        {rows.length === 0 ? (
          <EmptyState icon={Wallet} title="Nenhuma cobrança neste filtro" description="Cobranças aparecem aqui depois que o lote de emissão é aprovado em Faturamento → Lotes." action={<AppLink href="/faturamento/lotes" className={buttonClass("outline")}>Lotes de cobrança</AppLink>} />
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                <div>
                  <AppLink href={`/contas-a-receber/${r.id}`} className="font-medium hover:underline">{r.customerName}</AppLink>
                  <p className="text-xs text-muted-foreground">{r.description} · comp. {r.competenceMonth.slice(5, 7)}/{r.competenceMonth.slice(0, 4)} · vence {br(r.dueDate)}{r.overdueDays > 0 ? ` · ${r.overdueDays} dia(s) de atraso` : ""}</p>
                </div>
                <span className="flex items-center gap-3 text-right">
                  <span><Money cents={r.openCents} />{r.paidCents > 0 && <span className="block text-xs text-muted-foreground">de <Money cents={r.amountCents} /></span>}</span>
                  <StatusPill tone={TONE[r.situation]}>{SITUATION_LABEL[r.situation]}</StatusPill>
                </span>
              </li>
            ))}
          </ul>
        )}
        {rows.length === 500 && <p className="mt-3 text-xs text-muted-foreground">Mostrando as 500 primeiras. Refine o filtro ou exporte o CSV.</p>}
      </SectionCard>
    </div>
  );
}
