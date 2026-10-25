import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/lib/db";
import { previewPasswordReset } from "@/modules/identity/recovery";
import { ResetForm } from "./form";
import { Logo } from "@/components/k3g/shell";
import { buttonClass } from "@/components/k3g/button";

export const metadata: Metadata = { title: "Redefinir senha", referrer: "no-referrer" };

export default async function Redefinir({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const p = await previewPasswordReset(db, token);
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-xl border bg-card p-7">
        <Logo />
        {p.valid ? (
          <>
            <h1 className="mt-6 text-2xl font-semibold">Criar nova senha</h1>
            <p className="mt-1 mb-6 text-sm text-muted-foreground">Acesso: <strong>{p.emailMasked}</strong></p>
            <ResetForm token={token} />
          </>
        ) : (
          <>
            <h1 className="mt-6 text-2xl font-semibold">Link inválido ou expirado</h1>
            <p className="mt-1 mb-6 text-sm text-muted-foreground">Este link já foi usado, venceu ou foi substituído por outro mais novo. Peça um novo.</p>
            <Link href="/esqueci-senha" className={buttonClass("primary", "md", "w-full")}>Pedir novo link</Link>
          </>
        )}
      </div>
    </main>
  );
}
