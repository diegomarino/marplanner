import path from "node:path";
import { leaveAdmin, openAdminSection } from "./admin-nav";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { type APIRequestContext } from "@playwright/test";
import { tmpdir } from "node:os";
// `test` comes from./printer-session (extended again below), NOT from @playwright/test: the
// printer-pairing mutex fixture must wrap every test in this file, including the one that
// shares the run with printing.spec.ts.
import { test as printerSessionTest, expect } from "./printer-session";
import { messages, resolveLang } from "../../src/client/i18n/messages";
import { FIXTURE_QUOTE_AUTHOR, FIXTURE_QUOTE_TEXT } from "./quote-onthisday-fixture-server";
import { unlockAdmin } from "./admin-unlock";

/** `test` for this whole file extends `./printer-session`'s `test` (the `printerSession`
 * mutual-exclusion fixture both this file's test and printing.spec.ts need — see that
 * module's own doc comment) with ONE more fixture, `resetDailyBriefingTrigger`, used only by
 *.
 * a reviewer-forced timeout after the trigger-binding save proved the
 * ORIGINAL in-body `try/finally` reset never ran — Playwright abandons a timed-out test body
 * mid-`await`, and code after an abandoned `await` (including a `finally` in that same async
 * function) never executes. Fixture teardown is a SEPARATE mechanism Playwright still runs even
 * then, so the reset moved here. Declared `auto: false` — only a test that explicitly
 * destructures `resetDailyBriefingTrigger` pays for it; below never touches the
 * `daily_briefing_settings` singleton, so it never requests this fixture.
 */
const test = printerSessionTest.extend<{ resetDailyBriefingTrigger: void }>({
  resetDailyBriefingTrigger: [
    async ({ page }, use) => {
      await use();
      // Best-effort (never masks the real test outcome with a teardown error). No admin-session
      // gate applies to this route (AdminGate's PIN is a client-only UX gate, not a server
      // session — verified by reading routes/daily-briefing.ts before relying on this), so a
      // plain device-authenticated `page.request` call is sufficient.
      try {
        await page.request.put("/api/daily-briefing/settings", {
          data: { autoPrintTrigger: null },
        });
      } catch {
        /* best-effort cleanup */
      }
    },
    { auto: false },
  ],
});

/** Daily Briefing administration: opt-in and generation retain the complete catalogue proof.
 * retires only the family-view walk at /daily-briefing. The generated payload,
 * admin raster preview, and the independent trigger/printing test below remain covered.
 */

const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN ?? "mpg-e2e-access-token";
const BOOTSTRAP_KEY = process.env.MP_BOOTSTRAP_KEY ?? "mpk-e2e-bootstrap-key";
const ADMIN_PIN = process.env.ADMIN_PIN ?? "1234";
const DEVICE_TIMEZONE = "America/Los_Angeles";

test.use({ timezoneId: DEVICE_TIMEZONE });

//: declared here, at the top level, rather than as an in-body
// `test.setTimeout(...)` call in either test below — `test.describe.configure({ timeout })` is
// resolved at test-collection time, BEFORE any fixture (including the `printerSession` lock,
//./printer-session) ever runs, so this budget is already in effect for the WHOLE test including
// a slow fixture setup (e.g. a lock wait). An in-body call would be too late for exactly that
// case — see printer-session.ts's own "TIMEOUT ORDERING" doc comment for the full reasoning. Both
// tests in this file already wanted 120s, so one file-level declaration covers both.
test.describe.configure({ timeout: 120_000 });

/** the managed webServer's DATA_DIR is shared by all
 * specs and retries within one run, and callers may intentionally provide a persistent
 * E2E_DATA_DIR. A prior attempt holding TODAY's `daily_briefing_block_cache` row for `quoteOfDay`
 * would make generation serve that cached payload, never calling the fixture at all, and the
 * exact-fixture-quote assertion below would fail deterministically. Clearing this row up front
 * makes the assertion a genuine egress tripwire on every attempt. DB path resolution mirrors
 * `printing.spec.ts`'s `resolveE2eDbPath`/`cleanTestPrintState` precedent exactly (same env
 * vars `playwright.config.ts`'s shared `webServer` sets, same cwd for both processes).
 */
function resolveE2eDbPath(): string {
  const dataDir = process.env.E2E_DATA_DIR ?? ".e2e-data";
  const dbFile = process.env.DATABASE_PATH ?? "marplanner.db";
  return path.resolve(process.cwd(), dataDir, dbFile);
}

function clearQuoteOfDayCache(): void {
  const dbPath = resolveE2eDbPath();
  if (!existsSync(dbPath)) return;
  const db = new Database(dbPath);
  try {
    db.prepare("DELETE FROM daily_briefing_block_cache WHERE block_type = 'quoteOfDay'").run();
  } finally {
    db.close();
  }
}

function dateInTimezone(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(date);
}

