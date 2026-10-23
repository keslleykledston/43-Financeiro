"use server";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { Invalid, acceptInvite } from "@/modules/identity/service";

export async function accept(token: string, _: string | undefined, fd: FormData) {
  try {
    await acceptInvite(db, token, String(fd.get("name") ?? ""), String(fd.get("password") ?? ""));
  } catch (e) {
    if (e instanceof Invalid) return e.message;
    throw e;
  }
  redirect("/login");
}
