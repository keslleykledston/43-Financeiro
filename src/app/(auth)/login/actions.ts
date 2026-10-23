"use server";
import { AuthError } from "next-auth";
import { signIn } from "@/auth";

export async function login(_: string | undefined, formData: FormData) {
  try {
    await signIn("credentials", { email: formData.get("email"), password: formData.get("password"), redirectTo: "/" });
  } catch (e) {
    if (e instanceof AuthError) return "E-mail ou senha inválidos.";
    throw e; // redirect do Next
  }
}
