"use client";
import { useActionState } from "react";
import { accept } from "./actions";
import { buttonClass, inputClass } from "@/components/k3g/button";

export function AcceptForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(accept.bind(null, token), undefined);
  return (
    <form action={action} className="space-y-4">
      <div><label htmlFor="email" className="mb-1 block text-sm font-medium">E-mail convidado</label><input id="email" name="email" type="email" defaultValue={state?.email} required autoComplete="username" className={inputClass} /></div>
      <div><label htmlFor="name" className="mb-1 block text-sm font-medium">Nome</label><input id="name" name="name" defaultValue={state?.name} required className={inputClass} /></div>
      <div><label htmlFor="password" className="mb-1 block text-sm font-medium">Senha (mín. 12 caracteres; se já tem conta, informe a atual)</label><input id="password" name="password" type="password" minLength={12} autoComplete="new-password" required className={inputClass} /></div>
      {state?.error && <p role="alert" className="text-sm text-negative-foreground">{state.error}</p>}
      <button disabled={pending} className={buttonClass("primary", "md", "w-full")}>Criar acesso</button>
      <p className="text-xs text-muted-foreground">Contas existentes exigem a senha atual para entrar na empresa.</p>
    </form>
  );
}
