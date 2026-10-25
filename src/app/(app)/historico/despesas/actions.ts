"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import { removeExpenseImport } from "@/modules/expenses/history";

export async function removeExpenseImportAction(fd: FormData) {
  let err = "";
  try {
    const c = await requireContext();
    if (!c.current) throw new Forbidden();
    if (fd.get("confirm") !== "on") throw new Invalid("Marque a confirmação para desfazer a importação");
    await removeExpenseImport(db, c.user.id, c.current.id, String(fd.get("importId") ?? ""));
  } catch (e) { if (e instanceof Invalid || e instanceof Forbidden) err = e.message; else throw e; }
  revalidatePath("/historico/despesas");
  redirect(`/historico/despesas${err ? `?erro=${encodeURIComponent(err)}` : "?removido=1"}`);
}
