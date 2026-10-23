"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { signOut } from "@/auth";
import { requireContext, COMPANY_COOKIE } from "@/lib/security/context";

export async function switchCompany(formData: FormData) {
  const ctx = await requireContext();
  const id = String(formData.get("company") ?? "");
  // valida no servidor: só empresas com membership ativo
  if (ctx.companies.some((c) => c.id === id)) {
    (await cookies()).set(COMPANY_COOKIE, id, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" });
  }
  redirect("/");
}

export async function logout() {
  await signOut({ redirectTo: "/login" });
}
