import { test, expect } from "@playwright/test";

/** Calendar critical-flow e2e against the built app.
 * Walks the assembled flow: gate → provision → (API-seed a member + a weekly
 * recurring event) → read the merged feed on the surface (recurrence EXPANDS to
 * multiple occurrences end-to-end) → create a timed + an all-day event via the
 * UI → assign the timed event to the member and confirm the member-scoped read
 * → edit → delete, entirely on `/calendar`.
 * Notes on scope (verified against the implementation, not assumed):
 * - The family calendar is available at `/calendar` through shared shell navigation.
 * - The create FORM has no recurrence input, so a recurring event cannot be
 * created through the UI — it is API-seeded here (the browser context carries
 * the httpOnly device-key cookie after provisioning). The e2e asserts the
 * READ path expands recurrence; DST-instant correctness is unit-proven in
 * src/server/modules/calendar/recurrence.ts, not re-proven here.
 * - The app localizes to es by default (ADR-061). Interactive targets on
 * CalendarView carry stable `data-testid`s (added for this e2e), so row +
 * action-button + per-member-checkbox targeting is locale- and DOM-shape
 * independent — no text/`.last` races, and the member checkbox cannot
 * collide with the AdminGate members panel that echoes the same name above.
 */

const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN ?? "mpg-e2e-access-token";
const BOOTSTRAP_KEY = process.env.MP_BOOTSTRAP_KEY ?? "mpk-e2e-bootstrap-key";

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

test.describe.configure({ mode: "serial" });
test.use({ timezoneId: "America/New_York" });

