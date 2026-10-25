"use client";
import { useActionState } from "react";
import { accept } from "./actions";
import { buttonClass, inputClass } from "@/components/k3g/button";
import { PasswordFields } from "@/components/k3g/password-fields";

export function AcceptForm({ token, email, existingAccount }: { token: string; email: string; existingAccount: boolean }) {
  const [state, action, pending] = useActionState(accept.bind(null, token), undefined);
  return (
    <form action={action} className="space-y-4">
      <div>
        <label htmlFor="email" className="mb-1 block text-sm font-medium">E-mail do acesso</label>
        <input id="email" name="email" type="email" value={email} readOnly autoComplete="username" className={`${inputClass} bg-muted/50`} />
      </div>
      {existingAccount ? (
        <div>
          <label htmlFor="password" className="mb-1 block text-sm font-medium">Sua senha atual</label>
          <input id="password" name="password" type="password" autoComplete="current-password" required className={inputClass} />
          <p className="mt-1 text-xs text-muted-foreground">Você já tem conta: confirme a senha para entrar nesta empresa.</p>
        </div>
      ) : (
        <>
          <div><label htmlFor="name" className="mb-1 block text-sm font-medium">Seu nome</label><input id="name" name="name" defaultValue={state?.name} required maxLength={120} autoComplete="name" className={inputClass} /></div>
          <PasswordFields email={email} idPrefix="inv" />
        </>
      )}
      {state?.error && <p role="alert" className="text-sm text-negative-foreground">{state.error}</p>}
      <button disabled={pending} className={buttonClass("primary", "md", "w-full")}>{pending ? "Entrando…" : existingAccount ? "Entrar na empresa" : "Criar acesso e entrar"}</button>
    </form>
  );
}
