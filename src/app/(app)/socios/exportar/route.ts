import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { Forbidden } from "@/modules/identity/service";
import { exportEntries } from "@/modules/expenses/ledger";

export async function GET(req: Request) {
  const ctx = await requireContext();
  if (!ctx.current) return new Response("Sem empresa", { status: 403 });
  const u = new URL(req.url);
  try {
    const csv = await exportEntries(db, ctx.user.id, ctx.current.id, { partnerId: u.searchParams.get("socio") ?? undefined, month: u.searchParams.get("mes") ?? undefined, status: u.searchParams.get("situacao") ?? undefined });
    return new Response("﻿" + csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="socios-conta-corrente.csv"', "cache-control": "no-store" } });
  } catch (e) { if (e instanceof Forbidden) return new Response("Acesso negado", { status: 403 }); throw e; }
}
