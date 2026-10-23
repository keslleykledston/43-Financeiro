import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { exportReceivables } from "@/modules/receivables/service";
import { Forbidden } from "@/modules/identity/service";

export async function GET(req: Request) {
  const ctx = await requireContext();
  if (!ctx.current) return new Response("Sem empresa ativa", { status: 403 });
  const p = new URL(req.url).searchParams;
  try {
    const csv = await exportReceivables(db, ctx.user.id, ctx.current.id, { status: p.get("status") ?? undefined, q: p.get("q") ?? undefined, dueFrom: p.get("de") ?? undefined, dueTo: p.get("ate") ?? undefined, competence: p.get("mes") ?? undefined });
    return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="contas-a-receber.csv"', "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  } catch (e) {
    if (e instanceof Forbidden) return new Response("Sem permissão para exportar", { status: 403 });
    throw e;
  }
}
