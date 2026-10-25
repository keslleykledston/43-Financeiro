"use client";
import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { buttonClass } from "./button";

/** Link de acesso mostrado UMA vez, com botão de copiar. Não fica guardado em lugar nenhum da tela depois de fechada. */
export function LinkOnce({ link, note }: { link: string; note: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div role="status" className="space-y-2 rounded-md bg-positive-soft p-3 text-sm text-positive-foreground">
      <p>{note}</p>
      <code className="block break-all rounded bg-card/60 p-2 text-xs">{link}</code>
      <button type="button" className={buttonClass("outline", "sm")} onClick={async () => { try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* o link continua visível para copiar à mão */ } }}>
        {copied ? <><Check className="size-3.5" aria-hidden /> Copiado</> : <><Copy className="size-3.5" aria-hidden /> Copiar link</>}
      </button>
    </div>
  );
}
