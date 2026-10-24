import { AlertTriangle, CalendarClock, ClipboardCheck, ChevronLeft, ChevronRight, FileText, Receipt } from "lucide-react";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { getBillingCalendar, listHolidays, type CalendarItem } from "@/modules/billing/service";
import { addMonths, daysInMonth, WARNING_LABEL } from "@/modules/billing/calendar";
import { Callout, Money, PageHeader, SectionCard } from "@/components/k3g/primitives";
import { EmptyState } from "@/components/k3g/states";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass, inputClass } from "@/components/k3g/button";
import { formatBRL } from "@/lib/format";
import { cn } from "@/lib/utils";
import { addHolidayAction, removeHolidayAction } from "./actions";

const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const SEM = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const dayLabel = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: "UTC" });
const pad = (n: number) => String(n).padStart(2, "0");

function ItemLine({ i, kind }: { i: CalendarItem; kind: "issue" | "due" }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
      <div className="min-w-0">
        <AppLink href={`/contratos/${i.contractId}`} className="font-medium hover:underline">{i.customerName}</AppLink>
        <p className="text-muted-foreground">
          {i.description} ·{" "}
          {kind === "issue" ? <>Boleto{i.jointInvoice ? " + NF" : ""}{i.batch ? ` · lote ${i.batch}` : " · emissão personalizada"} · vence {i.dueDate!.split("-").reverse().join("/")}</> : <>Vencimento · competência {i.competenceMonth}</>}
          {kind === "issue" && !i.jointInvoice && <span className="ml-1 text-xs">(NF: regra fiscal a definir)</span>}
        </p>
        {i.warnings.length > 0 && <p className="text-xs text-muted-foreground">{i.warnings.map((w) => WARNING_LABEL[w]).join("; ")}</p>}
        {i.review && <p className="flex items-center gap-1 text-xs font-medium text-warning-foreground"><AlertTriangle className="size-3.5" aria-hidden /> Precisa de revisão: {i.reason}</p>}
      </div>
      <Money cents={i.amountCents} className="font-semibold" />
    </li>
  );
}

