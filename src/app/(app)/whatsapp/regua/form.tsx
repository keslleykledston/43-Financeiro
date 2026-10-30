"use client";
import { useActionState } from "react";
import { saveAutomationAction } from "../actions";
import { buttonClass, inputClass } from "@/components/k3g/button";

export function AutomationForm({ phrase, kinds }: { phrase: string; kinds: { key: string; label: string }[] }) {
  const [s, act, pending] = useActionState(saveAutomationAction, undefined);
  return (
    <form action={act} className="space-y-3">
      <input type="hidden" name="enable" value="1" />
      <fieldset className="space-y-1">
        <legend className="mb-1 text-sm font-medium">Quais réguas ligar (comece com UMA)</legend>
        {kinds.map((k) => <label key={k.key} className="flex items-center gap-2 text-sm"><input type="checkbox" name="kinds" value={k.key} /> {k.label}</label>)}
      </fieldset>
      <div><label htmlFor="rg-ref" className="mb-1 block text-sm font-medium">Onde está a aprovação da diretoria para a régua automática</label><input id="rg-ref" name="reference" required minLength={5} maxLength={200} placeholder="Ex.: e-mail da diretoria de 30/10/2026" className={inputClass} /></div>
      <div><label htmlFor="rg-phrase" className="mb-1 block text-sm font-medium">Para confirmar, digite: <code className="rounded bg-muted px-1">{phrase}</code></label><input id="rg-phrase" name="phrase" required autoComplete="off" className={inputClass} /></div>
      {s?.error && <p role="alert" className="text-sm text-negative-foreground">{s.error}</p>}
      <button disabled={pending} className={buttonClass("primary")}>Ligar régua automática</button>
    </form>
  );
}
