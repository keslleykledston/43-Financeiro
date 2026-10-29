import { db } from "@/lib/db";
import { readBodyCapped, receiveWahaWebhook } from "@/modules/whatsapp/inbound";

export const dynamic = "force-dynamic";

/**
 * Receptor dos avisos da WAHA (W3b). Rota pública para a rede, protegida por ASSINATURA HMAC-SHA512 do corpo bruto + janela de tempo + tamanho máximo (ver src/modules/whatsapp/inbound.ts).
 * Sem a chave no servidor, ou com assinatura inválida, NADA é gravado. Resposta sem corpo útil (a WAHA só precisa do status).
 */
export async function POST(req: Request) {
  const raw = await readBodyCapped(req);                         // lido em fluxo, com corte em 256 KB ANTES de qualquer processamento
  if (!raw) return new Response(null, { status: 413 });
  const r = await receiveWahaWebhook(db, raw, {
    hmac: req.headers.get("x-webhook-hmac"), algorithm: req.headers.get("x-webhook-hmac-algorithm"), timestamp: req.headers.get("x-webhook-timestamp"), contentLength: req.headers.get("content-length"),
  });
  return new Response(null, { status: r.status });
}
