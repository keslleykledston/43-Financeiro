import { ArrowLeft } from "lucide-react";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { commitments, listSeries, listTemplates } from "@/modules/payables/planning";
import { listActiveVendors } from "@/modules/payables/service";
import { listCategories, listCostCenters } from "@/modules/expenses/catalog";
import { todayManaus } from "@/modules/messaging/service";
import { formatBRL } from "@/lib/format";
import { Callout, PageHeader, SectionCard, StatusPill } from "@/components/k3g/primitives";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass, inputClass, selectClass } from "@/components/k3g/button";
import { createSeriesAction, createTemplateAction, patchTemplateAction, toggleSeriesAction, toggleTemplateAction } from "./actions";

const br = (d: string) => d.split("-").reverse().join("/");
const mes = (m: string) => `${m.slice(5, 7)}/${m.slice(0, 4)}`;
const OKMSG: Record<string, string> = { "1": "Salvo.", modelo: "Modelo salvo.", serie: "Parcelamento cadastrado." };

export default async function Recorrentes({ searchParams }: { searchParams: Promise<{ erro?: string; ok?: string }> }) {
  const [sp, ctx] = await Promise.all([searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "payables.read")) return <Callout tone="warning">Seu papel não tem acesso às contas a pagar.</Callout>;
  const manage = can(role, "payables.manage");
  const today = todayManaus();
  const [templates, series, com, vendors, cats, centers] = await Promise.all([
    listTemplates(db, ctx.user.id, ctx.current.id), listSeries(db, ctx.user.id, ctx.current.id, today), commitments(db, ctx.user.id, ctx.current.id, today),
    manage ? listActiveVendors(db, ctx.user.id, ctx.current.id) : Promise.resolve([]), manage ? listCategories(db, ctx.user.id, ctx.current.id, { kind: "empresa" }) : Promise.resolve([]), manage ? listCostCenters(db, ctx.user.id, ctx.current.id) : Promise.resolve([]),
  ]);
  const groups = [...new Set(cats.map((c) => c.grp))];
  const Sel = ({ id, label, kind }: { id: string; label: string; kind: "v" | "c" | "cc" }) => (
    <div><label htmlFor={id} className="mb-1 block text-sm font-medium">{label}</label>
      {kind === "v" ? <select id={id} name="vendorId" required className={`${selectClass} w-full`}><option value="">Escolha…</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select>
        : kind === "c" ? <select id={id} name="categoryId" className={`${selectClass} w-full`}><option value="">Sem categoria</option>{groups.map((g) => <optgroup key={g} label={g}>{cats.filter((c) => c.grp === g).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>)}</select>
        : <select id={id} name="costCenterId" className={`${selectClass} w-full`}><option value="">Sem centro</option>{centers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}</div>
  );
  return (
    <div className="space-y-5">
      <PageHeader title="Recorrentes e parcelas" description={ctx.current.name} actions={<AppLink href="/contas-a-pagar" className={buttonClass("outline")}><ArrowLeft className="size-4" aria-hidden /> Contas a pagar</AppLink>} />
      <Callout tone="info">Contas que se repetem todo mês (Vivo, energia, Simples, salários) e parcelamentos (empréstimo, consórcio, carro) viram <strong>rascunhos</strong> de contas a pagar quando você usa <strong>Gerar o mês</strong> no Calendário. Nada é aprovado nem pago sozinho.</Callout>
      {sp.erro && <Callout tone="negative" role="alert">{sp.erro}</Callout>}
      {sp.ok && <Callout tone="positive" role="status">{OKMSG[sp.ok] ?? "Salvo."}</Callout>}

      <section aria-label="Compromissos" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Parcelas a pagar (todas as séries)</p><p className="text-xl font-semibold">{formatBRL(com.installmentsCents)}</p><p className="text-xs text-muted-foreground">{com.installmentsCount} parcela(s) em {com.seriesCount} parcelamento(s)</p></div>
        <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Recorrentes por mês</p><p className="text-xl font-semibold">{formatBRL(com.recurringMonthlyCents)}</p><p className="text-xs text-muted-foreground">valor esperado dos modelos ativos</p></div>
      </section>

      <SectionCard title="Parcelamentos">
        {series.length === 0 ? <p className="text-sm text-muted-foreground">Nenhum parcelamento cadastrado.</p> : (
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead><tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground"><th className="py-2 pr-3">Parcelamento</th><th className="pr-3">Parcela</th><th className="pr-3">Pagas</th><th className="pr-3">Restam</th><th className="pr-3">Próximo venc.</th><th className="pr-3">Último venc.</th><th /></tr></thead>
            <tbody className="divide-y divide-border">
              {series.map((r) => (
                <tr key={r.id} className={r.active ? "" : "text-muted-foreground"}>
                  <td className="py-2 pr-3"><span className="font-medium">{r.description}</span><span className="block text-xs text-muted-foreground">{r.vendorName}{!r.active && " · encerrado"}</span></td>
                  <td className="pr-3 whitespace-nowrap">{formatBRL(r.amountCents)} × {r.installments}</td><td className="pr-3">{r.paid}</td>
                  <td className="pr-3 whitespace-nowrap">{r.remaining} · {formatBRL(r.remainingCents)}</td><td className="pr-3 whitespace-nowrap">{r.nextDue ? br(r.nextDue) : "—"}</td><td className="pr-3 whitespace-nowrap">{br(r.lastDue)}</td>
                  <td className="text-right">{manage && <form action={toggleSeriesAction}><input type="hidden" name="id" value={r.id} /><input type="hidden" name="active" value={r.active ? "0" : "1"} /><button className={buttonClass("ghost", "sm")}>{r.active ? "Encerrar" : "Reabrir"}</button></form>}</td>
                </tr>
              ))}
            </tbody></table></div>
        )}
        {manage && (
          <form action={createSeriesAction} className="mt-4 grid gap-3 border-t pt-4 sm:grid-cols-2 lg:grid-cols-3">
            <h3 className="text-sm font-semibold sm:col-span-2 lg:col-span-3">Novo parcelamento</h3>
            <Sel id="vs" label="Fornecedor" kind="v" />
            <div className="lg:col-span-2"><label htmlFor="sdesc" className="mb-1 block text-sm font-medium">Descrição</label><input id="sdesc" name="description" required minLength={2} maxLength={160} className={inputClass} placeholder="Ex.: Empréstimo K3G2" /></div>
            <div><label htmlFor="sn" className="mb-1 block text-sm font-medium">Nº de parcelas</label><input id="sn" name="installments" type="number" min={2} max={120} required className={inputClass} /></div>
            <div><label htmlFor="sfirst" className="mb-1 block text-sm font-medium">Primeiro vencimento</label><input id="sfirst" name="firstDue" type="date" required className={inputClass} /></div>
            <div><label htmlFor="samt" className="mb-1 block text-sm font-medium">Valor de cada parcela (R$)</label><input id="samt" name="amount" inputMode="decimal" required className={inputClass} /></div>
            <Sel id="cs" label="Categoria" kind="c" /><Sel id="ccs" label="Centro de custo" kind="cc" />
            <p className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-3">Se já pagou algumas parcelas, cadastre o parcelamento com o <strong>primeiro vencimento ainda em aberto</strong> e o número de parcelas que restam.</p>
            <div className="sm:col-span-2 lg:col-span-3"><button className={buttonClass("primary")}>Cadastrar parcelamento</button></div>
          </form>
        )}
      </SectionCard>

      <SectionCard title="Contas recorrentes (todo mês)">
        {templates.length === 0 ? <p className="text-sm text-muted-foreground">Nenhum modelo cadastrado.</p> : (
          <ul className="divide-y divide-border">
            {templates.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-sm">
                <div className="min-w-0"><p className="font-medium">{t.description}{!t.active && <span className="ml-2"><StatusPill tone="neutral">inativo</StatusPill></span>}</p>
                  <p className="text-xs text-muted-foreground">{t.vendorName} · todo dia {t.dueDay} · de {mes(t.startMonth)}{t.endMonth ? ` até ${mes(t.endMonth)}` : " sem fim"}{t.categoryName ? ` · ${t.categoryName}` : ""}{t.costCenterName ? ` · ${t.costCenterName}` : ""}{t.lastGenerated ? ` · gerado até ${mes(t.lastGenerated)}` : ""}</p></div>
                {manage && (
                  <div className="flex flex-wrap items-center gap-2">
                    <form action={patchTemplateAction} className="flex items-center gap-1"><input type="hidden" name="id" value={t.id} />
                      <input name="amount" aria-label={`Valor esperado: ${t.description}`} defaultValue={(t.amountCents / 100).toFixed(2).replace(".", ",")} inputMode="decimal" className={`${inputClass} w-28`} />
                      <input name="dueDay" aria-label={`Dia do vencimento: ${t.description}`} type="number" min={1} max={31} defaultValue={t.dueDay} className={`${inputClass} w-16`} />
                      <input name="endMonth" aria-label={`Mês final: ${t.description}`} type="month" defaultValue={t.endMonth ?? ""} className={`${inputClass} w-40`} />
                      <button className={buttonClass("outline", "sm")}>Salvar</button></form>
                    <form action={toggleTemplateAction}><input type="hidden" name="id" value={t.id} /><input type="hidden" name="active" value={t.active ? "0" : "1"} /><button className={buttonClass("ghost", "sm")}>{t.active ? "Desativar" : "Reativar"}</button></form>
                  </div>
                )}
                {!manage && <span className="text-sm">{formatBRL(t.amountCents)}</span>}
              </li>
            ))}
          </ul>
        )}
        {manage && (
          <form action={createTemplateAction} className="mt-4 grid gap-3 border-t pt-4 sm:grid-cols-2 lg:grid-cols-3">
            <h3 className="text-sm font-semibold sm:col-span-2 lg:col-span-3">Nova conta recorrente</h3>
            <Sel id="vt" label="Fornecedor" kind="v" />
            <div className="lg:col-span-2"><label htmlFor="tdesc" className="mb-1 block text-sm font-medium">Descrição</label><input id="tdesc" name="description" required minLength={2} maxLength={200} className={inputClass} placeholder="Ex.: Vivo corporativo" /></div>
            <div><label htmlFor="tamt" className="mb-1 block text-sm font-medium">Valor esperado (R$)</label><input id="tamt" name="amount" inputMode="decimal" required className={inputClass} /></div>
            <div><label htmlFor="tday" className="mb-1 block text-sm font-medium">Dia do vencimento</label><input id="tday" name="dueDay" type="number" min={1} max={31} required className={inputClass} /></div>
            <div><label htmlFor="tstart" className="mb-1 block text-sm font-medium">A partir de</label><input id="tstart" name="startMonth" type="month" required defaultValue={today.slice(0, 7)} className={inputClass} /></div>
            <div><label htmlFor="tend" className="mb-1 block text-sm font-medium">Até (opcional)</label><input id="tend" name="endMonth" type="month" className={inputClass} /></div>
            <Sel id="ct" label="Categoria" kind="c" /><Sel id="cct" label="Centro de custo" kind="cc" />
            <div className="sm:col-span-2 lg:col-span-3"><button className={buttonClass("primary")}>Cadastrar conta recorrente</button></div>
          </form>
        )}
      </SectionCard>
    </div>
  );
}
