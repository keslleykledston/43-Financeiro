import { ReceiptText } from "lucide-react";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { getPayablesSettings, listPayables, payablesSummary } from "@/modules/payables/service";
import { FILTERS, FILTER_LABEL, SITUATION_LABEL, type Filter, type Situation } from "@/modules/payables/status";
import { Callout, Money, PageHeader, SectionCard, StatusPill, type StatusTone } from "@/components/k3g/primitives";
import { EmptyState } from "@/components/k3g/states";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass, inputClass, selectClass } from "@/components/k3g/button";
import { saveSettingsAction } from "./actions";

const TONE: Record<Situation, StatusTone> = { rascunho: "neutral", aguardando: "info", a_vencer: "info", vencida: "negative", parcial: "warning", paga: "positive", rejeitada: "neutral", cancelada: "neutral" };
const br = (d: string) => d.split("-").reverse().join("/");
type SP = { status?: string; q?: string; de?: string; ate?: string; erro?: string; ok?: string };

export default async function ContasAPagar({ searchParams }: { searchParams: Promise<SP> }) {
  const [sp, ctx] = await Promise.all([searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "payables.read")) return <Callout tone="warning">Seu papel não tem acesso às contas a pagar.</Callout>;
  const status: Filter = (FILTERS as readonly string[]).includes(sp.status ?? "") ? (sp.status as Filter) : "abertas";
  const [sum, rows, st] = await Promise.all([payablesSummary(db, ctx.user.id, ctx.current.id), listPayables(db, ctx.user.id, ctx.current.id, { status, q: sp.q, dueFrom: sp.de, dueTo: sp.ate }), getPayablesSettings(db, ctx.user.id, ctx.current.id)]);
  const qs = new URLSearchParams(Object.entries({ status, q: sp.q ?? "", de: sp.de ?? "", ate: sp.ate ?? "" }).filter(([, v]) => v));
  const write = can(role, "payables.write"), manage = can(role, "payables.manage");

  return (
    <div className="space-y-5">
      <PageHeader title="Contas a pagar" description={`${ctx.current.name} · lançamento, aprovação e controle da execução manual no banco.`}
        actions={<div className="flex flex-wrap gap-2">
          {write && <AppLink href="/contas-a-pagar/novo" className={buttonClass("primary")}>Nova conta</AppLink>}
          <AppLink href="/contas-a-pagar/execucao" className={buttonClass("outline")}>Fila de execução</AppLink>
          <AppLink href="/contas-a-pagar/calendario" className={buttonClass("outline")}>Calendário</AppLink>
          <AppLink href="/contas-a-pagar/recorrentes" className={buttonClass("outline")}>Recorrentes e parcelas</AppLink>
          {can(role, "payables.export") && <a href={`/contas-a-pagar/exportar?${qs}`} className={buttonClass("outline")}>Exportar CSV</a>}
        </div>} />
      <Callout tone="info">Este sistema <strong>não executa pagamentos</strong>. Ele organiza e aprova as contas; quem tem alçada paga no banco (Cora) e depois registra a baixa aqui.</Callout>
      {sp.erro && <Callout tone="negative" role="alert">{sp.erro}</Callout>}
      {sp.ok === "config" && <Callout tone="positive" role="status">Configuração salva.</Callout>}

      <section aria-label="Resumo" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Aprovadas a pagar</p><Money cents={sum.approvedOpenCents} className="text-xl font-semibold" /><p className="text-xs text-muted-foreground">{sum.dueSoonCount} vencem em até 3 dias</p></div>
        <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Vencidas</p><Money cents={sum.overdueCents} className="text-xl font-semibold text-negative-foreground" /><p className="text-xs text-muted-foreground">{sum.overdueCount} conta(s)</p></div>
        <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Aguardando aprovação</p><Money cents={sum.pendingCents} className="text-xl font-semibold" /><p className="text-xs text-muted-foreground">{sum.pendingCount} conta(s)</p></div>
        <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Pago no mês</p><Money cents={sum.paidMonthCents} className="text-xl font-semibold" /><p className="text-xs text-muted-foreground">baixas ativas registradas</p></div>
      </section>

      <SectionCard title="Contas">
        <form method="get" className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div className="lg:col-span-2"><label htmlFor="q" className="mb-1 block text-xs font-medium">Fornecedor ou descrição</label><input id="q" name="q" defaultValue={sp.q ?? ""} maxLength={80} className={inputClass} /></div>
          <div><label htmlFor="status" className="mb-1 block text-xs font-medium">Situação</label><select id="status" name="status" defaultValue={status} className={`${selectClass} w-full`}>{FILTERS.map((s) => <option key={s} value={s}>{FILTER_LABEL[s]}</option>)}</select></div>
          <div><label htmlFor="de" className="mb-1 block text-xs font-medium">Vence de</label><input id="de" name="de" type="date" defaultValue={sp.de ?? ""} className={inputClass} /></div>
          <div><label htmlFor="ate" className="mb-1 block text-xs font-medium">até</label><input id="ate" name="ate" type="date" defaultValue={sp.ate ?? ""} className={inputClass} /></div>
          <div className="flex gap-2 sm:col-span-2 lg:col-span-5"><button className={buttonClass("primary", "sm")}>Filtrar</button><AppLink href="/contas-a-pagar" className={buttonClass("ghost", "sm")}>Limpar</AppLink></div>
        </form>
        {rows.length === 0 ? (
          <EmptyState icon={ReceiptText} title="Nenhuma conta neste filtro" description="Lance a primeira conta a pagar ou mude o filtro." action={write ? <AppLink href="/contas-a-pagar/novo" className={buttonClass("outline")}>Nova conta</AppLink> : undefined} />
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                <div><AppLink href={`/contas-a-pagar/${r.id}`} className="font-medium hover:underline">{r.vendorName}</AppLink>
                  <p className="text-xs text-muted-foreground">{r.description}{r.documentNumber ? ` · doc. ${r.documentNumber}` : ""} · vence {br(r.dueDate)}{r.overdueDays > 0 ? ` · ${r.overdueDays} dia(s) de atraso` : ""}</p></div>
                <span className="flex items-center gap-3"><Money cents={r.status === "aprovado" ? r.openCents || r.amountCents : r.amountCents} /><StatusPill tone={TONE[r.situation]}>{SITUATION_LABEL[r.situation]}</StatusPill></span>
              </li>
            ))}
          </ul>
        )}
        {rows.length === 500 && <p className="mt-3 text-xs text-muted-foreground">Mostrando as 500 primeiras. Refine o filtro ou exporte o CSV.</p>}
      </SectionCard>

      <SectionCard title="Alçada de aprovação">
        <form action={saveSettingsAction} className="flex flex-wrap items-end gap-4">
          <div><label htmlFor="managerLimit" className="mb-1 block text-xs font-medium">Limite do gerente (R$)</label><input id="managerLimit" name="managerLimit" inputMode="decimal" defaultValue={(st.managerLimitCents / 100).toFixed(2).replace(".", ",")} disabled={!manage} className={`${inputClass} w-40`} /></div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="directorSelfApproval" defaultChecked={st.directorSelfApproval} disabled={!manage} className="size-4 accent-primary" /> Diretoria pode aprovar o que ela mesma lançou</label>
          {manage ? <button className={buttonClass("outline", "sm")}>Salvar</button> : <span className="text-xs text-muted-foreground">Só a diretoria altera.</span>}
        </form>
        <p className="mt-2 text-xs text-muted-foreground">Gerente aprova até o limite; acima disso, só a diretoria. Ninguém aprova o que lançou (a diretoria só se esta chave estiver ligada; fica registrado).</p>
      </SectionCard>
    </div>
  );
}
