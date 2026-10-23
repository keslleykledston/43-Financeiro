import { randomUUID } from "node:crypto";
import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { getPayable, getPayablesSettings } from "@/modules/payables/service";
import { METHODS, METHOD_LABEL, SITUATION_LABEL, type Method, type Situation } from "@/modules/payables/status";
import { formatBRL, formatDateTime } from "@/lib/format";
import { Callout, Money, PageHeader, SectionCard, StatusPill, type StatusTone } from "@/components/k3g/primitives";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass, inputClass, selectClass } from "@/components/k3g/button";
import { approveAction, cancelAction, payAction, rejectAction, reverseAction, submitAction } from "../actions";

const TONE: Record<Situation, StatusTone> = { rascunho: "neutral", aguardando: "info", a_vencer: "info", vencida: "negative", parcial: "warning", paga: "positive", rejeitada: "neutral", cancelada: "neutral" };
const br = (d: string) => d.split("-").reverse().join("/");
const OK: Record<string, string> = { criado: "Conta lançada como rascunho.", salvo: "Rascunho salvo.", enviado: "Enviada para aprovação.", aprovado: "Conta aprovada. Ela entrou na fila de execução.", rejeitado: "Conta rejeitada.", cancelado: "Conta cancelada.", pago: "Baixa registrada.", quitada: "Baixa registrada. Conta paga.", estornado: "Baixa estornada: o saldo voltou." };

