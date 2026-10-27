// Operação auditada (E28): remove a verificação em duas etapas de um usuário que ficou sem acesso (perdeu o aparelho e os códigos) e ninguém pode removê-la pela tela.
// Encerra as sessões abertas dele. Ele entra só com a senha e deve ativar o 2FA de novo.
// Uso: OPS_USER_EMAIL=... docker compose --profile tools run --rm -e OPS_USER_EMAIL tools pnpm tsx scripts/ops-2fa-reset.ts
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

(async () => {
  const email = process.env.OPS_USER_EMAIL;
  if (!email) throw new Error("Defina OPS_USER_EMAIL");
  const { db } = await import("../src/lib/db");
  const { resetTwoFactorForOps } = await import("../src/modules/identity/twofactor");
  await resetTwoFactorForOps(db, email);
  console.log("2FA removido; sessões encerradas.");
  process.exit(0);
})().catch((e) => { console.error("falha:", (e as Error).message); process.exit(1); });
