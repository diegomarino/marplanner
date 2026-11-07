import { test, expect } from "@playwright/test";
import { openAdminSection } from "./admin-nav";
import { messages, resolveLang, type MessageKey } from "../../src/client/i18n/messages";
import type { Reminder } from "../../src/shared";
import { unlockAdmin } from "./admin-unlock";

/** — reminders admin author→read critical-flow e2e (closes).
 * Flow: access gate → provision → API-seed 2 active members → admin unlock →
 * Reminders tab → create an `apply_to_all` scheduled reminder (US1/AC-03) AND
 * a `specific` reminder with per-member weekday assignments via the create
 * dialog's member pills with weekday rows (US2/INV-09/AC-03) → assert live emissions via
 * `GET /api/reminders/emissions` for the right member/date (quickstart
 * Scenarios B and C).
 * Anti-flakiness (memory e2e-flakiness — burned on /): unique
 * per-run member/reminder text, since the managed webServer persists a
 * shared DATA_DIR across runs. Reference dates are `today + {0,1,2,3}` days,
 * whose weekdays are pairwise-distinct (any 4 consecutive calendar days fall
 * on 4 distinct weekdays), so assertions never depend on the run date's
 * actual weekday.
 * The create/edit form is a Dialog (`reminder-form-dialog`) opened by "Add rule"; rows and
 * actions carry data-testids; each member is a pill (`reminders-member-<id>`) whose weekday
 * pills (`reminders-weekday-<id>-<day>`) appear once selected. The last step edits
 * the apply_to_all rule into a specific one (PATCH carrying targetingMode + assignments).
 */

const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN ?? "mpg-e2e-access-token";
const BOOTSTRAP_KEY = process.env.MP_BOOTSTRAP_KEY ?? "mpk-e2e-bootstrap-key";
const MP_ADMIN_PIN = process.env.MP_ADMIN_PIN ?? "1234";

