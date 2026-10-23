import { ChevronLeft, ChevronRight, ClipboardCheck } from "lucide-react";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { getBillingCalendar } from "@/modules/billing/service";
import { listBatches } from "@/modules/billing/batches";
import { addMonths } from "@/modules/billing/calendar";
import { Callout, Money, PageHeader, SectionCard, StatusPill } from "@/components/k3g/primitives";
import { EmptyState } from "@/components/k3g/states";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass } from "@/components/k3g/button";
import { generateAction } from "./actions";
import { STATUS_LABEL, STATUS_TONE } from "./status";

const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const br = (d: string) => d.split("-").reverse().join("/");

export default async function Lotes({ searchParams }: { searchParams: Promise<{ mes?: string; erro?: string }> }) {
  const [sp, ctx] = await Promise.all([searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "billing.read")) return <Callout tone="warning">Seu papel não tem acesso aos lotes de cobrança.</Callout>;
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Manaus" });
  const mes = sp.mes && /^\d{4}-(0[1-9]|1[0-2])$/.test(sp.mes) ? sp.mes : today.slice(0, 7);
  const [y, m] = mes.split("-").map(Number);
  const [cal, batches] = await Promise.all([getBillingCalendar(db, ctx.user.id, ctx.current.id, mes), listBatches(db, ctx.user.id, ctx.current.id)]);
  const byDate = new Map(batches.map((b) => [b.issueDate, b]));
  const days = cal.days.filter((d) => d.issue.length > 0);
  const write = can(role, "billing.write");

  return (
    <div className="space-y-5">
      <PageHeader title="Lotes de cobrança" description={`${ctx.current.name} · prévia e aprovação humana antes de qualquer emissão.`}
        actions={<AppLink href="/faturamento" className={buttonClass("outline")}>Calendário</AppLink>} />
      <Callout tone="info">Simulação: gerar prévia e aprovar <strong>não emite</strong> boleto, nota fiscal nem mensagem. A emissão real só será ligada em uma fase própria, com credenciais e autorização.</Callout>
      {sp.erro && <Callout tone="negative" role="alert">{sp.erro}</Callout>}

      <nav aria-label="Mês" className="flex items-center justify-between gap-2">
        <AppLink href={`/faturamento/lotes?mes=${addMonths(mes, -1)}`} className={buttonClass("outline", "sm")}><ChevronLeft className="size-4" aria-hidden /> {MESES[(m + 10) % 12]}</AppLink>
        <h2 className="text-lg font-semibold" aria-live="polite">{MESES[m - 1][0].toUpperCase() + MESES[m - 1].slice(1)} de {y}</h2>
        <AppLink href={`/faturamento/lotes?mes=${addMonths(mes, 1)}`} className={buttonClass("outline", "sm")}>{MESES[m % 12]} <ChevronRight className="size-4" aria-hidden /></AppLink>
      </nav>

      <SectionCard title="Datas de emissão do mês">
        {days.length === 0 ? (
          <EmptyState icon={ClipboardCheck} title="Nenhuma emissão neste mês" description="Cadastre e aprove contratos de clientes ativos para ver as datas de emissão." action={<AppLink href="/contratos" className={buttonClass("outline")}>Contratos</AppLink>} />
        ) : (
          <ul className="divide-y divide-border">
            {days.map((d) => {
              const ok = d.issue.filter((i) => !i.review); const rev = d.issue.length - ok.length; const b = byDate.get(d.date);
              return (
                <li key={d.date} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                  <div>
                    <p className="font-medium">{br(d.date)} · {ok.length} cobrança{ok.length === 1 ? "" : "s"} <Money cents={ok.reduce((s, i) => s + i.amountCents, 0)} className="ml-1 text-muted-foreground" /></p>
                    {rev > 0 && <p className="text-xs text-warning-foreground">{rev} item(ns) em revisão ficam fora do lote{d.holiday ? ` (feriado: ${d.holiday})` : ""}</p>}
                  </div>
                  <div className="flex items-center gap-2">
                    {b && <StatusPill tone={STATUS_TONE[b.status as keyof typeof STATUS_TONE]}>{STATUS_LABEL[b.status as keyof typeof STATUS_LABEL]}</StatusPill>}
                    {b && <AppLink href={`/faturamento/lotes/${b.id}`} className={buttonClass("outline", "sm")}>Abrir</AppLink>}
                    {write && ok.length > 0 && (!b || b.status === "rascunho") && (
                      <form action={generateAction}><input type="hidden" name="mes" value={mes} /><input type="hidden" name="issueDate" value={d.date} />
                        <button className={buttonClass("primary", "sm")}>{b ? "Atualizar prévia" : "Gerar prévia"}</button></form>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="Lotes criados">
        {batches.length === 0 ? <p className="text-sm text-muted-foreground">Nenhum lote criado ainda.</p> : (
          <ul className="divide-y divide-border">
            {batches.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                <AppLink href={`/faturamento/lotes/${b.id}`} className="font-medium hover:underline">Emissão {br(b.issueDate)}</AppLink>
                <span className="flex items-center gap-3"><span className="text-muted-foreground">{b.count} cobrança{b.count === 1 ? "" : "s"}</span><Money cents={b.totalCents} /><StatusPill tone={STATUS_TONE[b.status as keyof typeof STATUS_TONE]}>{STATUS_LABEL[b.status as keyof typeof STATUS_LABEL]}</StatusPill></span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
