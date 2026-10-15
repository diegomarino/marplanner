import { expect, test } from "@playwright/test";
import { openAdminSection } from "./admin-nav";
import { messages, resolveLang } from "../../src/client/i18n/messages";
import { unlockAdmin } from "./admin-unlock";

const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN ?? "mpg-e2e-access-token";
const BOOTSTRAP_KEY = process.env.MP_BOOTSTRAP_KEY ?? "mpk-e2e-bootstrap-key";
const ADMIN_PIN = process.env.ADMIN_PIN ?? "1234";
const FROZEN_NOW = new Date("2026-01-15T23:00:00.000Z");
const HOUSEHOLD_TODAY = "2026-01-16";

// The kiosk/browser is twelve hours behind the default Europe/Madrid household.
test.use({ timezoneId: "Pacific/Pago_Pago" });

test("admin date defaults use the household timezone, not the browser timezone (#477)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const reminderText = `Timezone default reminder ${runId}`;

  await page.goto("/");
  await page.getByTestId("access-gate-form").locator('input[name="token"]').fill(ACCESS_TOKEN);
  await page.getByRole("button", { name: "Enter" }).click();
  await page.getByLabel("Bootstrap key").fill(BOOTSTRAP_KEY);
  await page.getByRole("button", { name: "Provision Device" }).click();
  await expect(page.getByTestId("home-surface")).toBeVisible({ timeout: 15_000 });

  const settingsResponse = await page.request.get("/api/settings");
  expect(settingsResponse.status()).toBe(200);
  const settings = (await settingsResponse.json()) as {
    locale: { language?: string; timezone: string };
  };
  expect(settings.locale.timezone).toBe("Europe/Madrid");
  const m = messages[resolveLang(settings.locale.language)];

  const memberResponse = await page.request.post("/api/members", {
    data: { displayName: "Timezone Default Member", role: "parent" },
  });
  expect(memberResponse.status()).toBe(201);

  const reminderResponse = await page.request.post("/api/reminders", {
    data: {
      kind: "calendar_gated",
      targetingMode: "apply_to_all",
      text: reminderText,
      query: `timezone-default-query-${runId}`,
    },
  });
  expect(reminderResponse.status()).toBe(201);
  const reminderId = ((await reminderResponse.json()) as { id: string }).id;

  await unlockAdmin(page, ADMIN_PIN);
  await expect(page.getByTestId("admin-overview")).toBeVisible({ timeout: 10_000 });

  // Freeze the browser after unlock. The assertion only proves that this device
  // sees the previous day; expected business-date values below are fixed from
  // the known household setting, not recalculated with browser-local helpers.
  await page.clock.install({ time: FROZEN_NOW });
  expect(
    await page.evaluate(() =>
      new Intl.DateTimeFormat("en-CA", { timeZone: "Pacific/Pago_Pago" }).format(new Date())
    )
  ).toBe("2026-01-15");

  await openAdminSection(page, "admin-nav-daily-messages-management");
  await expect(
    page.getByRole("heading", { name: m["dailyMessages.management.title"] })
  ).toBeVisible();
  const dailyMessageDays = page.getByTestId(/^daily-messages-day-/);
  await expect(dailyMessageDays).toHaveCount(14);
  await expect(dailyMessageDays.first()).toHaveAttribute(
    "data-testid",
    `daily-messages-day-${HOUSEHOLD_TODAY}`
  );
  await expect(page.getByTestId("daily-messages-window-range")).toContainText(HOUSEHOLD_TODAY);
  await expect(page.getByTestId("daily-messages-previous-window")).toBeDisabled();

  await openAdminSection(page, "admin-nav-meals-management");
  await expect(page.getByTestId("meals-menu-date-input")).toHaveValue(HOUSEHOLD_TODAY);
  await expect(page.getByTestId("meals-week-date-input")).toHaveValue(HOUSEHOLD_TODAY);
  await expect(page.getByTestId("meals-entry-date-input")).toHaveValue(HOUSEHOLD_TODAY);

  await openAdminSection(page, "admin-nav-reminders-management");
  const reminderCard = page.getByTestId(`reminder-${reminderId}`);
  await reminderCard.getByRole("button", { name: m["reminders.dryRun.toggleShow"] }).click();
  await expect(reminderCard.locator('input[type="date"]')).toHaveValue(HOUSEHOLD_TODAY);
});
