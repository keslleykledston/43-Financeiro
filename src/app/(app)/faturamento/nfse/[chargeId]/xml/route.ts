import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { previewNfse } from "@/modules/nfse/preview";
import { Forbidden } from "@/modules/identity/service";

/** Baixa o XML da DPS de PRÉVIA (homologação, sem assinatura). Só existe quando os dados estão completos. */
export async function GET(_: Request, { params }: { params: Promise<{ chargeId: string }> }) {
  const ctx = await requireContext();
  if (!ctx.current) return new Response("Sem empresa ativa", { status: 403 });
  const { chargeId } = await params;
  try {
    const p = await previewNfse(db, ctx.user.id, ctx.current.id, chargeId);
    if (!p) return new Response("Cobrança não encontrada", { status: 404 });
    if (!p.ready || !p.xml) return new Response("Dados incompletos para montar a DPS", { status: 409 });
    return new Response(p.xml, { headers: { "content-type": "application/xml; charset=utf-8", "content-disposition": `attachment; filename="dps-previa-${p.dpsId}.xml"`, "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  } catch (e) {
    if (e instanceof Forbidden) return new Response("Sem permissão", { status: 403 });
    throw e;
  }
}
