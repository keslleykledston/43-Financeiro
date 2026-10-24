import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { exportStatementCsv } from "@/modules/commissions/service";
import { Forbidden, Invalid } from "@/modules/identity/service";

export async function GET(req: Request) {
  const ctx = await requireContext();
  if (!ctx.current) return new Response("Sem empresa ativa", { status: 403 });
  const p = new URL(req.url).searchParams;
  try {
    const csv = await exportStatementCsv(db, ctx.user.id, ctx.current.id, p.get("parceiro") ?? "", p.get("mes") ?? "");
    return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="comissoes.csv"', "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  } catch (e) {
    if (e instanceof Forbidden) return new Response("Sem permissão para exportar", { status: 403 });
    if (e instanceof Invalid) return new Response(e.message, { status: 400 });
    throw e;
  }
}
