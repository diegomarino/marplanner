import { test, expect, type Page } from "@playwright/test";
import { messages, resolveLang } from "../../src/client/i18n/messages";

const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN ?? "mpg-e2e-access-token";
const BOOTSTRAP_KEY = process.env.MP_BOOTSTRAP_KEY ?? "mpk-e2e-bootstrap-key";

function todayInTimezone(timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function startOfWeek(date: string, weekStartDay: number): string {
  const weekday = new Date(`${date}T12:00:00.000Z`).getUTCDay();
  return addDays(date, -((weekday - weekStartDay + 7) % 7));
}

async function createOneOffFixture(page: Page, date: string, slot: string, note: string) {
  const response = await page.request.post("/api/meal-entries", {
    data: { kind: "oneoff", date, slot, note },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

let createdMealIds: string[] = [];
let createdRecipeIds: string[] = [];

test.beforeEach(() => {
  createdMealIds = [];
  createdRecipeIds = [];
});

test.afterEach(async ({ page }) => {
  const mealIds = createdMealIds;
  const recipeIds = createdRecipeIds;
  createdMealIds = [];
  createdRecipeIds = [];

  for (const mealId of mealIds.reverse()) {
    expect((await page.request.delete(`/api/meal-entries/${mealId}`)).status()).toBe(204);
  }
  for (const recipeId of recipeIds.reverse()) {
    expect((await page.request.delete(`/api/recipes/${recipeId}`)).status()).toBe(204);
  }
});

test("family Meals workspace authors and refreshes entries without Admin", async ({ page }) => {
  test.setTimeout(120_000);
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const recipeName = `Meals Recipe ${suffix}`;
  const editedRecipeName = `${recipeName} Edited`;
  const firstNote = `First note ${suffix}`;
  const secondNote = `Second note ${suffix}`;

  await page.goto("/");
  await page.getByTestId("access-gate-form").locator('input[name="token"]').fill(ACCESS_TOKEN);
  await page.getByRole("button", { name: "Enter" }).click();
  await page.getByLabel("Bootstrap key").fill(BOOTSTRAP_KEY);
  await page.getByRole("button", { name: "Provision Device" }).click();
  await expect(page.getByTestId("home-surface")).toBeVisible({ timeout: 15_000 });

  const settingsResponse = await page.request.get("/api/settings");
  expect(settingsResponse.status()).toBe(200);
  const settings = await settingsResponse.json();
  const m = messages[resolveLang(settings.locale?.language)];
  const today = todayInTimezone(settings.locale.timezone as string);
  const weekStartDay = settings.locale?.weekStartDay;
  if (typeof weekStartDay !== "number") throw new Error("Missing household weekStartDay");
  const weekStart = startOfWeek(today, weekStartDay);
  const previousWeekNote = `Previous week fixture ${suffix}`;
  const currentWeekNote = `Current week fixture ${suffix}`;
  const nextWeekNote = `Next week fixture ${suffix}`;

  createdMealIds.push(
    await createOneOffFixture(page, addDays(weekStart, -1), "lunch", previousWeekNote),
    await createOneOffFixture(page, addDays(weekStart, 1), "lunch", currentWeekNote),
    await createOneOffFixture(page, addDays(weekStart, 8), "lunch", nextWeekNote)
  );

  await page.goto("/meals");
  await expect(page.getByTestId("meal-plan-grid")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("recipe-catalogue")).toBeVisible();
  await page.getByRole("button", { name: m["meals.recipes.new"] }).click();
  await page.getByLabel(m["meals.recipes.nameLabel"]).fill(recipeName);
  const createRecipeResponse = page.waitForResponse(
    (response) => response.url().endsWith("/api/recipes") && response.request().method() === "POST"
  );
  await page.getByRole("button", { name: m["meals.action.save"] }).click();
  const createdRecipeResponse = await createRecipeResponse;
  expect(createdRecipeResponse.status()).toBe(201);
  createdRecipeIds.push(((await createdRecipeResponse.json()) as { id: string }).id);
  await expect(page.getByText(recipeName)).toBeVisible();

  const recipeCard = page.locator("article", { hasText: recipeName });
  await recipeCard.getByRole("button", { name: m["meals.action.edit"] }).click();
  await page.getByLabel(m["meals.recipes.nameLabel"]).fill(editedRecipeName);
  await page.getByRole("button", { name: m["meals.action.save"] }).click();
  await expect(page.getByText(editedRecipeName)).toBeVisible();

  const dinnerCellTestId = `meal-cell-${today}-dinner`;
  const dinnerCell = page.getByTestId(dinnerCellTestId);
  for (const note of [firstNote, secondNote]) {
    await page
      .locator(
        `[data-testid="${dinnerCellTestId}"]:is(button), [data-testid="${dinnerCellTestId}"] button`
      )
      .last()
      .click();
    await page.getByRole("radio", { name: m["meals.entries.contentModeNote"] }).click();
    await page.getByRole("textbox", { name: m["meals.entries.contentModeNote"] }).fill(note);
    const createEntryResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/meal-entries") && response.request().method() === "POST"
    );
    await page.getByRole("button", { name: m["meals.entries.action.add"] }).click();
    const createdEntryResponse = await createEntryResponse;
    expect(createdEntryResponse.status()).toBe(201);
    createdMealIds.push(((await createdEntryResponse.json()) as { id: string }).id);
    await expect(dinnerCell.getByText(note)).toBeVisible();
  }

  await page.reload();
  const reloadedCell = page.getByTestId(`meal-cell-${today}-dinner`);
  await expect(reloadedCell.getByText(firstNote, { exact: true })).toBeVisible();
  await expect(reloadedCell.getByText(secondNote, { exact: true })).toBeVisible();
  await reloadedCell.getByText(firstNote).click();
  await page
    .getByRole("textbox", { name: m["meals.entries.contentModeNote"] })
    .fill(`${firstNote} edited`);
  await page.getByRole("button", { name: m["meals.action.save"] }).click();
  await expect(reloadedCell.getByText(`${firstNote} edited`)).toBeVisible();
  await expect(reloadedCell.getByText(secondNote)).toBeVisible();

  await page.getByRole("button", { name: m["meals.week.previous"] }).click();
  await expect(page.getByTestId("meal-plan-grid")).toContainText(previousWeekNote);
  await page.getByRole("button", { name: m["meals.week.today"] }).click();
  await expect(page.getByTestId("meal-plan-grid")).toContainText(currentWeekNote);
  await page.getByRole("button", { name: m["meals.week.next"] }).click();
  await expect(page.getByTestId("meal-plan-grid")).toContainText(nextWeekNote);
  await expect(page.getByRole("button", { name: m["meals.action.delete"] })).toHaveCount(0);

  await page.goto("/");
  await expect(page.getByTestId("today-meals-strip")).toContainText(`${firstNote} edited`);
});
