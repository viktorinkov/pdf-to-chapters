// Playwright configuration for walnut e2e tests.
//
// One desktop project ("chromium") that runs tests 1-4 and 6, and one mobile
// project ("mobile-chromium") that only runs the mobile-viewport scenario.

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    headless: true,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
        hasTouch: false,
      },
      grepInvert: /@mobile/,
    },
    {
      name: "mobile-chromium",
      use: {
        // iPhone 14 device profile, but force the chromium browser engine so
        // we don't need a separate webkit install on the test machine.
        ...devices["iPhone 14"],
        defaultBrowserType: "chromium",
        browserName: "chromium",
      },
      grep: /@mobile/,
    },
  ],
});
