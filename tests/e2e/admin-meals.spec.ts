import { test, expect, type Page } from "@playwright/test";
import { openAdminSection } from "./admin-nav";
import { unlockAdmin } from "./admin-unlock";
import { messages, resolveLang } from "../../src/client/i18n/messages";

/** Meals admin: three tabs (Preview, Meal plans, Recipes) and the week menu is editable in
 * Preview. Add a one-off from a cell, add a weekly meal to a plan from a cell (it shows in the
 * grid and inside the plan card on the Meal plans tab), edit it from the grid (the card follows),
 * highlight this run's plan with its origin pill (its meal stands out, the one-off greys out, and
 * adding from a cell preselects the plan), and delete the one-off. Unique names per run: the e2e
 * server keeps a shared DATA_DIR across specs, so other active plans may exist. */

const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN ?? "mpg-e2e-access-token";
const BOOTSTRAP_KEY = process.env.MP_BOOTSTRAP_KEY ?? "mpk-e2e-bootstrap-key";
const ADMIN_PIN = process.env.ADMIN_PIN ?? "1234";

function todayInTimezone(timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
}

/** An empty cell is itself the add button; a filled cell (other specs share the DB) has its own
 * "+" button after the meal cards. */
async function openAddDialog(page: Page, date: string, slot: string): Promise<void> {
  const cell = page.getByTestId(`meal-cell-${date}-${slot}`);
  if ((await cell.evaluate((el) => el.tagName)) === "BUTTON") await cell.click();
  else await cell.getByRole("button").last().click();
}