export default async function Faturamento({ searchParams }: { searchParams: Promise<{ mes?: string; erro?: string }> }) {
  const [sp, ctx] = await Promise.all([searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "contracts.read")) return <Callout tone="warning">Seu papel não tem acesso ao faturamento.</Callout>;
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Manaus" });
  const mes = sp.mes && /^\d{4}-(0[1-9]|1[0-2])$/.test(sp.mes) ? sp.mes : today.slice(0, 7);
  const [y, m] = mes.split("-").map(Number);
  const cal = await getBillingCalendar(db, ctx.user.id, ctx.current.id, mes);
  const hol = await listHolidays(db, ctx.user.id, ctx.current.id, y);
  const manage = can(role, "contracts.approve");
  const byDate = new Map(cal.days.map((d) => [d.date, d]));
  const lead = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const cells: (number | null)[] = [...Array(lead).fill(null), ...Array.from({ length: daysInMonth(mes) }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);
  const events = cal.days.filter((d) => d.issue.length || d.due.length);

  return (
    <div className="space-y-5">
      <PageHeader title="Faturamento — calendário" description={`${ctx.current.name} · previsão de quando emitir boletos e notas e quando vencem. Nada é emitido aqui.`}
        actions={<><AppLink href="/faturamento/lotes" className={buttonClass("primary")}><ClipboardCheck className="size-4" aria-hidden /> Lotes</AppLink><AppLink href="/faturamento/ajustes" className={buttonClass("outline")}>Ajustes</AppLink><AppLink href="/faturamento/emissoes" className={buttonClass("outline")}>Emissões</AppLink><AppLink href="/contratos" className={buttonClass("outline")}><FileText className="size-4" aria-hidden /> Contratos</AppLink></>} />

      <nav aria-label="Mês" className="flex items-center justify-between gap-2">
        <AppLink href={`/faturamento?mes=${addMonths(mes, -1)}`} className={buttonClass("outline", "sm")}><ChevronLeft className="size-4" aria-hidden /> {MESES[(m + 10) % 12]}</AppLink>
        <h2 className="text-lg font-semibold" aria-live="polite">{MESES[m - 1][0].toUpperCase() + MESES[m - 1].slice(1)} de {y}</h2>
        <div className="flex gap-2">
          {mes !== today.slice(0, 7) && <AppLink href="/faturamento" className={buttonClass("ghost", "sm")}>Hoje</AppLink>}
          <AppLink href={`/faturamento?mes=${addMonths(mes, 1)}`} className={buttonClass("outline", "sm")}>{MESES[m % 12]} <ChevronRight className="size-4" aria-hidden /></AppLink>
        </div>
      </nav>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border bg-card p-4"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Emissões previstas</p><p className="num mt-1 text-2xl font-semibold">{cal.totals.issueCount}</p><p className="num text-sm text-muted-foreground">{formatBRL(cal.totals.issueCents)}</p></div>
        <div className="rounded-lg border bg-card p-4"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Vencimentos no mês</p><p className="num mt-1 text-2xl font-semibold">{cal.totals.dueCount}</p><p className="num text-sm text-muted-foreground">{formatBRL(cal.totals.dueCents)}</p></div>
        <div className="rounded-lg border bg-card p-4 sm:col-span-2"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Por lote de emissão</p>
          {cal.batches.length === 0 ? <p className="mt-1 text-sm text-muted-foreground">Nenhuma emissão neste mês.</p> : <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">{cal.batches.map((b) => <li key={String(b.batch)}><strong>{b.batch ? `Dia ${b.batch}` : "Personalizado"}</strong>: {b.count} · <span className="num">{formatBRL(b.cents)}</span></li>)}</ul>}
        </div>
      </div>

      {cal.review.length > 0 && (
        <section aria-label="Precisa de revisão" className="rounded-lg border border-warning/40 bg-warning-soft p-4 text-warning-foreground">
          <h2 className="flex items-center gap-2 font-semibold"><AlertTriangle className="size-4" aria-hidden /> Precisa de revisão humana ({cal.review.length})</h2>
          <ul className="mt-2 space-y-1 text-sm">{cal.review.map((i, k) => <li key={k}><AppLink href={`/contratos/${i.contractId}`} className="font-medium underline">{i.customerName}</AppLink> — {i.description}: {i.reason}</li>)}</ul>
          <p className="mt-2 text-xs">Esses itens não são emitidos automaticamente até a política ser definida (dia 31, meses curtos e feriados).</p>
        </section>
      )}

      <SectionCard title="Calendário">
        <div role="grid" aria-label={`Calendário de ${MESES[m - 1]} de ${y}`} className="grid grid-cols-7 gap-px overflow-hidden rounded-md border bg-border text-xs">
          {SEM.map((s) => <div key={s} role="columnheader" className="bg-muted px-1 py-1.5 text-center font-medium uppercase text-muted-foreground">{s}</div>)}
          {cells.map((n, idx) => {
            if (!n) return <div key={idx} className="min-h-14 bg-muted/40 sm:min-h-20" />;
            const iso = `${mes}-${pad(n)}`; const d = byDate.get(iso); const we = idx % 7 === 0 || idx % 7 === 6; const isToday = iso === today;
            const rev = d && [...d.issue, ...d.due].some((i) => i.review);
            return (
              <div key={idx} role="gridcell" aria-label={`${n} de ${MESES[m - 1]}${d?.holiday ? `, feriado: ${d.holiday}` : ""}${d?.issue.length ? `, ${d.issue.length} emissões` : ""}${d?.due.length ? `, ${d.due.length} vencimentos` : ""}`}
                className={cn("min-h-14 bg-card p-1 sm:min-h-20 sm:p-1.5", we && "bg-muted/50", d?.holiday && "bg-warning-soft/60")}>
                <div className="flex items-center justify-between"><span className={cn("num font-medium", isToday && "rounded-full bg-primary px-1.5 text-primary-foreground")}>{n}</span>{rev && <AlertTriangle className="size-3 text-warning-foreground" aria-label="precisa de revisão" />}</div>
                {d?.holiday && <p className="mt-0.5 hidden truncate text-[10px] text-warning-foreground sm:block">{d.holiday}</p>}
                {!!d?.issue.length && <p className="mt-0.5 rounded bg-primary-soft px-1 text-[10px] font-medium text-accent-foreground sm:text-xs">Emitir {d.issue.length}</p>}
                {!!d?.due.length && <p className="mt-0.5 rounded bg-info-soft px-1 text-[10px] font-medium text-info-foreground sm:text-xs">Vence {d.due.length}</p>}
              </div>
            );
          })}
        </div>
        <p className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground"><span><span className="mr-1 inline-block size-2 rounded-sm bg-primary-soft ring-1 ring-border" />Emissão de boleto/NF</span><span><span className="mr-1 inline-block size-2 rounded-sm bg-info-soft ring-1 ring-border" />Vencimento</span><span><span className="mr-1 inline-block size-2 rounded-sm bg-warning-soft ring-1 ring-border" />Feriado</span></p>
      </SectionCard>

      <SectionCard title="Agenda do mês" action={<CalendarClock className="size-4 text-muted-foreground" aria-hidden />}>
        {events.length === 0 ? (
          <EmptyState icon={Receipt} title="Nenhum evento neste mês" description="O calendário é montado a partir de contratos ativos de clientes ativos. Cadastre e aprove um contrato para ver as emissões previstas." action={<AppLink href="/contratos/novo" className={buttonClass("primary")}>Novo contrato</AppLink>} />
        ) : (
          <div className="space-y-4">
            {events.map((d) => (
              <section key={d.date} aria-label={dayLabel(d.date)}>
                <h3 className="text-sm font-semibold capitalize">{dayLabel(d.date)}{d.holiday && <span className="ml-2 font-normal text-warning-foreground">· feriado: {d.holiday}</span>}</h3>
                <ul className="divide-y divide-border">
                  {d.issue.map((i, k) => <ItemLine key={`i${k}`} i={i} kind="issue" />)}
                  {d.due.map((i, k) => <ItemLine key={`d${k}`} i={i} kind="due" />)}
                </ul>
              </section>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard title="Feriados desta empresa" className="scroll-mt-20">
        <div id="feriados" />
        <p className="mb-3 text-sm text-muted-foreground">Os feriados nacionais já estão no calendário. Cadastre aqui os municipais e estaduais: eles alteram a previsão e marcam emissões para revisão.</p>
        {sp.erro && <Callout tone="negative" role="alert" className="mb-3">{sp.erro}</Callout>}
        {hol.own.length === 0 ? <p className="text-sm text-muted-foreground">Nenhum feriado próprio cadastrado em {y}.</p> : (
          <ul className="mb-3 divide-y divide-border text-sm">{hol.own.map((h) => (
            <li key={h.id} className="flex items-center justify-between gap-2 py-2"><span>{h.day.split("-").reverse().join("/")} — {h.name}</span>
              {manage && <form action={removeHolidayAction}><input type="hidden" name="id" value={h.id} /><input type="hidden" name="mes" value={mes} /><button className={buttonClass("danger", "sm")}>Remover</button></form>}</li>))}</ul>
        )}
        {manage ? (
          <form action={addHolidayAction} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="mes" value={mes} />
            <div><label htmlFor="h-day" className="mb-1 block text-xs font-medium">Data</label><input id="h-day" name="day" type="date" required className={inputClass} /></div>
            <div className="min-w-[12rem] flex-1"><label htmlFor="h-name" className="mb-1 block text-xs font-medium">Nome</label><input id="h-name" name="name" required maxLength={80} placeholder="Ex.: Aniversário da cidade" className={inputClass} /></div>
            <button className={buttonClass("primary")}>Adicionar feriado</button>
          </form>
        ) : <p className="text-sm text-muted-foreground">Gerente ou diretoria cadastram feriados.</p>}
        <details className="mt-3 text-sm"><summary className="cursor-pointer text-primary">Feriados nacionais considerados em {y}</summary>
          <ul className="mt-2 grid gap-x-6 sm:grid-cols-2">{hol.national.map((h) => <li key={h.day}>{h.day.split("-").reverse().join("/")} — {h.name}</li>)}</ul></details>
      </SectionCard>
    </div>
  );
}
