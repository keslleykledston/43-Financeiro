"use client";
import { useActionState } from "react";
import { addContactAction } from "./actions";

export function ContactForm({ partyId }: { partyId: string }) {
  const [state, act, pending] = useActionState(addContactAction.bind(null, partyId), undefined);
  const f = "rounded-xl border border-slate-300 px-3 py-2.5";
  return (
    <form action={act} className="space-y-2" key={state?.error ?? "ok"}>
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="sr-only" htmlFor="c-name">Nome do contato</label><input id="c-name" name="name" required placeholder="Nome" defaultValue={state?.values?.name} className={f} />
        <label className="sr-only" htmlFor="c-email">E-mail do contato</label><input id="c-email" name="email" type="email" placeholder="E-mail" defaultValue={state?.values?.email} className={f} />
        <label className="sr-only" htmlFor="c-phone">Telefone do contato</label><input id="c-phone" name="phone" placeholder="Telefone" defaultValue={state?.values?.phone} className={f} />
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="isFinancial" /> Contato financeiro (recebe cobranças)</label>
      {state?.error && <p role="alert" className="text-sm text-red-700">{state.error}</p>}
      <button disabled={pending} className="rounded-xl bg-white px-4 py-2.5 text-sm ring-1 ring-slate-300 disabled:opacity-60">Adicionar contato</button>
    </form>
  );
}
