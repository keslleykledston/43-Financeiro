import { sql } from "drizzle-orm";
import type { DB } from "@/lib/db";

/** Contador atômico e compartilhado (Postgres). Retorna true se `key` passou de `max` na janela. */
export async function hit(db: DB, key: string, max: number, windowMs: number, now = new Date()): Promise<boolean> {
  const n = now.toISOString();
  const reset = new Date(now.getTime() + windowMs).toISOString();
  const rows = await db.execute(sql`
    insert into rate_limits (key, count, reset_at) values (${key}, 1, ${reset}::timestamptz)
    on conflict (key) do update set
      count = case when rate_limits.reset_at < ${n}::timestamptz then 1 else rate_limits.count + 1 end,
      reset_at = case when rate_limits.reset_at < ${n}::timestamptz then ${reset}::timestamptz else rate_limits.reset_at end
    returning count`);
  return Number((rows as unknown as { count: number }[])[0].count) > max;
}

export async function clear(db: DB, key: string) {
  await db.execute(sql`delete from rate_limits where key = ${key}`);
}

const WINDOW = 15 * 60_000;

/** Login: par conta+IP (5), conta (20) e IP (30). Um único IP não consegue travar a conta de outra pessoa. */
export async function loginBlocked(db: DB, email: string, ip: string, now = new Date()): Promise<boolean> {
  const r = await Promise.all([
    hit(db, `login:pair:${email}|${ip}`, 5, WINDOW, now),
    hit(db, `login:email:${email}`, 20, WINDOW, now),
    hit(db, `login:ip:${ip}`, 30, WINDOW, now),
  ]);
  return r.some(Boolean);
}
export const loginOk = (db: DB, email: string, ip: string) => clear(db, `login:pair:${email}|${ip}`);
