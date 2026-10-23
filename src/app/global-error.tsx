"use client";

// Após um deploy, abas abertas chamam ações/arquivos da versão anterior. Em vez de tela genérica, pede recarga.
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="pt-BR">
      <body style={{ fontFamily: "system-ui", display: "grid", placeItems: "center", minHeight: "100vh", margin: 0, background: "#f1f5f9" }}>
        <div role="alert" style={{ maxWidth: 360, padding: 24, background: "#fff", borderRadius: 24, textAlign: "center" }}>
          <h1 style={{ fontSize: 20, margin: 0 }}>Página desatualizada</h1>
          <p style={{ color: "#475569" }}>O sistema foi atualizado enquanto esta aba estava aberta. Recarregue para continuar.</p>
          <button onClick={() => window.location.reload()} style={{ background: "#2563eb", color: "#fff", border: 0, borderRadius: 12, padding: "12px 20px", fontSize: 16 }}>
            Recarregar
          </button>
          {error.digest && <p style={{ fontSize: 11, color: "#94a3b8" }}>ref: {error.digest}</p>}
        </div>
      </body>
    </html>
  );
}
