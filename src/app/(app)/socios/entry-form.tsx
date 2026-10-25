"use client";
import { useActionState, useMemo, useRef, useState } from "react";
import { createEntryAction } from "./actions";
import { buttonClass, inputClass, selectClass } from "@/components/k3g/button";
import { Callout } from "@/components/k3g/primitives";

type Opt = { id: string; name: string; kind: "empresa" | "pessoal" };
const KINDS: { id: string; label: string; cat: "pessoal" | "empresa" | null }[] = [
  { id: "retirada", label: "Retirada: gasto pessoal pago pela empresa", cat: "pessoal" },
  { id: "despesa_paga_pelo_socio", label: "Despesa da empresa paga pelo sócio", cat: "empresa" },
  { id: "devolucao_do_socio", label: "Devolução do sócio à empresa", cat: null },
  { id: "reembolso_ao_socio", label: "Reembolso da empresa ao sócio", cat: null },
  { id: "compensacao_lucros", label: "Compensação na distribuição de lucros", cat: null },
];

export function EntryForm({ partners, categories, today }: { partners: { id: string; name: string }[]; categories: Opt[]; today: string }) {
  const [state, action, pending] = useActionState(createEntryAction, undefined);
  const [kind, setKind] = useState("retirada");
  const key = useRef(typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Math.random()));
  const cat = KINDS.find((k) => k.id === kind)?.cat ?? null;
  const cats = useMemo(() => categories.filter((c) => c.kind === cat), [categories, cat]);
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2" key={state?.ok ? "ok" : "form"}>
      <input type="hidden" name="requestKey" value={state?.ok ? "" : key.current} />
      <div><label htmlFor="partnerId" className="mb-1 block text-sm font-medium">Sócio</label>
        <select id="partnerId" name="partnerId" required className={`${selectClass} w-full`}><option value="">Escolha…</option>{partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
      <div><label htmlFor="kind" className="mb-1 block text-sm font-medium">Tipo</label>
        <select id="kind" name="kind" value={kind} onChange={(e) => setKind(e.target.value)} className={`${selectClass} w-full`}>{KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}</select></div>
      {cat && <div><label htmlFor="categoryId" className="mb-1 block text-sm font-medium">Categoria</label>
        <select id="categoryId" name="categoryId" className={`${selectClass} w-full`}><option value="">A classificar (decidir depois)</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>}
      <div><label htmlFor="occurredOn" className="mb-1 block text-sm font-medium">Data</label>
        <input id="occurredOn" name="occurredOn" type="date" required defaultValue={today} max={today} className={inputClass} /></div>
      <div><label htmlFor="amount" className="mb-1 block text-sm font-medium">Valor (R$)</label>
        <input id="amount" name="amount" inputMode="decimal" required className={inputClass} /></div>
      <div className="sm:col-span-2"><label htmlFor="description" className="mb-1 block text-sm font-medium">Descrição</label>
        <input id="description" name="description" required minLength={2} maxLength={200} className={inputClass} placeholder="Ex.: fatura do cartão pessoal — setembro" /></div>
      {state?.error && <div className="sm:col-span-2"><Callout tone="negative" role="alert">{state.error}</Callout></div>}
      {state?.ok && <div className="sm:col-span-2"><Callout tone="positive" role="status">Lançamento registrado.</Callout></div>}
      <div className="sm:col-span-2"><button disabled={pending} className={buttonClass("primary")}>{pending ? "Salvando…" : "Registrar lançamento"}</button></div>
    </form>
  );
}
