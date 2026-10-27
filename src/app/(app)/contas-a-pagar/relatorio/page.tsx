import { ArrowLeft, Download } from "lucide-react";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { spendReport, type SpendBasis } from "@/modules/payables/report";
import { todayManaus } from "@/modules/messaging/service";
import { formatBRL } from "@/lib/format";
import { Callout, PageHeader, SectionCard } from "@/components/k3g/primitives";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass, inputClass } from "@/components/k3g/button";

const mes = (m: string) => `${m.slice(5)}/${m.slice(2, 4)}`;

export default async function Relatorio({ searchParams }: { searchParams: Promise<{ de?: string; ate?: string; base?: string }> }) {
  const [sp, ctx] = await Promise.all([searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "payables.read")) return <Callout tone="warning">Seu papel não tem acesso às contas a pagar.</Callout>;
  let rep: Awaited<ReturnType<typeof spendReport>> | null = null, erro = "";
  try { rep = await spendReport(db, ctx.user.id, ctx.current.id, { from: sp.de, to: sp.ate, basis: sp.base }, todayManaus()); } catch (e) { erro = e instanceof Error ? e.message : "Período inválido"; }
  const basis: SpendBasis = sp.base === "competencia" ? "competencia" : "pago";
  const qs = new URLSearchParams({ de: rep?.from ?? sp.de ?? "", ate: rep?.to ?? sp.ate ?? "", base: basis }).toString();
  const table = (title: string, lines: NonNullable<typeof rep>["categories"], showGroup: boolean) => (
    <SectionCard title={title}>
      {lines.length === 0 ? <p className="text-sm text-muted-foreground">Nada no período.</p> : (
        <div className="overflow-x-auto"><table className="w-full text-sm" style={{ minWidth: `${14 + rep!.months.length * 5}rem` }}>
          <thead><tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground"><th className="py-2 pr-3">{showGroup ? "Categoria" : "Centro"}</th>{rep!.months.map((m) => <th key={m} className="pr-3 text-right">{mes(m)}</th>)}<th className="text-right">Total</th></tr></thead>
          <tbody className="divide-y divide-border">{lines.map((l) => <tr key={l.key}><td className="py-1.5 pr-3">{l.name}{showGroup && l.group && <span className="ml-1 text-xs text-muted-foreground">· {l.group}</span>}</td>{l.byMonth.map((c, k) => <td key={k} className="pr-3 text-right">{c ? formatBRL(c) : "–"}</td>)}<td className="text-right font-medium">{formatBRL(l.totalCents)}</td></tr>)}</tbody>
          <tfoot><tr className="border-t font-medium"><td className="py-1.5 pr-3">Total</td>{rep!.totalByMonth.map((c, k) => <td key={k} className="pr-3 text-right">{formatBRL(c)}</td>)}<td className="text-right">{formatBRL(rep!.totalCents)}</td></tr></tfoot></table></div>
      )}
    </SectionCard>
  );
  return (
    <div className="max-w-6xl space-y-5">
      <PageHeader title="Despesas por categoria" description={`${ctx.current.name} · contas a pagar por mês, categoria e centro de custo`} actions={<AppLink href="/contas-a-pagar" className={buttonClass("outline")}><ArrowLeft className="size-4" aria-hidden /> Contas a pagar</AppLink>} />
      <form method="get" className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-4">
        <div><label htmlFor="de" className="mb-1 block text-xs text-muted-foreground">De (mês)</label><input id="de" name="de" type="month" defaultValue={rep?.from ?? sp.de} className={inputClass} /></div>
        <div><label htmlFor="ate" className="mb-1 block text-xs text-muted-foreground">Até (mês)</label><input id="ate" name="ate" type="month" defaultValue={rep?.to ?? sp.ate} className={inputClass} /></div>
        <div><label htmlFor="base" className="mb-1 block text-xs text-muted-foreground">Contar por</label><select id="base" name="base" defaultValue={basis} className={inputClass}><option value="pago">Data do pagamento (o que saiu do caixa)</option><option value="competencia">Competência (contas aprovadas)</option></select></div>
        <button className={buttonClass("primary")}>Ver</button>
        {rep && can(role, "payables.export") && <a href={`/contas-a-pagar/relatorio/exportar?${qs}`} className={buttonClass("outline")}><Download className="size-4" aria-hidden /> Baixar CSV</a>}
      </form>
      {erro && <Callout tone="negative" role="alert">{erro}</Callout>}
      {rep && (<>
        <Callout tone="info">Total no período: <strong>{formatBRL(rep.totalCents)}</strong>. {basis === "pago" ? "Conta o que foi pago (baixas), no mês do pagamento; estornos não entram." : "Conta as contas aprovadas, pelo valor da conta, no mês de competência (ou do vencimento, se não houver competência)."} Gastos pessoais dos sócios ficam na conta-corrente dos sócios, não aqui.</Callout>
        {table("Por categoria e mês", rep.categories, true)}
        {table("Por centro de custo e mês", rep.centers, false)}
      </>)}
    </div>
  );
}
