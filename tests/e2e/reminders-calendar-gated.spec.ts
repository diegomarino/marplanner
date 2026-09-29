import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { messages, resolveLang } from "../../src/client/i18n/messages";
import type { Reminder, DryRunResult, ReminderEmission } from "../../src/shared";
import { unlockAdmin } from "./admin-unlock";

/** calendar-gated reminders — calendar_gated admin author →
 * dry-run → emit critical-flow e2e
 * Flow: access gate → provision → API-seed 1 active member + an all-day
 * calendar event assigned to that member, titled to match a query → admin
 * unlock → Reminders tab → author a `calendar_gated` `specific` reminder
 * (query + membership assignment, no weekdays,
 * calendar-gated reminders US2/REMINDERS-AC-05) via the create form
 * → open the dry-run/explain panel on that rule's card and run it for the
 * seeded member/date → assert the verdict (`wouldEmit`,
 * calendar-gated reminders US3/REMINDERS-AC-10) → assert the rule
 * actually emits via `GET /api/reminders/emissions` (REMINDERS-AC-02).
 * Isolation: unique
 * per-run member/reminder/query text, since the managed webServer persists a
 * shared DATA_DIR across runs. The target date is derived from the household
 * timezone (`/api/settings` `locale.timezone`, ADR-062-adjacent) via
 * `Intl.DateTimeFormat`, not the test runner's local clock — the calendar
 * gate (`getEvents`) and the dry-run probes both resolve a single-day window
 * in that timezone, so anchoring the seeded event and the
 * dry-run date on the SAME household "today" keeps them aligned regardless of
 * the host machine's own timezone.
 * The create form uses its stable test ID; accessible labels identify its controls.
 */

const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN ?? "mpg-e2e-access-token";
const BOOTSTRAP_KEY = process.env.MP_BOOTSTRAP_KEY ?? "mpk-e2e-bootstrap-key";
const ADMIN_PIN = process.env.ADMIN_PIN ?? "1234";

