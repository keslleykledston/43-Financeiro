import type { NextAuthConfig } from "next-auth";

// Edge-safe: sem DB nem argon2 (usado pelo middleware).
export default {
  pages: { signIn: "/login" },
  session: { strategy: "jwt", maxAge: 8 * 60 * 60 },
  providers: [],
  callbacks: {
    authorized({ auth, request }) {
      const logged = !!auth?.user;
      if (request.nextUrl.pathname === "/login") {
        return logged ? Response.redirect(new URL("/", request.nextUrl)) : true;
      }
      return logged;
    },
  },
} satisfies NextAuthConfig;
