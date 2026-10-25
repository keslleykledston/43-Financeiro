import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/lib/db";
import { previewInvite } from "@/modules/identity/service";
import { ROLE_LABEL } from "@/modules/identity/permissions";
import { AcceptForm } from "./form";
import { Logo } from "@/components/k3g/shell";
import { buttonClass } from "@/components/k3g/button";

export const metadata: Metadata = { title: "Aceitar convite", referrer: "no-referrer" };

export default async function Convite({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const p = await previewInvite(db, token);
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-xl border bg-card p-7">
        <Logo />
        {p.valid ? (
          <>
            <h1 className="mt-6 text-2xl font-semibold">Criar seu acesso</h1>
            <p className="mt-1 mb-6 text-sm text-muted-foreground">Você foi convidado para <strong>{p.companyName}</strong> como <strong>{ROLE_LABEL[p.role]}</strong>.</p>
            <AcceptForm token={token} email={p.email} existingAccount={p.existingAccount} />
          </>
        ) : (
          <>
            <h1 className="mt-6 text-2xl font-semibold">Convite inválido ou expirado</h1>
            <p className="mt-1 mb-6 text-sm text-muted-foreground">Este link já foi usado, venceu ou foi cancelado. Peça à diretoria um novo convite.</p>
            <Link href="/login" className={buttonClass("outline", "md", "w-full")}>Ir para a entrada</Link>
          </>
        )}
      </div>
    </main>
  );
}
