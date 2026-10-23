import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password) throw new Error("Defina SEED_ADMIN_EMAIL e SEED_ADMIN_PASSWORD");
  const role = (process.env.SEED_ADMIN_ROLE ?? "diretoria") as "diretoria" | "admin_tecnico";
  if (password.length < 12) throw new Error("Senha deve ter ao menos 12 caracteres");

  const argon2 = (await import("argon2")).default;
  const { db } = await import("../src/lib/db");
  const { users, companies, memberships, auditLog } = await import("../src/lib/db/schema");
  const { eq, sql } = await import("drizzle-orm");

  const [existing] = await db.select().from(users).where(eq(sql`lower(${users.email})`, email.toLowerCase()));
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const [user] = existing
    ? await db.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, existing.id)).returning()
    : await db.insert(users).values({ email, name: "Administrador", passwordHash }).returning();

  // P1 (revisão Codex): o seed NÃO altera nem reativa vínculos existentes. Só cria o que falta.
  // Mudar papel é explícito (SEED_FORCE_ROLE) e auditado.
  const force = process.env.SEED_FORCE_ROLE as "diretoria" | "gerente" | "assistente" | "contabilidade" | "admin_tecnico" | undefined;
  for (const name of ["K3G Solutions", "K3G Call"]) {
    let [c] = await db.select().from(companies).where(eq(companies.name, name));
    if (!c) [c] = await db.insert(companies).values({ name }).returning();
    if (force) {
      await db.insert(memberships).values({ userId: user.id, companyId: c.id, role: force, status: "active" })
        .onConflictDoUpdate({ target: [memberships.userId, memberships.companyId], set: { role: force, status: "active", updatedAt: new Date() } });
      await db.insert(auditLog).values({ companyId: c.id, actorId: user.id, action: "seed.membership.role_forced", detail: { role: force } });
    } else {
      await db.insert(memberships).values({ userId: user.id, companyId: c.id, role, status: "active" }).onConflictDoNothing();
    }
  }
  await db.insert(auditLog).values({ actorId: user.id, action: existing ? "seed.admin.password_reset" : "seed.admin.created" });
  console.log(existing ? "Admin atualizado." : "Admin criado.", "Empresas: K3G Solutions, K3G Call (sem CNPJ).");
  process.exit(0);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
