"use client";
import { cn } from "@/lib/utils";

/** Chave liga/desliga: UM clique envia o formulário (com confirmação do navegador só quando a função pede). */
export function SwitchForm({ action, label, on, disabled, confirmMessage, children }: { action: (fd: FormData) => void | Promise<void>; label: string; on: boolean; disabled?: boolean; confirmMessage?: string; children?: React.ReactNode }) {
  return (
    <form action={action} onSubmit={(e) => { if (confirmMessage && !window.confirm(confirmMessage)) e.preventDefault(); }}>
      {children}
      <input type="hidden" name="on" value={on ? "0" : "1"} />
      <button type="submit" role="switch" aria-checked={on} aria-label={label} disabled={disabled}
        className={cn("relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50", on ? "border-positive bg-positive" : "border-border bg-muted")}>
        <span className={cn("inline-block size-5 rounded-full bg-white shadow transition-transform", on ? "translate-x-6" : "translate-x-1")} />
      </button>
    </form>
  );
}
