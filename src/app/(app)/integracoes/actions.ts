"use server";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import { setCustomerMode } from "@/modules/crm/service";
import { getCrmAdapter } from "@/modules/integrations/crm/factory";
import { removeCoraCredentials, saveCoraCredentials } from "@/modules/providers/cora-config";
import { disableCoraWebhook, enableCoraWebhook } from "@/modules/issuance/webhooks";
import { removeEmailAccount, saveEmailAccount } from "@/modules/providers/email-config";
import { authorizeEmailLive, revokeEmailLive } from "@/modules/providers/email-auth";
import { sendTestEmail } from "@/modules/providers/email-live";
import { applySync, previewSync, resolveConflict, saveConnection } from "@/modules/integrations/crm/sync";

type Sample = Awaited<ReturnType<typeof previewSync>>;
export type PreviewState = { error?: string; planHash?: string; stats?: Sample["stats"]; sample?: Sample["sample"] } | undefined;
export type ApplyState = { error?: string; stats?: Sample["stats"] } | undefined;
export type ConnState = { error?: string; saved?: boolean } | undefined;

// A empresa vem SEMPRE do contexto validado no servidor.
async function ctx() {
  const c = await requireContext();
  if (!c.current) throw new Forbidden();
  return { userId: c.user.id, companyId: c.current.id };
}
const msg = (e: unknown) => { if (e instanceof Invalid || e instanceof Forbidden) return e.message; throw e; };

export async function saveConnectionAction(_: ConnState, fd: FormData): Promise<ConnState> {
  try {
    const c = await ctx();
    await saveConnection(db, c.userId, c.companyId, { enabled: fd.get("enabled") === "on", companyRef: String(fd.get("companyRef") ?? "") });
  } catch (e) { return { error: msg(e) }; }
  revalidatePath("/integracoes");
  return { saved: true };
}

export async function previewAction(): Promise<PreviewState> {
  try { const c = await ctx(); return await previewSync(db, getCrmAdapter(), c.userId, c.companyId); }
  catch (e) { return { error: msg(e) }; }
}

export async function applyAction(_: ApplyState, fd: FormData): Promise<ApplyState> {
  try {
    const c = await ctx();
    const stats = await applySync(db, getCrmAdapter(), c.userId, c.companyId, String(fd.get("expectedHash") ?? ""));
    revalidatePath("/integracoes"); revalidatePath("/clientes");
    return { stats };
  } catch (e) { return { error: msg(e) }; }
}

export async function resolveAction(fd: FormData) {
  const action = fd.get("action") === "link" ? "link" : "ignore";
  try { const c = await ctx(); await resolveConflict(db, c.userId, c.companyId, String(fd.get("conflictId") ?? ""), action); } catch (e) { msg(e); }
  revalidatePath("/integracoes");
}

export type ModeState = { error?: string; saved?: boolean } | undefined;

export async function setModeAction(_: ModeState, fd: FormData): Promise<ModeState> {
  const mode = fd.get("mode") === "crm" ? "crm" : "local";
  try { const c = await ctx(); await setCustomerMode(db, c.userId, c.companyId, mode); }
  catch (e) { return { error: msg(e) }; }
  revalidatePath("/integracoes"); revalidatePath("/clientes");
  return { saved: true };
}

export type CoraState = { error?: string; saved?: string } | undefined;
const MAX_FILE = 16_384;
/** Campo de texto OU arquivo (.pem/.crt). Nada do conteúdo é devolvido à tela nem registrado. */
async function textOrFile(fd: FormData, text: string, file: string): Promise<string> {
  const f = fd.get(file);
  if (f instanceof File && f.size > 0) {
    if (f.size > MAX_FILE) throw new Invalid("Arquivo grande demais");
    return await f.text();
  }
  return bounded(fd, text, MAX_FILE);
}
const bounded = (fd: FormData, name: string, max: number): string => {
  const v = String(fd.get(name) ?? "");
  if (v.length > max) throw new Invalid("Texto grande demais");
  return v;
};

export async function saveCoraAction(_: CoraState, fd: FormData): Promise<CoraState> {
  try {
    const c = await ctx();
    const r = await saveCoraCredentials(db, c.userId, c.companyId, {
      environment: bounded(fd, "environment", 20), label: bounded(fd, "label", 200), clientId: bounded(fd, "clientId", 400),
      certificate: await textOrFile(fd, "certificate", "certificateFile"), privateKey: await textOrFile(fd, "privateKey", "privateKeyFile"),
    });
    revalidatePath("/integracoes");
    return { saved: `Credenciais guardadas (cifradas). Certificado ${r.fingerprint}… válido até ${r.notAfter.split("-").reverse().join("/")}.` };
  } catch (e) {
    if (e instanceof Invalid || e instanceof Forbidden) return { error: e.message };
    console.error("cora: falha inesperada ao guardar credenciais", e instanceof Error ? e.name : "erro"); // nunca o conteúdo
    return { error: "Não foi possível guardar agora. Tente de novo; se persistir, avise o suporte." };
  }
}

