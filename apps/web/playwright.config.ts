import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 45_000,
  use: { baseURL: "http://127.0.0.1:4100" },
  webServer: {
    command: "pnpm exec vite --host 127.0.0.1 --port 4100 --strictPort",
    url: "http://127.0.0.1:4100",
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
