import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { messages, resolveLang } from "../../src/client/i18n/messages";
import { startUnifiFixtureServer, type UnifiFixtureServer } from "./unifi-fixture-server";
import { unlockAdmin } from "./admin-unlock";
import { prepareActivePlugins } from "./plugin-fixture-db";

/** docs/features/network-devices.md — lifecycle e2e (FR-001, FR-009, FR-010; quickstart.md
 * scenario 10 + "Admin access posture"). Fake-client-backed instance: seed a live client via a
 * local self-signed HTTPS fixture standing in for the real UniFi controller, register it from the
 * picker, block it, then delete it (confirming the warning) — asserting UI state after each step.
 * OWN spawned server (backups-restore.spec.ts's pattern), NOT the shared Playwright `webServer`:
 * the shared server runs with `SCHEDULER_DISABLED=1` (playwright.config.ts), which never
 * registers the network-devices poller job at all (`src/server/index.ts`'s `startScheduler`) — the
 * live cache would stay `cold` forever and the picker could never show a fresh client. This spec's
 * own server runs with the scheduler ENABLED so `registerNetworkDevicesPollerJob`'s * run-on-startup poll actually populates the cache against the fixture below.
 * Auth posture (quickstart.md "Admin access posture", review 2026-09-04): a management cookie set
 * directly via `context.addCookies` — `mp_device_key` = the raw `MP_MANAGEMENT_KEY` value (the
 * `kind='integration'` row `reconcileManagement` seeds at boot) plus the non-HttpOnly
 * `mp_provisioned` marker `Shell.tsx` gates on (FR-031/ADR-059) — never the browser-driven
 * provisioning flow, which only ever mints a `kind='device'` key `requireManagementKey` rejects
 * (AC-06). The access-gate cookie (`mp_gate`, auth/gate.ts) is set the same way so the SPA loads
 * directly, without driving the HTML gate form.
 * FINDING (reported, not fixed here): `client.ts`'s `unifi.tlsInsecure` toggle is broken on this
 * repo's Node 24 — see `unifi-fixture-server.ts`'s docblock for the root cause (an `undici`
 * npm-package `Agent` passed as Node's built-in `fetch`'s `dispatcher`, a cross-major-version ABI
 * mismatch: Node 24 bundles undici 7.29.0 internally, the pinned npm package is 8.10.2).
 * `network-devices-client.test.ts`'s own tlsInsecure coverage never catches this because it spies
 * on `globalThis.fetch` directly (the real fetch call — and thus the real dispatcher — is never
 * invoked). This spec therefore does NOT set `UNIFI_TLS_INSECURE`; instead it points
 * `NODE_EXTRA_CA_CERTS` at the fixture's self-signed cert so Node's OWN default TLS validation
 * trusts it, keeping `client.ts` on its plain (dispatcher-free) `fetch` path.
 * Admin PIN seeding: `admin_config.pin_hash` (the row `AdminGate`'s PIN unlock compares against)
 * is seeded ONLY inside `POST /api/auth/provision`'s handler (`auth/provision.ts`) — there is no
 * standalone reconcile seam for it the way `reconcileManagement` covers the management key
 *. So this spec calls the REAL provision endpoint once, with the REAL bootstrap key, purely
 * as a seeding side effect (it also mints a throwaway `kind='device'` cookie pair, which the
 * subsequent `context.addCookies` call below immediately overwrites with the real management
 * key) — never driving the browser-side `ProvisioningScreen` UI itself.
 */

const MP_ACCESS_TOKEN = "mpg-e2e-network-devices-access-token";
const MP_BOOTSTRAP_KEY = `mpk-e2e-network-devices-bootstrap-${Date.now()}`;
const MP_MANAGEMENT_KEY = `mpk-e2e-network-devices-${Date.now()}`;
const ADMIN_PIN = "1234";

const SERVER_ENTRY = resolve(process.cwd(), "dist", "server", "index.js");
const HEALTH_TIMEOUT_MS = 30_000;

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

function gateCookieValue(token: string): string {
  // Mirrors auth/gate.ts's own `sha256Hex` — the gate cookie's value is the sha256 hex digest of
  // the configured access token, never the token itself.
  return createHash("sha256").update(token).digest("hex");
}

/** Unique, non-wall-clock-dependent per-run suffix (member-lifecycle.spec.ts's `generateMemberName`
 * precedent) — avoids collision with any leftover state, even though this spec's own DATA_DIR is
 * a fresh tmp directory every run and so should never actually collide. */
function uniqueSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

function randomMac(): string {
  const bytes = Array.from({ length: 6 }, () =>
    Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, "0")
  );
  // Set the locally-administered + unicast bits on the first octet — cosmetic only, avoids ever
  // colliding with a real vendor OUI.
  bytes[0] = ((parseInt(bytes[0], 16) & 0xfe) | 0x02).toString(16).padStart(2, "0");
  return bytes.join(":").toUpperCase();
}

