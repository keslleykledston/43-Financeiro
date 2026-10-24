"use client";
import { useActionState, useState } from "react";
import { checkDocument } from "@/lib/validators/document";
import { saveFixAction } from "./actions";
import { inputClass } from "@/components/k3g/button";

type Sug = { digits: string; formatted: string; why: string };

/** Correção de CNPJ/CPF com validador ao vivo (dígitos verificadores) e sugestões de um clique. O servidor confere de novo. */
export function FixForm({ name, rows, rawDocuments, suggestions }: { name: string; rows: number; rawDocuments: string[]; suggestions: Sug[] }) {
  const [state, act, pending] = useActionState(saveFixAction, undefined);
  const [value, setValue] = useState("");
  const c = checkDocument(value);
  return (
    <form action={act} className="space-y-2">
      <input type="hidden" name="name" value={name} /><input type="hidden" name="expected" value="" />
      <p className="text-sm"><strong>{name}</strong> <span className="text-xs text-muted-foreground">· {rows} linha(s){rawDocuments.length ? ` · na planilha: ${rawDocuments.join(", ")}` : " · sem CNPJ/CPF na planilha"}</span></p>
      {suggestions.length > 0 && (
        <p className="flex flex-wrap items-center gap-2 text-xs">Sugestões: {suggestions.map((s) => (
          <button type="button" key={s.digits} onClick={() => setValue(s.formatted)} title={s.why} className="rounded-full bg-info-soft px-2.5 py-1 text-info-foreground">{s.formatted}</button>
        ))}</p>
      )}
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-[14rem] flex-1">
          <label htmlFor={`doc-${name}`} className="sr-only">CNPJ ou CPF correto de {name}</label>
          <input id={`doc-${name}`} name="document" value={value} onChange={(e) => setValue(e.target.value)} placeholder="CNPJ ou CPF correto" autoComplete="off" className={inputClass} aria-describedby={`dv-${name}`} />
          <p id={`dv-${name}`} aria-live="polite" className={`mt-1 text-xs ${c.state === "valido" ? "text-positive-foreground" : c.state === "invalido" ? "text-negative-foreground" : "text-muted-foreground"}`}>
            {c.state === "valido" ? `${c.type === "cnpj" ? "CNPJ" : "CPF"} válido: ${c.formatted}` : c.state === "invalido" ? c.message : c.state === "incompleto" ? `Faltam dígitos (${c.digits} informados)` : "Digite ou escolha uma sugestão"}
          </p>
        </div>
        <input name="note" maxLength={200} placeholder="Observação (opcional)" className={`${inputClass} max-w-[16rem]`} aria-label={`Observação sobre ${name}`} />
        <button disabled={pending || c.state !== "valido"} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">{pending ? "Salvando…" : "Aplicar correção"}</button>
      </div>
      {state?.error && <p role="alert" className="text-sm text-negative-foreground">{state.error}</p>}
      {state?.saved && <p role="status" className="text-sm text-positive-foreground">{state.saved}</p>}
    </form>
  );
}
