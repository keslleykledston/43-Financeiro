import { randomUUID } from "node:crypto";
import { ArrowLeft } from "lucide-react";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole, Invalid } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { listAccounts, listImports, listTransactions, MARK_LABEL, TX_FILTERS, type Suggestion } from "@/modules/banking/service";
import { Callout, Money, PageHeader, SectionCard, StatusPill, type StatusTone } from "@/components/k3g/primitives";
import { EmptyState } from "@/components/k3g/states";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass, inputClass } from "@/components/k3g/button";
import { allocateAction } from "../../actions";

const FLABEL: Record<string, string> = { pendentes: "A conciliar", conciliadas: "Conciliadas", ignoradas: "Classificadas", debitos: "Débitos", todas: "Todas" };
const br = (d: string) => d.split("-").reverse().join("/");
const IMP: Record<string, [string, StatusTone]> = { previa: ["Em análise", "info"], aplicado: ["Importada", "positive"], desfeito: ["Desfeita", "neutral"], cancelado: ["Cancelada", "neutral"] };

function Badge({ s }: { s: Suggestion | null }) {
  if (!s) return null;
  if (s.level === "forte") return <StatusPill tone="positive">Sugestão forte: {s.customerName} (doc. …{s.docTail})</StatusPill>;
  if (s.level === "ambigua") return <StatusPill tone="warning">Ambígua — revisar</StatusPill>;
  if (s.level === "cliente") return <StatusPill tone="info">Cliente identificado: {s.customerName}</StatusPill>;
  if (s.level === "valor") return <StatusPill tone="neutral">Mesmo valor, sem identificador ({s.count})</StatusPill>;
  return null;
}

export default async function ContaBancaria({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ f?: string; q?: string; erro?: string; ok?: string }> }) {
  const [{ id }, sp, ctx] = await Promise.all([params, searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "bank.read")) return <Callout tone="warning">Seu papel não tem acesso à conciliação bancária.</Callout>;
  let data;
  try { data = await listTransactions(db, ctx.user.id, ctx.current.id, id, sp.f, sp.q ?? ""); } catch (e) { if (e instanceof Invalid) return <Callout tone="warning">Conta não encontrada.</Callout>; throw e; }
  const [accounts, imports] = await Promise.all([listAccounts(db, ctx.user.id, ctx.current.id), listImports(db, ctx.user.id, ctx.current.id, id)]);
  const acc = accounts.find((a) => a.id === id)!;
  const f = (TX_FILTERS as string[]).includes(sp.f ?? "") ? sp.f! : "pendentes";
  const reconcile = can(role, "bank.reconcile"), imp = can(role, "bank.import");
  const OK: Record<string, string> = { vinculado: "Crédito vinculado: a baixa foi registrada em Contas a receber.", quitada: "Crédito vinculado. Cobrança quitada." };

  return (
    <div className="space-y-5">
      <PageHeader title={data.account.name} description={`${data.account.bank}${data.account.last4 ? ` · final ${data.account.last4}` : ""}`}
        actions={<div className="flex gap-2"><AppLink href="/conciliacao" className={buttonClass("outline")}><ArrowLeft className="size-4" aria-hidden /> Contas</AppLink>{imp && <AppLink href={`/conciliacao/contas/${id}/importar`} className={buttonClass("primary")}>Importar extrato</AppLink>}</div>} />
      {sp.erro && <Callout tone="negative" role="alert">{sp.erro}</Callout>}
      {sp.ok && OK[sp.ok] && <Callout tone="positive" role="status">{OK[sp.ok]}</Callout>}
      <section aria-label="Resumo" className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Saldo pelo extrato</p><Money cents={acc.balanceCents} className="text-xl font-semibold" /><p className="text-xs text-muted-foreground">saldo inicial + movimentos importados</p></div>
        <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Créditos a conciliar</p><Money cents={acc.pendingCents} className="text-xl font-semibold" /><p className="text-xs text-muted-foreground">{acc.pendingCount} transação(ões)</p></div>
        <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Transações</p><p className="text-xl font-semibold">{acc.txCount}</p><p className="text-xs text-muted-foreground">importadas e ativas</p></div>
      </section>

      <SectionCard title="Transações">
        <nav aria-label="Filtrar" className="mb-3 flex flex-wrap gap-2 text-sm">
          {TX_FILTERS.map((x) => <AppLink key={x} href={`/conciliacao/contas/${id}?f=${x}`} className={buttonClass(x === f ? "outline" : "ghost", "sm")}>{FLABEL[x]}</AppLink>)}
        </nav>
        <form method="get" className="mb-4 flex gap-2"><input type="hidden" name="f" value={f} /><input name="q" defaultValue={sp.q ?? ""} maxLength={60} placeholder="Buscar no histórico…" aria-label="Buscar no histórico" className={`${inputClass} max-w-xs`} /><button className={buttonClass("outline", "sm")}>Buscar</button></form>
        {data.items.length === 0 ? (
          <EmptyState title="Nada neste filtro" description={f === "pendentes" ? "Importe um extrato para ver os créditos a conciliar." : "Mude o filtro ou importe um extrato."} />
        ) : (
          <ul className="divide-y divide-border">
            {data.items.map((t) => (
              <li key={t.id} className="py-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <AppLink href={`/conciliacao/transacoes/${t.id}`} className="font-medium hover:underline">{t.description}</AppLink>
                    <p className="text-xs text-muted-foreground">{br(t.postedAt)}{t.allocatedCents > 0 ? ` · vinculado ${(t.allocatedCents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}` : ""}{t.mark ? ` · ${MARK_LABEL[t.mark as keyof typeof MARK_LABEL]}` : ""}</p>
                  </div>
                  <span className="flex flex-wrap items-center gap-2"><Money cents={t.amountCents} className={t.amountCents < 0 ? "text-negative-foreground" : "font-medium"} /><Badge s={t.suggestion} /></span>
                </div>
                {reconcile && t.suggestion?.level === "forte" && (
                  <form action={allocateAction} className="mt-2 flex flex-wrap items-center gap-2">
                    <input type="hidden" name="txId" value={t.id} /><input type="hidden" name="accountId" value={id} /><input type="hidden" name="back" value="lista" />
                    <input type="hidden" name="chargeId" value={t.suggestion.chargeId} /><input type="hidden" name="amount" value={(t.remainingCents / 100).toFixed(2).replace(".", ",")} /><input type="hidden" name="requestKey" value={randomUUID().replace(/-/g, "")} />
                    <button className={buttonClass("success", "sm")}>Conciliar com {t.suggestion.customerName}</button>
                    <span className="text-xs text-muted-foreground">Confira o histórico antes: o documento do cliente aparece e o valor é igual ao saldo.</span>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
        {data.items.length === 300 && <p className="mt-3 text-xs text-muted-foreground">Mostrando as 300 mais recentes. Refine a busca.</p>}
      </SectionCard>

      <SectionCard title="Importações">
        {imports.length === 0 ? <p className="text-sm text-muted-foreground">Nenhuma importação ainda.</p> : (
          <ul className="divide-y divide-border text-sm">
            {imports.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <AppLink href={`/conciliacao/importacoes/${b.id}`} className="font-medium hover:underline">{b.fileName}</AppLink>
                <span className="flex items-center gap-3 text-xs text-muted-foreground">{b.periodStart ? `${br(b.periodStart)} a ${br(b.periodEnd!)}` : ""} · {b.newCount} nova(s), {b.dupCount} repetida(s)<StatusPill tone={IMP[b.status][1]}>{IMP[b.status][0]}</StatusPill></span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
