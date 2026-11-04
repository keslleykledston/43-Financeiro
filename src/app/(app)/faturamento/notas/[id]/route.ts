import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { getInvoiceFile } from "@/modules/invoices/service";
import { Forbidden } from "@/modules/identity/service";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireContext();
  if (!ctx.current) return new Response("Sem empresa ativa", { status: 403 });
  const { id } = await params;
  try {
    const f = await getInvoiceFile(db, ctx.user.id, ctx.current.id, id);
    if (!f) return new Response("Nota não encontrada", { status: 404 });
    return new Response(new Uint8Array(f.pdf), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${f.filename}"`, "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  } catch (e) {
    if (e instanceof Forbidden) return new Response("Sem permissão", { status: 403 });
    throw e;
  }
}
