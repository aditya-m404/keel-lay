import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 45_000,
  use: { baseURL: "http://127.0.0.1:4102" },
  webServer: {
    command: "node src/server.ts",
    url: "http://127.0.0.1:4102/targets",
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
