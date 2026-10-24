import { Download, HandCoins } from "lucide-react";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { listPartners, listStatements, monthView, sumCents } from "@/modules/commissions/service";
import { percentLabel, previousMonth } from "@/modules/commissions/calc";
import { todayManaus } from "@/modules/messaging/service";
import { Callout, Money, PageHeader, SectionCard, StatusPill } from "@/components/k3g/primitives";
import { EmptyState } from "@/components/k3g/states";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass, inputClass } from "@/components/k3g/button";
import { formatDate } from "@/lib/format";
import { cancelAction, closeAction, paidAction } from "./actions";

const mesLabel = (m: string) => `${m.slice(5, 7)}/${m.slice(0, 4)}`;
const STATUS_TONE = { fechado: "info", pago: "positive", cancelado: "neutral" } as const;
const STATUS_LABEL = { fechado: "Fechado, a pagar", pago: "Pago", cancelado: "Cancelado" } as const;

export default async function Comissoes({ searchParams }: { searchParams: Promise<{ parceiro?: string; mes?: string; erro?: string; ok?: string }> }) {
  const [sp, ctx] = await Promise.all([searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "commissions.read")) return <Callout tone="warning">Seu papel não tem acesso às comissões.</Callout>;
  const manage = can(role, "commissions.manage");
  const today = todayManaus();
  const partners = await listPartners(db, ctx.user.id, ctx.current.id);
  if (partners.length === 0) {
    return (
      <div className="space-y-4">
        <PageHeader title="Comissões" description={`${ctx.current.name}`} />
        <EmptyState icon={HandCoins} title="Nenhum contrato com parceiro de comissão" description="Abra um contrato e, no bloco Comissão, informe o parceiro e o percentual." />
      </div>
    );
  }
  const partner = partners.find((p) => p.partner === sp.parceiro)?.partner ?? partners[0].partner;
  const mes = sp.mes && /^\d{4}-(0[1-9]|1[0-2])$/.test(sp.mes) ? sp.mes : previousMonth(today);
  const [v, history] = await Promise.all([monthView(db, ctx.user.id, ctx.current.id, partner, mes), listStatements(db, ctx.user.id, ctx.current.id, partner)]);
  const info = partners.find((p) => p.partner === partner)!;
  const closedLines = v.statement ? v.closed : [];
  const monthOver = mes < today.slice(0, 7);
  const csv = `/comissoes/exportar?parceiro=${encodeURIComponent(partner)}&mes=${mes}`;
  const hidden = <><input type="hidden" name="partner" value={partner} /><input type="hidden" name="month" value={mes} /></>;
  return (
    <div className="space-y-4">
      <PageHeader title="Comissões" description={`${ctx.current.name} · percentual de cada contrato sobre o valor mensal, das cobranças recebidas no mês. Pagamento no dia 16 do mês seguinte.`} />
      {sp.erro && <Callout tone="negative" role="alert">{sp.erro}</Callout>}
      {sp.ok && <Callout tone="positive" role="status">{sp.ok === "fechado" ? "Mês fechado." : sp.ok === "pago" ? "Pagamento registrado." : "Fechamento cancelado."}</Callout>}
      <form className="flex flex-wrap items-center gap-2" role="search">
        <label htmlFor="parceiro" className="sr-only">Parceiro</label>
        <select id="parceiro" name="parceiro" defaultValue={partner} className={inputClass + " max-w-[14rem]"}>{partners.map((p) => <option key={p.partner} value={p.partner}>{p.partner}</option>)}</select>
        <label htmlFor="mes" className="text-sm text-muted-foreground">Recebido em</label>
        <input id="mes" name="mes" type="month" defaultValue={mes} className={inputClass + " max-w-[10rem]"} />
        <button className={buttonClass("outline")}>Ver</button>
      </form>
      {info.withoutPercent > 0 && <Callout tone="warning">{info.withoutPercent} contrato(s) de {partner} estão sem percentual. Eles ficam fora do cálculo e impedem o fechamento: abra cada contrato e preencha o bloco Comissão.</Callout>}

      <SectionCard title={`${partner} · recebido em ${mesLabel(mes)} · pagar em ${formatDate(v.payDate)}`}>
        {v.statement ? (
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            <StatusPill tone={STATUS_TONE[v.statement.status]}>{STATUS_LABEL[v.statement.status]}</StatusPill>
            <span>Total <Money cents={v.statement.totalCents} className="font-semibold" /></span>
            {v.statement.paidOn && <span className="text-muted-foreground">pago em {formatDate(v.statement.paidOn)}{v.statement.paidNote ? ` · ${v.statement.paidNote}` : ""}</span>}
          </div>
        ) : null}
        {v.reversedChargeIds.length > 0 && <Callout tone="warning">{v.reversedChargeIds.length} cobrança(s) deste fechamento tiveram a baixa estornada ou a cobrança cancelada depois do fechamento. O fechamento não muda sozinho. Se ainda não foi pago, cancele e feche de novo; se já foi pago, acerte a diferença com o parceiro no próximo pagamento.</Callout>}
        {closedLines.length > 0 && <Lines lines={closedLines} reversed={new Set(v.reversedChargeIds)} />}
        {!v.statement && v.pending.length === 0 && v.missing.length === 0 && <EmptyState title="Nada recebido neste mês" description="Nenhuma cobrança de contrato deste parceiro foi quitada neste mês." />}
        {v.statement && v.pending.length > 0 && (
          <div className="mt-3 space-y-2"><Callout tone="warning">{v.pending.length} cobrança(s) quitadas neste mês ainda não entraram no fechamento (baixa lançada depois). Elas valem <Money cents={v.pendingTotalCents} className="font-semibold" />. {v.statement.status === "fechado" ? "Cancele o fechamento e feche de novo para incluí-las." : "Como o fechamento já foi pago, avise a diretoria."}</Callout><Lines lines={v.pending} /></div>
        )}
        {!v.statement && v.pending.length > 0 && (
          <>
            <Lines lines={v.pending} />
            <p className="mt-3 text-sm">Total a pagar: <Money cents={sumCents(v.pending)} className="font-semibold" /> <span className="text-muted-foreground">(prévia: ainda não fechado)</span></p>
          </>
        )}
        {v.missing.length > 0 && (
          <div className="mt-3"><Callout tone="warning">Recebidos sem percentual (fora da conta):
            <ul className="mt-1 list-disc pl-5">{v.missing.map((m) => <li key={m.contractId}><AppLink href={`/contratos/${m.contractId}`} className="underline">{m.customerName}</AppLink></li>)}</ul></Callout></div>
        )}
        <div className="mt-4 flex flex-wrap items-start gap-3">
          {(v.statement || v.pending.length > 0) && <a href={csv} className={buttonClass("outline")}><Download className="size-4" aria-hidden /> Baixar CSV</a>}
          {manage && !v.statement && v.pending.length > 0 && (
            monthOver
              ? <form action={closeAction}>{hidden}<button className={buttonClass("primary")}>Fechar o mês</button></form>
              : <p className="text-sm text-muted-foreground">O mês ainda não terminou: o fechamento fica disponível a partir do dia 1 do mês seguinte.</p>
          )}
        </div>
        {manage && v.statement?.status === "fechado" && (
          <div className="mt-4 grid gap-4 border-t pt-4 sm:grid-cols-2">
            <form action={paidAction} className="space-y-2">{hidden}<input type="hidden" name="statementId" value={v.statement.id} />
              <p className="text-sm font-medium">Registrar que foi pago</p>
              <p className="text-xs text-muted-foreground">O sistema não paga: faça o pagamento no banco e registre aqui.</p>
              <label htmlFor="paidOn" className="sr-only">Data do pagamento</label><input id="paidOn" name="paidOn" type="date" required defaultValue={v.payDate <= today ? v.payDate : today} max={today} className={inputClass} />
              <label htmlFor="note" className="sr-only">Observação</label><input id="note" name="note" maxLength={200} placeholder="Observação (opcional)" className={inputClass} />
              <button className={buttonClass("success")}>Marcar como pago</button>
            </form>
            <form action={cancelAction} className="space-y-2">{hidden}<input type="hidden" name="statementId" value={v.statement.id} />
              <p className="text-sm font-medium">Cancelar o fechamento</p>
              <p className="text-xs text-muted-foreground">Fica no histórico. As cobranças voltam a poder entrar em outro fechamento.</p>
              <label htmlFor="reason" className="sr-only">Motivo</label><input id="reason" name="reason" required minLength={3} maxLength={200} placeholder="Motivo" className={inputClass} />
              <button className={buttonClass("danger")}>Cancelar fechamento</button>
            </form>
          </div>
        )}
      </SectionCard>

      <SectionCard title="Histórico de fechamentos">
        {history.length === 0 ? <p className="text-sm text-muted-foreground">Nenhum fechamento ainda.</p> : (
          <ul className="divide-y divide-border text-sm">
            {history.map((h) => (
              <li key={h.id}><AppLink href={`/comissoes?parceiro=${encodeURIComponent(partner)}&mes=${h.month}`} className="flex flex-wrap items-center justify-between gap-2 py-2 hover:bg-accent">
                <span>Recebido em {mesLabel(h.month)} · {h.lines} cobrança(s) · pagar em {formatDate(h.payDate)}</span>
                <span className="flex items-center gap-2"><StatusPill tone={STATUS_TONE[h.status]}>{STATUS_LABEL[h.status]}</StatusPill><Money cents={h.totalCents} className="font-semibold" /></span>
              </AppLink></li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

function Lines({ lines, reversed = new Set<string>() }: { lines: { chargeId: string; customerName: string; competenceMonth: string; receivedOn: string; baseCents: number; bps: number; commissionCents: number }[]; reversed?: Set<string> }) {
  return (
    <ul className="divide-y divide-border text-sm">
      {lines.map((l) => (
        <li key={l.chargeId} className="flex flex-wrap items-center justify-between gap-2 py-2">
          <div className="min-w-0"><p className="truncate font-medium">{l.customerName}</p><p className="text-muted-foreground">competência {mesLabel(l.competenceMonth.slice(0, 7))} · recebido em {formatDate(l.receivedOn)} · <Money cents={l.baseCents} /> × {percentLabel(l.bps)}</p></div>
          <div className="flex items-center gap-2">{reversed.has(l.chargeId) && <StatusPill tone="warning">baixa estornada ou cobrança cancelada</StatusPill>}<Money cents={l.commissionCents} className="font-semibold" /></div>
        </li>
      ))}
    </ul>
  );
}