test("calendar critical flow: create/read (recurrence-expanded) → assign+member-scoped read → edit → delete", async ({
  page,
}) => {
  test.setTimeout(120_000);
  // Unique per-run suffix so the spec is robust against a non-pristine DB: the
  // managed webServer persists a shared DATA_DIR, so titles/members from earlier
  // runs can linger. Unique titles keep every row/lookup unambiguous (exactly one
  // match), independent of accumulated data — no reliance on `.last`.
  const rid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  // 1) Access gate → provisioning (on /).
  await page.goto("/");
  await page.getByTestId("access-gate-form").locator('input[name="token"]').fill(ACCESS_TOKEN);
  await page.getByRole("button", { name: "Enter" }).click();
  await page.getByLabel("Bootstrap key").fill(BOOTSTRAP_KEY);
  await page.getByRole("button", { name: "Provision Device" }).click();
  await expect(page.getByTestId("home-surface")).toBeVisible();

  // 2) API-seed a member + a weekly recurring event (device cookie carried by context).
  const memberName = `Ada Lovelace ${rid}`;
  const otherMemberName = `Grace Hopper ${rid}`;
  const memberResp = await page.request.post("/api/members", {
    data: { displayName: memberName, role: "parent" },
  });
  expect(memberResp.status()).toBe(201);
  const memberId = (await memberResp.json()).id as string;
  const otherMemberResp = await page.request.post("/api/members", {
    data: { displayName: otherMemberName, role: "parent" },
  });
  expect(otherMemberResp.status()).toBe(201);

  // Weekly recurring timed event starting ~3 days out so >=2 occurrences fall in
  // the surface's fixed -29d/+364d window regardless of the run date.
  const seed = new Date();
  seed.setDate(seed.getDate() + 3);
  const seedDate = ymd(seed);
  const recurringTitle = `Weekly Standup (recurring) ${rid}`;
  const recResp = await page.request.post("/api/calendar/events", {
    data: {
      title: recurringTitle,
      allDay: false,
      startUtc: `${seedDate}T07:00:00.000Z`,
      endUtc: `${seedDate}T08:00:00.000Z`,
      tzid: "Europe/Madrid",
      rrule: "FREQ=WEEKLY",
    },
  });
  expect(recResp.status()).toBe(201);
  const recurringMasterId = ((await recResp.json()) as { id: string }).id;

  // 3) Read the merged feed on the surface. The recurring master EXPANDS to
  // multiple occurrences end-to-end (INV-01 read spine + recurrence).
  const feedResp = page.waitForResponse(
    (r) => r.url().includes("/api/calendar/events") && r.request().method() === "GET"
  );
  await page.goto("/calendar");
  await expect(page.getByRole("heading", { name: /calendario|calendar/i })).toBeVisible();
  // Install the clock after the app's Temporal/Intl polyfill has initialized.
  // The week view scrolls to the household's current hour: keep the 10:00 event
  // in that viewport regardless of CI's wall clock. Timers still run normally.
  await page.clock.setFixedTime(new Date(`${ymd(new Date())}T08:00:00.000Z`));
  const feed = await feedResp;
  expect(feed.status()).toBe(200);
  // Loading indicator must clear (surface actually rendered the feed).
  await expect(page.getByText(/cargando calendario|loading calendar/i)).toHaveCount(0, {
    timeout: 15_000,
  });
  const feedItems = (await feed.json()) as Array<{ title: string }>;
  expect(feedItems.filter((item) => item.title === recurringTitle).length).toBeGreaterThanOrEqual(
    2
  );
  await expect(page.getByText(recurringTitle).first()).toBeVisible({ timeout: 15_000 });

  // 4) Create a TIMED event via the UI. Scope every interaction to the create form
  // (identified by its testid'd title input) so it never collides with other
  // forms on the page (edit/assign panels, etc.).
  const today = ymd(new Date());
  const timedTitle = `Team Meeting (timed) ${rid}`;
  const createForm = () =>
    page.locator("form").filter({ has: page.getByTestId("calendar-create-title-input") });
  await page.getByTestId("calendar-create-btn").click();
  await createForm().getByTestId("calendar-create-title-input").fill(timedTitle);
  const allDay1 = createForm().locator('input[type="checkbox"]').first();
  if (await allDay1.isChecked()) await allDay1.uncheck();
  await createForm().locator('input[type="datetime-local"]').first().fill(`${today}T10:00`);
  await createForm().locator('input[type="datetime-local"]').nth(1).fill(`${today}T11:00`);
  await createForm().getByTestId("calendar-create-submit").click();
  await expect(page.getByText(timedTitle).first()).toBeVisible({ timeout: 8000 });

  // 5) Create an ALL-DAY event via the UI.
  const allDayTitle = `Doctor Appointment (all-day) ${rid}`;
  await page.getByTestId("calendar-create-btn").click();
  await createForm().getByTestId("calendar-create-title-input").fill(allDayTitle);
  const allDay2 = createForm().locator('input[type="checkbox"]').first();
  if (!(await allDay2.isChecked())) await allDay2.check();
  await createForm().locator('input[type="date"]').first().fill(today);
  await createForm().getByTestId("calendar-create-submit").click();
  await expect(page.getByText(allDayTitle).first()).toBeVisible({ timeout: 8000 });

  // 6) Assign the timed event to the member via the UI affordance, then confirm the
  // member-scoped read (INV-09/AC-06) via the API. Event activation opens the
  // calendar detail controls below the visual Calendar.
  const rowOf = (title: string) =>
    page.getByTestId("calendar-event-row").filter({ hasText: title });
  const timedRow = rowOf(timedTitle);
  await timedRow.click();
  const detail = page.getByTestId("calendar-event-detail");
  await detail.getByTestId("calendar-assign-btn").click();
  await detail.getByTestId(`calendar-assign-member-${memberId}`).check();
  // Await the PUT itself (not just the click) so the scoped read below cannot
  // race the assignment write — the click only dispatches the async submit.
  const assignResp = page.waitForResponse(
    (r) => r.url().includes("/assignments") && r.request().method() === "PUT"
  );
  await detail.getByTestId("calendar-assign-save-btn").click();
  expect((await assignResp).status()).toBe(200);

  const scoped = await page.request.get(
    `/api/calendar/events?source=all&from=${encodeURIComponent(
      new Date(Date.now() - 7 * 86_400_000).toISOString()
    )}&to=${encodeURIComponent(new Date(Date.now() + 7 * 86_400_000).toISOString())}&assignedTo=${memberId}`
  );
  expect(scoped.status()).toBe(200);
  const scopedItems = (await scoped.json()) as Array<{ title: string; assignedTo: string[] }>;
  expect(scopedItems.length).toBeGreaterThanOrEqual(1);
  expect(scopedItems.every((e) => e.assignedTo.includes(memberId))).toBe(true);
  expect(scopedItems.some((e) => e.title === timedTitle)).toBe(true);
  expect(scopedItems.some((e) => e.title === allDayTitle)).toBe(false);

  // A narrow month keeps readable day columns inside its own horizontal viewport.
  const originalViewport = page.viewportSize()!;
  await page.setViewportSize({ width: 375, height: 900 });
  const month = page.getByTestId("calendar-month-grid");
  const dayWidth = await month
    .locator("[data-date]")
    .first()
    .evaluate((el) => el.getBoundingClientRect().width);
  expect(dayWidth).toBeGreaterThanOrEqual(96);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await month.evaluate((el) => {
    el.scrollLeft = 200;
  });
  expect(await month.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  await test.info().attach("calendar-month-narrow-loaded", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
  await page.setViewportSize(originalViewport);

  // 7) Exercise the REAL Schedule-X week renderer. The browser runs in New York while the
  // household uses Europe/Madrid, so the 10:00 wall-clock label also proves the event is
  // projected in the configured household timezone. The all-day event must use Schedule-X's
  // date grid, while the timed event must use its time grid.
  await detail.getByRole("button", { name: /cerrar|close/i }).click();
  await page.getByRole("button", { name: /^(semana|week)$/i }).click();
  await expect(page.getByTestId("calendar-week-grid")).toBeVisible();

  const timedWeekRow = rowOf(timedTitle);
  const allDayWeekRow = rowOf(allDayTitle);
  await expect(timedWeekRow).toBeVisible();
  await expect(timedWeekRow).toBeInViewport();
  await expect(timedWeekRow).toContainText("10:00");
  await expect(
    timedWeekRow.locator("xpath=ancestor::*[contains(@class, 'sx__time-grid-event')][1]")
  ).toHaveCount(1);
  await expect(allDayWeekRow).toBeVisible();
  await expect(
    allDayWeekRow.locator("xpath=ancestor::*[contains(@class, 'sx__date-grid-event')][1]")
  ).toHaveCount(1);

  // The two visible weeks contain separate projections of the same recurring master. Assert on
  // the production EventContent attribute so this covers the real Schedule-X identity mapping,
  // not only the pure projection helper.
  const nextPeriod = page.getByRole("button", {
    name: /^(período siguiente|next period)$/i,
  });
  await nextPeriod.click();
  const firstRecurringOccurrence = rowOf(recurringTitle);
  await expect(firstRecurringOccurrence).toBeVisible();
  const firstOccurrenceId = await firstRecurringOccurrence.getAttribute("data-presentation-id");

  await nextPeriod.click();
  const secondRecurringOccurrence = rowOf(recurringTitle);
  await expect(secondRecurringOccurrence).toBeVisible();
  const secondOccurrenceId = await secondRecurringOccurrence.getAttribute("data-presentation-id");

  expect(firstOccurrenceId).toMatch(new RegExp(`^${recurringMasterId}@`));
  expect(secondOccurrenceId).toMatch(new RegExp(`^${recurringMasterId}@`));
  expect(secondOccurrenceId).not.toBe(firstOccurrenceId);

  await page.getByRole("button", { name: /^(hoy|today)$/i }).click();
  await expect(timedWeekRow).toBeVisible();

  // Clicking the actual Schedule-X event invokes its callback and restores the calendar detail controls.
  await timedWeekRow.click();
  await expect(detail.getByTestId("calendar-edit-btn")).toBeVisible();
  await detail.getByRole("button", { name: /cerrar|close/i }).click();

  // Filter changes update the existing Schedule-X app through calendarApp.events.set: selecting
  // the other member removes Ada's event, while the unassigned all-day event remains until its
  // independent filter is disabled.
  const otherMemberFilter = page.getByRole("checkbox", { name: otherMemberName });
  const weekViewport = page.locator(".sx__view-container");
  const [windowScrollXBeforeFilter, weekScrollLeftBeforeFilter] = await Promise.all([
    page.evaluate(() => window.scrollX),
    weekViewport.evaluate((element) => element.scrollLeft),
  ]);
  await otherMemberFilter.check();
  await expect(timedWeekRow).toHaveCount(0);
  await expect(allDayWeekRow).toBeVisible();
  expect(await page.evaluate(() => window.scrollX)).toBe(windowScrollXBeforeFilter);
  expect(await weekViewport.evaluate((element) => element.scrollLeft)).toBe(
    weekScrollLeftBeforeFilter
  );

  const allDayFilter = page.getByRole("checkbox", {
    name: /eventos de día completo|all-day events/i,
  });
  await allDayFilter.uncheck();
  await expect(allDayWeekRow).toHaveCount(0);

  await otherMemberFilter.uncheck();
  await allDayFilter.check();
  await expect(timedWeekRow).toBeVisible();
  await expect(allDayWeekRow).toBeVisible();

  // 8) Edit the timed event's title via the event activated in the real Week view.
  await timedWeekRow.click();
  const editedTitle = `Team Meeting (edited) ${rid}`;
  await detail.getByTestId("calendar-edit-btn").click();
  await detail.getByTestId("calendar-edit-title-input").fill(editedTitle);
  await detail.getByTestId("calendar-edit-save-btn").click();
  await expect(page.getByText(editedTitle).first()).toBeVisible({ timeout: 8000 });

  // 9) Delete the (now edited) event via the UI and confirm it disappears.
  await rowOf(editedTitle).click();
  await detail.getByTestId("calendar-delete-btn").click();
  await detail.getByTestId("calendar-delete-confirm-btn").click();
  await expect(page.getByText(editedTitle)).toHaveCount(0, { timeout: 8000 });
});