function weekdayCode(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" })
    .format(new Date(Date.UTC(year, month - 1, day)))
    .slice(0, 3)
    .toLowerCase();
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

test("synchronized imported occurrence appears once in the generated household-date briefing", async () => {
  const { register } = await import("tsx/esm/api");
  const unregister = register();
  const dataDir = mkdtempSync(path.join(tmpdir(), "mp-briefing-feed-"));
  const originalDataDir = process.env.DATA_DIR;
  const originalDatabasePath = process.env.DATABASE_PATH;
  const { getDb, resetDb } = await import("../../src/server/db/client");
  const { runMigrations } = await import("../../src/server/db/migrate");
  const { startExternalSourceSynchronization } =
    await import("../../src/server/modules/calendar/sync-coordinator");
  const { generateBriefing } = await import("../../src/server/modules/daily-briefing/index");
  try {
    resetDb();
    process.env.DATA_DIR = dataDir;
    process.env.DATABASE_PATH = "marplanner.db";
    runMigrations();
    const date = dateInTimezone(new Date(), "Europe/Madrid");
    const tomorrow = addDays(date, 1);
    const now = Date.now();
    const db = getDb();
    db.prepare(
      "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES ('alex', 'Alex', 'child', 'active', ?, ?)"
    ).run(now, now);
    db.prepare(
      "INSERT INTO daily_briefing_optin (member_id, enabled, created_at, updated_at) VALUES ('alex', 1, ?, ?)"
    ).run(now, now);
    db.prepare(
      "INSERT INTO settings_objects (object_name, data, updated_at) VALUES ('locale', ?, ?)"
    ).run(JSON.stringify({ timezone: "Europe/Madrid", language: "en" }), now);
    db.prepare(
      "INSERT INTO calendar_external_sources (id, name, provider, feed_url, created_at, updated_at) VALUES ('feed', 'Feed', 'ics_generic', 'https://calendar.example.test/feed', ?, ?)"
    ).run(now, now);
    const body = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:briefing-import",
      `DTSTAMP:${date.replaceAll("-", "")}T000000Z`,
      `DTSTART;VALUE=DATE:${date.replaceAll("-", "")}`,
      `DTEND;VALUE=DATE:${tomorrow.replaceAll("-", "")}`,
      "SUMMARY:Alex imported briefing event",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    await startExternalSourceSynchronization("feed", {
      lookup: async () => [{ address: "8.8.8.8", family: 4 as const }],
      transport: async () => body,
    });
    const briefing = await generateBriefing("alex", date);
    expect(briefing.date).toBe(date);
    const today = briefing.payload.blocks.find((block) => block.type === "today");
    expect(today?.status).toBe("ok");
    const bullets = (today?.data as { bullets: string[] }).bullets;
    expect(bullets.filter((bullet) => bullet === "Alex imported briefing event")).toHaveLength(1);
  } finally {
    unregister();
    resetDb();
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = originalDatabasePath;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

/** Mirrors `blocks/today.ts`'s exact truncate (36-char cap, trailing "…") so the "today"
 * block's bullet content can be pinned exactly rather than merely substring-matched. */
function truncateBullet(s: string, max = 36): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Block types this spec expects PRESENT, in their relative EFFECTIVE-ORDER position (no
 * `daily_briefing_block_order` row is configured, so the effective order is the full
 * ALL_BLOCK_TYPES registry verbatim). Deliberately EXCLUDES "quoteOfDay" — see this file's
 * top-of-file doc comment: its live network outcome is not reproducible here. */
const EXPECTED_PRESENT_BLOCK_TYPES = [
  "shotgun", // active-member ranking (both seeded members are eligible + active)
  "streak", // both members have a routine/chore/assignment matching today's weekday
  "today", // the seeded calendar event, explicitly assigned to both members below
  "meals", // the seeded one-off dinner entry
  "reminders", // the seeded apply-to-all reminder
  "dadJoke",
  "wordOfDay",
  "animalFact",
  "numberFact",
  "trivia",
  "riddle",
  "wouldYouRather",
  "wordSearch",
  "drawingPrompt",
  "streakText", // pure delegate of "streak" — present under the same precondition
];

/** Types this spec expects ABSENT for this fixture set (never generated, never a failed
 * record either — a legitimate "no block" per FR-011's null-omit rule). */
const EXPECTED_ABSENT_BLOCK_TYPES = [
  "weather", // no household weather location configured
  "weatherText", // pure delegate of "weather" — absent under the same precondition
  "birthday", // neither seeded member has a birthDate
  "onThisDay", // ships default-disabled (FR-013) — never enabled by this spec
];

type Member = { id: string; name: string; choreName: string };
type GeneratedBriefing = {
  date: string;
  memberId: string;
  status: string;
  payload: { blocks: Array<{ type: string; status: string; data?: unknown }> };
};

test("admin opt-in -> Generate -> complete ordered catalogue and raster preview (#557)", async ({
  page,
}) => {
  // Timeout: see the file-level `test.describe.configure({ timeout: 120_000 })` above.

  // The managed webServer keeps its e2e DATA_DIR between runs/specs. Keep the
  // members and all source entries unique so an accumulated database cannot
  // make picker/content assertions ambiguous.
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const calendarTitle = `Briefing calendar ${runId}`;
  const reminderText = `Briefing reminder ${runId}`;
  const mealNote = `Briefing meal ${runId}`;
  const dailyMessageText = `Briefing message ${runId}`;
  const firstMember: Member = {
    id: "",
    name: `Daily Briefing first ${runId}`,
    choreName: `Briefing chore first ${runId}`,
  };
  const secondMember: Member = {
    id: "",
    name: `Daily Briefing target ${runId}`,
    choreName: `Briefing chore target ${runId}`,
  };

  // 1) Access gate -> device provisioning.
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

  // Resolve the household timezone from the authenticated app. Generate must
  // retain its real UI contract (only memberId), so cover the server's current
  // household day and the one it can become if midnight passes during this run.
  const settingsResponse = await page.request.get("/api/settings");
  expect(settingsResponse.status()).toBe(200);
  const settings = (await settingsResponse.json()) as {
    locale: { language?: string; timezone: string };
  };
  expect(settings.locale.timezone).not.toBe(DEVICE_TIMEZONE);
  const serverSeedStart = dateInTimezone(new Date(), settings.locale.timezone);
  const serverDateCandidates = [serverSeedStart, addDays(serverSeedStart, 1)];
  const m = messages[resolveLang(settings.locale.language)];

  // 2) Seed two active children to exercise distinct generation targets.
  for (const member of [firstMember, secondMember]) {
    const memberResponse = await page.request.post("/api/members", {
      data: { displayName: member.name, role: "child" },
    });
    expect(memberResponse.status()).toBe(201);
    member.id = ((await memberResponse.json()) as { id: string }).id;
  }

  // 3) Seed every in-scope Daily Briefing source for both server dates that
  // can occur during this e2e: Calendar, Reminders, Chores, and Meals. The
  // actual Generate response below decides which of these real server dates
  // the generated snapshots must use.
  const seededDates = new Map<
    string,
    { calendarTitle: string; reminderText: string; mealNote: string; dailyMessageText: string }
  >();
  for (const date of serverDateCandidates) {
    const content = {
      calendarTitle: `${calendarTitle} ${date}`,
      reminderText: `${reminderText} ${date}`,
      mealNote: `${mealNote} ${date}`,
      dailyMessageText: `${dailyMessageText} ${date}`,
    };
    seededDates.set(date, content);

    const dailyMessageResponse = await page.request.put("/api/daily-messages", {
      data: { memberId: firstMember.id, date, text: content.dailyMessageText },
    });
    expect(dailyMessageResponse.status()).toBe(200);

    const calendarResponse = await page.request.post("/api/calendar/events", {
      data: {
        title: content.calendarTitle,
        allDay: true,
        startDate: date,
        endDate: addDays(date, 1),
      },
    });
    expect(calendarResponse.status()).toBe(201);
    const calendarEventId = ((await calendarResponse.json()) as { id: string }).id;
    // "today" (blocks/today.ts) queries getEvents with `assignedTo: memberId` — stricter
    // than 010's own unfiltered "all events" read — so the event needs an explicit
    // assignment to surface in either member's briefing (finding: an UNassigned event is
    // silently omitted from "today" for every member, a deliberate v2 tightening, not a bug).
    const assignResponse = await page.request.put(
      `/api/calendar/events/${calendarEventId}/assignments`,
      { data: { memberIds: [firstMember.id, secondMember.id] } }
    );
    expect(assignResponse.status()).toBe(200);

    const reminderResponse = await page.request.post("/api/reminders", {
      data: {
        kind: "scheduled",
        targetingMode: "apply_to_all",
        text: content.reminderText,
        weekdays: [weekdayCode(date)],
      },
    });
    expect(reminderResponse.status()).toBe(201);

    const mealResponse = await page.request.post("/api/meal-entries", {
      data: { kind: "oneoff", date, slot: "dinner", note: content.mealNote },
    });
    expect(mealResponse.status()).toBe(201);
  }

  for (const member of [firstMember, secondMember]) {
    const routineResponse = await page.request.post("/api/routines", {
      data: { name: `Briefing routine ${member.name}`, dayPeriodId: "morning" },
    });
    expect(routineResponse.status()).toBe(201);
    const routineId = ((await routineResponse.json()) as { id: string }).id;

    const choreResponse = await page.request.post(`/api/routines/${routineId}/chores`, {
      data: { name: member.choreName },
    });
    expect(choreResponse.status()).toBe(201);

    const assignmentResponse = await page.request.put(
      `/api/routines/${routineId}/assignments/${member.id}`,
      {
        data: { weekdays: serverDateCandidates.map(weekdayCode), active: true },
      }
    );
    expect(assignmentResponse.status()).toBe(200);
  }

  // 4) Admin unlock -> Daily Briefing management. The current admin UI sends
  // only memberId; observe that real request rather than mutating it.

  await unlockAdmin(page, ADMIN_PIN);

  await openAdminSection(page, "admin-nav-daily-briefing-management");
  const management = page.getByTestId("daily-briefing-management");
  await expect(
    management.getByRole("heading", { name: m["admin.sidebar.briefing"], exact: true })
  ).toBeVisible();
  // Schedule is the default tab and the only home of the opt-in.
  await expect(management.getByTestId("daily-briefing-tab-schedule")).toHaveAttribute(
    "aria-selected",
    "true"
  );

  async function optIn(member: Member): Promise<void> {
    await management.getByTestId("daily-briefing-tab-schedule").click();
    const optInResponse = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/daily-briefing/opt-in/${member.id}`) &&
        response.request().method() === "PUT"
    );
    await management.getByTestId(`daily-briefing-opt-in-${member.id}`).click();
    expect((await optInResponse).status()).toBe(200);
  }

  async function generateFor(member: Member): Promise<GeneratedBriefing> {
    await management.getByTestId("daily-briefing-tab-preview").click();
    await management.getByTestId(`daily-briefing-member-pill-${member.id}`).click();
    const generateRequest = page.waitForRequest(
      (request) =>
        request.url().includes("/api/daily-briefing/generate") && request.method() === "POST"
    );
    const generateResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/api/daily-briefing/generate") &&
        response.request().method() === "POST"
    );
    await management.getByTestId("daily-briefing-generate").click();
    expect((await generateRequest).postDataJSON()).toEqual({ memberId: member.id });
    const response = await generateResponse;
    expect(response.status()).toBe(200);
    return (await response.json()) as GeneratedBriefing;
  }

  await optIn(firstMember);
  await optIn(secondMember);
  //: must run AFTER opt-in (both members are seeded fresh above, so opt-in itself cannot
  // be affected) and BEFORE the first generation this test's quoteOfDay assertion depends on.
  clearQuoteOfDayCache();
  let firstBriefing = await generateFor(firstMember);
  const secondBriefing = await generateFor(secondMember);
  // If real household midnight landed between the first two clicks, refresh
  // the first snapshot through the same real UI contract. Both snapshots then
  // represent the server's observed household-today.
  if (firstBriefing.date !== secondBriefing.date) firstBriefing = await generateFor(firstMember);
  expect(firstBriefing.date).toBe(secondBriefing.date);
  const householdToday = secondBriefing.date;
  expect(seededDates.has(householdToday)).toBe(true);
  const householdContent = seededDates.get(householdToday);
  if (!householdContent)
    throw new Error(`Server generated unseeded household date ${householdToday}`);

  function blockOf(briefing: GeneratedBriefing, type: string) {
    return briefing.payload.blocks.find((block) => block.type === type) as
      { type: string; status: string; data?: unknown } | undefined;
  }

  for (const [member, briefing] of [
    [firstMember, firstBriefing],
    [secondMember, secondBriefing],
  ] as const) {
    expect(briefing.memberId).toBe(member.id);
    expect(briefing.date).toBe(householdToday);
    // quoteOfDay performs live egress in this real built-server process (see this file's
    // top-of-file doc comment, finding) — its outcome (ok/failed) is the only thing that
    // can flip overall status between "ready" and "partial" here, so both are accepted.
    expect(["ready", "partial"]).toContain(briefing.status);

    const types = briefing.payload.blocks.map((block) => block.type);
    for (const expectedType of EXPECTED_PRESENT_BLOCK_TYPES) {
      expect(types).toContain(expectedType);
    }
    if (member.id === firstMember.id) {
      expect(types).toContain("message");
      expect(blockOf(briefing, "message")?.data).toEqual({
        text: householdContent.dailyMessageText,
      });
    } else {
      expect(types).not.toContain("message");
    }
    for (const absentType of EXPECTED_ABSENT_BLOCK_TYPES) {
      expect(types).not.toContain(absentType);
    }
    // Every present, non-quoteOfDay block succeeded — the household has no OTHER source of
    // data-layer failure in this fixture set.
    for (const type of types) {
      if (type === "quoteOfDay") continue;
      expect(blockOf(briefing, type)?.status).toBe("ok");
    }

    // Precisely pin the content this e2e's own fixtures actually drive, in the NEW envelope
    // v2 shapes ("Envelope v2") — replaces the 010-era flat-array pins. The
    // managed webServer's DATA_DIR is shared across specs and retries within the run, so
    // "reminders"/"meals"/"shotgun" are HOUSEHOLD-WIDE aggregates that can carry content from
    // another attempt on the SAME calendar day — these assertions check CONTAINMENT of this run's
    // own uniquely-named content, never exact equality of the whole aggregate (only "today"the
    // per-member bullet list and "streak"the per-member board already scope safely on their own).
    expect((blockOf(briefing, "today")?.data as { bullets: string[] }).bullets).toContain(
      truncateBullet(householdContent.calendarTitle)
    );
    const reminders = blockOf(briefing, "reminders")?.data as {
      groups: Array<{ items: Array<{ value: string }> }>;
    };
    expect(
      reminders.groups
        .flatMap((group) => group.items)
        .some((item) => item.value === householdContent.reminderText)
    ).toBe(true);
    const meals = blockOf(briefing, "meals")?.data as {
      dinner?: Array<{ kind: "recipe" | "note"; label: string }>;
    };
    expect(meals.dinner).toBeDefined();
    expect(meals.dinner).toContainEqual({ kind: "note", label: householdContent.mealNote });
    // "streak" (was "chores") no longer exposes chore NAMES at all — it derives a completion
    // summary, never the raw routine/chore rows ("The 21 block types"). Presence
    // + shape is what's left to prove; this is the finding that retires this spec's original
    // per-member choreName differentiation technique (see the top-of-file doc comment).
    const streak = blockOf(briefing, "streak")?.data as {
      days: number;
      label: string;
      last7: boolean[];
    };
    expect(typeof streak.days).toBe("number");
    expect(typeof streak.label).toBe("string");
    expect(Array.isArray(streak.last7)).toBe(true);
    // "shotgun" is SHARED-scope, HOUSEHOLD-WIDE (every active member, capped at 4) — with the
    // DATA_DIR persisting across runs, this spec's own two members are not guaranteed to be
    // among the top 4 of an accumulated household, so only the STRUCTURAL shape is checked.
    const shotgun = blockOf(briefing, "shotgun")?.data as { ranking: string[] };
    expect(shotgun.ranking.length).toBeGreaterThan(0);
    expect(shotgun.ranking.length).toBeLessThanOrEqual(4);
    expect(shotgun.ranking.every((name) => typeof name === "string" && name.length > 0)).toBe(true);
    //: the managed webServer now points QUOTE_ENDPOINT at a deterministic e2e fixture
    // (tests/e2e/quote-onthisday-fixture-server.ts), so — unlike every other quoteOfDay
    // tolerance this spec still keeps above (finding, top-of-file doc comment) — the exact
    // text/author this fixture serves can now be pinned.
    const quoteOfDay = blockOf(briefing, "quoteOfDay")?.data as
      { text: string; author: string } | undefined;
    expect(quoteOfDay).toEqual({ text: FIXTURE_QUOTE_TEXT, author: FIXTURE_QUOTE_AUTHOR });
  }

  // Keep the ordered-catalogue assertion at the administration generation boundary.
  expect(
    secondBriefing.payload.blocks.map((block) => block.type).filter((type) => type !== "quoteOfDay")
  ).toEqual(EXPECTED_PRESENT_BLOCK_TYPES);
  expect(
    firstBriefing.payload.blocks.map((block) => block.type).filter((type) => type !== "quoteOfDay")
  ).toEqual([EXPECTED_PRESENT_BLOCK_TYPES[0], "message", ...EXPECTED_PRESENT_BLOCK_TYPES.slice(1)]);

  // Preview remains an administration capability after the family route is retired.
  // Selecting a member loads the page date (today here); there is no Show button any more.
  await management.getByTestId(`daily-briefing-member-pill-${firstMember.id}`).click();
  const previewResponse = page.waitForResponse((response) =>
    response.url().includes(`/api/daily-briefing/${secondMember.id}/${householdToday}/preview.png`)
  );
  await management.getByTestId(`daily-briefing-member-pill-${secondMember.id}`).click();
  await management.getByTestId("daily-briefing-admin-preview-date").fill(householdToday);
  expect((await previewResponse).status()).toBe(200);
  const preview = management.getByTestId("daily-briefing-admin-preview-image");
  await expect(preview).toBeVisible();
  await expect
    .poll(() =>
      preview.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)
    )
    .toBe(true);

  // History lists the briefing just generated for the selected member.
  await expect(
    management.getByTestId(`daily-briefing-history-entry-${householdToday}`)
  ).toBeVisible();

  // Pause today's weekday for secondMember: a regenerate is skipped, then resume.
  const todayCode = weekdayCode(householdToday);
  async function toggleToday(): Promise<void> {
    await management.getByTestId("daily-briefing-tab-blocks").click();
    await management.getByTestId(`daily-briefing-member-pill-${secondMember.id}`).click();
    const scheduleResponse = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/daily-briefing/schedule/${secondMember.id}`) &&
        response.request().method() === "PUT"
    );
    await management.getByTestId(`daily-briefing-schedule-day-${todayCode}`).click();
    expect((await scheduleResponse).status()).toBe(200);
  }
  await toggleToday();
  await expect(management.getByTestId("daily-briefing-settings-changed")).toBeVisible();
  await management.getByTestId("daily-briefing-tab-preview").click();
  await management.getByTestId(`daily-briefing-member-pill-${secondMember.id}`).click();
  const skippedResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/api/daily-briefing/generate") &&
      response.request().method() === "POST"
  );
  await management.getByTestId("daily-briefing-generate").click();
  expect(await (await skippedResponse).json()).toMatchObject({ skipped: true, reason: "paused" });
  await expect(management.getByTestId("daily-briefing-paused-notice")).toBeVisible();
  await management.getByTestId("daily-briefing-paused-open-blocks").click();
  await expect(management.getByTestId("daily-briefing-tab-blocks")).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await toggleToday(); // resume, so later specs sharing the data dir are unaffected
});

test("admin briefing tabs: opt-in gate, matrix cell, keyboard reorder and Generate briefings for a date", async ({
  page,
}) => {
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const childA = { id: "", name: `Briefing tabs A ${runId}` };
  const childB = { id: "", name: `Briefing tabs B ${runId}` };

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

  const settingsResponse = await page.request.get("/api/settings");
  expect(settingsResponse.status()).toBe(200);
  const settings = (await settingsResponse.json()) as {
    locale: { language?: string; timezone: string };
  };
  const m = messages[resolveLang(settings.locale.language)];
  const pastDate = addDays(dateInTimezone(new Date(), settings.locale.timezone), -7);

  // Two fresh children, neither opted in.
  for (const member of [childA, childB]) {
    const memberResponse = await page.request.post("/api/members", {
      data: { displayName: member.name, role: "child" },
    });
    expect(memberResponse.status()).toBe(201);
    member.id = ((await memberResponse.json()) as { id: string }).id;
  }

  await unlockAdmin(page, ADMIN_PIN);
  await openAdminSection(page, "admin-nav-daily-briefing-management");
  const management = page.getByTestId("daily-briefing-management");

  // 1) Schedule is the default tab; opted-out members show no days.
  await expect(management.getByTestId("daily-briefing-tab-schedule")).toHaveAttribute(
    "aria-selected",
    "true"
  );
  for (const member of [childA, childB]) {
    await expect(management.getByTestId(`daily-briefing-member-days-${member.id}`)).toHaveText("—");
  }

  // 2) Blocks: an opted-out member is gated until turned on.
  await management.getByTestId("daily-briefing-tab-blocks").click();
  await management.getByTestId(`daily-briefing-member-pill-${childA.id}`).click();
  await expect(management.getByTestId("daily-briefing-opted-out")).toBeVisible();
  await expect(management.getByTestId("daily-briefing-block-matrix")).toHaveCount(0);
  const turnOnResponse = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/daily-briefing/opt-in/${childA.id}`) &&
      response.request().method() === "PUT"
  );
  await management.getByTestId("daily-briefing-turn-on").click();
  expect((await turnOnResponse).status()).toBe(200);
  await expect(management.getByTestId("daily-briefing-block-matrix")).toBeVisible();

  // 3) One cell is the only on/off for a block on a day.
  const dadJokeMonday = management.getByTestId("daily-briefing-block-cell-dadJoke-mon");
  await expect(dadJokeMonday).toBeChecked();
  const cellResponse = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/daily-briefing/block-settings/${childA.id}/dadJoke`) &&
      response.request().method() === "PUT"
  );
  await dadJokeMonday.click();
  expect((await cellResponse).status()).toBe(200);
  await expect(dadJokeMonday).not.toBeChecked();
  await expect(management.getByTestId("daily-briefing-settings-changed")).toBeVisible();

  // 4) Keyboard reorder of the household order. `weather` never prints in this fixture set (no
  // location), so moving it leaves the order other tests in this file assert unchanged.
  const rowIds = () =>
    management
      .getByTestId(/^daily-briefing-admin-block-settings-row-/)
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-testid") ?? ""));
  const before = await rowIds();
  const weatherIndex = before.indexOf("daily-briefing-admin-block-settings-row-weather");
  expect(weatherIndex).toBeGreaterThan(0);
  const predecessor = before[weatherIndex - 1];
  // dnd-kit announces every step in its live region. Waiting on the announcement (rather than a
  // sleep) also covers the case where the sensor first scrolls the page to reach the target row.
  const liveRegion = page.locator('[id^="DndLiveRegion"]');
  const movedTo = (position: number) =>
    m["dailyBriefing.admin.dragOver"]
      .replace("{block}", m["dailyBriefing.admin.blockType.weather"])
      .replace("{position}", String(position));
  async function moveWeather(
    key: "ArrowUp" | "ArrowDown",
    from: number,
    to: number
  ): Promise<void> {
    const orderResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/api/daily-briefing/block-order") &&
        response.request().method() === "PUT"
    );
    const handle = management.getByTestId("daily-briefing-admin-block-drag-weather");
    await expect(handle).toBeEnabled();
    await handle.focus();
    await page.keyboard.press("Space");
    await expect(liveRegion).toHaveText(movedTo(from));
    await page.keyboard.press(key);
    await expect(liveRegion).toHaveText(movedTo(to));
    await page.keyboard.press("Space");
    expect((await orderResponse).status()).toBe(200);
  }
  await moveWeather("ArrowUp", weatherIndex + 1, weatherIndex);
  await expect
    .poll(async () => (await rowIds()).slice(weatherIndex - 1, weatherIndex + 1))
    .toEqual(["daily-briefing-admin-block-settings-row-weather", predecessor]);
  await moveWeather("ArrowDown", weatherIndex, weatherIndex + 1); // restore the household order
  await expect.poll(rowIds).toEqual(before);

  // 5) Generate briefings for a past date from Schedule.
  await management.getByTestId("daily-briefing-tab-schedule").click();
  await management.getByTestId("daily-briefing-generate-date").fill(pastDate);
  const generateAllRequest = page.waitForRequest(
    (request) =>
      request.url().includes("/api/daily-briefing/generate-all") && request.method() === "POST"
  );
  const generateAllResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/api/daily-briefing/generate-all") &&
      response.request().method() === "POST"
  );
  await management.getByTestId("daily-briefing-generate-all").click();
  expect((await generateAllRequest).postDataJSON()).toEqual({ date: pastDate });
  expect((await generateAllResponse).status()).toBe(200);
  await expect(management.getByTestId(`daily-briefing-member-status-${childA.id}`)).toHaveText(
    new RegExp(`^(${m["dailyBriefing.status.ready"]}|${m["dailyBriefing.status.partial"]})$`)
  );
  await expect(management.getByTestId(`daily-briefing-member-status-${childB.id}`)).toHaveText("—");

  // 6) The row shortcut opens that member's briefing for the same date.
  await management.getByTestId(`daily-briefing-open-briefings-${childA.id}`).click();
  await expect(management.getByTestId("daily-briefing-tab-preview")).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(management.getByTestId(`daily-briefing-history-entry-${pastDate}`)).toBeVisible();

  // 7) Leave the shared data dir as other specs expect it.
  const optOutResponse = await page.request.put(`/api/daily-briefing/opt-in/${childA.id}`, {
    data: { enabled: false },
  });
  expect(optOutResponse.status()).toBe(200);
});

