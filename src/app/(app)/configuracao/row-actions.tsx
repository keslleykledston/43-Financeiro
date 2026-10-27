"use client";
import { useActionState } from "react";
import { reissueInviteAction, resetLinkAction, resetTwoFactorAction, revokeInviteAction } from "./actions";
import { buttonClass } from "@/components/k3g/button";
import { LinkOnce } from "@/components/k3g/link-once";

export type PendingItem = { id: string; email: string; roleLabel: string; expired: boolean; until: string; canAct: boolean };

/** Lista de convites pendentes/vencidos. O estado do "Novo link" vive AQUI (acima da lista): a lista é redesenhada com o convite novo e a linha antiga some, então o link não pode morar na linha. */
export function PendingInvites({ items }: { items: PendingItem[] }) {
  const [state, action, pending] = useActionState(reissueInviteAction, undefined);
  return (
    <div className="space-y-3">
      {state?.error && <p role="alert" className="text-sm text-negative-foreground">{state.error}</p>}
      {state?.link && <LinkOnce link={state.link} note={`Novo convite criado (72 h). ${state.mail ?? ""} Este link não será exibido de novo:`} />}
      <ul className="divide-y divide-border">
        {items.map((i) => (
          <li key={i.id} className="flex flex-wrap items-start justify-between gap-3 py-2.5 text-sm">
            <div className="min-w-0"><p className="truncate font-medium">{i.email}</p><p className="text-muted-foreground">{i.roleLabel} · {i.expired ? <span className="text-warning-foreground">vencido em {i.until}</span> : <>vale até {i.until}</>}</p></div>
            {i.canAct && (
              <div className="flex gap-2">
                <form action={action}><input type="hidden" name="invitationId" value={i.id} /><button disabled={pending} className={buttonClass("outline", "sm")}>Novo link</button></form>
                <form action={revokeInviteAction}><input type="hidden" name="invitationId" value={i.id} /><button className={buttonClass("danger", "sm")}>Cancelar</button></form>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Gera o link para a pessoa criar uma nova senha (mostrado uma única vez; vale 24 h). */
export function ResetLinkButton({ membershipId }: { membershipId: string }) {
  const [state, action, pending] = useActionState(resetLinkAction, undefined);
  return (
    <div className="space-y-2">
      <form action={action}><input type="hidden" name="membershipId" value={membershipId} /><button disabled={pending} className={buttonClass("outline", "sm")}>Link de nova senha</button></form>
      {state?.error && <p role="alert" className="text-xs text-negative-foreground">{state.error}</p>}
      {state?.link && <LinkOnce link={state.link} note={`Link de redefinição criado (vale ${state.hours} h, uso único). Entregue à pessoa por um canal seguro. Ele não será exibido de novo:`} />}
    </div>
  );
}

/** Remove o 2FA do membro (perdeu o aparelho e os códigos). Pede confirmação no próprio botão. */
export function ResetTwoFactorButton({ membershipId }: { membershipId: string }) {
  const [state, action, pending] = useActionState(resetTwoFactorAction, undefined);
  if (state?.ok) return <p role="status" className="text-xs text-positive-foreground">2FA removido. A pessoa entra só com a senha e deve ativar de novo.</p>;
  return (
    <form action={action} onSubmit={(e) => { if (!confirm("Remover a verificação em duas etapas desta pessoa? As sessões abertas dela serão encerradas.")) e.preventDefault(); }}>
      <input type="hidden" name="membershipId" value={membershipId} />
      <button disabled={pending} className={buttonClass("outline", "sm")}>Remover 2FA</button>
      {state?.error && <p role="alert" className="mt-1 text-xs text-negative-foreground">{state.error}</p>}
    </form>
  );
}
