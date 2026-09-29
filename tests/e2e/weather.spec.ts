import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WEATHER_FIXTURE_ORIGIN, fetchFixtureRequestCount } from "./weather-fixture-server";
import { unlockAdmin } from "./admin-unlock";
import { prepareActivePlugins } from "./plugin-fixture-db";

/** docs/features/weather.md — e2e vs the fixture provider (quickstart
 * scenario 9). Configures the household weather location through the REAL admin panel
 * (`WeatherManagement.tsx`) and proves the kiosk home pill (`WeatherPill.tsx`) renders data
 * that actually came from the fixture HTTP server `global-setup.ts` starts — never a stale
 * prior render.
 * `HouseholdSettingsProvider` (src/client/lib/householdSettings.tsx) fetches
 * `/api/settings` exactly ONCE per page load (US0 hoist, no polling, no change event) — so
 * `WeatherPill`'s `lat`/`lon` props only pick up a just-saved location after a fresh page
 * load. Every save below is followed by `page.reload` for exactly this reason; this is a
 * black-box, real-navigation proof, distinct from (and coarser than) the in-page
 * generation-counter race `tests/client/weather-pill.test.tsx`/`weather-cache.test.ts`
 * already cover at the unit level (WEATHER-AC-06).
 * The admin unlock (`AdminGate.tsx`) renders ALONGSIDE `HomeSurface` at path "/" (not a
 * route change — `currentPath` never leaves "/" while configuring weather), so every
 * `provision`/`unlockAdmin` dance below stays on the SAME kiosk home route the pill lives on.
 * The `WEATHER_ENABLED=false` operator kill-switch pass (below, "operator kill-switch") owns
 * its OWN spawned server process (critical-flow.spec.ts / host-api-skeleton.spec.ts
 * precedent) rather than reusing the shared `webServer` — that shared server's env is fixed
 * for the whole run (playwright.config.ts), so a second, differently-configured boot is the
 * only way to exercise the kill-switch through the real admin panel + a real built process.
 * `tests/boundary/weather-forecast-port.test.ts`'s * describe("buildForecastPort — operator kill-switch") already proves the PORT-level
 * contract (unit); this proves it end-to-end (never a live fetch reaches the fixture even
 * when a location IS configured).
 * (Traces: FR-016, FR-013, FR-022)
 */

const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN ?? "mpg-e2e-access-token";
const BOOTSTRAP_KEY = process.env.MP_BOOTSTRAP_KEY ?? "mpk-e2e-bootstrap-key";
const ADMIN_PIN = process.env.ADMIN_PIN ?? "1234";

/** `node dist/server/index.js` — the real production entrypoint (npm start). */
const SERVER_ENTRY = resolve(process.cwd(), "dist", "server", "index.js");
const HEALTH_TIMEOUT_MS = 30_000;

/** Reserve an ephemeral free port so parallel/CI runs never collide
 * (critical-flow.spec.ts / host-api-skeleton.spec.ts precedent). */
function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "localhost", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const { port } = addr;
        srv.close(() => resolvePort(port));
      } else {
        srv.close(() => reject(new Error("could not reserve a free port")));
      }
    });
  });
}

/** Spawn the real server against a given port + DATA_DIR + extra env; resolve once it answers
 * GET /health (critical-flow.spec.ts / host-api-skeleton.spec.ts precedent).
 */
