"use client";
import "./globals.css";

// Erro inesperado (inclui abas abertas antes de um deploy, que chamam ações da versão anterior): pede recarga e mostra a referência. Não afirma uma causa que não conhece.
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="pt-BR">
      <body>
        <main className="flex min-h-screen items-center justify-center bg-background px-4">
          <div role="alert" className="max-w-sm rounded-xl border bg-card p-6 text-center">
            <h1 className="text-xl font-semibold">Algo deu errado</h1>
            <p className="mt-2 text-sm text-muted-foreground">Recarregue a página para continuar. Se acabou de haver uma atualização do sistema, é só isso; se o erro continuar, avise o suporte informando a referência abaixo.</p>
            <button onClick={() => window.location.reload()} className="mt-5 inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90">Recarregar</button>
            {error.digest && <p className="mt-3 text-[11px] text-muted-foreground">ref: {error.digest}</p>}
          </div>
        </main>
      </body>
    </html>
  );
}
