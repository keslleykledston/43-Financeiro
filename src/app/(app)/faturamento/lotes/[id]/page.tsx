import { notFound } from "next/navigation";
import { AlertTriangle, ArrowLeft } from "lucide-react";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { getBatch } from "@/modules/billing/batches";
import { WARNING_LABEL, type Warning } from "@/modules/billing/calendar";
import { Callout, Money, PageHeader, SectionCard, StatusPill } from "@/components/k3g/primitives";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass, inputClass } from "@/components/k3g/button";
import { formatDateTime } from "@/lib/format";
import { approveAction, cancelAction, refreshAction, reopenAction } from "../actions";
import { STATUS_LABEL, STATUS_TONE } from "../status";

const br = (d: string) => d.split("-").reverse().join("/");

export default async function Lote({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ erro?: string; ok?: string }> }) {
  const [{ id }, sp, ctx] = await Promise.all([params, searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "billing.read")) return <Callout tone="warning">Seu papel não tem acesso aos lotes de cobrança.</Callout>;
  const r = await getBatch(db, ctx.user.id, ctx.current.id, id);
  if (!r) notFound();
  const { batch: b, stale } = r;
  const approve = can(role, "billing.approve"), write = can(role, "billing.write");
  const OK: Record<string, string> = { aprovado: "Lote aprovado. Nada foi emitido: a emissão real é uma fase futura.", reaberto: "Lote reaberto: volta a ser prévia e precisa de nova aprovação.", atualizado: "Prévia atualizada." };

  return (
    <div className="space-y-5">
      <PageHeader title={`Lote de emissão ${br(b.issueDate)}`} description={ctx.current.name}
        actions={<AppLink href="/faturamento/lotes" className={buttonClass("outline")}><ArrowLeft className="size-4" aria-hidden /> Lotes</AppLink>} />
      {sp.ok && OK[sp.ok] && <Callout tone="positive" role="status">{OK[sp.ok]}</Callout>}
      {sp.erro && <Callout tone="negative" role="alert">{sp.erro}</Callout>}

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border bg-card p-4"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Situação</p><p className="mt-1"><StatusPill tone={STATUS_TONE[b.status as keyof typeof STATUS_TONE]}>{STATUS_LABEL[b.status as keyof typeof STATUS_LABEL]}</StatusPill></p>
          {b.approvedAt && <p className="mt-1 text-xs text-muted-foreground">Aprovado em {formatDateTime(b.approvedAt)}</p>}</div>
        <div className="rounded-lg border bg-card p-4"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Cobranças</p><p className="num mt-1 text-2xl font-semibold">{r.charges.length}</p></div>
        <div className="rounded-lg border bg-card p-4"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Total</p><p className="mt-1 text-2xl font-semibold"><Money cents={r.totalCents} /></p></div>
      </div>

      <Callout tone="info">Simulação: aprovar <strong>não emite</strong> boleto, nota fiscal nem mensagem.</Callout>

      {stale.any && (
        <Callout tone="warning" role="alert">
          <strong>Contratos mudaram desde esta {b.status === "aprovado" ? "aprovação" : "prévia"}</strong> ({stale.added} nova(s), {stale.removed} a sair, {stale.changed} alterada(s)).{" "}
          {b.status === "aprovado" ? "Reabra o lote para revalidar." : "Atualize a prévia antes de aprovar."}
        </Callout>
      )}
      {r.exceptions.length > 0 && (
        <section aria-label="Fora do lote" className="rounded-lg border border-warning/40 bg-warning-soft p-4 text-warning-foreground">
          <h2 className="flex items-center gap-2 font-semibold"><AlertTriangle className="size-4" aria-hidden /> Fora do lote — precisa de revisão ({r.exceptions.length})</h2>
          <ul className="mt-2 space-y-1 text-sm">{r.exceptions.map((i, k) => <li key={k}>{i.customerName} — {i.description}: {i.reason}</li>)}</ul>
        </section>
      )}

      <SectionCard title="Cobranças do lote">
        {r.charges.length === 0 ? <p className="text-sm text-muted-foreground">Nenhuma cobrança neste lote.</p> : (
          <ul className="divide-y divide-border">
            {r.charges.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                <div className="min-w-0">
                  <AppLink href={`/contratos/${c.contractId}`} className="font-medium hover:underline">{c.customerName}</AppLink>
                  <p className="text-muted-foreground">{c.description} · competência {c.competenceMonth.slice(5, 7)}/{c.competenceMonth.slice(0, 4)} · vence {br(c.dueDate)}{c.jointInvoice ? " · boleto + NF" : ""}</p>
                  {(c.warnings as Warning[]).length > 0 && <p className="text-xs text-muted-foreground">{(c.warnings as Warning[]).map((w) => WARNING_LABEL[w]).join("; ")}</p>}
                </div>
                <Money cents={c.amountCents} className="font-semibold" />
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="Ações">
        <div className="flex flex-wrap items-start gap-3">
          {b.status === "rascunho" && write && (
            <form action={refreshAction}><input type="hidden" name="id" value={b.id} /><input type="hidden" name="issueDate" value={b.issueDate} /><button className={buttonClass("outline")}>Atualizar prévia</button></form>
          )}
          {b.status === "rascunho" && approve && r.charges.length > 0 && (
            <form action={approveAction}><input type="hidden" name="id" value={b.id} /><input type="hidden" name="hash" value={r.hash} /><button className={buttonClass("success")} disabled={stale.any}>Aprovar lote</button></form>
          )}
          {b.status === "rascunho" && write && (
            <form action={cancelAction}><input type="hidden" name="id" value={b.id} /><button className={buttonClass("danger")}>Cancelar lote</button></form>
          )}
          {b.status === "aprovado" && approve && (
            <form action={reopenAction} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="id" value={b.id} />
              <div><label htmlFor="reason" className="mb-1 block text-xs font-medium">Motivo para reabrir</label><input id="reason" name="reason" required minLength={5} maxLength={300} className={inputClass} /></div>
              <button className={buttonClass("outline")}>Reabrir para revalidar</button>
            </form>
          )}
        </div>
        {b.status === "rascunho" && !approve && <p className="mt-2 text-sm text-muted-foreground">Gerente ou diretoria aprovam o lote.</p>}
        {b.status === "rascunho" && approve && <p className="mt-2 text-xs text-muted-foreground">Quem gerou a prévia não a aprova (exige outro gerente ou a diretoria). Você aprova exatamente o conteúdo exibido acima.</p>}
      </SectionCard>
    </div>
  );
}
