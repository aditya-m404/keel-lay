import { defineConfig } from "@playwright/test";

const web = process.env.KEEL_WEB_ORIGIN ?? "http://127.0.0.1:4100";
const port = new URL(web).port || "4100";

export default defineConfig({
  testDir: "e2e",
  timeout: 45_000,
  use: { baseURL: web },
  webServer: {
    command: `pnpm exec vite --host 127.0.0.1 --port ${port} --strictPort`,
    url: web,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