test("synchronized imported occurrence gates one reminder on the household date", async () => {
  const { register } = await import("tsx/esm/api");
  const unregister = register();
  const dataDir = mkdtempSync(join(tmpdir(), "mp-reminder-feed-"));
  const originalDataDir = process.env.DATA_DIR;
  const originalDatabasePath = process.env.DATABASE_PATH;
  const { getDb, resetDb } = await import("../../src/server/db/client");
  const { runMigrations } = await import("../../src/server/db/migrate");
  const { hashKey } = await import("../../src/server/auth/credentials");
  const { startExternalSourceSynchronization } =
    await import("../../src/server/modules/calendar/sync-coordinator");
  const { buildApp } = await import("../../src/server/app");
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    resetDb();
    process.env.DATA_DIR = dataDir;
    process.env.DATABASE_PATH = "marplanner.db";
    runMigrations();
    const date = ymdInTz(new Date(), "Europe/Madrid");
    const tomorrow = addDays(date, 1);
    const icsDate = date.replaceAll("-", "");
    const now = Date.now();
    const key = "mpk-reminder-feed-e2e";
    const db = getDb();
    db.prepare(
      "UPDATE plugin_activation_registry SET state = 'active' WHERE plugin_id = 'reminders'"
    ).run();
    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES ('device', ?, '*', 'device', ?)"
    ).run(hashKey(key), now);
    db.prepare(
      "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES ('alex', 'Alex', 'child', 'active', ?, ?)"
    ).run(now, now);
    db.prepare(
      "INSERT INTO calendar_external_sources (id, name, provider, feed_url, created_at, updated_at) VALUES ('feed', 'Feed', 'ics_generic', 'https://calendar.example.test/feed', ?, ?)"
    ).run(now, now);
    const body = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:vetcheck",
      `DTSTAMP:${icsDate}T000000Z`,
      `DTSTART;VALUE=DATE:${icsDate}`,
      `DTEND;VALUE=DATE:${tomorrow.replaceAll("-", "")}`,
      "SUMMARY:Alex vetcheck imported",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    await startExternalSourceSynchronization("feed", {
      lookup: async () => [{ address: "8.8.8.8", family: 4 as const }],
      transport: async () => body,
    });
    app = await buildApp();
    const cookies = { mp_device_key: key };
    const created = await app.inject({
      method: "POST",
      url: "/api/reminders",
      cookies,
      payload: {
        kind: "calendar_gated",
        targetingMode: "apply_to_all",
        text: "Prepare vetcheck",
        query: "vetcheck",
      },
    });
    expect(created.statusCode).toBe(201);
    const reminderId = (created.json() as { id: string }).id;
    const emissions = await app.inject({
      method: "GET",
      url: `/api/reminders/emissions?memberId=alex&date=${date}`,
      cookies,
    });
    expect(emissions.statusCode).toBe(200);
    expect(
      (emissions.json() as ReminderEmission[]).filter((item) => item.id === reminderId)
    ).toEqual([{ id: reminderId, text: "Prepare vetcheck" }]);
  } finally {
    unregister();
    await app?.close();
    resetDb();
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = originalDatabasePath;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

/** `YYYY-MM-DD` for `instant` as observed in IANA zone `tz` — timezone-correct, unlike local/UTC getters. */
function ymdInTz(instant: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const year = parts.find((p) => p.type === "year")!.value;
  const month = parts.find((p) => p.type === "month")!.value;
  const day = parts.find((p) => p.type === "day")!.value;
  return `${year}-${month}-${day}`;
}

function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(
    dt.getUTCDate()
  ).padStart(2, "0")}`;
}

test("calendar_gated admin author → dry-run → emit: query + membership assignment, no weekdays (specs/009-reminders-calendar-gated US2/US3, REMINDERS-AC-02/REMINDERS-AC-05/REMINDERS-AC-10)", async ({
  page,
}) => {
  test.setTimeout(120_000);

  const rid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  // --- 1) Access gate → provisioning (mirrors reminders.spec.ts) ---
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

  // --- 2) Resolve the active locale (default es, ADR-061) + household timezone ---
  const settingsResp = await page.request.get("/api/settings");
  expect(settingsResp.status()).toBe(200);
  const settings = (await settingsResp.json()) as {
    locale?: { language?: string; timezone?: string };
  };
  const lang = resolveLang(settings.locale?.language);
  const m = messages[lang];
  const tz = settings.locale?.timezone ?? "Europe/Madrid";
  const today = ymdInTz(new Date(), tz);
  const tomorrow = addDays(today, 1);

  // --- 3) API-seed 1 active member (device cookie carried by the browser context) ---
  const memberName = `CalGated-${rid}`;
  const memberResp = await page.request.post("/api/members", {
    data: { displayName: memberName, role: "parent" },
  });
  expect(memberResp.status()).toBe(201);
  const memberId = ((await memberResp.json()) as { id: string }).id;

  // --- 4) API-seed an all-day event on `today`, titled to match the reminder's
  // query text (case-insensitive, D2), and assign it to the member ---
  const queryText = `vetcheck${rid}`;
  const eventTitle = `Vet appointment (VetCheck${rid})`;
  const eventResp = await page.request.post("/api/calendar/events", {
    data: { title: eventTitle, allDay: true, startDate: today, endDate: tomorrow },
  });
  expect(eventResp.status()).toBe(201);
  const eventId = ((await eventResp.json()) as { id: string }).id;

  const assignResp = await page.request.put(`/api/calendar/events/${eventId}/assignments`, {
    data: { memberIds: [memberId] },
  });
  expect(assignResp.status()).toBe(200);

  // --- 5) Admin unlock (long-press → PIN) ---
  await unlockAdmin(page, ADMIN_PIN);
  await expect(page.getByTestId("admin-nav-member-create")).toBeVisible({ timeout: 10_000 });

  // --- 6) Reminders tab ---
  await page.getByTestId("admin-nav-reminders-management").click();
  await expect(page.getByRole("heading", { name: m["reminders.management.title"] })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText(m["reminders.management.loading"])).toHaveCount(0, {
    timeout: 10_000,
  });

  // --- 7) Author a calendar_gated `specific` reminder: query + membership
  // assignment, no weekdays (calendar-gated reminders US2,
  // REMINDERS-AC-05/REMINDERS-INV-01/REMINDERS-INV-09) — scoped to the
  // create form's testid so it never collides with any existing reminder
  // card (persisted DATA_DIR across runs). Was a styling-class locator
  // (.bg-white...), which broke the moment the token migration recoloured
  // the surface — never couple an e2e locator to presentation classes. ---
  const createForm = page.getByTestId("reminder-create-form");
  await expect(createForm).toBeVisible();

  const reminderText = `Prepara al perro ${rid}`;
  await createForm.getByLabel(m["reminders.kind.calendarGated"]).check();
  await createForm.getByPlaceholder(m["reminders.management.textPlaceholder"]).fill(reminderText);
  await createForm.getByLabel(m["reminders.management.targetingSpecific"]).check();
  await createForm.getByPlaceholder(m["reminders.calendarGated.queryPlaceholder"]).fill(queryText);
  // queryFields defaults to [title, description] — the event title match is sufficient, no toggle needed.
  await createForm.getByLabel(memberName).check();

  const [createResp] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith("/api/reminders") && r.request().method() === "POST"
    ),
    createForm.getByRole("button", { name: m["reminders.action.create"] }).click(),
  ]);
  expect(createResp.status()).toBe(201);
  const reminder = (await createResp.json()) as Reminder;
  expect(reminder.kind).toBe("calendar_gated");
  expect(reminder.targetingMode).toBe("specific");
  expect(reminder.weekdays).toBeNull();
  await expect(page.getByText(reminderText)).toBeVisible({ timeout: 10_000 });

  // --- 8) Run the dry-run/explain view on this rule's card for (member, today) ---
  const card = page.locator(".border.rounded-lg.p-4.mb-4").filter({ hasText: reminderText });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: m["reminders.dryRun.toggleShow"] }).click();
  await expect(card.getByText(m["reminders.dryRun.title"])).toBeVisible({ timeout: 10_000 });

  await card.locator("select").selectOption(memberId);
  await card.locator('input[type="date"]').fill(today);

  const [dryRunResp] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().includes(`/api/reminders/${reminder.id}/dry-run`) && r.request().method() === "POST"
    ),
    card.getByRole("button", { name: m["reminders.dryRun.run"] }).click(),
  ]);
  expect(dryRunResp.status()).toBe(200);
  const dryRunResult = (await dryRunResp.json()) as DryRunResult;
  expect(dryRunResult.wouldEmit).toBe(true);
  await expect(card.getByText(m["reminders.dryRun.wouldEmit"])).toBeVisible({ timeout: 10_000 });

  // --- 9) Assert the rule actually EMITS via GET /api/reminders/emissions (REMINDERS-AC-02) ---
  const emissionsResp = await page.request.get(
    `/api/reminders/emissions?memberId=${memberId}&date=${today}`
  );
  expect(emissionsResp.status()).toBe(200);
  const emissions = (await emissionsResp.json()) as ReminderEmission[];
  expect(emissions.map((e) => e.id)).toContain(reminder.id);
});
