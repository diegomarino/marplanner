import { test, expect } from "@playwright/test";
import { unlockAdmin } from "./admin-unlock";
import { messages, resolveLang } from "../../src/client/i18n/messages";

/** — day periods critical-flow e2e (· FR-002/FR-003/FR-005/FR-006/FR-007/FR-008/FR-009).
 * Flow: auth prelude → Períodos Diarios screen → US1 (view 4 periods ordered)
 * → US2 (edit boundary + assert persistence + neighbour derived end follows + invalid rejected)
 * → US3 (active-now indicator).
 * Cards are located by the stable data-testid `day-period-<id>` (matches the codebase precedent of
 * getByTestId('access-gate-form') / getByTestId('member-create-success')); label text is asserted only
 * to prove i18n rendering, never used as the card locator.
 */

const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN ?? "mpg-e2e-access-token";
const BOOTSTRAP_KEY = process.env.MP_BOOTSTRAP_KEY ?? "mpk-e2e-bootstrap-key";
const ADMIN_PIN = process.env.ADMIN_PIN ?? "1234";

test("day periods critical-flow: view → edit → active now (US1, US2, US3)", async ({ page }) => {
  // --- Prelude: reach admin Períodos Diarios UI (copy member-lifecycle.spec.ts pattern) ---
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

  await expect(page.getByTestId("admin-nav-member-create")).toBeVisible({ timeout: 10_000 });

  const settingsResp = await page.request.get("/api/settings");
  expect(settingsResp.ok()).toBeTruthy();
  const settings = (await settingsResp.json()) as { locale: { language: string } };
  const m = messages[resolveLang(settings.locale.language)];

  // --- Navigate to Períodos Diarios screen ---
  await page.getByTestId("admin-nav-day-periods").click();

  // --- US1 (view): exactly FOUR periods render, with their i18n labels ---
  await expect(page.getByText(m["dayPeriods.management.loading"])).toHaveCount(0, {
    timeout: 5000,
  });

  // Stable, non-fragile card locators (the whole point of the data-testid).
  const cards = page.getByTestId(/^day-period-/);
  await expect(cards).toHaveCount(4, { timeout: 10_000 });

  // Cards render in start order: morning → afternoon → evening → night (not just present).
  const orderedIds = await cards.evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-testid"))
  );
  expect(orderedIds).toEqual([
    "day-period-morning",
    "day-period-afternoon",
    "day-period-evening",
    "day-period-night",
  ]);

  const morningCard = page.getByTestId("day-period-morning");
  const afternoonCard = page.getByTestId("day-period-afternoon");

  // Period labels must match the effective household language.
  await expect(morningCard.getByText(m["dayPeriod.morning"], { exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await expect(afternoonCard.getByText(m["dayPeriod.afternoon"], { exact: true })).toBeVisible();
  await expect(
    page.getByTestId("day-period-evening").getByText(m["dayPeriod.evening"], { exact: true })
  ).toBeVisible();
  await expect(
    page.getByTestId("day-period-night").getByText(m["dayPeriod.night"], { exact: true })
  ).toBeVisible();

  // --- US2 (edit): change afternoon's start; SAVE; assert it persists + morning's derived end follows ---
  await afternoonCard.getByRole("button", { name: m["dayPeriods.action.edit"] }).click();

  const timeInput = page.locator('input[type="time"]');
  await expect(timeInput).toBeVisible({ timeout: 5000 });
  const originalAfternoonStart = await timeInput.getAttribute("value");
  expect(originalAfternoonStart).toMatch(/^\d{2}:\d{2}$/);

  const newAfternoonStart = "11:30";
  await timeInput.fill(newAfternoonStart);
  await afternoonCard.getByRole("button", { name: m["dayPeriods.action.save"] }).click();
  await expect(
    afternoonCard.getByRole("button", { name: m["dayPeriods.management.saving"] })
  ).toHaveCount(0, {
    timeout: 5000,
  });

  // Persisted: afternoon shows the new start.
  await expect(afternoonCard).toContainText(newAfternoonStart, { timeout: 5000 });
  // Neighbour follows: morning's derived end (= afternoon's start) is now the new start.
  await expect(morningCard).toContainText(newAfternoonStart);
  // Afternoon still renders a start–end range.
  await expect(afternoonCard).toContainText(/\d{2}:\d{2}\s*–\s*\d{2}:\d{2}/);

  // --- US3 (active): exactly one "active now" indicator, on the CORRECT (server-authoritative) period ---
  await expect(page.getByText(m["dayPeriods.activeNow"], { exact: true })).toHaveCount(1, {
    timeout: 10_000,
  });
  // Cross-check: the badge sits in the card the SERVER says is active (client resolver agrees with server).
  const activeResp = await page.request.get("/api/day-periods/active");
  expect(activeResp.ok()).toBeTruthy();
  const { activeId } = (await activeResp.json()) as { activeId: string };
  await expect(
    page.getByTestId(`day-period-${activeId}`).getByText(m["dayPeriods.activeNow"], { exact: true })
  ).toBeVisible();

  // --- US2 (negative): an out-of-order edit is rejected and does not persist ---
  await afternoonCard.getByRole("button", { name: m["dayPeriods.action.edit"] }).click();
  await timeInput.fill("04:00"); // before morning's 05:00 → strict-order violation
  await afternoonCard.getByRole("button", { name: m["dayPeriods.action.save"] }).click();

  // A save/validation error is surfaced via the shared ErrorNotice live region (
  // migrated this off an inline `style="color: crimson"` selector, which the token-dialect
  // migration removes entirely — the stable testid is the decoupled replacement).
  await expect(page.getByTestId("day-periods-error")).toBeVisible({ timeout: 5000 });

  await afternoonCard.getByRole("button", { name: m["dayPeriods.action.cancel"] }).click();
  // The rejected edit persisted nothing (client): afternoon still shows the last accepted value.
  await expect(afternoonCard).toContainText(newAfternoonStart, { timeout: 5000 });

  //...and nothing persisted SERVER-side either: refetch the catalog from the API and confirm 11:30, not 04:00.
  const afterReject = await page.request.get("/api/day-periods");
  expect(afterReject.ok()).toBeTruthy();
  const periodsAfter = (await afterReject.json()) as Array<{ id: string; start: string }>;
  expect(periodsAfter.find((p) => p.id === "afternoon")?.start).toBe(newAfternoonStart);
});
