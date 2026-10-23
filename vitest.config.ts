import { defineConfig } from "vitest/config";
import path from "node:path";
export default defineConfig({
  test: { fileParallelism: false, include: ["tests/**/*.test.ts"], exclude: ["e2e/**", "node_modules/**"] },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});
