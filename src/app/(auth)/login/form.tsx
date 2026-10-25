"use client";
import { useActionState } from "react";
import Link from "next/link";
import { login } from "./actions";
import { buttonClass, inputClass } from "@/components/k3g/button";

export function LoginForm() {
  const [error, action, pending] = useActionState(login, undefined);
  return (
    <form action={action} className="space-y-4">
      <div>
        <label htmlFor="email" className="mb-1 block text-sm font-medium">E-mail</label>
        <input id="email" name="email" type="email" autoComplete="username" required className={inputClass} />
      </div>
      <div>
        <div className="mb-1 flex items-center justify-between">
          <label htmlFor="password" className="block text-sm font-medium">Senha</label>
          <Link href="/esqueci-senha" className="text-xs text-primary underline-offset-4 hover:underline">Esqueci minha senha</Link>
        </div>
        <input id="password" name="password" type="password" autoComplete="current-password" required className={inputClass} />
      </div>
      {error && <p role="alert" className="text-sm text-negative-foreground">{error}</p>}
      <button disabled={pending} className={buttonClass("primary", "md", "w-full")}>{pending ? "Entrando…" : "Entrar"}</button>
    </form>
  );
}
