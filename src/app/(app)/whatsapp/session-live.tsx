"use client";
import { useEffect, useState } from "react";

type Live = { status: string; label: string; wahaDown: boolean; qr: string | null };

/** Atualiza o estado da conexão e, quando aguardando leitura, mostra o QR (que a WAHA renova sozinha). O QR vem por rota autenticada, sem cache; a chave da WAHA nunca chega aqui. */
export function SessionLive({ id, initial, label, canSeeQr }: { id: string; initial: string; label: string; canSeeQr: boolean }) {
  const [live, setLive] = useState<Live>({ status: initial, label, wahaDown: false, qr: null });
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let stop = false, timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (stop) return;
      let next = 15_000;
      try {
        if (document.visibilityState === "visible") {
          const r = await fetch(`/api/v1/whatsapp/sessions/${id}/state`, { cache: "no-store", credentials: "same-origin" });
          if (!r.ok) throw new Error(String(r.status));
          const j = (await r.json()) as Live;
          if (!stop) { setLive(j); setFailed(false); }
          if (j.status === "QR_REQUIRED" || j.status === "STARTING") next = 4_000;
        }
      } catch { if (!stop) setFailed(true); }
      if (!stop) timer = setTimeout(tick, next);
    };
    timer = setTimeout(tick, initial === "QR_REQUIRED" || initial === "STARTING" ? 800 : 5_000);
    return () => { stop = true; clearTimeout(timer); };
  }, [id, initial]);

  return (
    <div className="space-y-3" aria-live="polite">
      <p className="text-sm"><span className="text-muted-foreground">Situação agora:</span> <strong data-testid="wa-live-status">{failed ? "sem resposta (tentando de novo)" : live.label}</strong>{live.wahaDown && !failed ? <span className="ml-2 text-warning-foreground">WAHA fora do ar</span> : null}</p>
      {canSeeQr && live.status === "QR_REQUIRED" && (
        live.qr ? (
          <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={live.qr} alt="QR Code para conectar o WhatsApp" width={232} height={232} className="rounded-md border bg-white p-2" />
            <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
              <li>No celular, abra o WhatsApp → <strong>Aparelhos conectados</strong>.</li>
              <li>Toque em <strong>Conectar um aparelho</strong> e aponte a câmera para este QR.</li>
              <li>O QR troca sozinho; se expirar, aguarde o novo.</li>
            </ol>
          </div>
        ) : <p className="text-sm text-muted-foreground">Gerando o QR Code…</p>
      )}
      {live.status === "CONNECTED" && <p className="text-sm text-positive-foreground">Número conectado. A conexão continua pausada até a diretoria liberar.</p>}
    </div>
  );
}
