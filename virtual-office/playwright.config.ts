import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./browser",
  timeout: 45_000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4317",
    viewport: { width: 1440, height: 1000 },
    channel: "chrome",
    headless: true,
    screenshot: "only-on-failure",
  },
  outputDir: ".runtime/browser-results",
  reporter: "list",
});
