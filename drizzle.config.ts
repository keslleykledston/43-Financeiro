import { defineConfig } from "drizzle-kit";
import { loadEnvConfig } from "@next/env";
import { databaseUrl } from "./src/lib/db/url";

loadEnvConfig(process.cwd());
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: databaseUrl() },
});
