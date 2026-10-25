import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { monthPlan } from "@/modules/payables/planning";
import { addMonths, isMonth } from "@/modules/payables/schedule";
import { SITUATION_LABEL, type Situation } from "@/modules/payables/status";
import { todayManaus } from "@/modules/messaging/service";
import { formatBRL } from "@/lib/format";
import { Callout, PageHeader, SectionCard, StatusPill, type StatusTone } from "@/components/k3g/primitives";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass } from "@/components/k3g/button";
import { generateMonthAction } from "../recorrentes/actions";

const TONE: Record<Situation, StatusTone> = { rascunho: "neutral", aguardando: "info", a_vencer: "info", vencida: "negative", parcial: "warning", paga: "positive", rejeitada: "neutral", cancelada: "neutral" };
const dia = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const WD = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const wd = (d: string) => WD[new Date(`${d}T12:00:00Z`).getUTCDay()];
const nomeMes = (m: string) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" });

export default async function Calendario({ searchParams }: { searchParams: Promise<{ mes?: string; erro?: string; ok?: string }> }) {
  const [sp, ctx] = await Promise.all([searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "payables.read")) return <Callout tone="warning">Seu papel não tem acesso às contas a pagar.</Callout>;
  const today = todayManaus();
  const month = sp.mes && isMonth(sp.mes) ? sp.mes : today.slice(0, 7);
  const plan = await monthPlan(db, ctx.user.id, ctx.current.id, month, today);
  const days = new Map<string, { items: typeof plan.items; fc: typeof plan.forecasts }>();
  const get = (d: string) => days.get(d) ?? days.set(d, { items: [], fc: [] }).get(d)!;
  plan.items.forEach((p) => get(p.dueDate).items.push(p));
  plan.forecasts.forEach((f) => get(f.dueDate).fc.push(f));
  const keys = [...days.keys()].sort();
  const gen = sp.ok?.startsWith("gerado-") ? sp.ok.split("-") : null;
  return (
    <div className="space-y-5">
      <PageHeader title="Calendário de pagamentos" description={ctx.current.name}
        actions={<div className="flex flex-wrap gap-2"><AppLink href="/contas-a-pagar/recorrentes" className={buttonClass("outline")}>Recorrentes e parcelas</AppLink><AppLink href="/contas-a-pagar" className={buttonClass("outline")}><ArrowLeft className="size-4" aria-hidden /> Contas a pagar</AppLink></div>} />
      {sp.erro && <Callout tone="negative" role="alert">{sp.erro}</Callout>}
      {gen && <Callout tone="positive" role="status">Rascunhos gerados: {gen[1]}. Já existiam ou foram pulados: {gen[2]}.</Callout>}
      <nav aria-label="Mês" className="flex items-center justify-between gap-2">
        <AppLink href={`/contas-a-pagar/calendario?mes=${addMonths(month, -1)}`} className={buttonClass("outline", "sm")}><ChevronLeft className="size-4" aria-hidden /> {addMonths(month, -1).slice(5)}/{addMonths(month, -1).slice(0, 4)}</AppLink>
        <h2 className="text-lg font-semibold capitalize">{nomeMes(month)}</h2>
        <AppLink href={`/contas-a-pagar/calendario?mes=${addMonths(month, 1)}`} className={buttonClass("outline", "sm")}>{addMonths(month, 1).slice(5)}/{addMonths(month, 1).slice(0, 4)} <ChevronRight className="size-4" aria-hidden /></AppLink>
      </nav>
      <section aria-label="Totais do mês" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Lançadas no mês</p><p className="text-xl font-semibold">{formatBRL(plan.totals.itemsCents)}</p><p className="text-xs text-muted-foreground">pago: {formatBRL(plan.totals.paidCents)}</p></div>
        <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Previstas (ainda sem rascunho)</p><p className="text-xl font-semibold">{formatBRL(plan.totals.forecastCents)}</p><p className="text-xs text-muted-foreground">{plan.forecasts.length} item(ns)</p></div>
        <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Total do mês (lançado + previsto)</p><p className="text-xl font-semibold">{formatBRL(plan.totals.itemsCents + plan.totals.forecastCents)}</p></div>
      </section>
      {plan.forecasts.length > 0 && can(role, "payables.write") && (
        <form action={generateMonthAction} className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-4"><input type="hidden" name="month" value={month} />
          <p className="flex-1 text-sm">Há <strong>{plan.forecasts.length}</strong> conta(s) prevista(s) neste mês sem rascunho. Gerar cria rascunhos para você revisar o valor e enviar para aprovação.</p>
          <button className={buttonClass("primary")}>Gerar o mês</button></form>
      )}
      <SectionCard title="Por dia">
        {keys.length === 0 ? <p className="text-sm text-muted-foreground">Nada vence neste mês.</p> : (
          <ul className="divide-y divide-border">
            {keys.map((d) => {
              const g = days.get(d)!, total = g.items.reduce((a, p) => a + p.amountCents, 0) + g.fc.reduce((a, f) => a + f.amountCents, 0);
              return (
                <li key={d} className="py-3">
                  <div className="flex items-baseline justify-between"><h3 className={`font-semibold ${d === today ? "text-primary" : ""}`}>{dia(d)} <span className="text-xs font-normal text-muted-foreground">{wd(d)}{d === today ? " · hoje" : ""}</span></h3><span className="text-sm font-medium">{formatBRL(total)}</span></div>
                  <ul className="mt-1 space-y-1 text-sm">
                    {g.items.map((p) => (
                      <li key={p.id} className="flex flex-wrap items-center justify-between gap-2"><span><AppLink href={`/contas-a-pagar/${p.id}`} className="hover:underline">{p.vendorName}</AppLink> <span className="text-muted-foreground">· {p.description}</span></span><span className="flex items-center gap-2">{formatBRL(p.amountCents)}<StatusPill tone={TONE[p.situation]}>{SITUATION_LABEL[p.situation]}</StatusPill></span></li>
                    ))}
                    {g.fc.map((f) => (
                      <li key={f.key} className="flex flex-wrap items-center justify-between gap-2 text-muted-foreground"><span>{f.vendorName} · {f.description}</span><span className="flex items-center gap-2">{formatBRL(f.amountCents)}<StatusPill tone="warning">{f.kind === "parcela" ? "parcela prevista" : "recorrente prevista"}</StatusPill></span></li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
