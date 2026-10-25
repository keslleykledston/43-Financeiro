import { ArrowLeft, Download } from "lucide-react";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { getExpenseReport } from "@/modules/expenses/history";
import { DIV_LABEL, DIV_ORDER, DIV_SEVERITY } from "@/modules/expenses/report";
import { DEFAULT_CATEGORIES } from "@/modules/expenses/catalog";
import { formatBRL, formatDateTime } from "@/lib/format";
import { Callout, PageHeader, SectionCard } from "@/components/k3g/primitives";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass } from "@/components/k3g/button";
import { removeExpenseImportAction } from "./actions";

const mes = (m: string) => `${m.slice(5)}/${m.slice(0, 4)}`;
const NAME = new Map(DEFAULT_CATEGORIES.map(([code, name]) => [code, name]));
const SHOW = 25;

export default async function HistoricoDespesas({ searchParams }: { searchParams: Promise<{ erro?: string; removido?: string }> }) {
  const [sp, ctx] = await Promise.all([searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "partners.read")) return <Callout tone="warning">Seu papel não tem acesso ao histórico de despesas (inclui gasto pessoal dos sócios).</Callout>;
  const { current, report } = await getExpenseReport(db, ctx.user.id, ctx.current.id);
  const canImport = can(role, "history.import");
  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader title="Histórico de despesas" description={`${ctx.current.name} · a planilha de despesas como veio, com a classificação sugerida e o que precisa de revisão.`}
        actions={<AppLink href="/historico" className={buttonClass("outline")}><ArrowLeft className="size-4" aria-hidden /> Histórico de boletos</AppLink>} />
      <Callout tone="info">Esta tela só <strong>lê</strong> e sugere. Nada daqui cria contas a pagar, sócios, lançamentos, fornecedores ou categorias. A classificação é uma <strong>sugestão</strong> para você conferir antes de qualquer aplicação.</Callout>
      {sp.erro && <Callout tone="negative" role="alert">{sp.erro}</Callout>}
      {sp.removido && <Callout tone="positive" role="status">Importação desfeita.</Callout>}
      {!current || !report ? (
        <SectionCard title="Nada importado ainda"><p className="text-sm text-muted-foreground">Ainda não há linhas da planilha de despesas guardadas para esta empresa. A importação é feita pela operação, com a sua autorização escrita, e só guarda as linhas para análise.</p></SectionCard>
      ) : (<>
        <SectionCard title="Importação">
          <p className="text-sm">{current.label} {current.year} · <strong>{report.rows}</strong> linhas ({Object.entries(report.byBlock).map(([k, v]) => `${k} ${v}`).join(" · ")}) · importada em {formatDateTime(current.at)} por {current.by}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <a href="/historico/despesas/exportar?o=classificacao" className={buttonClass("outline", "sm")}><Download className="size-3.5" aria-hidden /> Classificação sugerida (CSV)</a>
            <a href="/historico/despesas/exportar?o=divergencias" className={buttonClass("outline", "sm")}><Download className="size-3.5" aria-hidden /> Divergências (CSV)</a>
          </div>
          {canImport && (
            <form action={removeExpenseImportAction} className="mt-3 flex flex-wrap items-center gap-3 text-sm">
              <input type="hidden" name="importId" value={current.id} />
              <label className="flex items-center gap-2"><input type="checkbox" name="confirm" /> Confirmo desfazer esta importação (as linhas guardadas somem; nenhum cadastro é afetado)</label>
              <button className="rounded-md px-3 py-1.5 text-sm text-negative-foreground ring-1 ring-border">Desfazer importação</button>
            </form>
          )}
        </SectionCard>

        <section aria-label="Totais" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Empresa (pago)</p><p className="text-xl font-semibold">{formatBRL(report.totals.empresaPaidCents)}</p></div>
          <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Casa — gasto pessoal (pago)</p><p className="text-xl font-semibold">{formatBRL(report.totals.casaPaidCents)}</p></div>
          <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Parcelas a vencer (estimativa)</p><p className="text-xl font-semibold">{formatBRL(report.totals.installmentRemainingCents)}</p><p className="text-xs text-muted-foreground">séries com total conhecido</p></div>
          <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Faturas de cartão (só referência)</p><p className="text-xl font-semibold">{formatBRL(report.totals.cardReferenceCents)}</p><p className="text-xs text-muted-foreground">não entram nos totais</p></div>
        </section>

        <SectionCard title="Por mês">
          <div className="overflow-x-auto"><table className="w-full min-w-[34rem] text-sm">
            <thead><tr className="text-left text-xs text-muted-foreground"><th className="py-1 pr-3 font-medium">Aba</th><th className="pr-3 text-right font-medium">Empresa (pago)</th><th className="pr-3 text-right font-medium">Casa (pago)</th><th className="text-right font-medium">Linhas</th></tr></thead>
            <tbody className="divide-y divide-border">{report.months.map((m) => <tr key={m.month}><td className="py-1.5 pr-3">{mes(m.month)}</td><td className="pr-3 text-right">{formatBRL(m.empresaPaidCents)}</td><td className="pr-3 text-right">{formatBRL(m.casaPaidCents)}</td><td className="text-right">{m.empresaRows + m.casaRows}</td></tr>)}</tbody></table></div>
        </SectionCard>

        <SectionCard title="Classificação sugerida (por categoria)">
          <div className="overflow-x-auto"><table className="w-full min-w-[34rem] text-sm">
            <thead><tr className="text-left text-xs text-muted-foreground"><th className="py-1 pr-3 font-medium">Categoria</th><th className="pr-3 font-medium">Natureza</th><th className="pr-3 text-right font-medium">Linhas</th><th className="text-right font-medium">Pago</th></tr></thead>
            <tbody className="divide-y divide-border">{report.categories.map((c) => <tr key={`${c.nature}-${c.categoryCode}`} className={c.categoryCode.startsWith("a_classificar") ? "text-warning-foreground" : ""}><td className="py-1.5 pr-3">{NAME.get(c.categoryCode) ?? c.categoryCode}</td><td className="pr-3">{c.nature === "empresa" ? "despesa da empresa" : c.nature === "retirada" ? "retirada de sócio" : "referência"}</td><td className="pr-3 text-right">{c.rows}</td><td className="text-right">{formatBRL(c.paidCents)}</td></tr>)}</tbody></table></div>
        </SectionCard>

        {report.toClassify.length > 0 && (
          <SectionCard title={`A classificar (${report.toClassify.length})`}>
            <p className="mb-2 text-sm text-muted-foreground">Descrições que as regras não reconheceram. Dizer o que são (ou confirmar que podem ficar em "A classificar") é o que falta para aplicar.</p>
            <ul className="divide-y divide-border text-sm">{report.toClassify.slice(0, SHOW).map((t) => <li key={`${t.block}-${t.description}`} className="flex justify-between gap-3 py-1.5"><span>{t.description} <span className="text-xs text-muted-foreground">· {t.block} · {t.rows}×</span></span><span>{formatBRL(t.paidCents)}</span></li>)}</ul>
            {report.toClassify.length > SHOW && <p className="mt-2 text-xs text-muted-foreground">+ {report.toClassify.length - SHOW} (todas no CSV de classificação)</p>}
          </SectionCard>
        )}

        <SectionCard title={`Candidatas a conta recorrente (${report.recurring.length})`}>
          {report.recurring.length === 0 ? <p className="text-sm text-muted-foreground">Nenhuma.</p> : (
            <ul className="divide-y divide-border text-sm">{report.recurring.slice(0, SHOW).map((r) => <li key={`${r.block}-${r.vendorKey}`} className="flex justify-between gap-3 py-1.5"><span>{r.sample} <span className="text-xs text-muted-foreground">· {r.block} · {r.months} meses ({mes(r.firstMonth)}–{mes(r.lastMonth)}){r.typicalDay ? ` · dia ${r.typicalDay}` : ""}</span></span><span>{formatBRL(r.typicalCents)}</span></li>)}</ul>
          )}
        </SectionCard>

        <SectionCard title={`Parcelamentos encontrados (${report.series.length})`}>
          {report.series.length === 0 ? <p className="text-sm text-muted-foreground">Nenhum.</p> : (
            <ul className="divide-y divide-border text-sm">{report.series.map((s) => <li key={`${s.block}-${s.vendorKey}-${s.total}`} className="flex flex-wrap justify-between gap-3 py-1.5"><span>{s.sample} <span className="text-xs text-muted-foreground">· {s.block} · última vista {s.lastNo}{s.total ? `/${s.total}` : "º (total desconhecido)"} em {mes(s.lastMonth)}</span></span><span>{formatBRL(s.installmentCents)}{s.remaining !== null ? ` × ${s.remaining} restantes = ${formatBRL(s.remainingCents ?? 0)}` : ""}</span></li>)}</ul>
          )}
        </SectionCard>

        <SectionCard title="Para revisar">
          <ul className="divide-y divide-border text-sm">
            {DIV_ORDER.filter((k) => report.counts[k] > 0).map((k) => <li key={k} className="flex justify-between gap-3 py-1.5"><span>{DIV_LABEL[k]}{DIV_SEVERITY[k] === "info" && <span className="ml-2 text-xs text-muted-foreground">(informativo)</span>}</span><strong>{report.counts[k]}</strong></li>)}
          </ul>
          <p className="mt-3 text-xs text-muted-foreground">Cada item, com aba e linha da planilha, está no CSV de divergências.</p>
        </SectionCard>
      </>)}
    </div>
  );
}
