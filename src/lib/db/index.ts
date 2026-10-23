import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { databaseUrl } from "./url";
import * as schema from "./schema";

const g = globalThis as unknown as { _pg?: ReturnType<typeof postgres> };
const client = (g._pg ??= postgres(databaseUrl(), { max: 5 }));
export const db = drizzle(client, { schema });
