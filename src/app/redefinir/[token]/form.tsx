"use client";
import { useActionState } from "react";
import { resetAction } from "./actions";
import { buttonClass } from "@/components/k3g/button";
import { PasswordFields } from "@/components/k3g/password-fields";

export function ResetForm({ token, email }: { token: string; email?: string }) {
  const [state, action, pending] = useActionState(resetAction.bind(null, token), undefined);
  return (
    <form action={action} className="space-y-4">
      <PasswordFields email={email} idPrefix="reset" />
      {state?.error && <p role="alert" className="text-sm text-negative-foreground">{state.error}</p>}
      <button disabled={pending} className={buttonClass("primary", "md", "w-full")}>{pending ? "Salvando…" : "Salvar nova senha"}</button>
      <p className="text-xs text-muted-foreground">Ao salvar, todas as sessões abertas desta conta são encerradas.</p>
    </form>
  );
}
