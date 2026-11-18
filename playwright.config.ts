import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 90000,
  expect: { timeout: 15000 },
  workers: 1,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000",
    trace: "retain-on-failure",
    storageState: process.env.SOLAR_TEST_STORAGE_STATE,
    proxy: process.env.SOLAR_TEST_PROXY
      ? { server: process.env.SOLAR_TEST_PROXY }
      : undefined,
    ignoreHTTPSErrors: !!process.env.SOLAR_TEST_PROXY,
  },
  reporter: "list",
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : [
        {
          command:
            "dotnet run --project services/platform-api --urls http://127.0.0.1:5080",
          url: "http://127.0.0.1:5080/health",
          reuseExistingServer: !process.env.CI,
          timeout: 120000,
        },
        {
          command: "npm start",
          url: "http://localhost:3000",
          reuseExistingServer: !process.env.CI,
          timeout: 120000,
        },
      ],
});
