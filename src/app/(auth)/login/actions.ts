"use server";
import { AuthError } from "next-auth";
import { signIn } from "@/auth";

/** Resultado: texto de erro, ou "totp_required" quando a senha conferiu e falta o código da verificação em duas etapas. */
export async function login(_: string | undefined, formData: FormData) {
  try {
    await signIn("credentials", { email: formData.get("email"), password: formData.get("password"), totp: formData.get("totp") ?? "", redirectTo: "/" });
  } catch (e) {
    if (e instanceof AuthError) {
      const code = (e as { code?: string }).code;
      if (code === "totp_required") return "totp_required";
      if (code === "totp_invalid") return "Código incorreto ou já usado. Tente o próximo código do aplicativo ou um código de recuperação.";
      return "E-mail ou senha inválidos.";
    }
    throw e; // redirect do Next
  }
}
