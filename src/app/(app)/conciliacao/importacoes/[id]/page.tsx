import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { getImport } from "@/modules/banking/service";
import { centsFromNumeric } from "@/lib/money";
import { Callout, Money, PageHeader, SectionCard, StatusPill } from "@/components/k3g/primitives";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass, inputClass } from "@/components/k3g/button";
import { cancelImportAction, confirmImportAction, undoImportAction } from "../../actions";

const br = (d: string) => d.split("-").reverse().join("/");

export default async function Importacao({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ erro?: string; ok?: string }> }) {
  const [{ id }, sp, ctx] = await Promise.all([params, searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "bank.read")) return <Callout tone="warning">Seu papel não tem acesso à conciliação bancária.</Callout>;
  const r = await getImport(db, ctx.user.id, ctx.current.id, id);
  if (!r) notFound();
  const { batch: b } = r;
  const imp = can(role, "bank.import"), undo = can(role, "bank.undo");
  const [okKind, ...okN] = (sp.ok ?? "").split(":");

  return (
    <div className="space-y-5">
      <PageHeader title={`Importação — ${b.fileName}`} description={`${r.account.name} · ${b.format.toUpperCase()}`}
        actions={<AppLink href={`/conciliacao/contas/${b.accountId}`} className={buttonClass("outline")}><ArrowLeft className="size-4" aria-hidden /> Conta</AppLink>} />
      {sp.erro && <Callout tone="negative" role="alert">{sp.erro}</Callout>}
      {okKind === "importado" && <Callout tone="positive" role="status">Importação concluída: {okN[0]} transação(ões) nova(s), {okN[1]} repetida(s) ignorada(s).</Callout>}
      {okKind === "desfeita" && <Callout tone="positive" role="status">Importação desfeita. O arquivo pode ser importado de novo.</Callout>}
      {r.warnings.map((w) => <Callout key={w} tone="warning" role="status">{w}</Callout>)}

      <section aria-label="Resumo da importação" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Linhas no arquivo</p><p className="text-xl font-semibold">{b.rowCount}</p></div>
        <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Novas</p><p className="text-xl font-semibold text-positive-foreground">{b.newCount}</p></div>
        <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Já importadas</p><p className="text-xl font-semibold">{b.dupCount}</p></div>
        <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Período</p><p className="text-sm font-semibold">{b.periodStart ? `${br(b.periodStart)} a ${br(b.periodEnd!)}` : "—"}</p>{b.ledgerBalance !== null && <p className="text-xs text-muted-foreground">Saldo do arquivo: <Money cents={centsFromNumeric(b.ledgerBalance.replace("-", "")) * (b.ledgerBalance.startsWith("-") ? -1 : 1)} /></p>}</div>
      </section>

      {b.status === "previa" && (
        <SectionCard title="Prévia — nada foi gravado ainda">
          {imp && (
            <div className="mb-4 flex flex-wrap gap-2">
              <form action={confirmImportAction} className="space-y-2"><input type="hidden" name="id" value={b.id} />
                {r.ambiguous > 0 && <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="ackAmbiguous" className="mt-0.5 size-4 accent-primary" /><span>Conferi os lançamentos marcados como <strong>ambíguos</strong> e entendo que o sistema não distingue novo de repetido neles.</span></label>}
                <button className={buttonClass("primary")} disabled={b.newCount === 0}>Confirmar importação ({b.newCount} nova(s))</button></form>
              <form action={cancelImportAction}><input type="hidden" name="id" value={b.id} /><input type="hidden" name="accountId" value={b.accountId} /><button className={buttonClass("outline")}>Cancelar</button></form>
            </div>
          )}
          <ul className="divide-y divide-border text-sm">
            {r.rows.map((x) => (
              <li key={x.lineNo} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="min-w-0"><span className="text-xs text-muted-foreground">{br(x.postedAt)} · </span>{x.description}</span>
                <span className="flex items-center gap-2"><Money cents={x.amountCents} />{x.ambiguous && <StatusPill tone="warning">Ambígua</StatusPill>}{x.duplicate ? <StatusPill tone="neutral">Já importada</StatusPill> : <StatusPill tone="positive">Nova</StatusPill>}</span>
              </li>
            ))}
          </ul>
          {b.rowCount > r.rows.length && <p className="mt-3 text-xs text-muted-foreground">Mostrando as {r.rows.length} primeiras de {b.rowCount} linhas.</p>}
        </SectionCard>
      )}

      {b.status === "aplicado" && undo && (
        <SectionCard title="Desfazer importação">
          <p className="mb-3 text-sm text-muted-foreground">Use se o arquivo era da conta errada. Só é possível se nenhuma transação dele estiver vinculada a cobrança.</p>
          <form action={undoImportAction} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="id" value={b.id} />
            <div className="min-w-64 flex-1"><label htmlFor="reason" className="mb-1 block text-xs font-medium">Motivo (5 a 300 caracteres)</label><input id="reason" name="reason" required minLength={5} maxLength={300} className={inputClass} /></div>
            <button className={buttonClass("danger", "sm")}>Desfazer importação</button>
          </form>
        </SectionCard>
      )}
      {(b.status === "desfeito" || b.status === "cancelado") && <Callout tone="info">{b.status === "desfeito" ? `Importação desfeita: ${b.undoReason}` : "Prévia cancelada."}</Callout>}
    </div>
  );
}
