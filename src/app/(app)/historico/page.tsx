import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { getHistoryReport } from "@/modules/history/service";
import { DIV_LABEL, DIV_ORDER, DIV_SEVERITY } from "@/modules/history/analysis";
import { todayManaus } from "@/modules/messaging/service";
import { formatBRL, formatDateTime } from "@/lib/format";
import { Callout, Money, PageHeader, SectionCard } from "@/components/k3g/primitives";
import { buttonClass } from "@/components/k3g/button";
import { removeFixAction, removeImportAction } from "./actions";
import { FixForm } from "./fix-form";

const mes = (m: string) => `${m.slice(5)}/${m.slice(0, 4)}`;
const SHOW = 30;

export default async function Historico({ searchParams }: { searchParams: Promise<{ erro?: string; removido?: string }> }) {
  const [sp, ctx] = await Promise.all([searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "history.read")) return <Callout tone="warning">Seu papel não tem acesso ao histórico.</Callout>;
  const { current, report, fixes } = await getHistoryReport(db, ctx.user.id, ctx.current.id, todayManaus());
  const canImport = can(role, "history.import"), canFix = can(role, "history.fix");
  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader title="Histórico da planilha" description={`${ctx.current.name} · as linhas da planilha de boletos como vieram, e o que precisa de revisão.`}
        actions={can(role, "partners.read") ? <a href="/historico/despesas" className={buttonClass("outline")}>Histórico de despesas</a> : undefined} />
      <Callout tone="info">Esta tela só <strong>lê</strong> e mede. Nada daqui cria ou altera clientes, contratos, cobranças, pagamentos, mensagens ou emissões.</Callout>
      {sp.erro && <Callout tone="negative" role="alert">{sp.erro}</Callout>}
      {sp.removido && <Callout tone="positive" role="status">Importação desfeita.</Callout>}
      {!current || !report ? (
        <SectionCard title="Nada importado ainda">
          <p className="text-sm text-muted-foreground">Ainda não há linhas da planilha guardadas para esta empresa. A importação é feita pela operação, com a autorização da diretoria, e só guarda as linhas para análise (veja o artigo de ajuda).</p>
        </SectionCard>
      ) : (<>
        <SectionCard title="Importação">
          <p className="text-sm">{current.label} {current.year} · <strong>{report.rows}</strong> linhas · {report.customers} clientes · importada em {formatDateTime(current.at)} por {current.by} · arquivo <span className="font-mono text-xs">{current.sha.slice(0, 12)}…</span></p>
          {canImport && (
            <form action={removeImportAction} className="mt-3 flex flex-wrap items-center gap-3 text-sm">
              <input type="hidden" name="importId" value={current.id} />
              <label className="flex items-center gap-2"><input type="checkbox" name="confirm" /> Confirmo desfazer esta importação (as linhas guardadas somem; nenhum cadastro é afetado)</label>
              <button className="rounded-md px-3 py-1.5 text-sm text-negative-foreground ring-1 ring-border">Desfazer importação</button>
            </form>
          )}
        </SectionCard>

        <SectionCard title="Por aba (mês do vencimento)">
          <div className="overflow-x-auto"><table className="w-full min-w-[34rem] text-sm">
            <thead><tr className="text-left text-xs text-muted-foreground"><th className="py-1 pr-3 font-medium">Aba</th><th className="pr-3 font-medium">Linhas</th><th className="pr-3 text-right font-medium">Cobrado</th><th className="pr-3 text-right font-medium">Recebido (líquido informado)</th><th className="text-right font-medium">Em aberto</th></tr></thead>
            <tbody className="divide-y divide-border">{report.months.map((m) => (
              <tr key={m.month}><td className="py-1.5 pr-3">{mes(m.month)}</td><td className="pr-3">{m.rows}</td><td className="pr-3 text-right"><Money cents={m.billedCents} /></td><td className="pr-3 text-right"><Money cents={m.receivedCents} />{m.assumedRows ? <span className="block text-xs text-muted-foreground">+ <Money cents={m.assumedCents} /> estimado ({m.assumedRows} sem líquido)</span> : null}</td><td className="text-right">{m.openRows ? <><Money cents={m.openCents} /> <span className="text-xs text-muted-foreground">({m.openRows})</span></> : "—"}{m.textRows ? <span className="block text-xs text-muted-foreground">+ <Money cents={m.textCents} /> a conferir ({m.textRows})</span> : null}</td></tr>
            ))}</tbody>
            <tfoot><tr className="border-t font-medium"><td className="py-1.5 pr-3">Total</td><td className="pr-3">{report.rows}</td><td className="pr-3 text-right"><Money cents={report.totals.billedCents} /></td><td className="pr-3 text-right"><Money cents={report.totals.receivedCents} />{report.totals.assumedRows ? <span className="block text-xs font-normal text-muted-foreground">+ <Money cents={report.totals.assumedCents} /> estimado ({report.totals.assumedRows} sem líquido)</span> : null}</td><td className="text-right"><Money cents={report.totals.openCents} />{report.totals.textRows ? <span className="block text-xs font-normal text-muted-foreground">+ <Money cents={report.totals.textCents} /> a conferir ({report.totals.textRows})</span> : null}</td></tr></tfoot>
          </table></div>
          <p className="mt-2 text-xs text-muted-foreground">“Em aberto” = vencido e sem data de pagamento. “A conferir” = pagamento escrito como texto (ex.: dois pagamentos), que não entra nem no em aberto nem no recebido. A competência do serviço é o mês anterior ao da aba.</p>
        </SectionCard>

        <SectionCard title="Caixa por mês de pagamento (líquido recebido)">
          <div className="overflow-x-auto"><table className="w-full min-w-[22rem] text-sm">
            <thead><tr className="text-left text-xs text-muted-foreground"><th className="py-1 pr-3 font-medium">Mês</th><th className="pr-3 font-medium">Pagamentos</th><th className="text-right font-medium">Recebido</th></tr></thead>
            <tbody className="divide-y divide-border">{report.receivedByPayMonth.map((p) => <tr key={p.month}><td className="py-1.5 pr-3">{mes(p.month)}</td><td className="pr-3">{p.rows + p.assumedRows}</td><td className="text-right"><Money cents={p.cents} />{p.assumedRows ? <span className="block text-xs text-muted-foreground">+ <Money cents={p.assumedCents} /> estimado ({p.assumedRows} sem líquido)</span> : null}</td></tr>)}</tbody>
          </table></div>
          <p className="mt-2 text-xs text-muted-foreground">Calculado pelas datas de pagamento da planilha; só o líquido informado conta como recebido (linhas pagas sem líquido aparecem à parte, como estimativa). A conferência contra o extrato do banco virá quando houver um extrato real.</p>
        </SectionCard>

        <SectionCard title={`Corrigir CNPJ/CPF (${report.toFix.length} cliente(s))`}>
          <div id="corrigir" />
          <p className="mb-3 text-sm text-muted-foreground">Clientes cujo CNPJ/CPF falta ou não confere. Digite o correto: o sistema confere os dígitos na hora e sugere o provável erro de digitação (ex.: dígitos verificadores trocados). A correção vale para todas as linhas do cliente nesta análise; a linha guardada <strong>não muda</strong> e nenhum cadastro é alterado.</p>
          {report.toFix.length === 0 ? <p className="text-sm text-muted-foreground">Nenhum cliente com CNPJ/CPF a corrigir.</p> : canFix ? (
            <ul className="space-y-4">{report.toFix.slice(0, 40).map((c) => <li key={c.nameKey} className="rounded-md border border-border p-3"><FixForm name={c.name} rows={c.rows} rawDocuments={c.rawDocuments} suggestions={c.suggestions} /></li>)}</ul>
          ) : <ul className="list-disc pl-5 text-sm">{report.toFix.slice(0, 40).map((c) => <li key={c.nameKey}>{c.name} ({c.rows} linha(s))</li>)}</ul>}
          {report.toFix.length > 40 && <p className="mt-2 text-xs text-muted-foreground">Mostrando 40 de {report.toFix.length}; corrija e a lista diminui.</p>}
          {fixes.length > 0 && (
            <div className="mt-4 border-t border-border pt-3"><p className="mb-1 text-sm font-medium">Correções feitas</p>
              <ul className="divide-y divide-border text-sm">{fixes.map((f) => (
                <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5"><span><strong>{f.name}</strong> → {f.formatted}{f.note ? <span className="text-xs text-muted-foreground"> · {f.note}</span> : null}</span>
                  {canFix && <form action={removeFixAction}><input type="hidden" name="fixId" value={f.id} /><button className="rounded-md px-2.5 py-1 text-xs text-negative-foreground ring-1 ring-border">Desfazer</button></form>}</li>
              ))}</ul></div>
          )}
        </SectionCard>

        <SectionCard title={`Divergências (${report.toReview} para revisar)`} action={<a href="/historico/exportar" className={buttonClass("outline", "sm")}>Baixar CSV</a>}>
          <ul className="space-y-2">
            {DIV_ORDER.map((k) => {
              const items = report.divergences.filter((d) => d.kind === k);
              if (items.length === 0) return null;
              return (
                <li key={k} className="rounded-md border border-border p-3">
                  <details>
                    <summary className="cursor-pointer text-sm font-medium">{DIV_LABEL[k]} <span className={`ml-2 rounded-full px-2 py-0.5 text-xs ${DIV_SEVERITY[k] === "revisar" ? "bg-warning-soft text-warning-foreground" : "bg-muted text-muted-foreground"}`}>{items.length} · {DIV_SEVERITY[k] === "revisar" ? "revisar" : "informativo"}</span></summary>
                    <ul className="mt-2 divide-y divide-border text-xs">
                      {items.slice(0, SHOW).map((d, i) => <li key={i} className="py-1.5"><strong>{d.name}</strong> · aba {mes(d.month)}, linha {d.row} — {d.detail}</li>)}
                    </ul>
                    {items.length > SHOW && <p className="mt-1 text-xs text-muted-foreground">Mostrando {SHOW} de {items.length}. O CSV traz todas.</p>}
                  </details>
                </li>
              );
            })}
          </ul>
          {report.divergences.length === 0 && <p className="text-sm text-muted-foreground">Nenhuma divergência.</p>}
          <p className="mt-3 text-xs text-muted-foreground">Total cobrado {formatBRL(report.totals.billedCents)} · recebido {formatBRL(report.totals.receivedCents)} · em aberto {formatBRL(report.totals.openCents)}.</p>
        </SectionCard>
      </>)}
    </div>
  );
}