async function startServer(
  port: number,
  dataDir: string,
  unifiOrigin: string,
  unifiCertPath: string
): Promise<ChildProcess> {
  const child = spawn("node", [SERVER_ENTRY], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "localhost",
      DATA_DIR: dataDir,
      DATABASE_PATH: "marplanner.db",
      MP_ACCESS_TOKEN,
      MP_BOOTSTRAP_KEY,
      MP_MANAGEMENT_KEY,
      ADMIN_PIN,
      // Scheduler ENABLED (no SCHEDULER_DISABLED) — see module docblock: the poller must
      // actually run for the picker to ever show a fresh client.
      UNIFI_API_KEY: "e2e-fixture-api-key",
      UNIFI_SITE_ID: "default",
      UNIFI_HOST: unifiOrigin,
      // NOT UNIFI_TLS_INSECURE (see module docblock's FINDING) — trust the fixture's self-signed
      // cert via Node's own extra-CA mechanism instead of client.ts's broken dispatcher toggle.
      NODE_EXTRA_CA_CERTS: unifiCertPath,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => {
    stderr += String(d);
    process.stderr.write(`[network-devices-e2e-server:${port}] ${d}`);
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

test.setTimeout(60_000);

test("network devices lifecycle: seed live client -> register from picker -> block -> delete (FR-001, FR-009, FR-010)", async ({
  page,
  context,
}) => {
  if (!existsSync(SERVER_ENTRY)) {
    throw new Error(
      `Built server missing at ${SERVER_ENTRY}. Run \`npm run build\` first ` +
        `(Playwright's configured webServer does this before the suite).`
    );
  }

  const suffix = uniqueSuffix();
  const mac = randomMac();
  const alias = `E2E Device ${suffix}`;

  const dataDir = mkdtempSync(join(tmpdir(), "mp-e2e-network-devices-"));
  let fixture: UnifiFixtureServer | undefined;
  let server: ChildProcess | undefined;

  try {
    // Seed the fake controller's live list ("fake-client-backed instance") — a real,
    // self-signed HTTPS server the built app's REAL UniFiClient talks to (see unifi-fixture-server.ts
    // docblock for why a plain-http stand-in, like weather's, cannot work here).
    fixture = await startUnifiFixtureServer([{ macAddress: mac, name: `Fixture ${suffix}` }]);

    const port = await getFreePort();
    const base = `http://localhost:${port}`;

    prepareActivePlugins(dataDir, ["network-devices"]);
    server = await startServer(port, dataDir, fixture.origin, fixture.certPath);

    // Seed admin_config.pin_hash via the REAL provisioning endpoint (see module docblock's "Admin
    // PIN seeding" note) — a throwaway call purely for that side effect; its own device-key cookie
    // is overwritten by the addCookies call immediately below.
    const provisionRes = await page.request.post(`${base}/api/auth/provision`, {
      headers: { Authorization: `Bearer ${MP_BOOTSTRAP_KEY}` },
    });
    expect(provisionRes.ok()).toBe(true);

    // Load the SPA with the provisioned device cookie so the plugin catalog's full-access browser
    // transport resolves normally. The management cookie replaces it only after that one-time
    // catalog read, before any network-device administration request is made.
    await context.addCookies([
      { name: "mp_gate", value: gateCookieValue(MP_ACCESS_TOKEN), url: base },
      { name: "mp_provisioned", value: "1", url: base },
    ]);

    const catalogResponsePromise = page.waitForResponse(
      (response) => response.url() === `${base}/api/plugins` && response.status() === 200
    );
    await page.goto(`${base}/`);
    await catalogResponsePromise;
    await context.addCookies([{ name: "mp_device_key", value: MP_MANAGEMENT_KEY, url: base }]);

    // Wait for the REAL poller (registered because this server's own scheduler is enabled) to
    // observe the fixture at least once — the picker only shows clients from a `fresh` cache.
    await expect
      .poll(
        async () => {
          const res = await page.request.get(`${base}/api/network-devices/live-clients`);
          if (!res.ok()) return "unreachable";
          const body = (await res.json()) as { state: string };
          return body.state;
        },
        { timeout: 20_000, intervals: [250] }
      )
      .toBe("fresh");

    // Resolve the household's current locale so we can assert against LOCALIZED literals
    // (member-lifecycle.spec.ts's precedent) rather than hardcoding English/Spanish strings.
    const settingsRes = await page.request.get(`${base}/api/settings`);
    expect(settingsRes.ok()).toBe(true);
    const settings = (await settingsRes.json()) as { locale?: { language?: string } };
    const lang = resolveLang(settings.locale?.language);
    const m = messages[lang];

    // --- Admin unlock (long-press affordance + PIN, AdminGate.tsx) ---
    await unlockAdmin(page, ADMIN_PIN);

    await page.getByTestId("admin-nav-network-devices").click();
    await expect(page.getByTestId("network-devices-management")).toBeVisible();

    // --- Register from the seeded picker (US1) ---
    await page.getByTestId("network-devices-open-picker").click();
    await expect(page.getByTestId("network-devices-picker")).toBeVisible();

    const macLower = mac.toLowerCase();
    await expect(page.getByTestId(`network-devices-picker-client-${macLower}`)).toBeVisible({
      timeout: 10_000,
    });
    await page.getByTestId(`network-devices-picker-select-${macLower}`).click();
    await page.getByTestId("network-devices-picker-alias-input").fill(alias);
    await page.getByTestId("network-devices-picker-submit").click();

    // Picker closes on success; the new row appears in the registry list.
    await expect(page.getByTestId("network-devices-picker")).toHaveCount(0);
    await expect(page.getByText(alias)).toBeVisible();

    const row = page.locator("li").filter({ hasText: alias });
    await expect(row).toHaveCount(1);

    // --- Block (US2) ---
    await row.getByRole("button", { name: m["networkDevices.action.block"] }).click();
    await expect(row.getByText(m["networkDevices.badge.blocked"])).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      row.getByRole("button", { name: m["networkDevices.action.unblock"] })
    ).toBeVisible();

    // --- Delete, confirming the warning (US3) ---
    page.once("dialog", (dialog) => {
      expect(dialog.message()).toBe(m["networkDevices.action.deleteConfirmBlocked"]);
      void dialog.accept();
    });
    await row.getByRole("button", { name: m["networkDevices.action.delete"] }).click();

    await expect(page.getByText(alias)).toHaveCount(0);
    await expect(page.getByTestId("network-devices-empty")).toBeVisible();
  } finally {
    if (server) await stopServer(server);
    if (fixture) await fixture.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
