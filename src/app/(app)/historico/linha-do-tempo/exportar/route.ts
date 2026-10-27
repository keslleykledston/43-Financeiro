import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { exportTimelineCsv } from "@/modules/history/service";
import { Forbidden } from "@/modules/identity/service";

export async function GET() {
  const ctx = await requireContext();
  if (!ctx.current) return new Response("Sem empresa ativa", { status: 403 });
  try {
    const csv = await exportTimelineCsv(db, ctx.user.id, ctx.current.id);
    return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="linha-do-tempo-clientes.csv"', "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  } catch (e) {
    if (e instanceof Forbidden) return new Response("Sem permissão", { status: 403 });
    throw e;
  }
}
