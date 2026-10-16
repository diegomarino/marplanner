// admin-unlock-resilience.spec.ts — the regression test, in its final form.
//
// LINEAGE, because this spec has deliberately changed meaning once: it began as proof that the
// shared unlock helper's RETRY recovered from a layout-shift-cancelled press, asserting
// `attempts > 1`. That assertion carried its own retirement signal: the day was fixed at the
// source, the first press would survive the shift, `attempts` would be 1, and this spec would go
// red — forcing exactly this rewrite. fixed with pointer capture, the spec went red on
// schedule (CI run 34486569445), the helper's retry collapsed to a single press, and this file now
// pins the fix itself:
//
// a layout shift under a STATIONARY pointer must NOT cancel the hold.
//
// The sabotage below is the exact reproduction from the investigation: 200ms into the hold,
// insert a 300px spacer above the affordance so it moves out from under the unmoving pointer. On
// the old `onMouseLeave={cancelPress}` implementation this cancelled the press 100% of the time
// (control pair: SHIFT=false / CONTROL=true). With pointer capture the element keeps receiving the
// pointer stream wherever it moves, so a SINGLE press must complete — there is no retry left to
// hide behind.

import { test, expect, type Locator, type Page } from "@playwright/test";
import { messages, resolveLang } from "../../src/client/i18n/messages";
import { unlockAdmin } from "./admin-unlock";

const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN ?? "mpg-e2e-access-token";
const BOOTSTRAP_KEY = process.env.MP_BOOTSTRAP_KEY ?? "mpk-e2e-bootstrap-key";
const ADMIN_PIN = process.env.ADMIN_PIN ?? "1234";

const SPACER_ATTR = "data-mp-shift-probe";
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

/** Arm a ONE-SHOT layout shift 200ms into the first press on the affordance. */
async function armOneShotShift(page: Page): Promise<void> {
  await page.evaluate((attr) => {
    const el = document.querySelector('[data-testid="admin-affordance"]');
    if (!el?.parentElement) throw new Error("probe setup: admin affordance not found");
    let armed = true;
    el.addEventListener("pointerdown", () => {
      if (!armed) return;
      armed = false;
      setTimeout(() => {
        const spacer = document.createElement("div");
        spacer.style.height = "300px";
        spacer.setAttribute(attr, "");
        document.documentElement.setAttribute(attr, "fired");
        el.parentElement?.insertBefore(spacer, el);
      }, 200);
    });
  }, SPACER_ATTR);
}

test("the hold SURVIVES a layout shift under a stationary pointer (#793 fixed via pointer capture)", async ({
  page,
}) => {
  await provision(page);
  const settingsResponse = await page.request.get("/api/settings");
  expect(settingsResponse.status()).toBe(200);
  const settings = (await settingsResponse.json()) as { locale: { language?: string } };
  const m = messages[resolveLang(settings.locale.language)];

  // With Admin as its only entry, Options is the Admin affordance itself.
  await expect(
    page.getByRole("button", { name: m["shell.options.label"], exact: true })
  ).toHaveAttribute("data-testid", "admin-affordance");
  // A plain tap does not open Admin, but it says why.
  await page.getByTestId("admin-affordance").click();
  await expect(page.getByTestId("admin-hold-hint")).toHaveText(m["shell.options.holdHint"]);
  await expect(page).toHaveURL((url) => url.pathname === "/");
  await armOneShotShift(page);

  // A SINGLE press — the helper has no retry. If pointer capture regresses, this throws.
  await unlockAdmin(page, ADMIN_PIN);

  await expect(page.getByTestId("admin-overview")).toBeVisible({ timeout: 10_000 });
  // The sabotage must actually have fired mid-hold — otherwise this spec proves nothing about
  // shift survival and would pass on any implementation.
  await expect(page.locator("html")).toHaveAttribute(SPACER_ATTR, "fired");
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
  // Each destination exercises direct PIN entry before and after refresh. The physical hold is
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
      await unlockAdmin(page, ADMIN_PIN);
      // The contract is reachability, not fourteen data mutations. These assertions prove
      // each original primary control remains available after routing and refresh without
      // generating, snapshotting, deleting, or otherwise altering isolated e2e data.
      await expect(destination.primary(page, m)).toBeVisible();

      await page.reload();
      await expect(page.getByTestId("admin-pin-keypad")).toBeVisible();
      await expect(destination.primary(page, m)).not.toBeVisible();

      await unlockAdmin(page, ADMIN_PIN);
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
