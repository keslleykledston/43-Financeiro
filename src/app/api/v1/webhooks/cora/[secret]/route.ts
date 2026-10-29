import { db } from "@/lib/db";
import { receiveCoraWebhook } from "@/modules/issuance/webhooks";

export const dynamic = "force-dynamic";

/**
 * Receptor dos avisos da Cora (E10b-5). Rota pública, protegida pelo segredo do caminho (hash no banco). Não lê o corpo.
 * O aviso só enfileira uma RECONSULTA do boleto; quem decide é a consulta autenticada à Cora (ver src/modules/issuance/webhooks.ts).
 * Formato real observado no stage: sem corpo; cabeçalhos `webhook-event-type` (ex.: invoice.CANCELED, em maiúsculas), `webhook-resource-id`, `webhook-event-id` e um cabeçalho `signature`
 * que a documentação da Cora NÃO explica (por isso não é usado como prova: o aviso é só gatilho).
 */
export async function POST(req: Request, ctx: { params: Promise<{ secret: string }> }) {
  const { secret } = await ctx.params;
  const r = await receiveCoraWebhook(db, secret, { type: req.headers.get("webhook-event-type"), resourceId: req.headers.get("webhook-resource-id"), eventId: req.headers.get("webhook-event-id") });
  if (r.status === 200) return Response.json({ success: true });
  return new Response(r.status === 404 ? "404 - Not Found" : "Too Many Requests", { status: r.status });
}
