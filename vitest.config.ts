import { defineConfig } from "vitest/config";
import path from "node:path";
export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } }, // o tsconfig usa jsx: preserve (Next); os testes que importam .tsx precisam transformar
  test: { fileParallelism: false, include: ["tests/**/*.test.ts"], exclude: ["e2e/**", "node_modules/**"] },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});
