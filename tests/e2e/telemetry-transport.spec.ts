import { test, expect, type Page } from "@playwright/test";

/** — client logger REAL transport e2e spec .
 * jsdom tests (`tests/client/logger.test.ts`) exercise the logger's buffering/at-most-once
 * logic against an INJECTABLE transport — they never touch a real network stack. This spec
 * closes that gap: it drives the shared logger inside a real, built-and-started kiosk page
 * (the default Playwright `webServer`, same as `telemetry-ingest.spec.ts`) through its exposed
 * `window.__mpTelemetry` test hook (gated to DEV/e2e builds — `VITE_E2E_HOOKS=true` is set for
 * this suite's `webServer.env` in `playwright.config.ts`) and asserts the row actually lands via
 * the real `fetch`/`sendBeacon` transport, not a mock.
 */

const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN ?? "mpg-e2e-access-token";
const BOOTSTRAP_KEY = process.env.MP_BOOTSTRAP_KEY ?? "mpk-e2e-bootstrap-key";

async function provision(page: Page): Promise<void> {
  await page.goto("/");
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

function uniqueComponent(prefix: string): string {
  const rid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  return `${prefix}.${rid}`;
}

test("manual flush delivers via the real fetch/keepalive transport", async ({ page }) => {
  test.setTimeout(60_000);
  await provision(page);

  const component = uniqueComponent("e2e.transport.manual");
  const message = "real transport probe (manual flush)";

  const hookExists = await page.evaluate(() => typeof window.__mpTelemetry !== "undefined");
  expect(hookExists).toBe(true);

  await page.evaluate(
    async ({ component, message }) => {
      window.__mpTelemetry!.log("info", component, message, { probe: "manual" });
      await window.__mpTelemetry!.flush();
    },
    { component, message }
  );

  await expect
    .poll(
      async () => {
        const res = await page.request.get(
          `/api/telemetry/client-log?component=${encodeURIComponent(component)}`
        );
        if (res.status() !== 200) return 0;
        const body = (await res.json()) as { rows: unknown[] };
        return body.rows.length;
      },
      { timeout: 15_000 }
    )
    .toBeGreaterThan(0);

  const getRes = await page.request.get(
    `/api/telemetry/client-log?component=${encodeURIComponent(component)}`
  );
  const body = (await getRes.json()) as { rows: Array<{ message: string; component: string }> };
  expect(body.rows).toHaveLength(1);
  expect(body.rows[0].message).toBe(message);
});

test("closing the page WITHOUT a manual flush still delivers via pagehide/sendBeacon", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await provision(page);

  const component = uniqueComponent("e2e.transport.pagehide");
  const message = "real transport probe (pagehide, no manual flush)";

  const hookExists = await page.evaluate(() => typeof window.__mpTelemetry !== "undefined");
  expect(hookExists).toBe(true);

  // Buffer the entry via the real logger singleton but deliberately do NOT await a manual
  // flush — delivery must happen through the pagehide/visibilitychange unload path instead.
  await page.evaluate(
    ({ component, message }) => {
      window.__mpTelemetry!.log("error", component, message, { probe: "pagehide" });
    },
    { component, message }
  );

  // Keep a handle to the browser context's request API (shared cookies) BEFORE closing the
  // page — `page.request` becomes unusable once the page itself is closed.
  const context = page.context();
  await page.close();

  await expect
    .poll(
      async () => {
        const res = await context.request.get(
          `/api/telemetry/client-log?component=${encodeURIComponent(component)}`
        );
        if (res.status() !== 200) return 0;
        const body = (await res.json()) as { rows: unknown[] };
        return body.rows.length;
      },
      { timeout: 15_000 }
    )
    .toBeGreaterThan(0);

  const getRes = await context.request.get(
    `/api/telemetry/client-log?component=${encodeURIComponent(component)}`
  );
  const body = (await getRes.json()) as { rows: Array<{ message: string; component: string }> };
  expect(body.rows).toHaveLength(1);
  expect(body.rows[0].message).toBe(message);
});
