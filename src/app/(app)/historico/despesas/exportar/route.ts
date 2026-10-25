import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { Forbidden } from "@/modules/identity/service";
import { exportExpenseCsv } from "@/modules/expenses/history";

export async function GET(req: Request) {
  const ctx = await requireContext();
  if (!ctx.current) return new Response("Sem empresa ativa", { status: 403 });
  const what = new URL(req.url).searchParams.get("o") === "classificacao" ? "classificacao" : "divergencias";
  try {
    const csv = await exportExpenseCsv(db, ctx.user.id, ctx.current.id, what);
    return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="despesas-${what}.csv"`, "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  } catch (e) { if (e instanceof Forbidden) return new Response("Acesso negado", { status: 403 }); throw e; }
}
