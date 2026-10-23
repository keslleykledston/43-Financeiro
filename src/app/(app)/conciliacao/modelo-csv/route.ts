import { requireContext } from "@/lib/security/context";
import { CSV_TEMPLATE } from "@/modules/banking/parsers";

export async function GET() {
  await requireContext();
  return new Response("﻿" + CSV_TEMPLATE, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="modelo-extrato.csv"', "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}
