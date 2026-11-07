import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { FILTER_LABEL, VIEW_FILTERS, coraInvoicesView } from "@/modules/receivables/cora-invoices";
import { Callout, Money, PageHeader, SectionCard, StatusPill, type StatusTone } from "@/components/k3g/primitives";
import { EmptyState } from "@/components/k3g/states";
import { AppLink } from "@/components/k3g/app-link";
import { SwitchForm } from "@/components/k3g/switch-form";
import { buttonClass, inputClass } from "@/components/k3g/button";
import { formatDateTime } from "@/lib/format";
import { overdueSwitchAction, refreshCoraAction } from "./actions";

const br = (d: string) => d.split("-").reverse().join("/");
const TONE: Record<string, StatusTone> = { LATE: "negative", OPEN: "info", IN_PAYMENT: "info", DRAFT: "neutral", PAID: "positive", CANCELLED: "neutral" };
const LABEL: Record<string, string> = { LATE: "Em atraso", OPEN: "A vencer", IN_PAYMENT: "Pagamento em andamento", DRAFT: "Rascunho", PAID: "Pago", CANCELLED: "Cancelado" };
const OK: Record<string, string> = { ligado: "Cobrança automática dos atrasados LIGADA para este cliente.", desligado: "Cobrança automática dos atrasados desligada para este cliente." };

export default async function BoletosCora({ searchParams }: { searchParams: Promise<{ filtro?: string; q?: string; ok?: string; erro?: string }> }) {
  const [sp, ctx] = await Promise.all([searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "receivables.read")) return <Callout tone="warning">Seu papel não tem acesso às contas a receber.</Callout>;
  const v = await coraInvoicesView(db, ctx.user.id, ctx.current.id, { filter: sp.filtro, q: sp.q });
  const canSwitch = can(role, "issuance.manage"), canRefresh = can(role, "issuance.run");
  const okMsg = sp.ok?.startsWith("atualizado:") ? `Atualizado: ${sp.ok.split(":")[1]} boleto(s) mudaram de situação (${sp.ok.split(":")[2]} pago(s)).` : sp.ok ? OK[sp.ok] : undefined;
  // agrupa por cliente (as linhas já vêm ordenadas por cliente)
  const groups: { id: string; name: string; auto: boolean; rows: typeof v.rows }[] = [];
  for (const r of v.rows) { const g = groups[groups.length - 1]; if (g && g.id === r.customer_id) g.rows.push(r); else groups.push({ id: r.customer_id, name: r.display_name, auto: r.overdue_collection, rows: [r] }); }

  return (
    <div className="space-y-5">
      <PageHeader title="Boletos da Cora" description={`${ctx.current.name} · tudo o que existe na Cora desde 01/01/2026, em qualquer situação. Só acompanhamento.`}
        actions={<span className="flex gap-2"><AppLink href="/contas-a-receber" className={buttonClass("outline")}>Contas a receber</AppLink>
          {canRefresh && <form action={refreshCoraAction}><input type="hidden" name="filtro" value={v.filter} /><button className={buttonClass("outline")}>Atualizar agora</button></form>}</span>} />
      {okMsg && <Callout tone="positive" role="status">{okMsg}</Callout>}
      {sp.erro && <Callout tone="negative" role="alert">{sp.erro}</Callout>}
      <Callout tone="info">São boletos <strong>emitidos fora da plataforma</strong> (e os que ela mesma emitiu), trazidos da Cora só para consulta. <strong>Nenhuma cobrança automática sai a partir deles:</strong> a chave de cada cliente, abaixo, nasce desligada e quem liga é a diretoria, um a um. A situação é conferida a cada 30 minutos e por aviso da Cora; boletos novos entram na importação diária.{v.lastSyncAt ? <> Última atualização: {formatDateTime(v.lastSyncAt)}.</> : null}</Callout>

      <section aria-label="Resumo" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Em atraso</p><Money cents={v.summary.late.cents} className="text-xl font-semibold text-negative-foreground" /><p className="text-xs text-muted-foreground">{v.summary.late.n} boleto(s)</p></div>
        <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">A vencer</p><Money cents={v.summary.open.cents} className="text-xl font-semibold" /><p className="text-xs text-muted-foreground">{v.summary.open.n} boleto(s)</p></div>
        <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Pagos</p><Money cents={v.summary.paid.cents} className="text-xl font-semibold" /><p className="text-xs text-muted-foreground">{v.summary.paid.n} boleto(s)</p></div>
        <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Cancelados</p><Money cents={v.summary.cancelled.cents} className="text-xl font-semibold" /><p className="text-xs text-muted-foreground">{v.summary.cancelled.n} boleto(s)</p></div>
      </section>

      <form className="flex flex-wrap items-end gap-3" aria-label="Filtros">
        <div><label htmlFor="filtro" className="mb-1 block text-xs font-medium">Situação</label>
          <select id="filtro" name="filtro" defaultValue={v.filter} className={inputClass}>{VIEW_FILTERS.map((f) => <option key={f} value={f}>{FILTER_LABEL[f]}</option>)}</select></div>
        <div><label htmlFor="q" className="mb-1 block text-xs font-medium">Cliente</label><input id="q" name="q" defaultValue={sp.q ?? ""} className={inputClass} placeholder="Nome" /></div>
        <button className={buttonClass("outline")}>Filtrar</button>
      </form>

      {groups.length === 0 ? <EmptyState title="Nenhum boleto neste filtro" description="Se a importação ainda não rodou, ela roda sozinha uma vez ao dia." /> : (
        <ul className="space-y-3">
          {groups.map((g) => (
            <li key={g.id} className="rounded-lg border bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <AppLink href={`/clientes/${g.id}`} className="font-semibold hover:underline">{g.name}</AppLink>
                <div className="flex items-center gap-3 text-sm">
                  <span className="text-muted-foreground">Cobrança automática dos atrasados:</span>
                  <SwitchForm action={overdueSwitchAction} label={`Cobrança automática dos atrasados de ${g.name}: ${g.auto ? "desligar" : "ligar"}`} on={g.auto} disabled={!canSwitch}
                    confirmMessage={g.auto ? undefined : `Ligar a cobrança automática dos atrasados de ${g.name}? Quando a cobrança de atrasados for ativada, este cliente passará a receber os avisos.`}>
                    <input type="hidden" name="customerId" value={g.id} /><input type="hidden" name="filtro" value={v.filter} />
                  </SwitchForm>
                  <span className="w-20 text-xs">{g.auto ? "Ligada" : "Desligada"}</span>
                </div>
              </div>
              <ul className="mt-2 divide-y divide-border text-sm">
                {g.rows.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>vence {br(r.due_date)}{r.daysLate > 0 ? ` · ${r.daysLate} dia(s) de atraso` : ""}{r.paid_on ? ` · pago em ${br(r.paid_on)}` : ""}{r.charge_id ? " · emitido pela plataforma" : ""}</span>
                    <span className="flex items-center gap-3"><StatusPill tone={TONE[r.status] ?? "neutral"}>{LABEL[r.status] ?? r.status}</StatusPill><Money cents={r.paid_cents > r.total_cents ? r.paid_cents : r.total_cents} className="font-medium" /></span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {v.truncated && <Callout tone="warning">Mostrando os 1.500 primeiros boletos: refine o filtro.</Callout>}
      {!canSwitch && <p className="text-xs text-muted-foreground">Seu papel só vê as chaves; quem liga a cobrança automática de um cliente é a diretoria.</p>}
    </div>
  );
}
