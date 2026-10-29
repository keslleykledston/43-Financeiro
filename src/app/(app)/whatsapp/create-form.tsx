"use client";
import { useActionState } from "react";
import { createSessionAction } from "./actions";
import { buttonClass, inputClass } from "@/components/k3g/button";

export function CreateForm({ defaultIdentity }: { defaultIdentity: string }) {
  const [s, act, pending] = useActionState(createSessionAction, undefined);
  return (
    <form action={act} className="space-y-3">
      <div><label htmlFor="wa-name" className="mb-1 block text-sm font-medium">Nome interno da conexão</label><input id="wa-name" name="displayName" required minLength={2} maxLength={64} placeholder="Ex.: Financeiro principal" className={inputClass} /></div>
      <div><label htmlFor="wa-sender" className="mb-1 block text-sm font-medium">Como o cliente vê quem escreve</label><input id="wa-sender" name="senderIdentity" required minLength={3} maxLength={80} defaultValue={defaultIdentity} className={inputClass} />
        <p className="mt-1 text-xs text-muted-foreground">Aparece no texto das mensagens. Use o nome real da empresa que cobra.</p></div>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="confirmAuthorized" required className="mt-0.5 size-4 rounded border-input accent-primary" /><span>Confirmo que tenho autorização para usar este número de WhatsApp com a empresa.</span></label>
      {s?.error && <p role="alert" className="text-sm text-negative-foreground">{s.error}</p>}
      {s?.saved && <p role="status" className="text-sm text-positive-foreground">{s.saved}</p>}
      <button disabled={pending} className={buttonClass("primary")}>{pending ? "Criando…" : "Conectar WhatsApp"}</button>
    </form>
  );
}
