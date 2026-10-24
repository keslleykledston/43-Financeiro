"use client";
import { useFormStatus } from "react-dom";
import type { ReactNode } from "react";

/** Botão de envio que se desabilita enquanto o formulário está sendo enviado (evita clique duplo em ações sensíveis). */
export function PendingButton({ children, className, pendingText = "Enviando…" }: { children: ReactNode; className?: string; pendingText?: string }) {
  const { pending } = useFormStatus();
  return <button disabled={pending} aria-disabled={pending} className={`${className ?? ""} disabled:opacity-60`}>{pending ? pendingText : children}</button>;
}
