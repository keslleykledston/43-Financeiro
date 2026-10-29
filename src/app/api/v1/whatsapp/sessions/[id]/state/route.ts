import { NextResponse } from "next/server";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { Forbidden, Invalid, activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { STATUS_LABEL } from "@/modules/whatsapp/domain";
import { getQr, refreshSession } from "@/modules/whatsapp/service";

export const dynamic = "force-dynamic";
const H = { "Cache-Control": "no-store, max-age=0", Pragma: "no-cache" };

/** Estado da conexão (e o QR, se estiver aguardando leitura) para a tela. Empresa vem do servidor; sem permissão ou sem vínculo = 404/403 sem detalhe. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireContext();
  if (!ctx.current) return NextResponse.json({ error: "forbidden" }, { status: 403, headers: H });
  try {
    const r = await refreshSession(db, ctx.user.id, ctx.current.id, id);
    const role = await activeRole(db, ctx.user.id, ctx.current.id);
    let qr: string | null = null;
    if (r.status === "QR_REQUIRED" && role && can(role, "whatsapp.manage")) {
      try { qr = `data:image/png;base64,${(await getQr(db, ctx.user.id, ctx.current.id, id)).toString("base64")}`; } catch { /* QR ainda não saiu: a próxima leitura traz */ }
    }
    return NextResponse.json({ status: r.status, label: STATUS_LABEL[r.status], wahaDown: r.wahaDown, qr }, { headers: H });
  } catch (e) {
    if (e instanceof Forbidden) return NextResponse.json({ error: "forbidden" }, { status: 403, headers: H });
    if (e instanceof Invalid) return NextResponse.json({ error: "not_found" }, { status: 404, headers: H });
    throw e;
  }
}
