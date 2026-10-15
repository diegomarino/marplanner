import { test, expect } from "@playwright/test";
import { openAdminSection } from "./admin-nav";
import { unlockAdmin } from "./admin-unlock";

/** Settings rework + overview uptime e2e. One pill change is saved with the single Save, shows
 * "Saved" that hides by itself, survives a reload, and is restored afterwards so no other spec
 * sees a different week start. Time zone and language are never touched.
 */

const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN ?? "mpg-e2e-access-token";
const BOOTSTRAP_KEY = process.env.MP_BOOTSTRAP_KEY ?? "mpk-e2e-bootstrap-key";
const ADMIN_PIN = process.env.ADMIN_PIN ?? "1234";

type LocaleBody = { locale: { timezone: string; language: string; weekStartDay: number } };

test("settings: pill change saves in one click and survives a reload; overview shows uptime", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("access-gate-form")).toBeVisible();
  await page.getByTestId("access-gate-form").locator('input[name="token"]').fill(ACCESS_TOKEN);
  await page.getByRole("button", { name: "Enter" }).click();
  await expect(page.getByRole("button", { name: "Provision Device" })).toBeVisible({
    timeout: 15000,
  });
  await page.getByLabel("Bootstrap key").fill(BOOTSTRAP_KEY);
  await page.getByRole("button", { name: "Provision Device" }).click();
  await expect(page.getByTestId("home-surface")).toBeVisible({ timeout: 15_000 });
  await unlockAdmin(page, ADMIN_PIN);
  await expect(page.getByTestId("admin-overview")).toBeVisible({ timeout: 10_000 });

  await expect(page.getByTestId("admin-overview-uptime")).toHaveText(/\d/);

  const before = (await (await page.request.get("/api/settings")).json()) as LocaleBody;
  const target = before.locale.weekStartDay === 1 ? 0 : 1;
  try {
    await openAdminSection(page, "admin-nav-settings");
    await page.getByTestId(`settings-week-start-${target}`).click();
    const put = page.waitForResponse(
      (res) => res.url().includes("/api/settings") && res.request().method() === "PUT"
    );
    await page.getByTestId("settings-save").click();
    expect((await put).status()).toBe(200);
    await expect(page.getByTestId("settings-saved")).toBeVisible();
    await expect(page.getByTestId("settings-saved")).toBeHidden({ timeout: 6000 });

    const after = (await (await page.request.get("/api/settings")).json()) as LocaleBody;
    expect(after.locale.weekStartDay).toBe(target);
    expect(after.locale.timezone).toBe(before.locale.timezone);

    await page.reload();
    await unlockAdmin(page, ADMIN_PIN);
    await openAdminSection(page, "admin-nav-settings");
    await expect(page.getByTestId(`settings-week-start-${target}`)).toBeChecked();
  } finally {
    await page.request.put("/api/settings", {
      data: { object: "locale", settings: before.locale },
    });
  }
});
