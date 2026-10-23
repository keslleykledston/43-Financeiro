"use client";
import { useActionState } from "react";
import { inviteAction } from "./actions";
import { ROLE_LABEL, type Role } from "@/modules/identity/permissions";

export function InviteForm({ roles }: { roles: Role[] }) {
  const [state, action, pending] = useActionState(inviteAction, undefined);
  return (
    <form action={action} className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <label className="sr-only" htmlFor="inv-email">E-mail</label>
        <input id="inv-email" name="email" type="email" required placeholder="email@empresa.com" className="flex-1 rounded-md border border-input px-3 py-2.5" />
        <label className="sr-only" htmlFor="inv-role">Papel</label>
        <select id="inv-role" name="role" className="rounded-md border border-input bg-card px-3 py-2.5">
          {roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
        </select>
        <button disabled={pending} className="rounded-md bg-primary px-4 py-2.5 font-medium text-primary-foreground disabled:opacity-60">Convidar</button>
      </div>
      {state?.error && <p role="alert" className="text-sm text-negative-foreground">{state.error}</p>}
      {state?.link && (
        <div role="status" className="rounded-md bg-positive-soft p-3 text-sm text-positive-foreground">
          Convite criado (válido por 72 h). Envie este link ao convidado — ele não será exibido de novo:
          <code className="mt-1 block break-all">{state.link}</code>
        </div>
      )}
    </form>
  );
}