type WeekdayCode = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
const WEEKDAY_ORDER: readonly WeekdayCode[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate()
  ).padStart(2, "0")}`;
}

function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return ymd(dt);
}

// Mirrors src/server/lib/household-date.ts weekdayOf: the weekday of a Y-M-D
// calendar date is timezone-invariant, derived from the UTC instant alone.
function weekdayCodeOf(dateStr: string): WeekdayCode {
  const [y, m, d] = dateStr.split("-").map(Number);
  const instant = new Date(Date.UTC(y, m - 1, d));
  const label = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" }).format(
    instant
  );
  return label.substring(0, 3).toLowerCase() as WeekdayCode;
}

test("reminders admin author→read: apply_to_all + specific-with-matrix (US1/US2, AC-03)", async ({
  page,
}) => {
  test.setTimeout(120_000);

  const rid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  // --- 1) Access gate → provisioning (mirrors member-lifecycle.spec.ts) ---
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

  // --- 2) Resolve the active locale (default en, ADR-015) for post-unlock t lookups ---
  const settingsResp = await page.request.get("/api/settings");
  expect(settingsResp.status()).toBe(200);
  const settings = (await settingsResp.json()) as { locale?: { language?: string } };
  const lang = resolveLang(settings.locale?.language);
  const m = messages[lang];

  // --- 3) API-seed 2 active members (device cookie carried by the browser context) ---
  // role: "parent" — NOT "child": chores-board.spec.ts's own empty-board scenario
  // archives EVERY active child in the shared DATA_DIR (not just its own), which
  // would race-archive child members created here when it runs in a parallel
  // worker. Reminders assignment is role-agnostic, so "parent" sidesteps that
  // pre-existing test's interference entirely.
  const memberAName = `Reminders-A-${rid}`;
  const memberBName = `Reminders-B-${rid}`;
  const memberAResp = await page.request.post("/api/members", {
    data: { displayName: memberAName, role: "parent" },
  });
  expect(memberAResp.status()).toBe(201);
  const memberAId = ((await memberAResp.json()) as { id: string }).id;

  const memberBResp = await page.request.post("/api/members", {
    data: { displayName: memberBName, role: "parent" },
  });
  expect(memberBResp.status()).toBe(201);
  const memberBId = ((await memberBResp.json()) as { id: string }).id;

  // --- 4) Reference dates: today+{0,1,2,3}, pairwise-distinct weekdays ---
  const today = ymd(new Date());
  const dateAllYes = addDays(today, 0);
  const dateAllNo = addDays(today, 1);
  const dateSpecificA = addDays(today, 2);
  const dateSpecificB = addDays(today, 3);
  const weekdayAll = weekdayCodeOf(dateAllYes);
  const weekdayA = weekdayCodeOf(dateSpecificA);
  const weekdayB = weekdayCodeOf(dateSpecificB);

  // --- 5) Admin unlock (long-press → PIN) ---
  await unlockAdmin(page, MP_ADMIN_PIN);
  await expect(page.getByTestId("admin-overview")).toBeVisible({ timeout: 10_000 });

  // --- 6) Reminders tab ---
  await openAdminSection(page, "admin-nav-reminders-management");
  await expect(page.getByRole("heading", { name: m["reminders.management.title"] })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText(m["reminders.management.loading"])).toHaveCount(0, {
    timeout: 10_000,
  });

  const dialog = page.getByTestId("reminder-form-dialog");
  const addRule = page.getByTestId("reminders-add-rule");

  // --- 7) Create an apply_to_all scheduled reminder (US1/AC-03) ---
  const applyToAllText = `Sacar la basura ${rid}`;
  await addRule.click();
  await dialog.getByPlaceholder(m["reminders.management.textPlaceholder"]).fill(applyToAllText);
  // targetingMode defaults to apply_to_all — only the weekday checkbox row needs a toggle.
  await dialog.getByLabel(m[`reminders.weekday.${weekdayAll}` as MessageKey]).check();

  const [applyToAllCreateResp] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith("/api/reminders") && r.request().method() === "POST"
    ),
    dialog.getByTestId("reminder-save").click(),
  ]);
  expect(applyToAllCreateResp.status()).toBe(201);
  const applyToAllReminder = (await applyToAllCreateResp.json()) as Reminder;
  expect(applyToAllReminder.targetingMode).toBe("apply_to_all");
  await expect(dialog).toBeHidden();
  await expect(page.getByText(applyToAllText)).toBeVisible({ timeout: 10_000 });

  // --- 8) Create a specific reminder with per-member assignments via the member pills (US2/INV-09/AC-03) ---
  const specificText = `Coges el bus ${rid}`;
  await addRule.click();
  await dialog.getByPlaceholder(m["reminders.management.textPlaceholder"]).fill(specificText);
  await dialog.getByLabel(m["reminders.management.targetingSpecific"]).check();

  // Pills are picked by testid: a member's day row only exists while that member is selected.
  await dialog.getByTestId(`reminders-member-${memberAId}`).check();
  await dialog.getByTestId(`reminders-weekday-${memberAId}-${weekdayA}`).check();
  await dialog.getByTestId(`reminders-member-${memberBId}`).check();
  await dialog.getByTestId(`reminders-weekday-${memberBId}-${weekdayB}`).check();

  // The seven weekday pills of one member share one line.
  const ys = await Promise.all(
    WEEKDAY_ORDER.map(async (day) => {
      const box = await dialog.getByTestId(`reminders-weekday-${memberAId}-${day}`).boundingBox();
      return box!.y;
    })
  );
  expect(new Set(ys).size).toBe(1);

  const [specificCreateResp] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith("/api/reminders") && r.request().method() === "POST"
    ),
    dialog.getByTestId("reminder-save").click(),
  ]);
  expect(specificCreateResp.status()).toBe(201);
  const specificReminder = (await specificCreateResp.json()) as Reminder;
  expect(specificReminder.targetingMode).toBe("specific");
  await expect(dialog).toBeHidden();
  await expect(page.getByText(specificText)).toBeVisible({ timeout: 10_000 });

  // --- 9) Assert emissions via GET /api/reminders/emissions for the right member/date ---
  async function emissionIds(memberId: string, date: string): Promise<string[]> {
    const resp = await page.request.get(
      `/api/reminders/emissions?memberId=${memberId}&date=${date}`
    );
    expect(resp.status()).toBe(200);
    const emissions = (await resp.json()) as Array<{ id: string; text: string }>;
    return emissions.map((e) => e.id);
  }

  // apply_to_all reaches BOTH members on the target weekday (Scenario B)...
  expect(await emissionIds(memberAId, dateAllYes)).toContain(applyToAllReminder.id);
  expect(await emissionIds(memberBId, dateAllYes)).toContain(applyToAllReminder.id);
  //... and not on a different weekday.
  expect(await emissionIds(memberAId, dateAllNo)).not.toContain(applyToAllReminder.id);
  expect(await emissionIds(memberBId, dateAllNo)).not.toContain(applyToAllReminder.id);

  // specific: per-member weekday assignment (Scenario C) — A only on wA, B only on wB.
  expect(await emissionIds(memberAId, dateSpecificA)).toContain(specificReminder.id);
  expect(await emissionIds(memberAId, dateSpecificB)).not.toContain(specificReminder.id);
  expect(await emissionIds(memberBId, dateSpecificB)).toContain(specificReminder.id);
  expect(await emissionIds(memberBId, dateSpecificA)).not.toContain(specificReminder.id);

  // --- 10) Edit the apply_to_all rule into a specific one for member A only (targetingMode edit) ---
  await page.getByTestId(`reminder-edit-${applyToAllReminder.id}`).click();
  await dialog.getByLabel(m["reminders.management.targetingSpecific"]).check();
  await dialog.getByTestId(`reminders-member-${memberAId}`).check();
  await dialog.getByTestId(`reminders-weekday-${memberAId}-${weekdayAll}`).check();
  const [editResp] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().endsWith(`/api/reminders/${applyToAllReminder.id}`) &&
        r.request().method() === "PATCH"
    ),
    dialog.getByTestId("reminder-save").click(),
  ]);
  expect(editResp.status()).toBe(200);
  expect(((await editResp.json()) as Reminder).targetingMode).toBe("specific");
  await expect(dialog).toBeHidden();
  expect(await emissionIds(memberAId, dateAllYes)).toContain(applyToAllReminder.id);
  expect(await emissionIds(memberBId, dateAllYes)).not.toContain(applyToAllReminder.id);
});
