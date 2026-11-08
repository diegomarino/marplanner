// admin-unlock-resilience.spec.ts — the Admin entry and protected-route PIN flows end to end.
//
// The Admin affordance opens the PIN gate on a plain tap (ADR-034). The earlier three-second
// hold, and its layout-shift regression (#793, fixed with pointer capture), no longer exist: with
// no press to keep alive there is nothing a layout shift can cancel. The first test pins the tap
// entry itself; the second proves every protected destination survives load and refresh.

import { test, expect, type Locator, type Page } from "@playwright/test";
import { messages, resolveLang } from "../../src/client/i18n/messages";
import { unlockAdmin } from "./admin-unlock";

const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN ?? "mpg-e2e-access-token";
const BOOTSTRAP_KEY = process.env.MP_BOOTSTRAP_KEY ?? "mpk-e2e-bootstrap-key";
const MP_ADMIN_PIN = process.env.MP_ADMIN_PIN ?? "1234";

type Translations = (typeof messages)[ReturnType<typeof resolveLang>];

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

test("a plain tap on the Admin affordance opens the PIN gate and the completed PIN unlocks", async ({
  page,
}) => {
  await provision(page);
  const settingsResponse = await page.request.get("/api/settings");
  expect(settingsResponse.status()).toBe(200);
  const settings = (await settingsResponse.json()) as { locale: { language?: string } };
  const m = messages[resolveLang(settings.locale.language)];

  // With Admin as its only entry, Options is the Admin affordance itself.
  const admin = page.getByRole("button", { name: m["shell.options.label"], exact: true });
  await expect(admin).toHaveAttribute("data-testid", "admin-affordance");
  await admin.click();
  await expect(page).toHaveURL((url) => url.pathname === "/admin");
  await expect(page.getByTestId("admin-pin-keypad")).toBeVisible();

  await unlockAdmin(page, MP_ADMIN_PIN);
  await expect(page.getByTestId("admin-overview")).toBeVisible({ timeout: 10_000 });
});

const adminDestinations: ReadonlyArray<{
  path: string;
  primary: (page: Page, m: Translations) => Locator;
}> = [
  {
    path: "/admin",
    primary: (page) => page.getByTestId("admin-overview-check"),
  },
  {
    path: "/admin/members",
    primary: (page, m) => page.getByTestId("members-add-member"),
  },
  {
    path: "/admin/routines",
    primary: (page) => page.getByTestId("routines-new"),
  },
  {
    path: "/admin/reminders",
    primary: (page) => page.getByTestId("reminders-add-rule"),
  },
  {
    path: "/admin/meals",
    // The page opens on its Preview tab; the recipe create form sits behind the Recipes tab.
    primary: (page) => page.getByTestId("meals-tab-recipes"),
  },
  {
    path: "/admin/daily-messages",
    primary: (page: Page) => page.getByTestId(/^daily-messages-text-/).first(),
  },
  {
    path: "/admin/daily-briefing",
    primary: (page: Page) => page.getByTestId("daily-briefing-tab-blocks"),
  },
  {
    path: "/admin/telemetry",
    primary: (page: Page) => page.getByTestId("telemetry-apply-filters"),
  },
  {
    path: "/admin/backups",
    primary: (page: Page) => page.getByTestId("backups-snapshot-now"),
  },
  {
    path: "/admin/time-announcements",
    primary: (page: Page) => page.getByTestId("time-announcements-create"),
  },
  {
    path: "/admin/network-devices",
    primary: (page: Page) => page.getByTestId("network-devices-open-picker"),
  },
  {
    path: "/admin/printing",
    primary: (page: Page) => page.getByTestId("printing-tab-diagnostics"),
  },
  {
    path: "/admin/settings",
    primary: (page: Page) => page.getByTestId("settings-save"),
  },
] as const;

test("every protected destination survives direct load and refresh with its primary action reachable", async ({
  page,
}) => {
  // Each destination exercises direct PIN entry before and after refresh. The tap entry is
  // owned by the Options-menu entry test above, not duplicated on direct protected routes.
  test.setTimeout(90_000);
  await provision(page);
  const settingsResponse = await page.request.get("/api/settings");
  expect(settingsResponse.status()).toBe(200);
  const settings = (await settingsResponse.json()) as { locale: { language?: string } };
  const m = messages[resolveLang(settings.locale.language)];
  const memberResponse = await page.request.post("/api/members", {
    data: { displayName: `Admin matrix member ${Date.now()}`, role: "child" },
  });
  expect(memberResponse.status()).toBe(201);
  const memberId = ((await memberResponse.json()) as { id: string }).id;
  const optInResponse = await page.request.put(`/api/daily-briefing/opt-in/${memberId}`, {
    data: { enabled: true },
  });
  expect(optInResponse.status()).toBe(200);

  try {
    for (const destination of adminDestinations) {
      await page.goto(destination.path);
      await unlockAdmin(page, MP_ADMIN_PIN);
      // The contract is reachability, not fourteen data mutations. These assertions prove
      // each original primary control remains available after routing and refresh without
      // generating, snapshotting, deleting, or otherwise altering isolated e2e data.
      await expect(destination.primary(page, m)).toBeVisible();

      await page.reload();
      await expect(page.getByTestId("admin-pin-keypad")).toBeVisible();
      await expect(destination.primary(page, m)).not.toBeVisible();

      await unlockAdmin(page, MP_ADMIN_PIN);
      await expect(destination.primary(page, m)).toBeVisible();
      expect(new URL(page.url()).pathname).toBe(destination.path);
    }
  } finally {
    await page.request.put(`/api/daily-briefing/opt-in/${memberId}`, {
      data: { enabled: false },
    });
    await page.request.post(`/api/members/${memberId}/archive`);
  }
});
