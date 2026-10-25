"use client";
import { useActionState } from "react";
import { forgotAction } from "./actions";
import { buttonClass, inputClass } from "@/components/k3g/button";
import { Callout } from "@/components/k3g/primitives";

export function ForgotForm() {
  const [state, action, pending] = useActionState(forgotAction, undefined);
  if (state?.done) {
    return (
      <div className="space-y-3">
        <Callout tone="positive" role="status">Se este e-mail tiver acesso, enviaremos o link para criar uma nova senha. Ele vale por 60 minutos.</Callout>
        <p className="text-sm text-muted-foreground">Não chegou em alguns minutos? Veja a caixa de spam ou peça à diretoria um link de redefinição (Configurações → Usuários e acessos).</p>
      </div>
    );
  }
  return (
    <form action={action} className="space-y-4">
      <div>
        <label htmlFor="email" className="mb-1 block text-sm font-medium">E-mail</label>
        <input id="email" name="email" type="email" autoComplete="username" required className={inputClass} />
      </div>
      {state?.error && <p role="alert" className="text-sm text-negative-foreground">{state.error}</p>}
      <button disabled={pending} className={buttonClass("primary", "md", "w-full")}>{pending ? "Enviando…" : "Enviar link"}</button>
    </form>
  );
}
