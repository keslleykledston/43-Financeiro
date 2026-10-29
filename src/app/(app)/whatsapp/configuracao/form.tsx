"use client";
import { useActionState } from "react";
import { saveCompanySettingsAction } from "../actions";
import { buttonClass, inputClass } from "@/components/k3g/button";

export function EnableForm({ phrase }: { phrase: string }) {
  const [s, act, pending] = useActionState(saveCompanySettingsAction, undefined);
  return (
    <form action={act} className="space-y-3">
      <input type="hidden" name="enable" value="1" />
      <div><label htmlFor="cf-ref" className="mb-1 block text-sm font-medium">Onde está a autorização escrita da empresa</label><input id="cf-ref" name="reference" required minLength={5} maxLength={200} placeholder="Ex.: ata/e-mail da diretoria de 29/10/2026 autorizando cobrança por WhatsApp" className={inputClass} /></div>
      <div><label htmlFor="cf-cap" className="mb-1 block text-sm font-medium">Limite diário de cobranças (1 a 10)</label><input id="cf-cap" name="dailyCap" type="number" min={1} max={10} defaultValue={5} required className={`${inputClass} max-w-[8rem]`} /></div>
      <div><label htmlFor="cf-phrase" className="mb-1 block text-sm font-medium">Para confirmar, digite: <code className="rounded bg-muted px-1">{phrase}</code></label><input id="cf-phrase" name="phrase" required autoComplete="off" className={inputClass} /></div>
      {s?.error && <p role="alert" className="text-sm text-negative-foreground">{s.error}</p>}
      <button disabled={pending} className={buttonClass("primary")}>Liberar cobrança por WhatsApp</button>
    </form>
  );
}
