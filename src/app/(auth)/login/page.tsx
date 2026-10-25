import { LoginForm } from "./form";
import { Logo } from "@/components/k3g/shell";
import { Callout } from "@/components/k3g/primitives";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ senha?: string }> }) {
  const sp = await searchParams;
  return (
    <main className="grid min-h-screen lg:grid-cols-2">
      <section className="hidden flex-col justify-between bg-brand-panel p-10 text-brand-panel-foreground lg:flex">
        <span className="inline-flex items-center gap-2 font-display font-semibold">
          <span className="flex size-8 items-center justify-center rounded-md bg-primary text-sm font-bold text-primary-foreground">K3</span>
          <span className="text-base">K3G Finance</span>
        </span>
        <div>
          <h2 className="max-w-md text-4xl leading-tight font-semibold">Cobrança recorrente, do contrato ao recebimento.</h2>
          <p className="mt-4 max-w-md text-sm opacity-80">Clientes, contratos, lotes de faturamento e conciliação das duas empresas do grupo, com rastreabilidade e aprovação humana em cada passo.</p>
        </div>
        <p className="text-xs opacity-70">Área restrita à diretoria e ao time financeiro.</p>
      </section>
      <section className="flex items-center justify-center bg-background px-4 py-10">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden"><Logo /></div>
          <h1 className="text-2xl font-semibold">Acessar o painel</h1>
          <p className="mt-1 mb-6 text-sm text-muted-foreground">Acesso somente por convite. Entre com seu e-mail corporativo.</p>
          {sp.senha === "ok" && <Callout tone="positive" role="status" className="mb-4">Senha alterada. Entre com a nova senha.</Callout>}
          <LoginForm />
        </div>
      </section>
    </main>
  );
}
