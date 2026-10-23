"use client";
import { useActionState } from "react";
import { changePasswordAction } from "./actions";
import { buttonClass, inputClass } from "@/components/k3g/button";
import { Callout } from "@/components/k3g/primitives";

export function PasswordForm() {
  const [state, action, pending] = useActionState(changePasswordAction, undefined);
  return (
    <form action={action} className="max-w-sm space-y-4">
      <div>
        <label htmlFor="current" className="mb-1 block text-sm font-medium">Senha atual</label>
        <input id="current" name="current" type="password" autoComplete="current-password" required className={inputClass} />
      </div>
      <div>
        <label htmlFor="next" className="mb-1 block text-sm font-medium">Nova senha</label>
        <input id="next" name="next" type="password" autoComplete="new-password" required minLength={12} className={inputClass} />
        <p className="mt-1 text-xs text-muted-foreground">Mínimo de 12 caracteres.</p>
      </div>
      <div>
        <label htmlFor="confirm" className="mb-1 block text-sm font-medium">Confirmar nova senha</label>
        <input id="confirm" name="confirm" type="password" autoComplete="new-password" required minLength={12} className={inputClass} />
      </div>
      {state?.error && <p role="alert" className="text-sm text-negative-foreground">{state.error}</p>}
      {state?.ok && <Callout tone="positive" role="status">Senha alterada. Use a nova senha no próximo acesso.</Callout>}
      <button disabled={pending} className={buttonClass("primary")}>{pending ? "Salvando…" : "Alterar senha"}</button>
    </form>
  );
}