export default async function Conta({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ erro?: string; ok?: string }> }) {
  const [{ id }, sp, ctx] = await Promise.all([params, searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "payables.read")) return <Callout tone="warning">Seu papel não tem acesso às contas a pagar.</Callout>;
  const p = await getPayable(db, ctx.user.id, ctx.current.id, id);
  if (!p) notFound();
  const st = await getPayablesSettings(db, ctx.user.id, ctx.current.id);
  const write = can(role, "payables.write"), approve = can(role, "payables.approve"), pay = can(role, "payables.pay"), reverse = can(role, "payables.reverse");
  const mine = p.createdBy === ctx.user.id;
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Manaus" });
  const requestKey = randomUUID().replace(/-/g, "");
  const aboveLimit = role === "gerente" && p.amountCents > st.managerLimitCents;
  const selfBlocked = mine && !(role === "diretoria" && st.directorSelfApproval);

  return (
    <div className="space-y-5">
      <PageHeader title={p.vendorName} description={`${p.description}${p.documentNumber ? ` · doc. ${p.documentNumber}` : ""}`}
        actions={<AppLink href="/contas-a-pagar" className={buttonClass("outline")}><ArrowLeft className="size-4" aria-hidden /> Contas a pagar</AppLink>} />
      {sp.erro && <Callout tone="negative" role="alert">{sp.erro}</Callout>}
      {sp.ok && OK[sp.ok] && <Callout tone="positive" role="status">{OK[sp.ok]}</Callout>}

      <section aria-label="Valores" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Valor</p><Money cents={p.amountCents} className="text-xl font-semibold" /></div>
        <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Pago</p><Money cents={p.paidCents} className="text-xl font-semibold" /></div>
        <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Vencimento</p><p className="text-xl font-semibold">{br(p.dueDate)}</p>{p.overdueDays > 0 && <p className="text-xs text-negative-foreground">{p.overdueDays} dia(s) de atraso</p>}</div>
        <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Situação</p><div className="mt-1"><StatusPill tone={TONE[p.situation]}>{SITUATION_LABEL[p.situation]}</StatusPill></div><p className="mt-1 text-xs text-muted-foreground">Lançada por {p.createdName}{p.category ? ` · ${p.category}` : ""}</p></div>
      </section>

      {p.status === "rascunho" && write && (
        <SectionCard title="Rascunho">
          <div className="flex flex-wrap gap-2">
            <form action={submitAction}><input type="hidden" name="id" value={p.id} /><button className={buttonClass("primary")}>Enviar para aprovação</button></form>
            <AppLink href={`/contas-a-pagar/${p.id}/editar`} className={buttonClass("outline")}>Editar</AppLink>
          </div>
        </SectionCard>
      )}

      {p.status === "aguardando_aprovacao" && approve && (
        <SectionCard title="Aprovação">
          {selfBlocked && <Callout tone="warning">Você lançou esta conta: outra pessoa com alçada precisa aprová-la.</Callout>}
          {!selfBlocked && aboveLimit && <Callout tone="warning">O valor passa da sua alçada ({formatBRL(st.managerLimitCents)}). A aprovação é da diretoria.</Callout>}
          <div className="mt-3 grid gap-4 lg:grid-cols-2">
            <form action={approveAction} className="space-y-2"><input type="hidden" name="id" value={p.id} />
              <label htmlFor="note" className="block text-xs font-medium">Observação (opcional)</label><input id="note" name="note" maxLength={300} className={inputClass} />
              <button className={buttonClass("success")} disabled={selfBlocked || aboveLimit}>Aprovar</button></form>
            <form action={rejectAction} className="space-y-2"><input type="hidden" name="id" value={p.id} />
              <label htmlFor="rj" className="block text-xs font-medium">Motivo da rejeição (5 a 300)</label><input id="rj" name="reason" required minLength={5} maxLength={300} className={inputClass} />
              <button className={buttonClass("danger")}>Rejeitar</button></form>
          </div>
        </SectionCard>
      )}

      {p.status === "aprovado" && p.openCents > 0 && pay && (
        <SectionCard title="Registrar baixa (pagamento feito no banco)">
          <Callout tone="info">Pague no Cora e registre aqui com a data e o protocolo do comprovante. Este sistema não executa o pagamento.</Callout>
          <form action={payAction} className="mt-3 grid max-w-3xl gap-4 sm:grid-cols-2">
            <input type="hidden" name="id" value={p.id} /><input type="hidden" name="requestKey" value={requestKey} />
            <div><label htmlFor="amount" className="mb-1 block text-sm font-medium">Valor pago (R$)</label><input id="amount" name="amount" inputMode="decimal" defaultValue={(p.openCents / 100).toFixed(2).replace(".", ",")} required className={inputClass} /></div>
            <div><label htmlFor="paidAt" className="mb-1 block text-sm font-medium">Data do pagamento</label><input id="paidAt" name="paidAt" type="date" defaultValue={today} max={today} required className={inputClass} /></div>
            <div><label htmlFor="method" className="mb-1 block text-sm font-medium">Forma</label><select id="method" name="method" defaultValue="pix" className={`${selectClass} w-full`}>{METHODS.map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}</select></div>
            <div><label htmlFor="reference" className="mb-1 block text-sm font-medium">Protocolo / comprovante</label><input id="reference" name="reference" maxLength={60} className={inputClass} /></div>
            <div className="sm:col-span-2"><label htmlFor="note2" className="mb-1 block text-sm font-medium">Observação (opcional)</label><input id="note2" name="note" maxLength={200} className={inputClass} /></div>
            <div className="sm:col-span-2"><button className={buttonClass("primary")}>Registrar baixa</button></div>
          </form>
        </SectionCard>
      )}

      <SectionCard title="Baixas">
        {p.payments.length === 0 ? <p className="text-sm text-muted-foreground">Nenhuma baixa registrada.</p> : (
          <ul className="divide-y divide-border text-sm">
            {p.payments.map((x) => (
              <li key={x.id} className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div><p className={x.status === "estornado" ? "text-muted-foreground line-through" : "font-medium"}><Money cents={x.amountCents} /> · {METHOD_LABEL[x.method as Method] ?? x.method} · {br(x.paidAt)}</p>
                    <p className="text-xs text-muted-foreground">Registrada por {x.registeredBy}{x.reference ? ` · protocolo ${x.reference}` : ""}{x.note ? ` · ${x.note}` : ""}</p></div>
                  <StatusPill tone={x.status === "ativo" ? "positive" : "neutral"}>{x.status === "ativo" ? "Ativa" : "Estornada"}</StatusPill>
                </div>
                {x.status === "estornado" && <p className="mt-1 text-xs text-muted-foreground">Estornada por {x.reversedBy ?? "—"}: {x.reverseReason}</p>}
                {reverse && x.status === "ativo" && (
                  <details className="mt-2"><summary className="cursor-pointer text-xs font-medium text-negative-foreground">Estornar baixa</summary>
                    <form action={reverseAction} className="mt-2 flex flex-wrap items-end gap-2"><input type="hidden" name="id" value={p.id} /><input type="hidden" name="paymentId" value={x.id} />
                      <div className="min-w-64 flex-1"><label htmlFor={`rv-${x.id}`} className="mb-1 block text-xs font-medium">Motivo (5 a 300)</label><input id={`rv-${x.id}`} name="reason" required minLength={5} maxLength={300} className={inputClass} /></div>
                      <button className={buttonClass("danger", "sm")}>Confirmar estorno</button></form></details>
                )}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {(p.status === "rascunho" || p.status === "aguardando_aprovacao" || p.status === "aprovado") && (write || approve) && (p.status === "rascunho" ? write : approve) && p.payments.length === 0 && (
        <SectionCard title="Cancelar conta">
          <form action={cancelAction} className="flex flex-wrap items-end gap-2"><input type="hidden" name="id" value={p.id} />
            <div className="min-w-64 flex-1"><label htmlFor="cc" className="mb-1 block text-xs font-medium">Motivo (5 a 300)</label><input id="cc" name="reason" required minLength={5} maxLength={300} className={inputClass} /></div>
            <button className={buttonClass("danger", "sm")}>Cancelar conta</button></form>
        </SectionCard>
      )}

      <SectionCard title="Histórico"><ol className="space-y-2 text-sm">{p.events.map((e, i) => <li key={i} className="flex gap-3"><span className="w-36 shrink-0 text-xs text-muted-foreground">{formatDateTime(e.at)}</span><span>{e.text}</span></li>)}</ol></SectionCard>
    </div>
  );
}
