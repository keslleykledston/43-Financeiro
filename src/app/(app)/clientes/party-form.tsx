"use client";
import { useActionState, useState } from "react";
import type { FormState } from "./actions";
import { checkDocument } from "@/lib/validators/document";

type Defaults = { kind?: string; legalName?: string; tradeName?: string | null; document?: string; status?: string };
const input = "w-full rounded-md border border-input px-3 py-3 text-base";

export function PartyForm({ action, defaults, submit, lockKind, onlyVendor }: { action: (s: FormState, fd: FormData) => Promise<FormState>; defaults?: Defaults; submit: string; lockKind?: boolean; onlyVendor?: boolean }) {
  const [state, act, pending] = useActionState(action, undefined);
  const v = state?.values ?? {};
  const [kindNow, setKindNow] = useState<string | undefined>(undefined);
  const [docNow, setDocNow] = useState<string | null>(null);
  const d = { status: v.status ?? defaults?.status ?? "ativo", kind: v.kind ?? defaults?.kind ?? (onlyVendor ? "fornecedor" : "cliente"), legalName: v.legalName ?? defaults?.legalName ?? "", tradeName: v.tradeName ?? defaults?.tradeName ?? "", document: v.document ?? defaults?.document ?? "" };
  return (
    <form action={act} className="space-y-4" key={state?.error ?? "ok"}>
      <div>
        <label htmlFor="kind" className="mb-1 block text-sm font-medium">Tipo</label>
        <select id="kind" name="kind" defaultValue={d.kind} disabled={lockKind} onChange={(e) => setKindNow(e.target.value)} className={input}>{!onlyVendor && <option value="cliente">Cliente</option>}<option value="fornecedor">Fornecedor</option></select>
        {lockKind && <p className="mt-1 text-xs text-muted-foreground">O tipo não pode ser alterado depois de criado.</p>}
      </div>
      {(kindNow ?? d.kind) === "cliente" && (
        <div>
          <label htmlFor="status" className="mb-1 block text-sm font-medium">Situação</label>
          <select id="status" name="status" defaultValue={d.status} className={input}><option value="ativo">Ativo (faturável)</option><option value="suspenso">Suspenso</option><option value="cancelado">Cancelado</option></select>
          <p className="mt-1 text-xs text-muted-foreground">Suspenso e cancelado continuam clientes (podem ter dívidas antigas), mas não geram nova cobrança.</p>
        </div>
      )}
      <div><label htmlFor="legalName" className="mb-1 block text-sm font-medium">Razão social / nome</label><input id="legalName" name="legalName" defaultValue={d.legalName} required maxLength={200} className={input} /></div>
      <div><label htmlFor="tradeName" className="mb-1 block text-sm font-medium">Nome fantasia (opcional)</label><input id="tradeName" name="tradeName" defaultValue={d.tradeName} maxLength={200} className={input} /></div>
      <div><label htmlFor="document" className="mb-1 block text-sm font-medium">CPF ou CNPJ</label><input id="document" name="document" defaultValue={d.document} required inputMode="text" autoComplete="off" onChange={(e) => setDocNow(e.target.value)} aria-describedby="document-check" className={input} />
        <DocHint value={docNow ?? d.document} onPick={(x) => { const el = document.getElementById("document") as HTMLInputElement | null; if (el) el.value = x; setDocNow(x); }} /></div>
      {state?.error && <p role="alert" className="text-sm text-negative-foreground">{state.error}</p>}
      <button disabled={pending} className="rounded-md bg-primary px-5 py-3 font-medium text-primary-foreground disabled:opacity-60">{pending ? "Salvando…" : submit}</button>
    </form>
  );
}

/** Validador ao vivo do CPF/CNPJ (dígitos verificadores) com sugestão do provável erro de digitação. O servidor confere de novo ao salvar. */
function DocHint({ value, onPick }: { value: string; onPick: (formatted: string) => void }) {
  const c = checkDocument(value);
  if (c.state === "vazio") return <p id="document-check" className="mt-1 text-xs text-muted-foreground">Digite o CPF (11 dígitos) ou o CNPJ (14). Conferimos os dígitos verificadores.</p>;
  if (c.state === "incompleto") return <p id="document-check" aria-live="polite" className="mt-1 text-xs text-muted-foreground">Faltam dígitos ({c.digits} informados).</p>;
  if (c.state === "valido") return <p id="document-check" aria-live="polite" className="mt-1 text-xs text-positive-foreground">{c.type === "cnpj" ? "CNPJ" : "CPF"} válido: {c.formatted}</p>;
  return (
    <p id="document-check" aria-live="polite" className="mt-1 text-xs text-negative-foreground">{c.message}.{c.suggestions.length > 0 && <> Será que é{" "}
      {c.suggestions.map((s) => <button type="button" key={s.digits} onClick={() => onPick(s.formatted)} title={s.why} className="mr-1 rounded-full bg-info-soft px-2 py-0.5 text-info-foreground">{s.formatted}</button>)}?</>}</p>
  );
}

