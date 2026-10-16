import { test, expect } from "@playwright/test";
import { openAdminSection } from "./admin-nav";
import { unlockAdmin } from "./admin-unlock";
import { messages, resolveLang } from "../../src/client/i18n/messages";

/** Routines admin: create a routine with a long unbroken name (must wrap, not scroll), add a chore
 * with Enter, assign a child on Monday (shown in the week grid), then move the routine to the
 * evening period through the streak confirmation. Unique names per run: the e2e server keeps a
 * shared DATA_DIR across specs. */

const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN ?? "mpg-e2e-access-token";
const BOOTSTRAP_KEY = process.env.MP_BOOTSTRAP_KEY ?? "mpk-e2e-bootstrap-key";
const ADMIN_PIN = process.env.ADMIN_PIN ?? "1234";

test("routines admin: create, add a chore, assign a child and move to another period", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const rid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

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

  const settingsResp = await page.request.get("/api/settings");
  expect(settingsResp.status()).toBe(200);
  const settings = (await settingsResp.json()) as { locale?: { language?: string } };
  const m = messages[resolveLang(settings.locale?.language)];

  const childName = `RoutinesKid-${rid}`;
  const memberResp = await page.request.post("/api/members", {
    data: { displayName: childName, role: "child" },
  });
  expect(memberResp.status()).toBe(201);
  const memberId = ((await memberResp.json()) as { id: string }).id;

  await unlockAdmin(page, ADMIN_PIN);
  await expect(page.getByTestId("admin-overview")).toBeVisible({ timeout: 10_000 });
  await openAdminSection(page, "admin-nav-routines-management");
  await expect(
    page.getByRole("heading", { name: m["routines.management.title"], exact: true })
  ).toBeVisible({ timeout: 10_000 });

  // Create — a long name without spaces must wrap instead of widening the page.
  const routineName = `Routine-${rid}-${"x".repeat(80)}`;
  await page.getByTestId("routines-new").click();
  const form = page.getByTestId("routine-form-dialog");
  await form.getByTestId("routine-form-name").fill(routineName);
  await form.getByTestId("routine-form-submit").click();
  await expect(form).toBeHidden();
  const detail = page.getByTestId("routine-detail");
  await expect(detail.getByRole("heading", { name: routineName })).toBeVisible();
  const routineId = await detail.getAttribute("data-routine-id");
  expect(routineId).toBeTruthy();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      )
    )
    .toBeLessThanOrEqual(0);

  // Chore — Enter submits.
  await detail.getByTestId("routine-add-chore").click();
  const choreDialog = page.getByTestId("chore-form-dialog");
  await choreDialog.getByTestId("chore-form-name").fill("Feed the cat");
  await choreDialog.getByTestId("chore-form-name").press("Enter");
  await expect(choreDialog).toBeHidden();
  await expect(detail.getByText("Feed the cat")).toBeVisible();

  // Assign the child on Monday — a new assignment saves without confirmation.
  await detail.getByTestId("routine-assign").click();
  const assign = page.getByTestId("assignment-dialog");
  const row = assign.getByTestId(`routine-assignment-${memberId}`);
  // The seven weekday pills fit one line inside the dialog.
  const dayTops = await row
    .locator(`input[data-testid^="routines-weekday-${memberId}-"]`)
    .evaluateAll((inputs) => inputs.map((input) => Math.round(input.getBoundingClientRect().top)));
  expect(dayTops).toHaveLength(7);
  expect(new Set(dayTops).size).toBe(1);
  // The dialog is wide enough that every pill sits inside it with room to spare.
  const dialogBox = await assign.boundingBox();
  if (dialogBox === null) throw new Error("assignment dialog has no box");
  const pillRights = await row
    .locator(`input[data-testid^="routines-weekday-${memberId}-"]`)
    .evaluateAll((inputs) => inputs.map((input) => input.getBoundingClientRect().right));
  for (const right of pillRights) {
    expect(right).toBeLessThanOrEqual(dialogBox.x + dialogBox.width - 16);
  }
  await row.getByTestId(`routines-weekday-${memberId}-mon`).check();
  await row.getByTestId(`routines-assignment-${memberId}-save`).click();
  await expect(row.getByTestId(`routines-assignment-${memberId}-deactivate`)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(assign).toBeHidden();
  await expect(detail.getByTestId("routine-week-day-mon")).toContainText(childName);

  // Move to the evening period — confirmed with the streak warning.
  await detail.getByTestId("routine-edit").click();
  await form.getByTestId("routine-form-period").click();
  await page.getByRole("option", { name: m["dayPeriod.evening"], exact: true }).click();
  await form.getByTestId("routine-form-submit").click();
  await page.getByTestId("routine-period-confirm").click();
  await expect(form).toBeHidden();
  await expect(detail).toContainText(m["dayPeriod.evening"]);
  const reread = await page.request.get(`/api/routines/${routineId}`);
  expect(((await reread.json()) as { dayPeriodId: string }).dayPeriodId).toBe("evening");

  await page.request.delete(`/api/routines/${routineId}`);
  await page.request.post(`/api/members/${memberId}/archive`);
});
