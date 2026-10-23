import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { CSV_TEMPLATE } from "@/modules/banking/parsers";

export async function GET() {
  const ctx = await requireContext();
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!role || !can(role, "bank.read")) return new Response("Sem permissão", { status: 403 });
  return new Response("\uFEFF" + CSV_TEMPLATE, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="modelo-extrato.csv"', "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}
