import { defineConfig } from "@playwright/test";
import { WEATHER_FIXTURE_ORIGIN } from "./tests/e2e/weather-fixture-server";
import { QUOTE_ONTHISDAY_FIXTURE_ORIGIN } from "./tests/e2e/quote-onthisday-fixture-server";
import { resolveE2eDataDir } from "./tools/e2e-data-dir.mjs";

const port = process.env.PORT ?? "43173";
const baseURL = process.env.BASE_URL ?? `http://localhost:${port}`;
if (new URL(baseURL).port !== port) throw new Error("BASE_URL and PORT must match");

const reuseExistingServer = !process.env.CI && process.env.PW_REUSE_SERVER === "1";
const e2eDataDir = resolveE2eDataDir({
  explicitDataDir: process.env.E2E_DATA_DIR,
  reuseExistingServer,
});
process.env.E2E_DATA_DIR = e2eDataDir.dataDir;
if (e2eDataDir.owned) process.env.MP_E2E_OWNED_DATA_DIR = e2eDataDir.dataDir;
else delete process.env.MP_E2E_OWNED_DATA_DIR;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.{ts,js}",
  globalSetup: "./tests/e2e/global-setup.ts",
  globalTeardown: "./tests/e2e/global-teardown.ts",
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  workers: process.env.CI ? 1 : undefined,
  globalTimeout: 15 * 60 * 1000,
  use: { baseURL: baseURL },
  expect: { timeout: 10000 },
  reporter: [["list"], ["json", { outputFile: ".quality/playwright-results.json" }]],
  webServer: {
    command: "node --import tsx tests/e2e/prepare-shared-db.ts && npm run build && npm start",
    url: `${baseURL}/health`,
    reuseExistingServer,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      HOST: "127.0.0.1",
      PORT: port,
      WEATHER_ENDPOINT: WEATHER_FIXTURE_ORIGIN,
      QUOTE_ENDPOINT: QUOTE_ONTHISDAY_FIXTURE_ORIGIN,
      ONTHISDAY_ENDPOINT: QUOTE_ONTHISDAY_FIXTURE_ORIGIN,
      VITE_E2E_PRINT_POLL_MS: "500",
      DATA_DIR: e2eDataDir.dataDir,
      MP_BOOTSTRAP_KEY: process.env.MP_BOOTSTRAP_KEY ?? "mpk-e2e-bootstrap-key",
      ADMIN_PIN: process.env.ADMIN_PIN ?? "1234",
      MP_ACCESS_TOKEN: process.env.MP_ACCESS_TOKEN ?? "mpg-e2e-access-token",
      VITE_E2E_HOOKS: "true",
      SCHEDULER_DISABLED: "1",
    },
  },
});
