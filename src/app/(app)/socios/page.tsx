import { Download, Scale } from "lucide-react";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { listCategories } from "@/modules/expenses/catalog";
import { ENTRY_KINDS, listEntries, partnerBalances } from "@/modules/expenses/ledger";
import { todayManaus } from "@/modules/messaging/service";
import { formatBRL, formatDate } from "@/lib/format";
import { Callout, PageHeader, SectionCard, StatusPill } from "@/components/k3g/primitives";
import { EmptyState } from "@/components/k3g/states";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass, inputClass, selectClass } from "@/components/k3g/button";
import { EntryForm } from "./entry-form";
import { reverseEntryAction } from "./actions";

export default async function Socios({ searchParams }: { searchParams: Promise<{ socio?: string; mes?: string; situacao?: string; erro?: string; ok?: string }> }) {
  const [sp, ctx] = await Promise.all([searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "partners.read")) return <Callout tone="warning">Seu papel não tem acesso à conta-corrente dos sócios.</Callout>;
  const manage = can(role, "partners.manage");
  const today = todayManaus();
  const f = { partnerId: sp.socio, month: sp.mes, status: sp.situacao };
  const [balances, entries, categories] = await Promise.all([partnerBalances(db, ctx.user.id, ctx.current.id, today), listEntries(db, ctx.user.id, ctx.current.id, f), listCategories(db, ctx.user.id, ctx.current.id)]);
  const active = balances.filter((b) => b.active);
  const qs = new URLSearchParams(Object.entries({ socio: sp.socio, mes: sp.mes, situacao: sp.situacao }).filter(([, v]) => v) as [string, string][]).toString();
  return (
    <div className="space-y-5">
      <PageHeader title="Sócios e retiradas" description={ctx.current.name}
        actions={<div className="flex flex-wrap gap-2"><AppLink href="/socios/plano" className={buttonClass("primary")}>Plano de retiradas e lucro</AppLink><AppLink href={`/socios/exportar${qs ? `?${qs}` : ""}`} className={buttonClass("outline")}><Download className="size-4" aria-hidden /> Baixar CSV</AppLink></div>} />
      <Callout tone="info">Aqui se <strong>registra</strong> o que a empresa pagou de gasto pessoal dos sócios (retirada) e o que os sócios pagaram pela empresa. Nada é pago por este sistema. O saldo mostra o quanto cada sócio deve à empresa (a compensar na distribuição de lucros) ou o quanto a empresa deve a ele.</Callout>
      {sp.erro && <Callout tone="negative" role="alert">{sp.erro}</Callout>}
      {sp.ok && <Callout tone="positive" role="status">Lançamento estornado.</Callout>}

      {balances.length === 0 ? (
        <EmptyState icon={Scale} title="Nenhum sócio cadastrado" description={can(role, "partners.manage") ? "Cadastre os sócios em Configurações → Despesas." : "Peça à diretoria para cadastrar os sócios em Configurações → Despesas."} />
      ) : (
        <section aria-label="Saldo dos sócios" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {balances.map((b) => (
            <div key={b.partnerId} className="rounded-lg border bg-card p-4">
              <div className="flex items-center justify-between gap-2"><h2 className="font-semibold">{b.name}</h2>{!b.active && <StatusPill tone="neutral">inativo</StatusPill>}</div>
              <p className="mt-2 text-xs uppercase tracking-wide text-muted-foreground">Saldo com a empresa</p>
              <p className={`text-2xl font-semibold ${b.balanceCents < 0 ? "text-negative-foreground" : ""}`}>{formatBRL(Math.abs(b.balanceCents))}</p>
              <p className="text-xs text-muted-foreground">{b.balanceCents < 0 ? "o sócio deve à empresa (a compensar nos lucros)" : b.balanceCents > 0 ? "a empresa deve ao sócio" : "sem saldo"}</p>
              <dl className="mt-3 grid grid-cols-2 gap-2 text-sm"><div><dt className="text-xs text-muted-foreground">Retiradas no mês</dt><dd className="font-medium">{formatBRL(b.withdrawnMonthCents)}</dd></div><div><dt className="text-xs text-muted-foreground">Retiradas no ano</dt><dd className="font-medium">{formatBRL(b.withdrawnYearCents)}</dd></div></dl>
              {b.toClassifyCount > 0 && <p className="mt-3 text-xs text-warning-foreground">{b.toClassifyCount} lançamento(s) a classificar ({formatBRL(b.toClassifyCents)})</p>}
            </div>
          ))}
        </section>
      )}

      {manage && active.length > 0 && (
        <SectionCard title="Novo lançamento"><EntryForm partners={active.map((b) => ({ id: b.partnerId, name: b.name }))} categories={categories.map((c) => ({ id: c.id, name: c.name, kind: c.kind }))} today={today} /></SectionCard>
      )}

      <SectionCard title="Lançamentos">
        <form className="mb-4 flex flex-wrap items-end gap-3" method="get">
          <div><label htmlFor="f-socio" className="mb-1 block text-xs font-medium">Sócio</label><select id="f-socio" name="socio" defaultValue={sp.socio ?? ""} className={selectClass}><option value="">Todos</option>{balances.map((b) => <option key={b.partnerId} value={b.partnerId}>{b.name}</option>)}</select></div>
          <div><label htmlFor="f-mes" className="mb-1 block text-xs font-medium">Mês</label><input id="f-mes" name="mes" type="month" defaultValue={sp.mes ?? ""} className={inputClass} /></div>
          <div><label htmlFor="f-sit" className="mb-1 block text-xs font-medium">Situação</label><select id="f-sit" name="situacao" defaultValue={sp.situacao ?? ""} className={selectClass}><option value="">Todas</option><option value="ativo">Ativos</option><option value="estornado">Estornados</option></select></div>
          <button className={buttonClass("outline")}>Filtrar</button>
        </form>
        {entries.length === 0 ? <p className="text-sm text-muted-foreground">Nenhum lançamento neste filtro.</p> : (
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead><tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground"><th className="py-2 pr-3">Data</th><th className="pr-3">Sócio</th><th className="pr-3">Tipo</th><th className="pr-3">Categoria</th><th className="pr-3">Descrição</th><th className="pr-3 text-right">Efeito no saldo</th><th /></tr></thead>
            <tbody className="divide-y divide-border">
              {entries.map((e) => (
                <tr key={e.id} className={e.status === "estornado" ? "text-muted-foreground line-through" : ""}>
                  <td className="py-2 pr-3 whitespace-nowrap">{formatDate(e.occurredOn)}</td><td className="pr-3">{e.partnerName}</td><td className="pr-3">{ENTRY_KINDS[e.kind].label}</td>
                  <td className="pr-3">{e.categoryName ?? "—"}{e.toClassify && e.status === "ativo" && <span className="ml-1 no-underline"><StatusPill tone="warning">a classificar</StatusPill></span>}</td>
                  <td className="pr-3">{e.description}{e.reverseReason && <span className="block text-xs">estornado: {e.reverseReason}</span>}</td>
                  <td className={`pr-3 text-right whitespace-nowrap ${e.signedCents < 0 ? "text-negative-foreground" : ""}`}>{e.signedCents < 0 ? "−" : "+"} {formatBRL(Math.abs(e.signedCents))}</td>
                  <td className="text-right">{manage && e.status === "ativo" && (
                    <details className="inline-block text-left"><summary className="cursor-pointer text-xs text-negative-foreground">Estornar</summary>
                      <form action={reverseEntryAction} className="mt-2 flex gap-2"><input type="hidden" name="id" value={e.id} /><input name="reason" required minLength={3} maxLength={200} placeholder="Motivo" aria-label="Motivo do estorno" className={inputClass} /><button className={buttonClass("danger", "sm")}>Confirmar</button></form></details>)}</td>
                </tr>
              ))}
            </tbody></table></div>
        )}
        <p className="mt-3 text-xs text-muted-foreground">Mostra até 500 lançamentos. Lançamentos não se apagam: erro se corrige estornando e lançando de novo.</p>
      </SectionCard>
    </div>
  );
}
