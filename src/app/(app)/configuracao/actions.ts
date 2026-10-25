"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { Forbidden, Invalid, INVITE_TTL_MS, inviteMember, reissueInvitation, removeMember, revokeInvitation } from "@/modules/identity/service";
import { issueResetLink } from "@/modules/identity/recovery";
import { ROLE_LABEL, type Role } from "@/modules/identity/permissions";
import { inviteMail, reasonText, sendSystemEmail } from "@/modules/providers/email-system";

const inviteSchema = z.object({
  email: z.string().email().max(254),
  role: z.enum(["admin_tecnico", "diretoria", "gerente", "assistente", "contabilidade"]),
});

export type InviteState = { error?: string; link?: string; mail?: string } | undefined;

const baseUrl = () => process.env.AUTH_URL ?? "";

/** Tenta enviar o convite por e-mail (mesmas travas do envio real). Nunca falha o convite: devolve a frase para a tela. */
async function mailInvite(actorId: string, companyId: string, companyName: string, email: string, role: Role, link: string): Promise<string> {
  try {
    const r = await sendSystemEmail(db, companyId, actorId, inviteMail(email, link, companyName, ROLE_LABEL[role], INVITE_TTL_MS / 3600_000));
    return r.sent ? `Convite enviado por e-mail para ${email}.` : `E-mail não enviado: ${reasonText(r.reason)}. Envie o link abaixo por outro meio.`;
  } catch { return "E-mail não enviado. Envie o link abaixo por outro meio."; }
}

export async function inviteAction(_: InviteState, fd: FormData): Promise<InviteState> {
  const ctx = await requireContext();
  if (!ctx.current) return { error: "Nenhuma empresa ativa." };
  const p = inviteSchema.safeParse({ email: fd.get("email"), role: fd.get("role") });
  if (!p.success) return { error: "Informe um e-mail válido e um papel." };
  try {
    // empresa vem do contexto validado no servidor, nunca do formulário
    const token = await inviteMember(db, ctx.user.id, ctx.current.id, p.data.email, p.data.role);
    revalidatePath("/configuracao");
    const link = `${baseUrl()}/convite/${token}`;
    return { link, mail: await mailInvite(ctx.user.id, ctx.current.id, ctx.current.name, p.data.email.toLowerCase(), p.data.role, link) };
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

const id = z.string().uuid();

export async function revokeInviteAction(fd: FormData) {
  const ctx = await requireContext();
  if (!ctx.current) return;
  const i = id.safeParse(fd.get("invitationId"));
  if (!i.success) return;
  try { await revokeInvitation(db, ctx.user.id, ctx.current.id, i.data); } catch (e) { if (!(e instanceof Forbidden || e instanceof Invalid)) throw e; }
  revalidatePath("/configuracao");
}

/** Novo link para um convite pendente ou vencido (o anterior deixa de valer). */
export async function reissueInviteAction(_: InviteState, fd: FormData): Promise<InviteState> {
  const ctx = await requireContext();
  if (!ctx.current) return { error: "Nenhuma empresa ativa." };
  const i = id.safeParse(fd.get("invitationId"));
  if (!i.success) return { error: "Convite inválido." };
  try {
    const r = await reissueInvitation(db, ctx.user.id, ctx.current.id, i.data);
    revalidatePath("/configuracao");
    const link = `${baseUrl()}/convite/${r.token}`;
    return { link, mail: await mailInvite(ctx.user.id, ctx.current.id, ctx.current.name, r.email, r.role, link) };
  } catch (e) { if (e instanceof Forbidden || e instanceof Invalid) return { error: e.message }; throw e; }
}

export type ResetLinkState = { error?: string; link?: string; hours?: number } | undefined;

/** Link de redefinição de senha de um membro, mostrado uma única vez (entregue por quem administra). */
export async function resetLinkAction(_: ResetLinkState, fd: FormData): Promise<ResetLinkState> {
  const ctx = await requireContext();
  if (!ctx.current) return { error: "Nenhuma empresa ativa." };
  const m = id.safeParse(fd.get("membershipId"));
  if (!m.success) return { error: "Membro inválido." };
  try { return await issueResetLink(db, ctx.user.id, ctx.current.id, m.data, baseUrl()); }
  catch (e) { if (e instanceof Forbidden || e instanceof Invalid) return { error: e.message }; throw e; }
}
