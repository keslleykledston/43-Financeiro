"use client";
import { useActionState } from "react";
import { accept } from "./actions";

export function AcceptForm({ token }: { token: string }) {
  const [error, action, pending] = useActionState(accept.bind(null, token), undefined);
  return (
    <form action={action} className="space-y-4">
      <div><label htmlFor="name" className="mb-1 block text-sm font-medium">Nome</label><input id="name" name="name" required className="w-full rounded-xl border border-slate-300 px-3 py-3" /></div>
      <div><label htmlFor="password" className="mb-1 block text-sm font-medium">Senha (mín. 12 caracteres)</label><input id="password" name="password" type="password" minLength={12} autoComplete="new-password" required className="w-full rounded-xl border border-slate-300 px-3 py-3" /></div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <button disabled={pending} className="w-full rounded-xl bg-blue-600 py-3 font-medium text-white disabled:opacity-60">Criar acesso</button>
      <p className="text-xs text-slate-500">Se você já tem conta, sua senha atual é mantida.</p>
    </form>
  );
}
