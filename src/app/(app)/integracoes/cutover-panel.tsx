"use client";
import { useActionState } from "react";
import { cutoverAction, queueUnlinkedAction, retryPushesAction } from "./actions";
import { buttonClass, inputClass } from "@/components/k3g/button";

const Msg = ({ s }: { s: { error?: string; saved?: string } | undefined }) => <>{s?.error && <p role="alert" className="text-sm text-negative-foreground">{s.error}</p>}{s?.saved && <p role="status" className="text-sm text-positive-foreground">{s.saved}</p>}</>;

/** Formulário do corte: frase de confirmação e, se a última sincronização está velha, o aceite explícito. */
export function CutoverForm({ stale, blocked }: { stale: boolean; blocked: string | null }) {
  const [s, act, pending] = useActionState(cutoverAction, undefined);
  return (
    <form action={act} className="space-y-3">
      {stale && <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="acceptStale" className="mt-0.5 size-4 accent-primary" /><span>Entendo que mudanças feitas no CRM depois da última sincronização <strong>não serão importadas</strong>.</span></label>}
      <div><label htmlFor="phrase" className="mb-1 block text-sm font-medium">Para confirmar, digite CORTE</label><input id="phrase" name="phrase" autoComplete="off" className={inputClass} disabled={!!blocked} /></div>
      {blocked && <p role="note" className="text-sm text-warning-foreground">{blocked}</p>}
      <Msg s={s} />
      <button disabled={pending || !!blocked} className={buttonClass("primary")}>{pending ? "Fazendo o corte…" : "Fazer o corte do CRM"}</button>
    </form>
  );
}

export function QueueUnlinkedForm({ count }: { count: number }) {
  const [s, act, pending] = useActionState(queueUnlinkedAction, undefined);
  return (<form action={act} className="space-y-2"><Msg s={s} /><button disabled={pending || count === 0} className={buttonClass("outline")}>{pending ? "Enfileirando…" : `Enviar ao CRM os ${count} cliente(s) sem cadastro lá`}</button></form>);
}
export function RetryPushesForm({ failed }: { failed: number }) {
  const [s, act, pending] = useActionState(retryPushesAction, undefined);
  return (<form action={act} className="space-y-2"><Msg s={s} /><button disabled={pending || failed === 0} className={buttonClass("outline")}>{pending ? "Reenfileirando…" : `Tentar de novo os ${failed} que falharam`}</button></form>);
}
