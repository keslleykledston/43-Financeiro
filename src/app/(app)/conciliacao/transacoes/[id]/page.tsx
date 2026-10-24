import { randomUUID } from "node:crypto";
import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { getTransaction, MARK_KINDS, MARK_LABEL } from "@/modules/banking/service";
import { Callout, Money, PageHeader, SectionCard, StatusPill } from "@/components/k3g/primitives";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass, inputClass, selectClass } from "@/components/k3g/button";
import { allocateAction, markAction, undoAllocationAction, unmarkAction } from "../../actions";

const br = (d: string) => d.split("-").reverse().join("/");
const RANK: Record<string, string> = { documento: "Documento do cliente no histórico", valor: "Mesmo valor (sem identificador — confira)", busca: "Encontrada pela busca" };
const OK: Record<string, string> = { vinculado: "Vínculo feito e baixa registrada.", quitada: "Vínculo feito. Cobrança quitada.", desfeito: "Vínculo desfeito: o pagamento foi estornado e o saldo voltou.", classificada: "Transação classificada.", liberada: "Classificação removida." };
const fmt = (c: number) => (c / 100).toFixed(2).replace(".", ",");

export default async function Transacao({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ q?: string; erro?: string; ok?: string }> }) {
  const [{ id }, sp, ctx] = await Promise.all([params, searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "bank.read")) return <Callout tone="warning">Seu papel não tem acesso à conciliação bancária.</Callout>;
  const r = await getTransaction(db, ctx.user.id, ctx.current.id, id, sp.q ?? "");
  if (!r) notFound();
  const { tx } = r;
  const reconcile = can(role, "bank.reconcile"), undo = can(role, "bank.undo");
  const credit = tx.amountCents > 0;

  return (
    <div className="space-y-5">
      <PageHeader title={tx.description} description={`${r.tx.accountName} · ${br(tx.postedAt)}`}
        actions={<AppLink href={`/conciliacao/contas/${tx.accountId}`} className={buttonClass("outline")}><ArrowLeft className="size-4" aria-hidden /> Conta</AppLink>} />
      {sp.erro && <Callout tone="negative" role="alert">{sp.erro}</Callout>}
      {sp.ok && OK[sp.ok] && <Callout tone="positive" role="status">{OK[sp.ok]}</Callout>}
      {tx.status === "desfeita" && <Callout tone="warning">Esta transação pertence a uma importação desfeita.</Callout>}

      <section aria-label="Valores" className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Valor</p><Money cents={tx.amountCents} className="text-xl font-semibold" /><p className="text-xs text-muted-foreground">{credit ? "Crédito (entrada)" : "Débito (saída)"}</p></div>
        {credit && <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Já vinculado</p><Money cents={r.allocatedCents} className="text-xl font-semibold" /></div>}
        {credit && <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Falta vincular</p><Money cents={r.remainingCents} className="text-xl font-semibold" /></div>}
      </section>

      {r.mark && (
        <SectionCard title="Classificação">
          <p className="text-sm"><StatusPill tone="neutral">{MARK_LABEL[r.mark.kind as keyof typeof MARK_LABEL]}</StatusPill>{r.mark.note ? <span className="ml-2 text-muted-foreground">{r.mark.note}</span> : null}</p>
          {reconcile && <form action={unmarkAction} className="mt-3"><input type="hidden" name="txId" value={tx.id} /><button className={buttonClass("outline", "sm")}>Remover classificação</button></form>}
        </SectionCard>
      )}

      {credit && !r.mark && r.remainingCents > 0 && tx.status === "ativa" && reconcile && (
        <SectionCard title="Vincular a uma cobrança">
          {r.suggestion?.level === "forte" && <Callout tone="positive">Sugestão forte: o histórico traz o documento de <strong>{r.suggestion.customerName}</strong> e há uma cobrança com saldo igual ao valor.</Callout>}
          {r.suggestion?.level === "ambigua" && <Callout tone="warning">Há mais de uma possibilidade: escolha manualmente a cobrança certa.</Callout>}
          {r.suggestion?.level === "valor" && <Callout tone="warning">Há {r.suggestion.count} cobrança(s) com este valor, mas o histórico <strong>não identifica o cliente</strong>. Não adivinhe: confirme com o comprovante.</Callout>}
          <p className="mt-2 text-xs text-muted-foreground">Crédito maior que a cobrança por causa de atraso? Informe o <strong>juros/multa</strong>. Cliente pagou menos com desconto combinado? Informe o <strong>desconto</strong>: a cobrança é quitada pelo valor do crédito + desconto.</p>
          <form method="get" className="my-3 flex gap-2"><input name="q" defaultValue={sp.q ?? ""} maxLength={60} placeholder="Buscar cliente…" aria-label="Buscar cliente" className={`${inputClass} max-w-xs`} /><button className={buttonClass("outline", "sm")}>Buscar</button></form>
          {r.candidates.length === 0 ? <p className="text-sm text-muted-foreground">Nenhuma cobrança em aberto combina. Busque pelo nome do cliente.</p> : (
            <ul className="divide-y divide-border text-sm">
              {r.candidates.map((c) => (
                <li key={c.id} className="py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div><p className="font-medium">{c.customerName}</p><p className="text-xs text-muted-foreground">{c.description} · comp. {c.competence.slice(5, 7)}/{c.competence.slice(0, 4)} · vence {br(c.dueDate)} · {RANK[c.rank] ?? ""}</p></div>
                    <span className="text-right"><Money cents={c.openCents} /><span className="block text-xs text-muted-foreground">saldo em aberto</span></span>
                  </div>
                  <form action={allocateAction} className="mt-2 flex flex-wrap items-end gap-2">
                    <input type="hidden" name="txId" value={tx.id} /><input type="hidden" name="chargeId" value={c.id} /><input type="hidden" name="requestKey" value={randomUUID().replace(/-/g, "")} />
                    <div><label htmlFor={`v-${c.id}`} className="mb-1 block text-xs font-medium">Valor do crédito a vincular (R$)</label><input id={`v-${c.id}`} name="amount" inputMode="decimal" defaultValue={fmt(Math.min(c.openCents, r.remainingCents))} required className={`${inputClass} w-40`} /></div>
                    <div><label htmlFor={`j-${c.id}`} className="mb-1 block text-xs font-medium">Juros/multa incluídos (opcional)</label><input id={`j-${c.id}`} name="interest" inputMode="decimal" placeholder="0,00" className={`${inputClass} w-36`} /></div>
                    <div><label htmlFor={`d-${c.id}`} className="mb-1 block text-xs font-medium">Desconto concedido (opcional)</label><input id={`d-${c.id}`} name="discount" inputMode="decimal" placeholder="0,00" className={`${inputClass} w-36`} /></div>
                    <button className={buttonClass("primary", "sm")}>Vincular</button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      )}

      {!r.mark && tx.status === "ativa" && reconcile && r.allocatedCents === 0 && (
        <SectionCard title="Não é pagamento de cobrança?">
          <form action={markAction} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="txId" value={tx.id} />
            <div><label htmlFor="kind" className="mb-1 block text-xs font-medium">Classificar como</label><select id="kind" name="kind" className={selectClass}>{MARK_KINDS.map((k) => <option key={k} value={k}>{MARK_LABEL[k]}</option>)}</select></div>
            <div className="min-w-56 flex-1"><label htmlFor="note" className="mb-1 block text-xs font-medium">Observação (opcional)</label><input id="note" name="note" maxLength={200} className={inputClass} /></div>
            <button className={buttonClass("outline", "sm")}>Classificar</button>
          </form>
          <p className="mt-2 text-xs text-muted-foreground">Classificar não cria pagamento nem receita. O pareamento entre contas do grupo é uma fase futura.</p>
        </SectionCard>
      )}

      <SectionCard title="Vínculos">
        {r.allocations.length === 0 ? <p className="text-sm text-muted-foreground">Nenhum vínculo.</p> : (
          <ul className="divide-y divide-border text-sm">
            {r.allocations.map((a) => (
              <li key={a.id} className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div><AppLink href={`/contas-a-receber/${a.chargeId}`} className={a.status === "desfeita" ? "text-muted-foreground line-through" : "font-medium hover:underline"}>{a.customerName}</AppLink><p className="text-xs text-muted-foreground">{a.description}</p></div>
                  <span className="flex items-center gap-2"><Money cents={a.amountCents} /><StatusPill tone={a.status === "ativa" ? "positive" : "neutral"}>{a.status === "ativa" ? "Ativo" : "Desfeito"}</StatusPill></span>
                </div>
                {a.status === "desfeita" && <p className="mt-1 text-xs text-muted-foreground">Motivo: {a.undoReason}</p>}
                {undo && a.status === "ativa" && (
                  <details className="mt-2"><summary className="cursor-pointer text-xs font-medium text-negative-foreground">Desfazer vínculo</summary>
                    <form action={undoAllocationAction} className="mt-2 flex flex-wrap items-end gap-2">
                      <input type="hidden" name="txId" value={tx.id} /><input type="hidden" name="allocationId" value={a.id} />
                      <div className="min-w-64 flex-1"><label htmlFor={`u-${a.id}`} className="mb-1 block text-xs font-medium">Motivo (5 a 270 caracteres)</label><input id={`u-${a.id}`} name="reason" required minLength={5} maxLength={270} className={inputClass} /></div>
                      <button className={buttonClass("danger", "sm")}>Confirmar</button>
                    </form></details>
                )}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
