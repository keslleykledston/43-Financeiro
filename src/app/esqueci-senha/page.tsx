import type { Metadata } from "next";
import Link from "next/link";
import { ForgotForm } from "./form";
import { Logo } from "@/components/k3g/shell";

export const metadata: Metadata = { title: "Esqueci minha senha", referrer: "no-referrer" };

export default function EsqueciSenha() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-xl border bg-card p-7">
        <Logo />
        <h1 className="mt-6 text-2xl font-semibold">Esqueci minha senha</h1>
        <p className="mt-1 mb-6 text-sm text-muted-foreground">Informe o e-mail do seu acesso. Se ele existir, você recebe um link para criar uma nova senha.</p>
        <ForgotForm />
        <p className="mt-6 text-center text-sm"><Link href="/login" className="text-primary underline-offset-4 hover:underline">Voltar para a entrada</Link></p>
      </div>
    </main>
  );
}
