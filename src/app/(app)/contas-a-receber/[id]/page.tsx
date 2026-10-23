import { randomUUID } from "node:crypto";
import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { getReceivable } from "@/modules/receivables/service";
import { METHODS, METHOD_LABEL, SITUATION_LABEL, type Situation } from "@/modules/receivables/status";
import { formatDateTime } from "@/lib/format";
import { Callout, Money, PageHeader, SectionCard, StatusPill, type StatusTone } from "@/components/k3g/primitives";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass, inputClass, selectClass } from "@/components/k3g/button";
import { payAction, reverseAction } from "../actions";

const TONE: Record<Situation, StatusTone> = { quitada: "positive", parcial: "warning", vencida: "negative", a_vencer: "info" };
const br = (d: string) => d.split("-").reverse().join("/");
const OK: Record<string, string> = { pago: "Pagamento registrado.", quitada: "Pagamento registrado. Cobrança quitada: as mensagens da régua foram interrompidas.", estornado: "Pagamento estornado. O saldo voltou; se quiser retomar a régua, use Mensagens → Programar." };

export default async function Cobranca({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ erro?: string; ok?: string }> }) {
  const [{ id }, sp, ctx] = await Promise.all([params, searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "receivables.read")) return <Callout tone="warning">Seu papel não tem acesso às contas a receber.</Callout>;
  const r = await getReceivable(db, ctx.user.id, ctx.current.id, id);
  if (!r) notFound();
  const pay = can(role, "receivables.pay"), reverse = can(role, "receivables.reverse");
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Manaus" });
  const requestKey = randomUUID().replace(/-/g, ""); // um por exibição da página: reenviar o mesmo formulário não duplica
  const openText = (r.openCents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className="space-y-5">
      <PageHeader title={r.customerName} description={`${r.description} · competência ${r.competenceMonth.slice(5, 7)}/${r.competenceMonth.slice(0, 4)}`}
        actions={<AppLink href="/contas-a-receber" className={buttonClass("outline")}><ArrowLeft className="size-4" aria-hidden /> Contas a receber</AppLink>} />
      {sp.erro && <Callout tone="negative" role="alert">{sp.erro}</Callout>}
      {sp.ok && OK[sp.ok] && <Callout tone="positive" role="status">{OK[sp.ok]}</Callout>}

      <section aria-label="Valores" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Valor</p><Money cents={r.amountCents} className="text-xl font-semibold" /></div>
        <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Pago</p><Money cents={r.paidCents} className="text-xl font-semibold" /></div>
        <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Saldo</p><Money cents={r.openCents} className="text-xl font-semibold" /></div>
        <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Situação</p><div className="mt-1"><StatusPill tone={TONE[r.situation]}>{SITUATION_LABEL[r.situation]}</StatusPill></div><p className="mt-1 text-xs text-muted-foreground">Emitida {br(r.issueDate)} · vence {br(r.dueDate)}{r.overdueDays > 0 ? ` · ${r.overdueDays} dia(s) de atraso` : ""}</p></div>
      </section>

      {pay && r.openCents > 0 && (
        <SectionCard title="Registrar pagamento (baixa manual)">
          <form action={payAction} className="grid max-w-2xl gap-4 sm:grid-cols-2">
            <input type="hidden" name="id" value={r.id} /><input type="hidden" name="requestKey" value={requestKey} />
            <div><label htmlFor="amount" className="mb-1 block text-sm font-medium">Valor (R$)</label><input id="amount" name="amount" inputMode="decimal" defaultValue={openText} required className={inputClass} /><p className="mt-1 text-xs text-muted-foreground">Pagamento parcial é permitido; não pode passar do saldo.</p></div>
            <div><label htmlFor="paidAt" className="mb-1 block text-sm font-medium">Data do pagamento</label><input id="paidAt" name="paidAt" type="date" defaultValue={today} min={r.issueDate} max={today} required className={inputClass} /></div>
            <div><label htmlFor="method" className="mb-1 block text-sm font-medium">Forma</label><select id="method" name="method" defaultValue="pix" className={`${selectClass} w-full`}>{METHODS.map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}</select></div>
            <div><label htmlFor="note" className="mb-1 block text-sm font-medium">Observação (opcional)</label><input id="note" name="note" maxLength={200} className={inputClass} /></div>
            <div className="sm:col-span-2"><button className={buttonClass("primary")}>Registrar pagamento</button></div>
          </form>
        </SectionCard>
      )}

      <SectionCard title="Pagamentos">
        {r.payments.length === 0 ? <p className="text-sm text-muted-foreground">Nenhum pagamento registrado.</p> : (
          <ul className="divide-y divide-border text-sm">
            {r.payments.map((p) => (
              <li key={p.id} className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div><p className={p.status === "estornado" ? "text-muted-foreground line-through" : "font-medium"}><Money cents={p.amountCents} /> · {METHOD_LABEL[p.method]} · {br(p.paidAt)}</p>
                    <p className="text-xs text-muted-foreground">Registrado por {p.registeredBy}{p.note ? ` · ${p.note}` : ""}</p></div>
                  <StatusPill tone={p.status === "ativo" ? "positive" : "neutral"}>{p.status === "ativo" ? "Ativo" : "Estornado"}</StatusPill>
                </div>
                {p.status === "estornado" && <p className="mt-1 text-xs text-muted-foreground">Estornado por {p.reversedBy ?? "—"}: {p.reverseReason}</p>}
                {reverse && p.status === "ativo" && (
                  <details className="mt-2"><summary className="cursor-pointer text-xs font-medium text-negative-foreground">Estornar</summary>
                    <form action={reverseAction} className="mt-2 flex flex-wrap items-end gap-2">
                      <input type="hidden" name="id" value={r.id} /><input type="hidden" name="paymentId" value={p.id} />
                      <div className="min-w-64 flex-1"><label htmlFor={`why-${p.id}`} className="mb-1 block text-xs font-medium">Motivo (5 a 300 caracteres)</label><input id={`why-${p.id}`} name="reason" required minLength={5} maxLength={300} className={inputClass} /></div>
                      <button className={buttonClass("danger", "sm")}>Confirmar estorno</button>
                    </form></details>
                )}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="Histórico">
        <ol className="space-y-2 text-sm">
          {r.events.map((e, i) => <li key={i} className="flex gap-3"><span className="w-36 shrink-0 text-xs text-muted-foreground">{formatDateTime(e.at)}</span><span>{e.text}</span></li>)}
        </ol>
      </SectionCard>
    </div>
  );
}
