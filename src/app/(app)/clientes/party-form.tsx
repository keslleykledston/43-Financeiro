"use client";
import { useActionState } from "react";
import type { FormState } from "./actions";

type Defaults = { kind?: string; legalName?: string; tradeName?: string | null; document?: string };
const input = "w-full rounded-xl border border-slate-300 px-3 py-3 text-base";

export function PartyForm({ action, defaults, submit, lockKind }: { action: (s: FormState, fd: FormData) => Promise<FormState>; defaults?: Defaults; submit: string; lockKind?: boolean }) {
  const [state, act, pending] = useActionState(action, undefined);
  const v = state?.values ?? {};
  const d = { kind: v.kind ?? defaults?.kind ?? "cliente", legalName: v.legalName ?? defaults?.legalName ?? "", tradeName: v.tradeName ?? defaults?.tradeName ?? "", document: v.document ?? defaults?.document ?? "" };
  return (
    <form action={act} className="space-y-4" key={state?.error ?? "ok"}>
      <div>
        <label htmlFor="kind" className="mb-1 block text-sm font-medium">Tipo</label>
        <select id="kind" name="kind" defaultValue={d.kind} disabled={lockKind} className={input}><option value="cliente">Cliente</option><option value="fornecedor">Fornecedor</option></select>
        {lockKind && <p className="mt-1 text-xs text-slate-500">O tipo não pode ser alterado depois de criado.</p>}
      </div>
      <div><label htmlFor="legalName" className="mb-1 block text-sm font-medium">Razão social / nome</label><input id="legalName" name="legalName" defaultValue={d.legalName} required maxLength={200} className={input} /></div>
      <div><label htmlFor="tradeName" className="mb-1 block text-sm font-medium">Nome fantasia (opcional)</label><input id="tradeName" name="tradeName" defaultValue={d.tradeName} maxLength={200} className={input} /></div>
      <div><label htmlFor="document" className="mb-1 block text-sm font-medium">CPF ou CNPJ</label><input id="document" name="document" defaultValue={d.document} required inputMode="text" autoComplete="off" className={input} /></div>
      {state?.error && <p role="alert" className="text-sm text-red-700">{state.error}</p>}
      <button disabled={pending} className="rounded-xl bg-blue-600 px-5 py-3 font-medium text-white disabled:opacity-60">{pending ? "Salvando…" : submit}</button>
    </form>
  );
}
