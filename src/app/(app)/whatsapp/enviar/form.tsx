"use client";
import { useActionState } from "react";
import { queueCustomerAction } from "../actions";
import { buttonClass } from "@/components/k3g/button";

export function QueueForm({ chargeId, templateVersionId, sessionId, keyValue, canQueue }: { chargeId: string; templateVersionId: string; sessionId: string; keyValue: string; canQueue: boolean }) {
  const [s, act, pending] = useActionState(queueCustomerAction, undefined);
  return (
    <form action={act} className="space-y-3">
      <input type="hidden" name="chargeId" value={chargeId} /><input type="hidden" name="templateVersionId" value={templateVersionId} /><input type="hidden" name="sessionId" value={sessionId} /><input type="hidden" name="key" value={keyValue} />
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="confirm" required className="mt-0.5 size-4 rounded border-input accent-primary" /><span>Revisei a mensagem acima e confirmo que o cliente <strong>aceitou receber</strong> cobranças por WhatsApp.</span></label>
      {s?.error && <p role="alert" className="text-sm text-negative-foreground">{s.error}</p>}
      <button disabled={pending || !canQueue} className={buttonClass("primary")}>{pending ? "Colocando na fila…" : "Colocar na fila"}</button>
      {!canQueue && <p className="text-xs text-muted-foreground">O botão libera quando toda a lista de verificação estiver verde.</p>}
    </form>
  );
}
