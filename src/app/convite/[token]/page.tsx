import { AcceptForm } from "./form";
import { Logo } from "@/components/k3g/shell";

export default async function Convite({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-xl border bg-card p-7">
        <Logo />
        <h1 className="mt-6 text-2xl font-semibold">Aceitar convite</h1>
        <p className="mt-1 mb-6 text-sm text-muted-foreground">Crie seu acesso. Se já tem conta, informe a senha atual.</p>
        <AcceptForm token={token} />
      </div>
    </main>
  );
}
