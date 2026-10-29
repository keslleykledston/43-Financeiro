import NextAuth from "next-auth";
import authConfig from "./auth.config";

export default NextAuth(authConfig).auth;
export const config = {
  matcher: ["/((?!api/auth|api/v1/health|api/v1/webhooks/cora/|api/v1/webhooks/waha|convite/|redefinir/|esqueci-senha|_next/static|_next/image|favicon.ico).*)"],
};
