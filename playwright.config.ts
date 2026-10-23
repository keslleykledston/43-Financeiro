import { defineConfig, devices } from "@playwright/test";

export const ADMIN_STATE = "e2e-results/admin.json";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./e2e-results/artifacts",
  reporter: [["list"], ["html", { outputFolder: "e2e-results/report", open: "never" }]],
  workers: 1,
  retries: 0,
  timeout: 30_000,
  use: { baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3150", trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    { name: "desktop", testMatch: /.*\.spec\.ts/, testIgnore: /.*\.mobile\.spec\.ts/, dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], storageState: ADMIN_STATE } },
    { name: "mobile", testMatch: /.*\.mobile\.spec\.ts/, dependencies: ["setup"],
      use: { ...devices["Pixel 5"], viewport: { width: 375, height: 812 }, storageState: ADMIN_STATE } },
  ],
});
