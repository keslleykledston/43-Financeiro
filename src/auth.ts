import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import argon2 from "argon2";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import authConfig from "./auth.config";
import { db } from "@/lib/db";
import { users, auditLog } from "@/lib/db/schema";
import { loginBlocked, loginOk } from "@/lib/security/rate-limit";
import { verifySecondFactor } from "@/modules/identity/twofactor";

const creds = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(256), totp: z.string().max(40).optional() });
// E28: só depois de a SENHA conferir é que o login diz que falta o segundo fator (nunca antes: não revela quem usa 2FA)
export class TotpRequired extends CredentialsSignin { code = "totp_required"; }
export class TotpInvalid extends CredentialsSignin { code = "totp_invalid"; }
// hash válido fictício: iguala o tempo de resposta quando o usuário não existe
const dummyHash = argon2.hash("k3g-dummy-password");

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      async authorize(raw, request) {
        const p = creds.safeParse(raw);
        if (!p.success) return null;
        const email = p.data.email.toLowerCase();
        // x-real-ip é sobrescrito pelo Nginx (não aceita valor enviado pelo cliente)
        const ip = request.headers.get("x-real-ip") ?? "unknown";
        if (await loginBlocked(db, email, ip)) return null;
        const [u] = await db.select().from(users).where(eq(sql`lower(${users.email})`, email));
        const ok = await argon2.verify(u?.passwordHash ?? (await dummyHash), p.data.password).catch(() => false);
        if (!u || u.disabledAt || !ok) {
          await db.insert(auditLog).values({ actorId: u?.id, action: "auth.login.failed" });
          return null;
        }
        if (u.totpEnabledAt) {
          const code = (p.data.totp ?? "").trim();
          if (!code) throw new TotpRequired();
          if (!(await verifySecondFactor(db, u.id, code))) {
            await db.insert(auditLog).values({ actorId: u.id, action: "auth.login.failed", detail: { step: "2fa" } });
            throw new TotpInvalid();
          }
        }
        await loginOk(db, email, ip);
        await db.insert(auditLog).values({ actorId: u.id, action: "auth.login.ok", detail: u.totpEnabledAt ? { twoFactor: true } : {} });
        return { id: u.id, name: u.name, email: u.email, sv: u.sessionVersion };
      },
    }),
  ],
  callbacks: {
    ...authConfig.callbacks,
    jwt({ token, user }) { if (user?.id) { token.uid = user.id; token.sv = (user as { sv?: number }).sv ?? 0; } return token; },
    session({ session, token }) { if (token.uid) session.user.id = token.uid as string; session.sv = typeof token.sv === "number" ? token.sv : 0; return session; },
  },
});
