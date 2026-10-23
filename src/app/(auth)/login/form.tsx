"use client";
import { useActionState } from "react";
import { login } from "./actions";

export function LoginForm() {
  const [error, action, pending] = useActionState(login, undefined);
  return (
    <form action={action} className="space-y-4">
      <div>
        <label htmlFor="email" className="mb-1 block text-sm font-medium">E-mail</label>
        <input id="email" name="email" type="email" autoComplete="username" required className="w-full rounded-xl border border-slate-300 px-3 py-3 text-base" />
      </div>
      <div>
        <label htmlFor="password" className="mb-1 block text-sm font-medium">Senha</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required className="w-full rounded-xl border border-slate-300 px-3 py-3 text-base" />
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <button disabled={pending} className="w-full rounded-xl bg-blue-600 py-3 font-medium text-white disabled:opacity-60">{pending ? "Entrando…" : "Entrar"}</button>
    </form>
  );
}
