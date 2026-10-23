"use client";
import { useActionState } from "react";
import type { FormState } from "./actions";
import { buttonClass, inputClass } from "@/components/k3g/button";

type Defaults = { customerId?: string; description?: string; monthlyAmount?: string; startAt?: string; endAt?: string | null; dueDay?: number | string; invoiceJointRequired?: boolean; issueDayOverride?: number | null };
type Opt = { id: string; name: string; status: string };

const L = ({ id, children }: { id: string; children: React.ReactNode }) => <label htmlFor={id} className="mb-1 block text-sm font-medium">{children}</label>;

export function ContractForm({ action, defaults, customers, submit, withReason }: { action: (s: FormState, fd: FormData) => Promise<FormState>; defaults?: Defaults; customers?: Opt[]; submit: string; withReason?: boolean }) {
  const [state, act, pending] = useActionState(action, undefined);
  const v = state?.values ?? {};
  const d = (k: keyof Defaults, fb = "") => v[k] ?? (defaults?.[k] !== undefined && defaults?.[k] !== null ? String(defaults[k]) : fb);
  return (
    <form action={act} className="space-y-4" key={state?.error ?? "ok"}>
      {customers && (
        <div>
          <L id="customerId">Cliente</L>
          <select id="customerId" name="customerId" required defaultValue={d("customerId")} className={inputClass}>
            <option value="" disabled>Selecione…</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}{c.status !== "ativo" ? ` — ${c.status}` : ""}</option>)}
          </select>
          <p className="mt-1 text-xs text-muted-foreground">Só clientes <strong>ativos</strong> geram cobrança; suspenso/cancelado fica fora do calendário.</p>
        </div>
      )}
      <div><L id="description">Serviço contratado</L><input id="description" name="description" required maxLength={200} defaultValue={d("description")} className={inputClass} /></div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div><L id="monthlyAmount">Valor mensal (R$)</L><input id="monthlyAmount" name="monthlyAmount" required inputMode="decimal" placeholder="2.500,00" defaultValue={d("monthlyAmount")} className={inputClass} /></div>
        <div><L id="dueDay">Dia de vencimento (1–31)</L><input id="dueDay" name="dueDay" required type="number" min={1} max={31} defaultValue={d("dueDay")} className={inputClass} /></div>
        <div><L id="startAt">Início da vigência</L><input id="startAt" name="startAt" required type="date" defaultValue={d("startAt")} className={inputClass} /></div>
        <div><L id="endAt">Fim da vigência (opcional)</L><input id="endAt" name="endAt" type="date" defaultValue={d("endAt")} className={inputClass} /></div>
        <div><L id="issueDayOverride">Dia de emissão personalizado (opcional)</L><input id="issueDayOverride" name="issueDayOverride" type="number" min={1} max={28} defaultValue={d("issueDayOverride")} className={inputClass} /><p className="mt-1 text-xs text-muted-foreground">Deixe em branco para seguir o calendário padrão (lotes 25 / 1 / 8 / 15).</p></div>
        <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" name="invoiceJointRequired" defaultChecked={v.invoiceJointRequired ? v.invoiceJointRequired === "on" : !!defaults?.invoiceJointRequired} /> Cliente exige NF emitida junto do boleto</label>
      </div>
      {withReason && <div><L id="reason">Motivo da alteração</L><input id="reason" name="reason" maxLength={200} defaultValue={d("reason" as keyof Defaults)} placeholder="Ex.: reajuste anual" className={inputClass} /></div>}
      {state?.error && <p role="alert" className="text-sm text-negative-foreground">{state.error}</p>}
      <button disabled={pending} className={buttonClass("primary")}>{pending ? "Enviando…" : submit}</button>
    </form>
  );
}