export async function enableWebhookAction(fd: FormData) {
  try { const c = await ctx(); await enableCoraWebhook(db, c.userId, c.companyId, String(fd.get("environment") ?? ""), process.env.AUTH_URL ?? ""); } catch (e) { msg(e); }
  revalidatePath("/integracoes");
}
export async function disableWebhookAction(fd: FormData) {
  try { const c = await ctx(); await disableCoraWebhook(db, c.userId, c.companyId, String(fd.get("environment") ?? "")); } catch (e) { msg(e); }
  revalidatePath("/integracoes");
}

export async function removeCoraAction(fd: FormData) {
  try { const c = await ctx(); await removeCoraCredentials(db, c.userId, c.companyId, String(fd.get("environment") ?? "")); } catch (e) { msg(e); }
  revalidatePath("/integracoes");
}

export type EmailState = { error?: string; saved?: string; values?: Record<string, string> } | undefined;

/** Usuário e senha em branco mantêm os atuais. Nada do que foi digitado volta para a tela nem vai para o registro. */
export async function saveEmailAction(_: EmailState, fd: FormData): Promise<EmailState> {
  try {
    const c = await ctx();
    const r = await saveEmailAccount(db, c.userId, c.companyId, {
      host: bounded(fd, "host", 300), port: bounded(fd, "port", 10), security: bounded(fd, "security", 20), fromEmail: bounded(fd, "fromEmail", 300),
      fromName: bounded(fd, "fromName", 200), replyTo: bounded(fd, "replyTo", 300), user: bounded(fd, "user", 300), password: bounded(fd, "password", 600),
    });
    revalidatePath("/integracoes");
    return { saved: r.replaced ? "Conta de e-mail atualizada (usuário e senha em branco mantêm os atuais)." : "Conta de e-mail guardada (usuário e senha cifrados). Nenhum e-mail é enviado." };
  } catch (e) {
    // devolve só o que NÃO é segredo (usuário e senha são sempre limpos), para a pessoa não redigitar o resto
    if (e instanceof Invalid || e instanceof Forbidden) return { error: e.message, values: Object.fromEntries(["host", "port", "security", "fromEmail", "fromName", "replyTo"].map((k) => [k, String(fd.get(k) ?? "").slice(0, 300)])) };
    console.error("email: falha inesperada ao guardar a conta", e instanceof Error ? e.name : "erro"); // nunca o conteúdo
    return { error: "Não foi possível guardar agora. Tente de novo; se persistir, avise o suporte." };
  }
}

export async function removeEmailAction() {
  try { const c = await ctx(); await removeEmailAccount(db, c.userId, c.companyId); } catch (e) { msg(e); }
  revalidatePath("/integracoes");
}

export type LiveState = { error?: string; saved?: string } | undefined;

/** Registra a autorização escrita (canário). Não envia nada: o servidor também precisa estar com EMAIL_EXTERNAL_ENABLED=true. */
export async function authorizeEmailLiveAction(_: LiveState, fd: FormData): Promise<LiveState> {
  try {
    const c = await ctx();
    await authorizeEmailLive(db, c.userId, c.companyId, { reference: bounded(fd, "reference", 300), allowed: bounded(fd, "allowed", 3000), dailyLimit: bounded(fd, "dailyLimit", 10) });
    revalidatePath("/integracoes"); revalidatePath("/", "layout");
    return { saved: "Autorização registrada. Nada foi enviado: o envio só acontece com a chave do servidor ligada e ao processar a fila." };
  } catch (e) { if (e instanceof Invalid || e instanceof Forbidden) return { error: e.message }; throw e; }
}

export async function revokeEmailLiveAction() {
  try { const c = await ctx(); await revokeEmailLive(db, c.userId, c.companyId); } catch (e) { msg(e); }
  revalidatePath("/integracoes"); revalidatePath("/", "layout");
}

export async function testEmailAction(_: LiveState, fd: FormData): Promise<LiveState> {
  try {
    const c = await ctx();
    await sendTestEmail(db, c.userId, c.companyId, bounded(fd, "to", 300));
    revalidatePath("/integracoes");
    return { saved: "E-mail de teste enviado. Confira a caixa de entrada (e o spam) do destinatário." };
  } catch (e) {
    if (e instanceof Invalid || e instanceof Forbidden) return { error: e.message };
    console.error("email: falha inesperada no teste", e instanceof Error ? e.name : "erro");
    return { error: "Não foi possível enviar agora. Tente de novo; se persistir, avise o suporte." };
  }
}
