import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { databaseUrl } from "./url";
import * as schema from "./schema";

export type DB = PostgresJsDatabase<typeof schema>;
const g = globalThis as unknown as { _db?: DB };

// Conexão preguiçosa: o build do Next importa módulos sem credenciais.
function get(): DB {
  return (g._db ??= drizzle(postgres(databaseUrl(), { max: 5 }), { schema }));
}
export const db = new Proxy({} as DB, {
  get: (_t, prop) => Reflect.get(get(), prop),
});
