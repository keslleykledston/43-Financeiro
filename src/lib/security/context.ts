import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { companies, memberships } from "@/lib/db/schema";

export const COMPANY_COOKIE = "k3g_company";

/** Contexto autenticado: empresas vêm SEMPRE de memberships ativos no servidor. */
export async function requireContext() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const list = await db
    .select({ id: companies.id, name: companies.name, role: memberships.role })
    .from(memberships)
    .innerJoin(companies, eq(companies.id, memberships.companyId))
    .where(and(eq(memberships.userId, session.user.id), eq(memberships.status, "active")));
  const wanted = (await cookies()).get(COMPANY_COOKIE)?.value;
  const current = list.find((c) => c.id === wanted) ?? list[0] ?? null;
  return { user: session.user, companies: list, current };
}
