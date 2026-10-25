"use client";
import { useActionState, useState } from "react";
import { savePayableAction } from "./actions";
import { buttonClass, inputClass, selectClass } from "@/components/k3g/button";
import { Callout } from "@/components/k3g/primitives";

type Initial = { id?: string; vendorId?: string; description?: string; documentNumber?: string; amount?: string; dueDate?: string; category?: string; categoryId?: string; costCenterId?: string; competence?: string };
type Opt = { id: string; name: string; grp?: string };

export function PayableForm({ vendors, categories = [], centers = [], initial = {} }: { vendors: { id: string; name: string }[]; categories?: Opt[]; centers?: Opt[]; initial?: Initial }) {
  const [state, action, pending] = useActionState(savePayableAction, undefined);
  const [f, setF] = useState({ vendorId: initial.vendorId ?? "", description: initial.description ?? "", documentNumber: initial.documentNumber ?? "", amount: initial.amount ?? "", dueDate: initial.dueDate ?? "", categoryId: initial.categoryId ?? "", costCenterId: initial.costCenterId ?? "", competence: initial.competence ?? "" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));
  return (
    <form action={action} className="grid max-w-3xl gap-4 sm:grid-cols-2">
      {initial.id && <input type="hidden" name="id" value={initial.id} />}
      <div className="sm:col-span-2"><label htmlFor="vendorId" className="mb-1 block text-sm font-medium">Fornecedor</label>
        <select id="vendorId" name="vendorId" required value={f.vendorId} onChange={set("vendorId")} className={`${selectClass} w-full`}><option value="">Escolha…</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></div>
      <div className="sm:col-span-2"><label htmlFor="description" className="mb-1 block text-sm font-medium">Descrição da despesa</label>
        <input id="description" name="description" required minLength={2} maxLength={200} value={f.description} onChange={set("description")} className={inputClass} /></div>
      <div><label htmlFor="documentNumber" className="mb-1 block text-sm font-medium">Nº do documento (nota/boleto/fatura)</label>
        <input id="documentNumber" name="documentNumber" maxLength={40} value={f.documentNumber} onChange={set("documentNumber")} className={inputClass} /><p className="mt-1 text-xs text-muted-foreground">Evita lançar duas vezes a mesma conta do fornecedor.</p></div>
      <div><label htmlFor="categoryId" className="mb-1 block text-sm font-medium">Categoria</label>
        <select id="categoryId" name="categoryId" value={f.categoryId} onChange={set("categoryId")} className={`${selectClass} w-full`}><option value="">Sem categoria</option>
          {[...new Set(categories.map((c) => c.grp))].map((g) => <optgroup key={g} label={g}>{categories.filter((c) => c.grp === g).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>)}</select>
        {initial.category && <input type="hidden" name="category" value={initial.category} />}
        {initial.category && <p className="mt-1 text-xs text-muted-foreground">Categoria antiga (texto): {initial.category}</p>}</div>
      <div><label htmlFor="costCenterId" className="mb-1 block text-sm font-medium">Centro de custo</label>
        <select id="costCenterId" name="costCenterId" value={f.costCenterId} onChange={set("costCenterId")} className={`${selectClass} w-full`}><option value="">Sem centro</option>{centers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
      <div><label htmlFor="competence" className="mb-1 block text-sm font-medium">Mês de competência</label>
        <input id="competence" name="competence" type="month" value={f.competence} onChange={set("competence")} className={inputClass} /><p className="mt-1 text-xs text-muted-foreground">Mês a que a despesa pertence (pode ser diferente do vencimento).</p></div>
      <div><label htmlFor="amount" className="mb-1 block text-sm font-medium">Valor (R$)</label>
        <input id="amount" name="amount" inputMode="decimal" required value={f.amount} onChange={set("amount")} className={inputClass} /></div>
      <div><label htmlFor="dueDate" className="mb-1 block text-sm font-medium">Vencimento</label>
        <input id="dueDate" name="dueDate" type="date" required value={f.dueDate} onChange={set("dueDate")} className={inputClass} /></div>
      {state?.error && <div className="sm:col-span-2"><Callout tone={state.duplicate ? "warning" : "negative"} role="alert">{state.error}</Callout></div>}
      {state?.duplicate && <label className="flex items-start gap-2 text-sm sm:col-span-2"><input type="checkbox" name="force" className="mt-0.5 size-4 accent-primary" /><span>Confirmo que <strong>não é a mesma conta</strong> e quero lançar mesmo assim.</span></label>}
      <div className="sm:col-span-2"><button disabled={pending} className={buttonClass("primary")}>{pending ? "Salvando…" : initial.id ? "Salvar rascunho" : "Salvar como rascunho"}</button></div>
    </form>
  );
}
