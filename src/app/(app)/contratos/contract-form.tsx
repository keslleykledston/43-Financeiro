"use client";
import { useActionState } from "react";
import type { FormState } from "./actions";
import { buttonClass, inputClass } from "@/components/k3g/button";

type Defaults = { customerId?: string; description?: string; monthlyAmount?: string; startAt?: string; endAt?: string | null; dueDay?: number | string; invoiceJointRequired?: boolean; issueDayOverride?: number | null };
type Opt = { id: string; name: string; status: string };

const L = ({ id, children }: { id: string; children: React.ReactNode }) => <label htmlFor={id} className="mb-1 block text-sm font-medium">{children}</label>;

const KINDS: [string, string][] = [["alteracao", "Alteração"], ["reajuste", "Reajuste (muda o valor)"], ["valor", "Ajuste de valor"], ["prorrogacao", "Prorrogação (muda o fim)"], ["outros", "Outros"]];

export function ContractForm({ action, defaults, customers, submit, withReason, amendment, approveNow }: { action: (s: FormState, fd: FormData) => Promise<FormState>; defaults?: Defaults; customers?: Opt[]; submit: string; withReason?: boolean; amendment?: boolean; approveNow?: boolean }) {
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
        <div><L id="endAt">Fim da vigência (opcional)</L><input id="endAt" name="endAt" type="date" defaultValue={d("endAt")} className={inputClass} /><p className="mt-1 text-xs text-muted-foreground">Deixe em branco: o contrato vale 12 meses e renova sozinho se o cliente não se manifestar. Preencha só quando o cliente encerrar.</p></div>
        <div><L id="issueDayOverride">Dia de emissão personalizado (opcional)</L><input id="issueDayOverride" name="issueDayOverride" type="number" min={1} max={28} defaultValue={d("issueDayOverride")} className={inputClass} /><p className="mt-1 text-xs text-muted-foreground">Deixe em branco para seguir o calendário padrão (lotes 25 / 1 / 8 / 15).</p></div>
        <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" name="invoiceJointRequired" defaultChecked={v.invoiceJointRequired ? v.invoiceJointRequired === "on" : !!defaults?.invoiceJointRequired} /> Cliente exige NF emitida junto do boleto</label>
      </div>
      {withReason && <div><L id="reason">Motivo da alteração</L><input id="reason" name="reason" maxLength={200} defaultValue={d("reason" as keyof Defaults)} placeholder="Ex.: reajuste anual" className={inputClass} /></div>}
      {amendment && (
        <fieldset className="grid gap-4 rounded-md border bg-muted/30 p-3 sm:grid-cols-2">
          <legend className="px-1 text-sm font-medium">Aditivo</legend>
          <div><L id="kind">Tipo</L><select id="kind" name="kind" defaultValue={v.kind ?? "alteracao"} className={inputClass}>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
          <div><L id="effectiveOn">Vale a partir de (opcional)</L><input id="effectiveOn" name="effectiveOn" type="date" defaultValue={v.effectiveOn ?? ""} className={inputClass} /><p className="mt-1 text-xs text-muted-foreground">Não pode ser futura. Cobranças já geradas não mudam.</p></div>
          <div className="sm:col-span-2"><L id="reference">Referência do documento (opcional)</L><input id="reference" name="reference" maxLength={200} defaultValue={v.reference ?? ""} placeholder="Ex.: 2º aditivo assinado em 10/10/2026, pasta Contratos/2026" className={inputClass} /></div>
        </fieldset>
      )}
      {approveNow && <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="approveNow" defaultChecked={v.approveNow === "on"} /> Aprovar agora (diretoria): o aditivo passa a valer já, e fica registrado quem pediu e quem aprovou</label>}
      {state?.error && <p role="alert" className="text-sm text-negative-foreground">{state.error}</p>}
      <button disabled={pending} className={buttonClass("primary")}>{pending ? "Enviando…" : submit}</button>
    </form>
  );
}
