"use client";
import { useActionState, useState } from "react";
import Link from "next/link";
import { login } from "./actions";
import { buttonClass, inputClass } from "@/components/k3g/button";

export function LoginForm() {
  const [state, action, pending] = useActionState(login, undefined);
  // campos controlados: o formulário é limpo depois de cada tentativa e a senha precisa continuar no passo do código
  const [email, setEmail] = useState(""), [password, setPassword] = useState(""), [totp, setTotp] = useState("");
  const needTotp = state === "totp_required" || (state !== undefined && totp !== "");
  const error = state && state !== "totp_required" ? state : undefined;
  return (
    <form action={action} className="space-y-4">
      <div>
        <label htmlFor="email" className="mb-1 block text-sm font-medium">E-mail</label>
        <input id="email" name="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} />
      </div>
      <div>
        <div className="mb-1 flex items-center justify-between">
          <label htmlFor="password" className="block text-sm font-medium">Senha</label>
          <Link href="/esqueci-senha" className="text-xs text-primary underline-offset-4 hover:underline">Esqueci minha senha</Link>
        </div>
        <input id="password" name="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} />
      </div>
      {needTotp && (
        <div>
          <label htmlFor="totp" className="mb-1 block text-sm font-medium">Código de verificação</label>
          <input id="totp" name="totp" inputMode="text" autoComplete="one-time-code" autoFocus required value={totp} onChange={(e) => setTotp(e.target.value)} className={inputClass} />
          <p className="mt-1 text-xs text-muted-foreground">Digite o código de 6 dígitos do aplicativo autenticador (ou um código de recuperação).</p>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-negative-foreground">{error}</p>}
      <button disabled={pending} className={buttonClass("primary", "md", "w-full")}>{pending ? "Entrando…" : needTotp ? "Verificar e entrar" : "Entrar"}</button>
    </form>
  );
}
