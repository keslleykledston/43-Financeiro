"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { Forbidden, Invalid, inviteMember, removeMember } from "@/modules/identity/service";

const inviteSchema = z.object({
  email: z.string().email().max(254),
  role: z.enum(["admin_tecnico", "diretoria", "gerente", "assistente", "contabilidade"]),
});

export type InviteState = { error?: string; link?: string } | undefined;

export async function inviteAction(_: InviteState, fd: FormData): Promise<InviteState> {
  const ctx = await requireContext();
  if (!ctx.current) return { error: "Nenhuma empresa ativa." };
  const p = inviteSchema.safeParse({ email: fd.get("email"), role: fd.get("role") });
  if (!p.success) return { error: "Informe um e-mail válido e um papel." };
  try {
    // empresa vem do contexto validado no servidor, nunca do formulário
    const token = await inviteMember(db, ctx.user.id, ctx.current.id, p.data.email, p.data.role);
    revalidatePath("/configuracao");
    return { link: `${process.env.AUTH_URL ?? ""}/convite/${token}` };
  } catch (e) {
    if (e instanceof Forbidden || e instanceof Invalid) return { error: e.message };
    throw e;
  }
}

export async function removeAction(fd: FormData) {
  const ctx = await requireContext();
  if (!ctx.current) return;
  const id = z.string().uuid().safeParse(fd.get("membershipId"));
  if (!id.success) return;
  try { await removeMember(db, ctx.user.id, ctx.current.id, id.data); } catch (e) {
    if (!(e instanceof Forbidden || e instanceof Invalid)) throw e;
  }
  revalidatePath("/configuracao");
}