async function startServer(
  port: number,
  dataDir: string,
  extraEnv: Record<string, string>
): Promise<ChildProcess> {
  const child = spawn("node", [SERVER_ENTRY], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "localhost",
      DATA_DIR: dataDir,
      DATABASE_PATH: "marplanner.db",
      MP_BOOTSTRAP_KEY: BOOTSTRAP_KEY,
      ADMIN_PIN,
      MP_ACCESS_TOKEN: ACCESS_TOKEN,
      SCHEDULER_DISABLED: "1",
      ...extraEnv,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => {
    stderr += String(d);
  });
  const exit: { done: boolean; code: number | null; signal: string | null } = {
    done: false,
    code: null,
    signal: null,
  };
  const onExit = (code: number | null, signal: string | null) => {
    exit.done = true;
    exit.code = code;
    exit.signal = signal;
  };
  child.once("exit", onExit);

  try {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (exit.done) {
        throw new Error(
          `server exited before becoming healthy on :${port} ` +
            `(code=${exit.code}, signal=${exit.signal}). stderr:\n${stderr}`
        );
      }
      try {
        const res = await fetch(`http://localhost:${port}/health`);
        if (res.ok) {
          child.off("exit", onExit);
          return child;
        }
      } catch {
        // not accepting connections yet — keep polling
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(
      `server on :${port} never became healthy within ${HEALTH_TIMEOUT_MS}ms. stderr:\n${stderr}`
    );
  } catch (err) {
    child.off("exit", onExit);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    throw err;
  }
}

/** Terminate a spawned server and wait for the process to actually exit. */
async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((res) => child.once("exit", () => res()));
  child.kill("SIGTERM");
  let settled = false;
  await Promise.race([
    exited.then(() => {
      settled = true;
    }),
    new Promise<void>((res) => setTimeout(res, 5_000)),
  ]);
  if (!settled && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

// Unique-per-run jitter on longitude only (task: "unique per-run coordinates") — latitude
// stays a clean integer since the fixture server's rendered temperature IS
// `Math.round(latitude)` (weather-fixture-server.ts), and the pill assertions below compare
// against that exact integer.
const RUN_JITTER = (Date.now() % 1000) / 100_000;
const LOCATION_A = { lat: 12, lon: 34.5 + RUN_JITTER };
const LOCATION_B = { lat: 52, lon: -1.25 - RUN_JITTER };

/** Clears the household `weather` settings object via raw HTTP — setup AND teardown both
 * call this to isolate retries and caller-owned persistent E2E_DATA_DIR runs — using the bootstrap key
 * directly as the `mp_device_key` cookie value (backups-restore.spec.ts precedent):
 * `reconcileBootstrap` seeds an ACTIVE, scope `'*'` `api_keys` row for it on every boot.
 * Asserts success: a silently-failing clear here would otherwise surface only as a
 * confusing pill/count mismatch much later in the test, never at its actual cause. */
async function clearWeatherLocation(request: APIRequestContext): Promise<void> {
  const res = await request.put("/api/settings", {
    headers: { cookie: `mp_device_key=${BOOTSTRAP_KEY}` },
    data: { object: "weather", settings: { lat: null, lon: null } },
  });
  expect(res.ok()).toBeTruthy();
}

/** `baseUrl` defaults to "" (relative — resolves against the shared `webServer`'s configured
 * `baseURL`); the kill-switch scenario passes its OWN spawned server's absolute origin. */
async function provision(page: Page, baseUrl = ""): Promise<void> {
  await page.goto(`${baseUrl}/`);
  await expect(page.getByTestId("access-gate-form")).toBeVisible();
  await page.getByTestId("access-gate-form").locator('input[name="token"]').fill(ACCESS_TOKEN);
  await page.getByRole("button", { name: "Enter" }).click();
  await expect(page.getByRole("button", { name: "Provision Device" })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByLabel("Bootstrap key").fill(BOOTSTRAP_KEY);
  await page.getByRole("button", { name: "Provision Device" }).click();
  await expect(page.getByTestId("home-surface")).toBeVisible({ timeout: 15_000 });
}

/** Unlock, then wait for this suite's own entry point. The unlock itself is shared. */
async function unlockAdminAndAwaitWeatherNav(page: Page): Promise<void> {
  await unlockAdmin(page, ADMIN_PIN);
  await expect(page.getByTestId("admin-nav-weather")).toBeVisible({ timeout: 10_000 });
}

/** Return through persistent family navigation so assertions observe the family-only weather pill. */
async function returnToHome(page: Page): Promise<void> {
  await page.getByRole("link", { name: /home|inicio/i, exact: true }).click();
  await expect(page.getByTestId("home-surface")).toBeVisible();
}

/** Opens the weather panel, fills lat/lon, saves, and waits for the PUT to resolve. */
async function saveWeatherLocation(
  page: Page,
  location: { lat: number; lon: number } | null
): Promise<void> {
  await page.getByTestId("admin-nav-weather").click();
  await expect(page.getByTestId("weather-management")).toBeVisible();

  const responsePromise = page.waitForResponse(
    (res) => res.url().includes("/api/settings") && res.request().method() === "PUT"
  );

  if (location === null) {
    await page.getByTestId("weather-clear").click();
  } else {
    await page.getByTestId("weather-lat-input").fill(String(location.lat));
    await page.getByTestId("weather-lon-input").fill(String(location.lon));
    await page.getByTestId("weather-save").click();
  }

  const response = await responsePromise;
  expect(response.status()).toBe(200);
}

test.describe("weather e2e (slice-016 T013)", () => {
  // Serial: the kill-switch test's request-count assertion needs the FIRST test's page (and
  // its still-running WeatherPill recheck interval) fully closed before it captures its
  // "before" count — the fixture's hit counter is process-wide, so two tests running in
  // parallel workers would race each other's fixture hits into a false positive.
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ request }) => {
    await clearWeatherLocation(request);
  });

  test.afterAll(async ({ request }) => {
    await clearWeatherLocation(request);
  });

  test("configure -> change -> clear: the home pill always reflects the CURRENT admin-panel location, never a stale one", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    await provision(page);

    // No location yet -> the pill slot renders empty (FR-022) and the surface still mounts.
    await expect(page.getByTestId("home-surface")).toBeVisible();
    await expect(page.getByTestId("weather-pill")).toHaveCount(0);

    // ---- Scenario: configure location A through the real admin panel -----------------
    await unlockAdminAndAwaitWeatherNav(page);
    await saveWeatherLocation(page, LOCATION_A);
    await page.reload();
    await returnToHome(page);

    await expect(page.getByTestId("weather-pill")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("weather-pill-temp")).toHaveText(`${LOCATION_A.lat}°`);

    // ---- Scenario: change to location B -> never renders A's stale data --------------
    await unlockAdminAndAwaitWeatherNav(page);
    await saveWeatherLocation(page, LOCATION_B);
    await page.reload();
    await returnToHome(page);

    await expect(page.getByTestId("weather-pill")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("weather-pill-temp")).toHaveText(`${LOCATION_B.lat}°`);
    await expect(page.getByTestId("weather-pill-temp")).not.toHaveText(`${LOCATION_A.lat}°`);

    // ---- Scenario: clear the location -> empty slot, navigation intact ---------------
    await unlockAdminAndAwaitWeatherNav(page);
    await saveWeatherLocation(page, null);
    await page.reload();
    await returnToHome(page);

    await expect(page.getByTestId("weather-pill")).toHaveCount(0);
    await expect(page.getByTestId("home-surface")).toBeVisible();

    // Navigation still works after the empty-slot render: a route change away from "/" and
    // back renders correctly, and the home surface is exactly as before (no crash/blank page).
    await page.goto("/calendar");
    await expect(page.getByRole("heading", { name: /calendario|calendar/i })).toBeVisible({
      timeout: 10_000,
    });
    await page.goto("/");
    await expect(page.getByTestId("home-surface")).toBeVisible();
    await expect(page.getByTestId("weather-pill")).toHaveCount(0);
  });

  test("operator kill-switch (WEATHER_ENABLED=false): configuring a location still renders the empty slot, and ZERO requests ever reach the fixture", async ({
    page,
  }) => {
    test.setTimeout(90_000);

    if (!existsSync(SERVER_ENTRY)) {
      throw new Error(
        `Built server missing at ${SERVER_ENTRY}. Run \`npm run build\` first ` +
          `(Playwright's configured webServer does this before the suite).`
      );
    }

    const countBefore = await fetchFixtureRequestCount();

    const port = await getFreePort();
    const dataDir = mkdtempSync(join(tmpdir(), "mp-weather-kill-switch-"));
    const base = `http://localhost:${port}`;
    prepareActivePlugins(dataDir, ["weather"]);
    // WEATHER_ENDPOINT is DELIBERATELY still pointed at the real fixture (not left unset or
    // pointed at an unreachable URL) — a kill-switch regression that let a fetch slip through
    // must be VISIBLE as a real hit incrementing the fixture's counter below, never masked
    // behind a generic "endpoint unreachable" absence that would look identical either way.
    const server = await startServer(port, dataDir, {
      WEATHER_ENABLED: "false",
      WEATHER_ENDPOINT: WEATHER_FIXTURE_ORIGIN,
    });
    try {
      await provision(page, base);
      await unlockAdminAndAwaitWeatherNav(page);
      await saveWeatherLocation(page, LOCATION_A);
      await page.reload();
      await returnToHome(page);

      // A location IS configured (proves this isn't vacuously "no location -> no pill"),
      // yet the pill slot renders empty because the operator kill-switch is on (FR-013).
      await expect(page.getByTestId("home-surface")).toBeVisible();
      await expect(page.getByTestId("weather-pill")).toHaveCount(0);

      // Navigation intact under the kill-switch (P2-c): a
      // kill-switch-specific regression breaking another route would otherwise be invisible
      // here — proven against THIS spawned (WEATHER_ENABLED=false) server, before it stops.
      await page.goto(`${base}/calendar`);
      await expect(page.getByRole("heading", { name: /calendario|calendar/i })).toBeVisible({
        timeout: 10_000,
      });
      await page.goto(`${base}/`);
      await expect(page.getByTestId("home-surface")).toBeVisible();
      await expect(page.getByTestId("weather-pill")).toHaveCount(0);
    } finally {
      await stopServer(server);
    }

    const countAfter = await fetchFixtureRequestCount();
    expect(countAfter).toBe(countBefore);
  });
});
