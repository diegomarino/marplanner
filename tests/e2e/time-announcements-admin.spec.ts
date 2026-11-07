import { expect, test, type Page } from "@playwright/test";
import { unlockAdmin } from "./admin-unlock";

/** Time announcements admin UI e2e: create and edit in the dialog, deactivate, delete through
 * ConfirmDialog. The sibling `time-announcements.spec.ts` seeds via HTTP and is excluded from
 * default runs (it waits on the real clock); this spec drives only the admin surface.
 * A Saturday-only 03:17 rule cannot collide with the demo seeds (07:00 / 19:00, Mon-Fri).
 * (FR-020)
 */

const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN ?? "mpg-e2e-access-token";
const BOOTSTRAP_KEY = process.env.MP_BOOTSTRAP_KEY ?? "mpk-e2e-bootstrap-key";
const MP_ADMIN_PIN = process.env.MP_ADMIN_PIN ?? "1234";

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

test("admin page: create in the dialog, edit, deactivate, delete through ConfirmDialog", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await provision(page);
  await page.goto("/admin/time-announcements");
  await unlockAdmin(page, MP_ADMIN_PIN);

  let ruleId: string | null = null;
  try {
    await page.getByTestId("time-announcements-create").click();
    const dialog = page.getByTestId("time-announcements-form-dialog");
    await dialog.getByTestId("time-announcements-time-input").fill("03:17");
    await dialog.getByTestId("time-announcements-weekday-sat").click();
    await dialog.getByTestId("time-announcements-submit").click();
    await expect(dialog).toBeHidden();

    const card = page.getByTestId(/^time-announcements-rule-/).filter({ hasText: "03:17" });
    await expect(card).toHaveCount(1);
    ruleId = (await card.getAttribute("data-testid"))!.replace("time-announcements-rule-", "");

    await card.getByTestId(`time-announcements-edit-${ruleId}`).click();
    await dialog.getByTestId("time-announcements-weekday-sun").click();
    await dialog.getByTestId("time-announcements-submit").click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId(`time-announcements-day-${ruleId}-sun`)).toHaveAttribute(
      "data-on",
      "true"
    );

    await card.getByTestId(`time-announcements-toggle-${ruleId}`).click();
    await expect(card).toContainText(/inactive|inactiva/i);

    await card.getByTestId(`time-announcements-delete-${ruleId}`).click();
    await page.getByTestId("time-announcements-delete-confirm").click();
    await expect(page.getByTestId(`time-announcements-rule-${ruleId}`)).toHaveCount(0);
    ruleId = null;
  } finally {
    // Best-effort cleanup if a step failed before the UI delete ran.
    if (ruleId) await page.request.delete(`/api/time-announcements/${ruleId}`).catch(() => {});
  }
});
