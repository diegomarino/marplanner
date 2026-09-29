import { test, expect } from "@playwright/test";

/** — telemetry real-process e2e smoke .
 * The default Playwright suite runs against the managed `webServer` (a real built-and-started
 * `dist/server/index.js` process, not an injected Fastify instance) — proving the ingest+read
 * routes are wired through the REAL assembled app: access gate -> provision -> real HTTP POST a
 * batch containing a secret (page.request, not app.inject) -> real HTTP GET the admin endpoint
 * -> the row comes back redacted. The browser-side logger half of the assembly (kiosk page ->
 * fetch/sendBeacon transport) lands in the own e2e transport spec — this spec exercises the
 * server seam directly via `page.request`.
 */

const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN ?? "mpg-e2e-access-token";
const BOOTSTRAP_KEY = process.env.MP_BOOTSTRAP_KEY ?? "mpk-e2e-bootstrap-key";

test("telemetry ingest -> admin read, real process (T005)", async ({ page }) => {
  test.setTimeout(60_000);

  // --- Access gate -> provisioning (mirrors daily-messages.spec.ts) ---
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

  const rid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const secretMessage = `boom mpk-e2eSecret${rid}`;
  const component = `e2e.telemetry.${rid}`;

  // --- Real HTTP POST a batch containing a secret (device cookie carried by the browser context) ---
  const postRes = await page.request.post("/api/telemetry/client-log", {
    data: {
      entries: [
        {
          level: "error",
          component,
          message: secretMessage,
          data: { token: `mpk-anotherSecret${rid}` },
        },
      ],
    },
  });
  expect(postRes.status()).toBe(200);
  const postBody = (await postRes.json()) as { accepted: number; dropped: number };
  expect(postBody.accepted).toBe(1);
  expect(postBody.dropped).toBe(0);

  // --- Real HTTP GET the admin endpoint (scoped to this run's unique component) ---
  const getRes = await page.request.get(
    `/api/telemetry/client-log?component=${encodeURIComponent(component)}`
  );
  expect(getRes.status()).toBe(200);
  const page1 = (await getRes.json()) as {
    rows: Array<{ message: string; data: string | null; component: string }>;
  };
  expect(page1.rows).toHaveLength(1);
  const row = page1.rows[0];
  expect(row.component).toBe(component);
  expect(row.message).not.toContain(`mpk-e2eSecret${rid}`);
  expect(row.message).toContain("[redacted]");
  expect(row.data).not.toBeNull();
  expect(row.data as string).not.toContain(`mpk-anotherSecret${rid}`);
  expect(row.data as string).toContain("[redacted]");
});
