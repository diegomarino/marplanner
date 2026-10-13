import { test, expect } from "@playwright/test";
import { openAdminSection } from "./admin-nav";
import { messages, resolveLang } from "../../src/client/i18n/messages";
import type { DailyMessage } from "../../src/shared";
import { unlockAdmin } from "./admin-unlock";

/** — daily-messages admin author→read critical-flow e2e (closes).
 * Flow: access gate → provision → API-seed 1 active member → admin unlock →
 * Daily Messages tab (`data-testid="admin-nav-daily-messages-management"`) →
 * select the seeded member → author today's message via the 14-day editor
 * (PUT /api/daily-messages) → assert it appears in the member's window list
 * (both the rendered UI AND `GET /api/daily-messages`) AND via the outbound
 * single read `GET /api/daily-messages/current` (FR-015/016).
 * Anti-flakiness (memory e2e-flakiness — burned on /): this spec uses a
 * unique per-run member name and message text. The E2E harness also gives each
 * run an isolated DATA_DIR and removes that store when the run ends.
 */

const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN ?? "mpg-e2e-access-token";
const BOOTSTRAP_KEY = process.env.MP_BOOTSTRAP_KEY ?? "mpk-e2e-bootstrap-key";
const ADMIN_PIN = process.env.ADMIN_PIN ?? "1234";

/** HOUSEHOLD-tz calendar date (Europe/Madrid, the unseeded default), NOT the runner's local
 * date. The server derives "today" in the household timezone; a UTC CI runner disagrees with
 * it nightly between 22:00–24:00 UTC, which made this spec red for every in that window
 * (-class: green everywhere except inside its own window). The kiosk browser shares the
 * household tz in production, so DailyMessagesManagement.tsx's local-date mirror stays valid
 * there — only this spec runs on a foreign-tz machine.
 */
function todayIsoDate(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(new Date());
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

test("daily-messages admin author→read: PUT then GET window + current (#462)", async ({ page }) => {
  test.setTimeout(120_000);

  const rid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const memberName = `DailyMessages-${rid}`;
  const messageText = `Buen día ${rid}`;

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

  // --- 3) API-seed 1 active member (device cookie carried by the browser context) ---
  // role: "parent" — NOT "child": chores-board.spec.ts's own empty-board scenario
  // archives EVERY active child in the shared DATA_DIR, which would race-archive
  // a child member created here when it runs in a parallel worker. Daily-message
  // authoring is role-agnostic, so "parent" sidesteps that interference entirely.
  const memberResp = await page.request.post("/api/members", {
    data: { displayName: memberName, role: "parent" },
  });
  expect(memberResp.status()).toBe(201);
  const memberId = ((await memberResp.json()) as { id: string }).id;

  const today = todayIsoDate();

  // --- 4) Admin unlock (long-press → PIN) ---
  await unlockAdmin(page, ADMIN_PIN);
  await expect(page.getByTestId("admin-overview")).toBeVisible({ timeout: 10_000 });

  // --- 5) Daily Messages tab ---
  await openAdminSection(page, "admin-nav-daily-messages-management");
  await expect(
    page.getByRole("heading", { name: m["dailyMessages.management.title"] })
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(m["dailyMessages.management.loading"])).toHaveCount(0, {
    timeout: 10_000,
  });

  // --- 6) Select the seeded member — the dropdown may default to a pre-existing
  // active member from earlier runs, so pick ours explicitly by label. ---
  await page
    .getByLabel(m["dailyMessages.management.selectMember"])
    .selectOption({ label: memberName });
  await expect(page.getByText(m["dailyMessages.management.loading"])).toHaveCount(0, {
    timeout: 10_000,
  });

  // --- 7) Author today's message via the 14-day editor (FR-015) ---
  const todayTextarea = page.getByTestId(`daily-messages-text-${today}`);
  await todayTextarea.fill(messageText);

  const [upsertResp] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith("/api/daily-messages") && r.request().method() === "PUT"
    ),
    todayTextarea.blur(),
  ]);
  expect(upsertResp.status()).toBe(200);
  const upserted = (await upsertResp.json()) as DailyMessage;
  expect(upserted.memberId).toBe(memberId);
  expect(upserted.date).toBe(today);
  expect(upserted.text).toBe(messageText);

  // --- 8) Assert it appears in the member's window list (rendered UI) ---
  await expect(todayTextarea).toHaveValue(messageText, { timeout: 10_000 });

  // --- 9) Assert it appears in the member's window list (GET /api/daily-messages) ---
  const windowResp = await page.request.get(
    `/api/daily-messages?memberId=${memberId}&from=${today}&days=1`
  );
  expect(windowResp.status()).toBe(200);
  const windowList = (await windowResp.json()) as DailyMessage[];
  expect(windowList.some((msg) => msg.date === today && msg.text === messageText)).toBe(true);

  // --- 10) Assert the outbound single read (GET /api/daily-messages/current, FR-016) ---
  const currentResp = await page.request.get(
    `/api/daily-messages/current?memberId=${memberId}&date=${today}`
  );
  expect(currentResp.status()).toBe(200);
  const current = (await currentResp.json()) as DailyMessage;
  expect(current.memberId).toBe(memberId);
  expect(current.date).toBe(today);
  expect(current.text).toBe(messageText);

  // --- 11) Navigate one 14-day block forward and back; today is the lower bound ---
  const previousWindow = page.getByTestId("daily-messages-previous-window");
  await expect(previousWindow).toBeDisabled();
  await page.getByTestId("daily-messages-next-window").click();
  await expect(page.getByTestId(`daily-messages-day-${addDays(today, 14)}`)).toBeVisible();
  await expect(previousWindow).toBeEnabled();

  await previousWindow.click();
  await expect(page.getByTestId(`daily-messages-text-${today}`)).toHaveValue(messageText);
  await expect(previousWindow).toBeDisabled();
});
