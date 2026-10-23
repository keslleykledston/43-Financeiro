"use client";
import { useActionState } from "react";
import { saveConnectionAction } from "./actions";

export function ConnectionForm({ enabled, companyRef }: { enabled: boolean; companyRef?: string }) {
  const [s, act, pending] = useActionState(saveConnectionAction, undefined);
  return (
    <form action={act} className="space-y-3">
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="enabled" defaultChecked={enabled} /> Ativar sincronização com o CRM nesta empresa</label>
      <div>
        <label htmlFor="companyRef" className="mb-1 block text-sm font-medium">Identificação desta empresa no CRM (opcional)</label>
        <input id="companyRef" name="companyRef" defaultValue={companyRef} maxLength={100} className="w-full rounded-md border border-input px-3 py-2.5" placeholder="ex.: código da conta/CNPJ emissor no CRM" />
        <p className="mt-1 text-xs text-muted-foreground">Se preenchida, só entram clientes do CRM com esta identificação; sem identificação, ficam para revisão.</p>
      </div>
      {s?.error && <p role="alert" className="text-sm text-negative-foreground">{s.error}</p>}
      {s?.saved && <p role="status" className="text-sm text-positive-foreground">Configuração salva.</p>}
      <button disabled={pending} className="rounded-md bg-card px-4 py-2.5 text-sm ring-1 ring-input disabled:opacity-60">Salvar configuração</button>
    </form>
  );
}
