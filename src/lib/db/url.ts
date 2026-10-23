export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  const { POSTGRES_USER: u, POSTGRES_PASSWORD: p } = env;
  if (!u || !p) throw new Error("Defina POSTGRES_USER e POSTGRES_PASSWORD no .env");
  const host = env.POSTGRES_HOST ?? "127.0.0.1";
  const port = env.POSTGRES_PORT ?? "5440";
  return `postgresql://${encodeURIComponent(u)}:${encodeURIComponent(p)}@${host}:${port}/k3gfinance`;
}