async function postedEntryId(page: Page, submit: () => Promise<void>): Promise<string> {
  const [response] = await Promise.all([
    page.waitForResponse(
      (res) => res.url().endsWith("/api/meal-entries") && res.request().method() === "POST"
    ),
    submit(),
  ]);
  expect(response.status()).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

test("meals admin: edit the week menu and see recurring entries inside their plan", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const rid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const entryIds: string[] = [];
  let planId: string | null = null;

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

  try {
    const settingsResp = await page.request.get("/api/settings");
    expect(settingsResp.status()).toBe(200);
    const settings = (await settingsResp.json()) as {
      locale: { language?: string; timezone: string };
    };
    const m = messages[resolveLang(settings.locale.language)];
    const openTab = (key: keyof typeof m) =>
      page.getByRole("tab", { name: m[key], exact: true }).click();
    const today = todayInTimezone(settings.locale.timezone);

    const planName = `E2E plan ${rid}`;
    const planResp = await page.request.post("/api/meal-plans", { data: { name: planName } });
    expect(planResp.status()).toBe(201);
    planId = ((await planResp.json()) as { id: string }).id;

    await unlockAdmin(page, ADMIN_PIN);
    await expect(page.getByTestId("admin-overview")).toBeVisible({ timeout: 10_000 });
    await openAdminSection(page, "admin-nav-meals-management");
    await expect(
      page.getByRole("heading", { level: 2, name: m["admin.sidebar.meals"], exact: true })
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("tab", { name: m["meals.tabs.preview"] })).toHaveAttribute(
      "aria-selected",
      "true"
    );

    const grid = page.getByTestId("meal-plan-grid");
    const planEntries = page.getByTestId(`meals-plan-entries-${planId}`);
    await openTab("meals.tabs.plans");
    await expect(planEntries).toBeVisible();
    await openTab("meals.tabs.preview");

    // 1. A one-off note in today's dinner cell.
    const oneOff = `One-off ${rid}`;
    await openAddDialog(page, today, "dinner");
    let dialog = page.getByRole("dialog");
    await dialog.getByRole("radio", { name: m["meals.entries.contentModeNote"] }).check();
    await dialog.getByRole("textbox", { name: m["meals.entries.noteInputLabel"] }).fill(oneOff);
    entryIds.push(
      await postedEntryId(page, () =>
        dialog.getByRole("button", { name: m["meals.entries.action.add"] }).click()
      )
    );
    await expect(dialog).toBeHidden();
    await expect(grid.getByRole("button", { name: oneOff })).toBeVisible();

    // 2. A weekly note in today's lunch cell, into this run's plan.
    const weekly = `Weekly ${rid}`;
    await openAddDialog(page, today, "lunch");
    dialog = page.getByRole("dialog");
    await dialog
      .getByRole("radio", { name: new RegExp(`^${m["meals.entries.repeatWeeklyPrefix"]} `) })
      .check();
    await dialog.getByRole("combobox", { name: m["meals.plan.selectLabel"] }).selectOption({
      label: planName,
    });
    await dialog.getByRole("radio", { name: m["meals.entries.contentModeNote"] }).check();
    await dialog.getByRole("textbox", { name: m["meals.entries.noteInputLabel"] }).fill(weekly);
    entryIds.push(
      await postedEntryId(page, () =>
        dialog.getByRole("button", { name: m["meals.entries.action.add"] }).click()
      )
    );
    await expect(dialog).toBeHidden();
    await expect(grid.getByRole("button", { name: weekly })).toBeVisible();
    await openTab("meals.tabs.plans");
    await expect(planEntries.getByText(weekly)).toBeVisible();
    await openTab("meals.tabs.preview");

    // 3. Edit the weekly meal from the grid; the plan card follows.
    const weeklyEdited = `Weekly edited ${rid}`;
    await grid.getByRole("button", { name: weekly }).click();
    dialog = page.getByRole("dialog");
    await dialog
      .getByRole("textbox", { name: m["meals.entries.noteInputLabel"] })
      .fill(weeklyEdited);
    await dialog.getByRole("button", { name: m["meals.action.save"] }).click();
    await expect(dialog).toBeHidden();
    await openTab("meals.tabs.plans");
    await expect(planEntries.getByText(weeklyEdited)).toBeVisible();
    await openTab("meals.tabs.preview");
    await expect(grid.getByRole("button", { name: weeklyEdited })).toBeVisible();

    // 3b. Highlight this run's plan: its meal stands out, the one-off greys out in place; adding
    // from a cell opens on "Every <weekday>" in this plan.
    const planPill = page.getByTestId(`meal-origin-pill-${planId}`);
    await planPill.check();
    const weeklyChip = grid.getByRole("button", { name: weeklyEdited });
    const oneOffChip = grid.getByRole("button", { name: oneOff });
    await expect(weeklyChip).toHaveAttribute("data-origin", planId!);
    await expect(weeklyChip).toHaveAttribute("data-emphasis", "hit");
    await expect(oneOffChip).toHaveAttribute("data-emphasis", "dim");
    await openAddDialog(page, today, "breakfast");
    dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("radio", { name: new RegExp(`^${m["meals.entries.repeatWeeklyPrefix"]} `) })
    ).toBeChecked();
    await expect(dialog.getByRole("combobox", { name: m["meals.plan.selectLabel"] })).toHaveValue(
      planId!
    );
    await dialog.getByRole("button", { name: m["meals.action.cancel"] }).click();
    await expect(dialog).toBeHidden();
    await planPill.uncheck();
    await expect(oneOffChip).toHaveAttribute("data-emphasis", "normal");

    // 4. Delete the one-off from the grid through the confirmation.
    await grid.getByRole("button", { name: oneOff }).click();
    await page.getByRole("dialog").getByRole("button", { name: m["meals.action.delete"] }).click();
    const confirm = page.getByRole("dialog").filter({ hasText: m["meals.entries.deleteConfirm"] });
    await confirm.getByRole("button", { name: m["meals.action.delete"] }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(grid.getByRole("button", { name: oneOff })).toHaveCount(0);
  } finally {
    for (const id of entryIds) {
      const res = await page.request.delete(`/api/meal-entries/${id}`);
      expect([204, 404]).toContain(res.status());
    }
    // Plans have no delete: deactivate this run's plan so it leaves the shared menu.
    if (planId) {
      await page.request.patch(`/api/meal-plans/${planId}`, { data: { active: false } });
    }
  }
});