/** (docs/features/daily-briefing.md Phase 7, FR-017) — the trigger -> print e2e
 * proof. The task text calls for a "NEW" file, but this one already exists (the runnable
 * skeleton above) — this is an EXTENSION, a second, independent test in the same file, not a
 * new file. Nothing above this comment (the own test) is touched beyond the doc-comment note
 * on finding.
 * Model: tests/e2e/printing.spec.ts (018) for the `__mpPrintTransport` fake + the real
 * claim -> payload -> transmit -> ack pipeline; tests/e2e/chores-board.spec.ts (005) for
 * driving chore completion through the REAL kiosk `/chores` UI (`chore-toggle-*`) rather than a
 * direct API/DB write — the whole point is proving the LEVEL-TRIGGERED predicate fires from real
 * user action, not from calling `evaluateAutoPrintTrigger` directly.
 * Scope — what this proves, end to end, against the REAL server:
 * 1. Completing a member's LAST morning chore through the real `/chores` UI is what fires the
 * auto-print trigger (`trigger.ts`'s `routines.completion_changed` wakeup subscription) —
 * a print job for `daily-briefing:<memberId>` is enqueued.
 * 2. The job actually prints through the fake transport (claim -> payload -> transmit -> ack,
 * the same pipeline printing.spec.ts exercises), and the admin Printing panel shows it
 * printed.
 * 3. Level-triggered, not edge-triggered: with the day already complete and printed, an
 * uncomplete/complete cycle on the SAME chore does not enqueue a second job (018's
 * `print_records` printed-and-not-superseded dedup, `enqueuePrintJob` in
 * `modules/printing/index.ts`) — proven by re-firing a REAL predicate evaluation, not
 * merely by nobody calling enqueue again.
 * 4. The opt-in gate, isolated from every OTHER gate: a SECOND member (`optOutMember`) is
 * opted IN and given a generated raster (so gate the raster-exists check is satisfied),
 * then opted back OUT — with the trigger already globally bound (gate) — before
 * completing their morning. Only gate (opt-in) is false at that instant, and NOTHING is
 * enqueued — a mutation that deletes the opt-in check would pass this (raster + binding
 * alone are not enough), unlike an unopted member with no raster, which gate alone would
 * already block regardless of gate.
 * 5. Admin regenerate re-enqueues: clicking "Generate" again for the first member (the SAME
 * button — there is no separate "Regenerate" affordance; `generateBriefing`'s own doc
 * comment in `modules/daily-briefing/index.ts` confirms every call unconditionally
 * supersedes the prior print record) bumps the print record's generation and clears the
 * "already printed" gate. Regeneration itself does NOT re-evaluate the trigger ("No print
 * job is ever enqueued here... the next trigger sweep or admin action re-enqueues" — that
 * same doc comment) — a fresh wakeup (another uncomplete/complete cycle) is what drives the
 * actual re-enqueue, of a genuinely NEW job, which also prints.
 * Poll/sweep seam actually used (trap-sweep.md's row assumed a shortened SWEEP interval
 * would be needed, mirroring the executor's `VITE_E2E_PRINT_POLL_MS` seam — verified NOT the
 * case by reading `trigger.ts` before writing this): `registerAutoPrintTrigger` wires THREE
 * wakeup paths, but only ONE is reachable here without a real wall-clock wait — the
 * `routines.completion_changed` subscription, which fires UNCONDITIONALLY, independent of
 * `scheduler.start`/`SCHEDULER_DISABLED` (only the periodic sweep and the startup catch-up arm
 * through the scheduler, gated on `lifecycle === "started"`, which Playwright's shared
 * `webServer` never reaches — `SCHEDULER_DISABLED=1`, `playwright.config.ts`). So every enqueue
 * in this spec is driven by that wakeup hint, fired by a real `completeChore`/`uncompleteChore`
 * call through the `/chores` UI — no sweep-interval env var needed, and none was added. The
 * print DELIVERY side (claim/transmit/ack) still uses the existing `VITE_E2E_PRINT_POLL_MS=500`
 * seam (`playwright.config.ts`'s shared `webServer`), identical to printing.spec.ts.
 * CONCURRENCY CONSTRAINT: this test and printing.spec.ts are now the
 * ONLY TWO e2e specs that pair a real print executor, and `claimJob`
 * (src/server/modules/printing/index.ts) claims the OLDEST pending job for household-today
 * ACROSS ALL record keys — it is not scoped by session or producer, so two paired executors
 * against the SAME server can steal each other's jobs (reproduced: printing.spec.ts failed 4/4
 * when run alongside this test before this fixture existed). The two must therefore never run
 * concurrently — enforced, not just documented, by the `printerSession` fixture (a filesystem
 * mutex; see `./printer-session`'s own doc comment), which this test destructures below.
 * Synchronization note (no arbitrary sleeps): `emit` (`src/server/lib/event-bus.ts`) queues
 * the trigger's handler via `queueMicrotask` INSIDE the same synchronous call that produces the
 * chore-completion HTTP response — Node drains all microtasks before servicing the next network
 * event, so by the time this spec's NEXT request reaches the server, `evaluateAutoPrintTrigger`
 * has already run to completion for that wakeup. Absence assertions (item 4, and the dedup half
 * of item 3) rely on exactly this ordering guarantee, not a race; presence assertions still use
 * `expect.poll` (`waitForPrinted` below) because the print DELIVERY side genuinely is
 * asynchronous (the executor's poll cadence).
 * TIMEOUT: declared via the file-level `test.describe.configure({
 * timeout: 120_000 })` above, not an in-body `test.setTimeout(...)` — the `printerSession`
 * fixture's lock wait runs BEFORE this test's body, so an in-body call could never extend the
 * budget in time to cover it. See `./printer-session`'s own "TIMEOUT ORDERING" doc comment.
 * DATE CONSISTENCY: a household-midnight rollover between seeding the
 * routine assignment and actually completing the chore (steps 2 vs. 7/8/11/12) would otherwise
 * make this test self-inconsistent — the chore assigned to "today's" weekday would no longer be
 * markable, 400ing the completion, once the real day rolls over mid-run. Fixed structurally,
 * mirroring the file's own test's `serverDateCandidates` convention: the routine assignment
 * covers BOTH the current household date's weekday and the one it can become
 * (`serverWeekdayCandidates`), and the raster-generating admin actions are ordered as the LAST
 * setup step before any chore is touched, minimizing the (separate) window in which a stale
 * raster — rather than a stale weekday assignment — could make the trigger's gate false when
 * it should be true.
 * State hygiene: every member/routine/chore is unique-per-run (this file's own `runId`
 * precedent) and every print job/record this spec creates is keyed off one of those fresh
 * member ids, so nothing here can collide with another spec or retry in the shared run database.
 * The ONE genuinely global piece of state this spec writes is the `daily_briefing_settings`
 * singleton's
 * `auto_print_trigger` binding (there is exactly one such row, household-wide) — it defaults to
 * unbound (`null`) on a fresh DB, and no other e2e spec touches it (verified by grep across
 * tests/e2e/ before writing this). The `resetDailyBriefingTrigger` fixture (defined at the top
 * of this file) restores it to `null` after this test in FIXTURE teardown, not an in-body
 * `try/finally` — a reviewer-forced timeout proved the original `finally` never ran (Playwright
 * abandons a timed-out test body mid-`await`), so this is now robust to that failure mode too,
 * not just to an assertion failure.
 */
