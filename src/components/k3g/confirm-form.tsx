"use client";

/** Formulário que pede UMA confirmação do navegador antes de enviar (para ações que cobram cliente de verdade). */
export function ConfirmForm({ action, message, className, children }: { action: (fd: FormData) => void | Promise<void>; message?: string; className?: string; children: React.ReactNode }) {
  return <form action={action} className={className} onSubmit={(e) => { if (message && !window.confirm(message)) e.preventDefault(); }}>{children}</form>;
}