const DAILY_BRIEFING_RECORD_PREFIX = "daily-briefing";

interface TriggerMember {
  id: string;
  choreId: string;
  name: string;
  choreName: string;
}

interface PrintJobDto {
  id: string;
  recordKey: string;
  derivedState: string;
}

async function fetchJobsByRecordKey(
  request: APIRequestContext,
  recordKey: string
): Promise<PrintJobDto[]> {
  const res = await request.get("/api/printing/jobs");
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { jobs: PrintJobDto[] };
  return body.jobs.filter((job) => job.recordKey === recordKey);
}

/** Polls the REAL API's `derivedState` (never the admin-panel DOM, which doesn't auto-refresh —
 * printing.spec.ts's own precedent) until the executor's claim/transmit/ack cycle lands. */
async function waitForPrinted(request: APIRequestContext, jobId: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const res = await request.get("/api/printing/jobs");
        expect(res.status()).toBe(200);
        const body = (await res.json()) as { jobs: PrintJobDto[] };
        return body.jobs.find((job) => job.id === jobId)?.derivedState;
      },
      { timeout: 15_000, intervals: [100] }
    )
    .toBe("printed");
}

test(": morning chores done through the real UI auto-prints the daily briefing; level-triggered dedup; opt-in gate; admin regenerate re-enqueues", async ({
  page,
  printerSession,
  resetDailyBriefingTrigger,
}) => {
  // Timeout: see the file-level `test.describe.configure({ timeout: 120_000 })` above — this is
  // the test whose fixture setup (the `printerSession` lock wait) the is
  // actually about; an in-body call here would have been unreachable exactly when it mattered.

  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const boundMember: TriggerMember = {
    id: "",
    choreId: "",
    name: `Briefing trigger bound ${runId}`,
    choreName: `Trigger chore bound ${runId}`,
  };
  const optOutMember: TriggerMember = {
    id: "",
    choreId: "",
    name: `Briefing trigger optout ${runId}`,
    choreName: `Trigger chore optout ${runId}`,
  };

  // 1) Access gate -> device provisioning (this file's own precedent).
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

  const settingsResponse = await page.request.get("/api/settings");
  expect(settingsResponse.status()).toBe(200);
  const settings = (await settingsResponse.json()) as {
    locale: { language?: string; timezone: string };
  };
  const m = messages[resolveLang(settings.locale.language)];
  const showMorningChores = async (...members: TriggerMember[]) => {
    await expect(page.getByText(m["chores.board.loading"])).toHaveCount(0, { timeout: 15_000 });
    for (const member of members) {
      const column = page.getByTestId(`chores-board-column-${member.id}`);
      await expect(column).toBeVisible();
      const activePeriod = column.getByTestId("today-chores-active-period");
      for (
        let remainingEarlierPeriods = 3;
        remainingEarlierPeriods > 0;
        remainingEarlierPeriods--
      ) {
        const currentPeriod = await activePeriod.getAttribute("data-period-id");
        if (currentPeriod === "morning") break;
        await column.getByRole("button", { name: m["todayChores.previousPeriod"] }).click();
        await expect(activePeriod).not.toHaveAttribute("data-period-id", currentPeriod ?? "");
      }
      await expect(activePeriod).toHaveAttribute("data-period-id", "morning");
    }
  };
  //: the file's own test (above) already established the
  // convention for this class of bug — capture the CURRENT household date once, but also cover
  // the date it can become if midnight passes during the run (`serverDateCandidates`), rather
  // than pinning everything to a single snapshot that a real wall clock can silently invalidate.
  // has no per-member "which date did Generate actually use" reconciliation to lean on the
  // way does (detects a mismatch across TWO members' Generate calls and re-generates;
  // the chore-completion/trigger path has no equivalent single call to compare), so the fix
  // here is structural instead: assign the routine to BOTH candidate weekdays, so a chore stays
  // markable (`isCurrentlyScheduled`, modules/routines/index.ts) across a single midnight
  // rollover no matter which of the two calendar days the actual completion below lands on — a
  // stale, today-only assignment is exactly what previously made the chore vanish / the
  // completion 400 / the trigger find nothing scheduled when the clock rolled over mid-test.
  const serverSeedStart = dateInTimezone(new Date(), settings.locale.timezone);
  const serverDateCandidates = [serverSeedStart, addDays(serverSeedStart, 1)];
  const serverWeekdayCandidates = serverDateCandidates.map(weekdayCode);

  // 2) Seed two active children, each with their OWN morning routine + single chore, assigned
  // for BOTH candidate weekdays (chores-board.spec.ts's own seeding technique, extended per
  // the note above). `boundMember` stays opted in throughout; `optOutMember` is opted
  // in just long enough to get a raster, then opted back OUT below (gate isolation proof,
  // item 4).
  for (const member of [boundMember, optOutMember]) {
    const memberResp = await page.request.post("/api/members", {
      data: { displayName: member.name, role: "child" },
    });
    expect(memberResp.status()).toBe(201);
    member.id = ((await memberResp.json()) as { id: string }).id;

    const routineResp = await page.request.post("/api/routines", {
      data: { name: `Trigger routine ${member.name}`, dayPeriodId: "morning" },
    });
    expect(routineResp.status()).toBe(201);
    const routineId = ((await routineResp.json()) as { id: string }).id;

    const choreResp = await page.request.post(`/api/routines/${routineId}/chores`, {
      data: { name: member.choreName },
    });
    expect(choreResp.status()).toBe(201);
    member.choreId = ((await choreResp.json()) as { id: string }).id;

    const assignResp = await page.request.put(
      `/api/routines/${routineId}/assignments/${member.id}`,
      { data: { weekdays: serverWeekdayCandidates, active: true } }
    );
    expect(assignResp.status()).toBe(200);
  }

  // 3) Load the real kiosk `/chores` board — a fresh navigation, so the members seeded above
  // (created before this navigation) render immediately, no reload needed.
  await page.goto("/chores");
  await expect(page.getByRole("heading", { name: m["chores.board.title"] })).toBeVisible();
  await expect(page.getByText(m["chores.board.loading"])).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId(`chores-board-column-${boundMember.id}`)).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByTestId(`chores-board-column-${optOutMember.id}`)).toBeVisible();

  // 4) Admin unlock enters the protected subtree before the existing long-press/PIN flow.
  await unlockAdmin(page, ADMIN_PIN);

  // 5) Pair through the compact shared-session presentation (printing.spec.ts's precedent).
  // The same-document admin transition above preserves both the session and transport hook.
  const attentionPill = page.getByTestId("printer-attention-pill");
  await expect(attentionPill).toBeVisible();
  const hookPresent = await page.evaluate(() => typeof window.__mpPrintTransport !== "undefined");
  expect(hookPresent).toBe(true);
  await attentionPill.click();
  const attentionState = page.getByTestId("printer-attention-state");
  await expect(attentionState).toHaveText(m["printing.executor.state.unpaired"]);
  await page.getByTestId("printer-attention-pair").click();
  await expect(attentionState).toHaveText(m["printing.executor.state.paired"], {
    timeout: 10_000,
  });
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("printer-attention-dialog")).toHaveCount(0);

  // 6) Daily Briefing management: opt IN both members; bind the auto-print trigger globally
  // (gate, no raster dependency) — all inside ONE mount of this panel. The GENERATE calls
  // (which write the printable raster gate requires) are deliberately pushed to the END of
  // this panel's setup (steps 6b/6c below), not done here —, this
  // minimizes the real-wall-clock gap between "raster written for household-today" and the
  // chore completions in step 7/8 that depend on that exact day's raster still being current.
  await openAdminSection(page, "admin-nav-daily-briefing-management");
  const management = page.getByTestId("daily-briefing-management");
  await expect(
    management.getByRole("heading", { name: m["admin.sidebar.briefing"], exact: true })
  ).toBeVisible();
  // Idempotent: checks the binding regardless of whatever state a previously-interrupted run
  // left it in (this spec's own teardown restores it to unbound, but defends against a crash
  // that skipped teardown rather than assuming a clean precondition).
  // Save is enabled only when a value changed, so an already-bound trigger needs no write.
  const triggerBinding = management.getByTestId("daily-briefing-admin-trigger-binding");
  if (!(await triggerBinding.isChecked())) {
    const settingsSaveResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/api/daily-briefing/settings") &&
        response.request().method() === "PUT"
    );
    await triggerBinding.check();
    await management.getByTestId("daily-briefing-admin-settings-save").click();
    expect((await settingsSaveResponse).status()).toBe(200);
  }
  await expect(triggerBinding).toBeChecked();

  // Opt-in lives on the default Schedule tab.
  const optInResponse = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/daily-briefing/opt-in/${boundMember.id}`) &&
      response.request().method() === "PUT"
  );
  await management.getByTestId(`daily-briefing-opt-in-${boundMember.id}`).click();
  expect((await optInResponse).status()).toBe(200);

  // Item 4 setup: optOutMember is opted IN here too — long enough to
  // get a raster below (gate satisfied), then opted back OUT before step 7. This isolates
  // gate (opt-in) as the ONLY false gate at the moment their morning completes: a mutation
  // that deletes the opt-in check would still enqueue for them (raster + binding alone are
  // enough), so this actually kills that mutant, unlike testing against a member with no raster
  // at all (gate would block them regardless of gate, proving nothing about gate
  // specifically).
  const optOutOptInResponse = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/daily-briefing/opt-in/${optOutMember.id}`) &&
      response.request().method() === "PUT"
  );
  await management.getByTestId(`daily-briefing-opt-in-${optOutMember.id}`).click();
  expect((await optOutOptInResponse).status()).toBe(200);

  // 6b) Generate optOutMember's raster, then immediately opt them back OUT (the isolation —
  // see above).
  await management.getByTestId("daily-briefing-tab-preview").click();
  await management.getByTestId(`daily-briefing-member-pill-${optOutMember.id}`).click();
  const optOutGenerateResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/api/daily-briefing/generate") &&
      response.request().method() === "POST"
  );
  await management.getByTestId("daily-briefing-generate").click();
  expect((await optOutGenerateResponse).status()).toBe(200);

  await management.getByTestId("daily-briefing-tab-schedule").click();
  const optOutOptOutResponse = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/daily-briefing/opt-in/${optOutMember.id}`) &&
      response.request().method() === "PUT"
  );
  await management.getByTestId(`daily-briefing-opt-in-${optOutMember.id}`).click();
  expect((await optOutOptOutResponse).status()).toBe(200);

  // 6c) Generate boundMember's raster LAST — this is the freshest possible moment before step 7/8
  // fire the real trigger off boundMember's morning completion.
  await management.getByTestId("daily-briefing-tab-preview").click();
  await management.getByTestId(`daily-briefing-member-pill-${boundMember.id}`).click();
  const generateResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/api/daily-briefing/generate") &&
      response.request().method() === "POST"
  );
  await management.getByTestId("daily-briefing-generate").click();
  expect((await generateResponse).status()).toBe(200);

  // Authoring is complete. Return through the persistent family navigation to exercise the real
  // Tasks surface; leaving /admin/* deliberately relocks administration but keeps the global
  // printer session mounted.
  await leaveAdmin(page);
  await page.getByRole("link", { name: m["shell.nav.tasks"], exact: true }).click();
  await expect(page.getByRole("heading", { name: m["chores.board.title"] })).toBeVisible();

  // The board opens each member on the household's current day period. The trigger fixtures
  // intentionally belong to `morning`, so navigate each run-local column there explicitly
  // instead of assuming the wall clock happens to be inside the morning period.
  await showMorningChores(boundMember, optOutMember);

  // 7) Gate (opt-in) in isolation: complete optOutMember's ONLY morning chore through the
  // real board. The wakeup event fires and re-evaluates EVERY opted-in member, but
  // optOutMember is filtered out before the per-member predicate ever runs (gates / are
  // both satisfied for them per step 6b — only gate is false), and boundMember's own chore
  // is still untouched -> NOTHING is enqueued for either recordKey (item 4).
  const optOutToggle = page.getByTestId(`chore-toggle-${optOutMember.choreId}`);
  await expect(optOutToggle).toHaveAttribute("aria-pressed", "false");
  const optOutCompleteResp = page.waitForResponse(
    (r) =>
      r.url().includes(`/api/chores/${optOutMember.choreId}/completions`) &&
      r.request().method() === "POST"
  );
  await optOutToggle.click();
  expect((await optOutCompleteResp).status()).toBe(204);
  await expect(optOutToggle).toHaveAttribute("aria-pressed", "true");

  expect(
    await fetchJobsByRecordKey(page.request, `${DAILY_BRIEFING_RECORD_PREFIX}:${optOutMember.id}`)
  ).toHaveLength(0);
  const boundRecordKey = `${DAILY_BRIEFING_RECORD_PREFIX}:${boundMember.id}`;
  expect(await fetchJobsByRecordKey(page.request, boundRecordKey)).toHaveLength(0);

  // 8) Item 1 — the real trigger: complete boundMember's ONLY morning chore. Every FR-018 gate
  // now passes (binding bound, opted in, Printing plugin active, raster exists) -> exactly
  // ONE job is enqueued for `daily-briefing:<boundMember.id>`.
  const boundToggle = page.getByTestId(`chore-toggle-${boundMember.choreId}`);
  await expect(boundToggle).toHaveAttribute("aria-pressed", "false");
  const boundCompleteResp = page.waitForResponse(
    (r) =>
      r.url().includes(`/api/chores/${boundMember.choreId}/completions`) &&
      r.request().method() === "POST"
  );
  await boundToggle.click();
  expect((await boundCompleteResp).status()).toBe(204);
  await expect(boundToggle).toHaveAttribute("aria-pressed", "true");

  const firstJobs = await fetchJobsByRecordKey(page.request, boundRecordKey);
  expect(firstJobs).toHaveLength(1);
  const firstJobId = firstJobs[0].id;

  // 9) Item 2 — it actually prints, through the SAME fake-transport pipeline printing.spec.ts
  // exercises (claim -> payload -> transmit -> ack), on the executor's
  // `VITE_E2E_PRINT_POLL_MS=500` cadence (no sweep interval involved — see this test's own
  // doc comment above).
  await waitForPrinted(page.request, firstJobId);

  // 10) The admin Printing panel (a DIFFERENT admin surface) shows it printed — force a fresh
  // mount, exactly like printing.spec.ts's `reopenPrintingPanel`, since `loadJobs` only
  // runs on mount.
  await unlockAdmin(page, ADMIN_PIN);
  await openAdminSection(page, "admin-nav-members-management");
  await openAdminSection(page, "admin-nav-printing");
  await expect(page.getByTestId("printing-management")).toBeVisible();
  await page.getByTestId("printing-tab-diagnostics").click();
  await expect(page.getByTestId(`printing-job-state-${firstJobId}`)).toHaveText(
    m["printing.management.state.printed"]
  );

  // 11) Item 3 — level-triggered, not edge-triggered: an uncomplete/complete cycle on the SAME
  // already-printed chore must NOT enqueue a second job.
  // (FR-008/DP2): un-completing is now gated behind a ConfirmDialog — the
  // tap opens it rather than firing the DELETE immediately.
  await leaveAdmin(page);
  await page.getByRole("link", { name: m["shell.nav.tasks"], exact: true }).click();
  await showMorningChores(boundMember);
  await expect(boundToggle).toHaveAttribute("aria-pressed", "true");
  await boundToggle.click();
  const boundUncompleteResp = page.waitForResponse(
    (r) =>
      r.url().includes(`/api/chores/${boundMember.choreId}/completions`) &&
      r.request().method() === "DELETE"
  );
  await page.getByTestId("chores-uncomplete-confirm").click();
  expect((await boundUncompleteResp).status()).toBe(204);
  await expect(boundToggle).toHaveAttribute("aria-pressed", "false");

  const boundRecompleteResp = page.waitForResponse(
    (r) =>
      r.url().includes(`/api/chores/${boundMember.choreId}/completions`) &&
      r.request().method() === "POST"
  );
  await boundToggle.click();
  expect((await boundRecompleteResp).status()).toBe(204);
  await expect(boundToggle).toHaveAttribute("aria-pressed", "true");

  const jobsAfterToggle = await fetchJobsByRecordKey(page.request, boundRecordKey);
  expect(jobsAfterToggle.map((job) => job.id)).toEqual([firstJobId]);

  // 12) Item 5 — admin regenerate re-enqueues. There is no separate "Regenerate" affordance:
  // clicking "Generate" again for an already-generated member IS the regenerate path. This
  // panel switch remounts DailyBriefingManagement (AdminContent's ternary chain fully
  // unmounts the previous panel), so the member has to be reselected from the dropdown.
  await unlockAdmin(page, ADMIN_PIN);
  await openAdminSection(page, "admin-nav-members-management");
  await openAdminSection(page, "admin-nav-daily-briefing-management");
  const managementAgain = page.getByTestId("daily-briefing-management");
  await managementAgain.getByTestId("daily-briefing-tab-preview").click();
  await managementAgain.getByTestId(`daily-briefing-member-pill-${boundMember.id}`).click();
  const regenerateResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/api/daily-briefing/generate") &&
      response.request().method() === "POST"
  );
  await managementAgain.getByTestId("daily-briefing-generate").click();
  expect((await regenerateResponse).status()).toBe(200);

  // Regeneration itself enqueues nothing (`modules/daily-briefing/index.ts`'s own doc comment)
  // — a fresh wakeup is what drives the actual re-enqueue.
  // (FR-008/DP2): un-completing opens the ConfirmDialog rather than firing the
  // DELETE immediately.
  await leaveAdmin(page);
  await page.getByRole("link", { name: m["shell.nav.tasks"], exact: true }).click();
  await showMorningChores(boundMember);
  await expect(boundToggle).toHaveAttribute("aria-pressed", "true");
  await boundToggle.click();
  const regenUncompleteResp = page.waitForResponse(
    (r) =>
      r.url().includes(`/api/chores/${boundMember.choreId}/completions`) &&
      r.request().method() === "DELETE"
  );
  await page.getByTestId("chores-uncomplete-confirm").click();
  expect((await regenUncompleteResp).status()).toBe(204);
  const regenCompleteResp = page.waitForResponse(
    (r) =>
      r.url().includes(`/api/chores/${boundMember.choreId}/completions`) &&
      r.request().method() === "POST"
  );
  await boundToggle.click();
  expect((await regenCompleteResp).status()).toBe(204);

  const jobsAfterRegen = await fetchJobsByRecordKey(page.request, boundRecordKey);
  expect(jobsAfterRegen).toHaveLength(2);
  const secondJobId = jobsAfterRegen.find((job) => job.id !== firstJobId)?.id;
  if (!secondJobId) throw new Error("regenerate did not enqueue a fresh job");

  // The regenerated job also actually prints, through the same fake-transport pipeline.
  await waitForPrinted(page.request, secondJobId);

  await unlockAdmin(page, ADMIN_PIN);
  await openAdminSection(page, "admin-nav-members-management");
  await openAdminSection(page, "admin-nav-printing");
  await expect(page.getByTestId("printing-management")).toBeVisible();
  await page.getByTestId("printing-tab-diagnostics").click();
  await expect(page.getByTestId(`printing-job-state-${secondJobId}`)).toHaveText(
    m["printing.management.state.printed"]
  );
});
