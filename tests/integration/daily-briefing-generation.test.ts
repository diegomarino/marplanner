import { afterEach, describe, expect, it, vi } from "vitest";
import { PNG } from "pngjs";
import { __setForecastPortForTests } from "../../src/server/modules/weather/port";
import {
  createDailyBlockCache,
  evictWeatherCache,
} from "../../src/server/modules/daily-briefing/external/shared-cache";
import { getDb } from "../../src/server/db/client";
import { RASTER_WIDTH_DOTS } from "../../src/server/modules/daily-briefing/render/raster";

/** Hoisted override seam for the render-layer-isolation tests below (mirrors
 * `tests/boundary/daily-briefing-render-probe.test.ts`'s identical shape) — MUST live at the
 * top level (not nested inside a `describe`) since `vi.mock`'s hoisting transform operates on
 * the module's top-level statements. Every OTHER test in this file leaves `bridgeOverride.current`
 * `null`, in which case the mock calls straight through to the REAL `renderBriefingBitmap`.
 */
const { bridgeOverride } = vi.hoisted(() => ({
  bridgeOverride: {
    current: null as
      | ((envelope: RenderEnvelope) => Promise<{
          bitmapPng: Uint8Array | null;
          bitmapHeight: number | null;
          failedRenderBlocks: string[];
          unrenderedBlocks: string[];
        }>)
      | null,
  },
}));
vi.mock("../../src/server/modules/daily-briefing/render/index", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/server/modules/daily-briefing/render/index")>();
  return {
    ...actual,
    renderBriefingBitmap: (...args: Parameters<typeof actual.renderBriefingBitmap>) =>
      bridgeOverride.current
        ? bridgeOverride.current(args[0])
        : actual.renderBriefingBitmap(...args),
  };
});
import {
  __setPrintingPluginActiveForTests,
  claimJob,
  enqueuePrintJob,
  getPayload,
} from "../../src/server/modules/printing/index";
import {
  __setOnThisDaySourceForTests,
  __setQuoteSourceForTests,
  DailyBriefingValidationError,
  deriveStatus,
  generateAllBriefings,
  generateBriefing,
  readBriefing,
} from "../../src/server/modules/daily-briefing/index";
import {
  writeBlockOrder,
  writeMemberBlockSettings,
} from "../../src/server/modules/daily-briefing/settings";
import { generateAnimalFact } from "../../src/server/modules/daily-briefing/blocks/animal-fact";
import { generateNumberFact } from "../../src/server/modules/daily-briefing/blocks/number-fact";
import { generateWouldYouRather } from "../../src/server/modules/daily-briefing/blocks/would-you-rather";
import { generateDrawingPrompt } from "../../src/server/modules/daily-briefing/blocks/drawing-prompt";
import { ALL_BLOCK_TYPES } from "../../src/server/modules/daily-briefing/corpora/index";
import { getLabels } from "../../src/server/modules/daily-briefing/render/labels";
import { useIsolatedDb } from "../helpers/db";
import { seedMember } from "../helpers/daily-briefing-seed";
import type { RenderEnvelope } from "../../src/server/modules/daily-briefing/render/types";
import type { Briefing } from "../../src/shared";

/** docs/features/daily-briefing.md — the full-generation integrator's own
 * integration suite (FR-011/FR-014/FR-015, quickstart S1). Every test drives the REAL
 * `generateBriefing`/`generateAllBriefings` module functions (not HTTP) against a real isolated
 * SQLite DB — the pre-existing per-domain suites (daily-briefing-blocks-*.test.ts) already prove
 * each GENERATOR in isolation; this file proves the ASSEMBLY: effective-order merge, settings
 * resolution, envelope v2 emission, the two-layer status model, and the shared external cache —
 * end to end, across the full 21-block registry.
 */

const DATE_FRI = "2026-08-21"; // Friday, Europe/Madrid (default household tz).
const DATE_MON = "2026-08-24"; // Monday.

function seedDailyMessage(memberId: string, date: string, text: string): void {
  const now = Date.now();
  getDb()
    .prepare(
      "INSERT INTO daily_messages (id, member_id, date, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(`msg-${memberId}-${date}`, memberId, date, text, now, now);
}

/** Raw insert bypassing settings.ts's write-boundary validation — simulates an illegal param
 * value reaching the DB some other way, so a generator's own defense-in-depth throw is exercised
 * deterministically without needing to mock anything. */
function seedIllegalMemberBlockParams(memberId: string, blockType: string, params: unknown): void {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO daily_briefing_member_block_settings
         (member_id, block_type, enabled, weekdays, params, created_at, updated_at)
       VALUES (?, ?, 1, NULL, ?, ?, ?)`
    )
    .run(memberId, blockType, JSON.stringify(params), now, now);
}

/** Seeds a routine/chore/assignment so `getBoard(date)` returns a column for `memberId` on
 * `weekday` — the precondition `blocks/streak.ts` (and its `streakText` delegate) need to
 * produce content instead of omitting (mirrors `daily-briefing-generate.test.ts`'s fixture). */
function seedRoutineForStreak(memberId: string, weekday: string): void {
  const now = Date.now();
  const db = getDb();
  db.prepare(
    "INSERT INTO routines (id, day_period_id, name, active, created_at, updated_at) VALUES (?, 'morning', 'Morning jobs', 1, ?, ?)"
  ).run(`routine-${memberId}`, now, now);
  db.prepare(
    "INSERT INTO chores (id, routine_id, name, sort_order, active, created_at, updated_at) VALUES (?, ?, 'Make bed', 0, 1, ?, ?)"
  ).run(`chore-${memberId}`, `routine-${memberId}`, now, now);
  db.prepare(
    "INSERT INTO routine_assignments (id, routine_id, member_id, weekdays, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)"
  ).run(
    `assignment-${memberId}`,
    `routine-${memberId}`,
    memberId,
    JSON.stringify([weekday]),
    now,
    now
  );
}

/** Persist a household language preference for tests; absent locale rows default to English. */
function seedHouseholdLanguage(language: "en" | "es"): void {
  getDb()
    .prepare("INSERT INTO settings_objects (object_name, data, updated_at) VALUES ('locale', ?, ?)")
    .run(JSON.stringify({ language }), Date.now());
}

/** Seeds `memberId`'s birth month/day to match `date` exactly — the "own birthday is today"
 * branch of `blocks/birthday.ts` (`daysUntilOwn === 0` -> `ownLabel: happyBirthday`), so the
 * household-wide sweep test below also exercises birthday's generator-emitted label, not just
 * streak's. */
function seedOwnBirthdayToday(memberId: string, date: string): void {
  const [, month, day] = date.split("-").map(Number);
  getDb()
    .prepare("UPDATE members SET birth_month = ?, birth_day = ? WHERE id = ?")
    .run(month, day, memberId);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** regression guard (DAILY-BRIEFING-INV-06). Ground-truths every ES-only structural
 * string this plugin can emit by reading `render/labels.ts`'s OWN `es`/`en` maps at runtime
 * (never hand-retyped), so a future wording edit there can't silently desync this list.
 * Two categories are deliberately excluded from the literal sweep:
 * - `streak.dayLetters` — single ASCII letters ("D"/"L"/"M"/"X"/"J"/"V"/"S"); checking these
 * would produce false positives against unrelated English content (member names, corpus
 * text) rather than proving anything about a leaked Spanish label.
 * - any `titles.*` entry whose es/en values are byte-identical (e.g. "TRIVIA") — including it
 * could never signal a leak, since it would "match" regardless of which language actually won.
 * A field whose value is a function (`birthday.daysUntil` / `streak.daysStrong`) is converted to
 * a digit-invariant regex by diffing the function's own output at two distinct sentinel inputs —
 * whatever text surrounds the varying digit run is the language marker this guard is after.
 */
function collectForbiddenEsPatterns(): Array<{ label: string; pattern: RegExp }> {
  const es = getLabels("es");
  const en = getLabels("en");
  const patterns: Array<{ label: string; pattern: RegExp }> = [];

  const addLiteral = (label: string, value: string): void => {
    patterns.push({ label, pattern: new RegExp(escapeRegExp(value)) });
  };
  const addDigitInvariant = (label: string, fn: (n: number) => string): void => {
    const a = fn(123456789);
    const b = fn(987654321);
    let prefixLen = 0;
    while (prefixLen < a.length && a[prefixLen] === b[prefixLen]) prefixLen += 1;
    let suffixLen = 0;
    while (
      suffixLen < a.length - prefixLen &&
      a[a.length - 1 - suffixLen] === b[b.length - 1 - suffixLen]
    ) {
      suffixLen += 1;
    }
    const prefix = a.slice(0, prefixLen);
    const suffix = suffixLen > 0 ? a.slice(a.length - suffixLen) : "";
    patterns.push({
      label,
      pattern: new RegExp(`${escapeRegExp(prefix)}\\d+${escapeRegExp(suffix)}`),
    });
  };

  addLiteral("meals.lunch", es.meals.lunch);
  addLiteral("meals.snack", es.meals.snack);
  addLiteral("meals.dinner", es.meals.dinner);
  addLiteral("onThisDay.events", es.onThisDay.events);
  addLiteral("onThisDay.births", es.onThisDay.births);
  addLiteral("onThisDay.deaths", es.onThisDay.deaths);
  addLiteral("birthday.noUpcoming", es.birthday.noUpcoming);
  addLiteral("birthday.happyBirthday", es.birthday.happyBirthday);
  addDigitInvariant("birthday.daysUntil", es.birthday.daysUntil);
  addLiteral("weatherText.min", es.weatherText.min);
  addLiteral("weatherText.max", es.weatherText.max);
  addLiteral("weatherText.rain", es.weatherText.rain);
  for (const [key, value] of Object.entries(es.weather.conditions)) {
    addLiteral(`weather.conditions.${key}`, value);
  }
  addLiteral("streak.startToday", es.streak.startToday);
  addDigitInvariant("streak.daysStrong", es.streak.daysStrong);
  for (const [type, value] of Object.entries(es.titles)) {
    if (value === en.titles[type as keyof typeof en.titles]) continue; // byte-identical — never discriminating
    addLiteral(`titles.${type}`, value);
  }

  return patterns;
}

/** A minimal valid 1-bit, receipt-width PNG (mirrors `daily-briefing-render-degrade.test.ts`'s * own fixture) — used to simulate a NON-catastrophic bridge result (a raster DID render). */
function buildValidPng(): Uint8Array {
  const png = new PNG({ width: RASTER_WIDTH_DOTS, height: 1 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 0;
    png.data[i + 1] = 0;
    png.data[i + 2] = 0;
    png.data[i + 3] = 255;
  }
  return new Uint8Array(PNG.sync.write(png));
}

describe("daily-briefing full generation", () => {
  useIsolatedDb();

  afterEach(() => {
    __setPrintingPluginActiveForTests(undefined);
    __setQuoteSourceForTests(undefined);
    __setOnThisDaySourceForTests(undefined);
    __setForecastPortForTests(undefined);
    bridgeOverride.current = null;
    vi.useRealTimers();
  });

  it("rejects an empty member before generation or persistence", async () => {
    await expect(generateBriefing("", DATE_FRI)).rejects.toThrow("memberId is required");
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM daily_briefing").get()).toEqual({
      count: 0,
    });
  });

  it.each(["content", "settings"])(
    "ADR-043: freezes local %s before a concurrent edit during external work",
    async (mutation) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(`${DATE_FRI}T12:00:00Z`));
      seedMember("m1", { optedIn: true });
      seedDailyMessage("m1", DATE_FRI, "Before edit");
      writeBlockOrder([
        { type: "shotgun" },
        { type: "streak" },
        { type: "quoteOfDay" },
        { type: "message" },
        { type: "streakText" },
      ]);
      seedHouseholdLanguage("en");
      const db = getDb();
      db.prepare(
        "INSERT INTO calendar_events (id, source, title, all_day, start_date, end_date, created_at, updated_at) VALUES ('event', 'local', 'Before event', 1, ?, '2026-08-22', ?, ?)"
      ).run(DATE_FRI, Date.now(), Date.now());
      db.prepare(
        "INSERT INTO calendar_assignments (id, event_id, member_id, created_at) VALUES ('assignment', 'event', 'm1', ?)"
      ).run(Date.now());
      db.prepare(
        `INSERT INTO reminder (id, kind, targeting_mode, text, query, query_fields, active, created_at, updated_at) VALUES ('rule', 'calendar_gated', 'apply_to_all', 'Before reminder', 'before', '["title"]', 1, ?, ?)`
      ).run(Date.now(), Date.now());
      db.prepare("UPDATE members SET created_at = ? WHERE id = 'm1'").run(Date.UTC(2026, 0, 1));
      db.prepare(
        "INSERT INTO routines (id, day_period_id, name, active, created_at, updated_at) VALUES ('routine', 'morning', 'Morning', 1, ?, ?)"
      ).run(Date.now(), Date.now());
      db.prepare(
        "INSERT INTO chores (id, routine_id, name, sort_order, active, created_at, updated_at) VALUES ('chore', 'routine', 'Make bed', 0, 1, ?, ?)"
      ).run(Date.now(), Date.now());
      db.prepare(
        `INSERT INTO routine_assignments (id, routine_id, member_id, weekdays, active, created_at, updated_at) VALUES ('routine-assignment', 'routine', 'm1', '["mon","tue","wed","thu","fri","sat","sun"]', 1, ?, ?)`
      ).run(Date.now(), Date.now());
      db.prepare(
        "INSERT INTO settings_objects (object_name, data, updated_at) VALUES ('weather', ?, ?)"
      ).run(JSON.stringify({ lat: 40, lon: -3 }), Date.now());
      __setForecastPortForTests(async (location) => ({
        current: { conditionKey: "clear", tempC: location.lat, rainPct: 0 },
        hourly: [],
        daily: [
          {
            date: DATE_FRI,
            conditionKey: "clear",
            tempMinC: location.lat,
            tempMaxC: location.lat,
            rainPct: 0,
          },
        ],
      }));
      __setPrintingPluginActiveForTests(true);
      let renderedLanguage: string | undefined;
      bridgeOverride.current = (envelope) => {
        renderedLanguage = envelope.language;
        expect(db.inTransaction).toBe(false);
        return Promise.resolve({
          bitmapPng: buildValidPng(),
          bitmapHeight: 1,
          failedRenderBlocks: [],
          unrenderedBlocks: [],
        });
      };
      let signalEntered!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        signalEntered = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        release = resolve;
      });
      __setQuoteSourceForTests(async () => {
        signalEntered();
        await resume;
        return { text: "Paused quote", author: "Test" };
      });

      const pending = generateBriefing("m1", DATE_FRI);
      await entered;
      try {
        expect(db.inTransaction).toBe(false);
        db.transaction(() => {
          db.prepare("UPDATE members SET display_name = 'After edit' WHERE id = 'm1'").run();
          db.prepare("UPDATE daily_messages SET text = 'After edit' WHERE member_id = 'm1'").run();
          db.prepare("UPDATE calendar_events SET title = 'After event' WHERE id = 'event'").run();
          db.prepare(
            "UPDATE reminder SET text = 'After reminder', query = 'after' WHERE id = 'rule'"
          ).run();
          db.prepare("UPDATE settings_objects SET data = ? WHERE object_name = 'locale'").run(
            JSON.stringify({ language: "es" })
          );
          db.prepare(
            "INSERT INTO chore_completions (id, chore_id, member_id, date, completed_at) VALUES ('completion', 'chore', 'm1', '2026-08-20', ?)"
          ).run(Date.now());
          db.prepare("UPDATE settings_objects SET data = ? WHERE object_name = 'weather'").run(
            JSON.stringify({ lat: 50, lon: -4 })
          );
          evictWeatherCache();
          if (mutation === "settings")
            writeMemberBlockSettings("m1", "message", { enabled: false });
        })();
      } finally {
        release();
      }
      const briefing = await pending;
      expect(briefing.payload.member.displayName).toBe("m1");
      expect(briefing.payload.blocks.find((b) => b.type === "shotgun")?.data).toEqual({
        ranking: ["m1"],
      });
      expect(briefing.payload.blocks.find((b) => b.type === "message")?.data).toEqual({
        text: "Before edit",
      });
      expect(readBriefing("m1", DATE_FRI)).toMatchObject({
        briefing: { payload: briefing.payload },
      });
      expect(briefing.payload.blocks.find((b) => b.type === "today")?.data).toEqual({
        bullets: ["Before event"],
      });
      expect(briefing.payload.blocks.find((b) => b.type === "reminders")?.data).toEqual({
        groups: [{ items: [{ value: "Before reminder" }] }],
      });
      const streak = briefing.payload.blocks.find((b) => b.type === "streak")?.data;
      expect(streak).toMatchObject({
        days: 0,
        last7: [false, false, false, false, false, false, false],
      });
      expect(briefing.payload.blocks.find((b) => b.type === "streakText")?.data).toEqual(streak);
      expect(briefing.payload.blocks.find((b) => b.type === "weather")?.data).toMatchObject({
        tempMaxC: 40,
      });
      expect(
        db
          .prepare("SELECT payload FROM daily_briefing_block_cache WHERE block_type = 'weather'")
          .get()
      ).toBeUndefined();
      expect(renderedLanguage).toBe("en");
      const regenerated = await generateBriefing("m1", DATE_FRI);
      expect(regenerated.id).toBe(briefing.id);
      expect(renderedLanguage).toBe("es");
      expect(regenerated.payload.blocks.find((b) => b.type === "weather")?.data).toMatchObject({
        tempMaxC: 50,
      });
      expect(regenerated.payload.blocks.find((b) => b.type === "streak")?.data).toMatchObject({
        days: 1,
        last7: [false, false, false, false, false, false, true],
      });
      expect(regenerated.payload.blocks.find((b) => b.type === "today")?.data).toEqual({
        bullets: ["After event"],
      });
      expect(regenerated.payload.blocks.find((b) => b.type === "reminders")?.data).toEqual({
        groups: [{ items: [{ value: "After reminder" }] }],
      });
      expect(regenerated.payload.member.displayName).toBe("After edit");
      expect(regenerated.payload.blocks.find((b) => b.type === "message")?.data).toEqual(
        mutation === "settings" ? undefined : { text: "After edit" }
      );
    }
  );

  it("FR-014: effective order merge — configured instances (incl. a repeated type with distinct params) first, then unlisted registry types in registry order", async () => {
    seedMember("m1", { optedIn: true });
    // "wordOfDay" appears TWICE with distinct params (INV-05/ADR-044); "message" is configured
    // third; every other registry type is unlisted and must be appended afterward, in
    // `ALL_BLOCK_TYPES`'s own order.
    writeBlockOrder([
      { type: "wordOfDay", params: { level: "L1" } },
      { type: "wordOfDay", params: { level: "L3" } },
      { type: "message" },
    ]);
    seedDailyMessage("m1", DATE_FRI, "Have a wonderful day!");

    const briefing = await generateBriefing("m1", DATE_FRI);
    const types = briefing.payload.blocks.map((b) => b.type);

    expect(types.slice(0, 3)).toEqual(["wordOfDay", "wordOfDay", "message"]);
    expect(briefing.payload.blocks[0].params).toMatchObject({ level: "L1" });
    expect(briefing.payload.blocks[1].params).toMatchObject({ level: "L3" });
    // The two wordOfDay instances resolve DIFFERENT corpus entries (different level pools).
    expect(briefing.payload.blocks[0].data).not.toEqual(briefing.payload.blocks[1].data);

    // Every unlisted registry type is appended afterward, in ALL_BLOCK_TYPES order (skipping
    // "wordOfDay"/"message", already configured, and "onThisDay", default-disabled).
    const appended = types.slice(3);
    const expectedAppendedOrder = ALL_BLOCK_TYPES.filter(
      (t) => t !== "wordOfDay" && t !== "message" && t !== "onThisDay"
    );
    // `appended` is a SUBSET (some types legitimately omit — e.g. "birthday"/"today" with no
    // seeded domain data) but must preserve the registry's relative order.
    const filteredExpected = expectedAppendedOrder.filter((t) => appended.includes(t));
    expect(appended).toEqual(filteredExpected);
    // "onThisDay" ships default-disabled (FR-013) — never present without an explicit opt-in.
    expect(types).not.toContain("onThisDay");
  });

  it("SC-003: generating the same member/date twice produces identical block selections and an identical raster", async () => {
    seedMember("m1", { optedIn: true });

    const first = await generateBriefing("m1", DATE_FRI);
    const rows = getDb()
      .prepare("SELECT raster_bits FROM daily_briefing WHERE member_id = ? AND date = ?")
      .get("m1", DATE_FRI) as { raster_bits: Buffer | null };
    expect(rows.raster_bits).not.toBeNull();
    const firstRaster = Buffer.from(rows.raster_bits as Buffer);
    const second = await generateBriefing("m1", DATE_FRI);
    expect(second.payload.blocks).toEqual(first.payload.blocks);

    // Regenerating in place replaces the raster with a byte-identical one (same content, same
    // rendering engine, same fonts — SC-003's "identical raster" guarantee).
    const secondRow = getDb()
      .prepare("SELECT raster_bits FROM daily_briefing WHERE id = ?")
      .get(second.id) as { raster_bits: Buffer };
    expect(Buffer.compare(firstRaster, secondRow.raster_bits)).toBe(0);
  });

  it(": editing a member colour does not alter the monochrome briefing raster", async () => {
    seedMember("m1", { optedIn: true });

    await generateBriefing("m1", DATE_FRI);
    const before = getDb()
      .prepare("SELECT raster_bits FROM daily_briefing WHERE member_id = ? AND date = ?")
      .get("m1", DATE_FRI) as { raster_bits: Buffer };

    getDb().prepare("UPDATE members SET color_key = ? WHERE id = ?").run("violet", "m1");
    await generateBriefing("m1", DATE_FRI);
    const after = getDb()
      .prepare("SELECT raster_bits FROM daily_briefing WHERE member_id = ? AND date = ?")
      .get("m1", DATE_FRI) as { raster_bits: Buffer };

    expect(Buffer.compare(after.raster_bits, before.raster_bits)).toBe(0);
  });

  it("FR-014/US4-AC5: a weekday-masked block is omitted on a non-matching weekday and present on a matching one", async () => {
    seedMember("m1", { optedIn: true });
    writeMemberBlockSettings("m1", "dadJoke", { weekdays: ["fri"] });

    const onFriday = await generateBriefing("m1", DATE_FRI);
    expect(onFriday.payload.blocks.map((b) => b.type)).toContain("dadJoke");

    const onMonday = await generateBriefing("m1", DATE_MON);
    expect(onMonday.payload.blocks.map((b) => b.type)).not.toContain("dadJoke");
  });

  it("FR-009/INV-06: a corpus-backed block instance's language is resolved, frozen, and reflected in content", async () => {
    seedMember("m1", { optedIn: true });
    seedHouseholdLanguage("en");
    writeMemberBlockSettings("m1", "animalFact", { params: { language: "es" } });

    const briefing = await generateBriefing("m1", DATE_FRI);
    const animalFact = briefing.payload.blocks.find((b) => b.type === "animalFact");
    expect(animalFact).toMatchObject({ status: "ok", language: "es" });

    // The SAME date, un-configured (default "en") member gets DIFFERENT (English) content —
    // proves the language selection actually changed the resolved corpus entry, not just the
    // recorded label.
    seedMember("m2", { optedIn: true });
    const englishBriefing = await generateBriefing("m2", DATE_FRI);
    const englishAnimalFact = englishBriefing.payload.blocks.find((b) => b.type === "animalFact");
    expect(englishAnimalFact).toMatchObject({ status: "ok", language: "en" });
    expect(animalFact?.data).not.toEqual(englishAnimalFact?.data);
  });

  it.each(["es", "en"] as const)(
    "corpus defaults follow the %s household with English-only fallback",
    async (language) => {
      seedHouseholdLanguage(language);
      seedMember("m1", { optedIn: true });
      const briefing = await generateBriefing("m1", DATE_FRI);
      const generators = {
        animalFact: generateAnimalFact,
        numberFact: generateNumberFact,
        wouldYouRather: generateWouldYouRather,
        drawingPrompt: generateDrawingPrompt,
      };
      for (const [type, generate] of Object.entries(generators)) {
        const block = briefing.payload.blocks.find((b) => b.type === type);
        expect(block).toMatchObject({
          status: "ok",
          language,
          params: { language },
          data: generate({ date: DATE_FRI, memberId: "m1", params: { language } }),
        });
      }
      for (const type of ["dadJoke", "wordOfDay", "trivia", "riddle", "wordSearch"]) {
        expect(briefing.payload.blocks.find((b) => b.type === type)).toMatchObject({
          status: "ok",
          language: "en",
          params: { language: "en" },
        });
      }
    }
  );

  it("explicit corpus overrides win while household changes leave stored snapshots intact", async () => {
    seedHouseholdLanguage("es");
    seedMember("m1", { optedIn: true });
    writeBlockOrder([{ type: "animalFact", params: { language: "en" } }, { type: "animalFact" }]);
    const briefing = await generateBriefing("m1", DATE_FRI);
    const animals = briefing.payload.blocks.filter((b) => b.type === "animalFact");
    expect(animals[0]).toMatchObject({
      language: "en",
      params: { language: "en" },
      data: generateAnimalFact({ date: DATE_FRI, memberId: "m1", params: { language: "en" } }),
    });
    expect(animals[1]).toMatchObject({
      language: "es",
      params: { language: "es" },
      data: generateAnimalFact({ date: DATE_FRI, memberId: "m1", params: { language: "es" } }),
    });
    expect(animals[0].title).toMatch(/ DATO ANIMAL$/);
    const stored = getDb()
      .prepare("SELECT payload, raster_bits FROM daily_briefing WHERE id = ?")
      .get(briefing.id);
    getDb()
      .prepare("UPDATE settings_objects SET data = ? WHERE object_name = 'locale'")
      .run(JSON.stringify({ language: "en" }));
    const read = readBriefing("m1", DATE_FRI);
    expect(read.generated).toBe(true);
    if (read.generated) expect(read.briefing.payload).toEqual(briefing.payload);
    expect(
      getDb()
        .prepare("SELECT payload, raster_bits FROM daily_briefing WHERE id = ?")
        .get(briefing.id)
    ).toEqual(stored);
  });

  it("FR-011/INV-07: null-omit vs recorded-failed — a generator resolving null is ABSENT, a generator throwing is RECORDED failed, status is partial", async () => {
    seedMember("m1", { optedIn: true });
    // No daily_messages row seeded for m1/DATE_FRI: "message" resolves null (handoff note the
    // null-omit trap) — must be ABSENT from blocks, never a {status:"failed"} record.
    // "dadJoke" is EN-only; an illegal "es" request (bypassing settings.ts's write-boundary
    // validator, simulating stale/legacy data) makes `generateDadJoke` throw
    // `CorpusBlockParamError` — caught and RECORDED as a failed block (never omitted).
    seedIllegalMemberBlockParams("m1", "dadJoke", { language: "es" });

    const briefing = await generateBriefing("m1", DATE_FRI);
    const types = briefing.payload.blocks.map((b) => b.type);

    expect(types).not.toContain("message");
    const dadJoke = briefing.payload.blocks.find((b) => b.type === "dadJoke");
    expect(dadJoke).toMatchObject({ status: "failed", error: "gather_failed" });
    expect(dadJoke?.data).toBeUndefined();
    // Survivors exist (corpus/shotgun content unaffected by the dadJoke throw) — "partial", not
    // "failed" (DAILY-BRIEFING-AC-09).
    expect(briefing.status).toBe("partial");
    expect(briefing.payload.blocks.some((b) => b.status === "ok")).toBe(true);
  });

  describe("render-layer isolation (D5, review fold P1-2 partition)", () => {
    // (coverage-gap task) registered pressedslip render-defs for all 21 block
    // types (render/registry.ts) — a REAL generation no longer has a natural registry-miss to
    // observe (this test's original form asserted `unrenderedBlocks.length > 0` against a live
    // `generateBriefing` call, which relied on the -era registry shipping only "message").
    // The partition this test pins (a registry-miss goes to `unrenderedBlocks`, NEVER
    // `failedRenderBlocks`) is a property of `render/bridge.ts#doRender`'s own partitioning logic,
    // independent of how many types happen to be registered — so it is now proven via the same
    // `bridgeOverride` seam the adjacent "GENUINE render failure" test already uses, simulating a
    // registry-miss deterministically rather than depending on registry incompleteness.
    it("a registry-miss-only day: unrendered_blocks is populated, failed_render_blocks stays empty, status is data-derived", async () => {
      bridgeOverride.current = () =>
        Promise.resolve({
          bitmapPng: buildValidPng(),
          bitmapHeight: 1,
          failedRenderBlocks: [],
          unrenderedBlocks: ["someFutureBlockType"],
        });
      try {
        seedMember("m1", { optedIn: true });
        seedDailyMessage("m1", DATE_FRI, "printable message");

        const briefing = await generateBriefing("m1", DATE_FRI);
        // Data layer is entirely clean (no illegal params, no missing message).
        expect(briefing.status).not.toBe("render-failed");
        expect(briefing.status).not.toBe("failed");

        const row = getDb()
          .prepare(
            "SELECT raster_bits, failed_render_blocks, unrendered_blocks FROM daily_briefing WHERE member_id = ? AND date = ?"
          )
          .get("m1", DATE_FRI) as {
          raster_bits: Buffer | null;
          failed_render_blocks: string;
          unrendered_blocks: string;
        };
        expect(row.raster_bits).not.toBeNull();
        // A registry-miss is correctly reported in `unrendered_blocks` (a coverage gap), NEVER in
        // `failed_render_blocks` (the population that would demote status per D5's "≥ surviving
        // blocks" rule) — that is the partition this test pins.
        expect(JSON.parse(row.failed_render_blocks)).toEqual([]);
        const unrenderedBlocks: string[] = JSON.parse(row.unrendered_blocks);
        expect(unrenderedBlocks).toEqual(["someFutureBlockType"]);
      } finally {
        bridgeOverride.current = null;
      }
    });

    it("Printing inactive: content generates, raster is NULL, status derives from data alone (FR-006/AC-05)", async () => {
      __setPrintingPluginActiveForTests(false);
      seedMember("m1", { optedIn: true });

      const briefing = await generateBriefing("m1", DATE_FRI);
      expect(briefing.payload.blocks.length).toBeGreaterThan(0);
      expect(briefing.status).not.toBe("render-failed");

      const row = getDb()
        .prepare(
          "SELECT raster_bits, raster_height, png, failed_render_blocks, unrendered_blocks FROM daily_briefing WHERE member_id = ? AND date = ?"
        )
        .get("m1", DATE_FRI) as {
        raster_bits: Buffer | null;
        raster_height: number | null;
        png: Buffer | null;
        failed_render_blocks: string;
        unrendered_blocks: string;
      };
      expect(row.raster_bits).toBeNull();
      expect(row.raster_height).toBeNull();
      expect(row.png).toBeNull();
      expect(row.failed_render_blocks).toBe("[]");
      expect(row.unrendered_blocks).toBe("[]");
    });

    it("a GENUINE render failure among survivors forces render-failed even though a raster still renders (D5's '≥ surviving blocks' rule)", async () => {
      // The bridge itself reports a non-null raster (some content DID render) alongside a
      // non-empty `failedRenderBlocks` (a GENUINE failure, e.g. a registered block's schema
      // validation failing at render time) — `deriveOverallStatus` must still flip to
      // `render-failed`, never let a partial genuine failure hide behind a produced raster.
      bridgeOverride.current = () =>
        Promise.resolve({
          bitmapPng: buildValidPng(),
          bitmapHeight: 1,
          failedRenderBlocks: ["message"],
          unrenderedBlocks: ["dadJoke", "shotgun"],
        });
      try {
        seedMember("m1", { optedIn: true });
        const briefing = await generateBriefing("m1", DATE_FRI);
        expect(briefing.status).toBe("render-failed");
        const row = getDb()
          .prepare(
            "SELECT raster_bits, failed_render_blocks, unrendered_blocks FROM daily_briefing WHERE member_id = ? AND date = ?"
          )
          .get("m1", DATE_FRI) as {
          raster_bits: Buffer | null;
          failed_render_blocks: string;
          unrendered_blocks: string;
        };
        // The raster IS persisted (the render wasn't catastrophic) — only the STATUS reflects
        // the genuine failure; the partial raster is still the best available artifact.
        expect(row.raster_bits).not.toBeNull();
        expect(JSON.parse(row.failed_render_blocks)).toEqual(["message"]);
        expect(JSON.parse(row.unrendered_blocks)).toEqual(["dadJoke", "shotgun"]);
      } finally {
        bridgeOverride.current = null;
      }
    });

    describe("a genuinely catastrophic render failure", () => {
      it("yields render-failed — never a `ready` briefing with a missing raster (v1 study gotcha #14)", async () => {
        bridgeOverride.current = () =>
          Promise.resolve({
            bitmapPng: null,
            bitmapHeight: null,
            failedRenderBlocks: [],
            unrenderedBlocks: [],
          });
        try {
          seedMember("m1", { optedIn: true });
          const briefing = await generateBriefing("m1", DATE_FRI);
          expect(briefing.status).toBe("render-failed");
          const row = getDb()
            .prepare("SELECT raster_bits FROM daily_briefing WHERE member_id = ? AND date = ?")
            .get("m1", DATE_FRI) as { raster_bits: Buffer | null };
          expect(row.raster_bits).toBeNull();
        } finally {
          bridgeOverride.current = null;
        }
      });
    });
  });

  describe("late-eligibility abort (FOLD-2, Codex #707 review)", () => {
    it("a member archived while the render is in-flight aborts that write quietly: no crash, no payload/raster committed, other members unaffected", async () => {
      seedMember("m1", { optedIn: true });
      seedMember("m2", { optedIn: true });

      let renderStarted = false;
      let releaseRender: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        releaseRender = resolve;
      });
      bridgeOverride.current = async () => {
        renderStarted = true;
        await gate;
        return {
          bitmapPng: buildValidPng(),
          bitmapHeight: 1,
          failedRenderBlocks: [],
          unrenderedBlocks: [],
        };
      };
      try {
        const generatePromise = generateBriefing("m1", DATE_FRI);
        await vi.waitFor(() => {
          expect(renderStarted).toBe(true);
        });

        // Archive m1 WHILE its render is still in flight — exactly the window the pre-render
        // TOCTOU check (before this fold) could not see.
        getDb().prepare("UPDATE members SET lifecycle = 'archived' WHERE id = ?").run("m1");
        releaseRender?.();

        // First-ever generation attempt for m1/DATE_FRI, now abandoned — no prior row exists to
        // fall back to, so this surfaces as the SAME typed rejection the pre-render TOCTOU
        // checks already produce for a concurrent archive (never a raw crash).
        await expect(generatePromise).rejects.toThrow(DailyBriefingValidationError);

        const m1Row = getDb()
          .prepare("SELECT COUNT(*) AS count FROM daily_briefing WHERE member_id = ?")
          .get("m1") as { count: number };
        expect(m1Row.count).toBe(0);

        // m2 is entirely unaffected by m1's aborted write.
        bridgeOverride.current = () =>
          Promise.resolve({
            bitmapPng: buildValidPng(),
            bitmapHeight: 1,
            failedRenderBlocks: [],
            unrenderedBlocks: [],
          });
        const m2Briefing = await generateBriefing("m2", DATE_FRI);
        expect(m2Briefing.status).not.toBe("render-failed");
        expect(
          getDb()
            .prepare("SELECT COUNT(*) AS count FROM daily_briefing WHERE member_id = ?")
            .get("m2")
        ).toEqual({ count: 1 });
      } finally {
        bridgeOverride.current = null;
      }
    });

    it("a member archived while the render is in-flight, with a PRIOR frozen snapshot, returns that snapshot untouched (no emit, no mutation)", async () => {
      seedMember("m1", { optedIn: true });

      // A prior, healthy generation already exists for this member/date.
      const prior = await generateBriefing("m1", DATE_FRI);

      let renderStarted = false;
      let releaseRender: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        releaseRender = resolve;
      });
      bridgeOverride.current = async () => {
        renderStarted = true;
        await gate;
        return {
          bitmapPng: buildValidPng(),
          bitmapHeight: 1,
          failedRenderBlocks: [],
          unrenderedBlocks: [],
        };
      };
      try {
        const generatePromise = generateBriefing("m1", DATE_FRI);
        await vi.waitFor(() => {
          expect(renderStarted).toBe(true);
        });

        getDb().prepare("UPDATE members SET lifecycle = 'archived' WHERE id = ?").run("m1");
        releaseRender?.();

        const result = await generatePromise;
        // The PRIOR frozen row is returned exactly as it stood — the aborted regeneration
        // attempt changed nothing (INV-01: no partial/silent mutation from an abandoned write).
        expect(result).toEqual(prior);
      } finally {
        bridgeOverride.current = null;
      }
    });
  });

  it("FR-019: a shared-scope external block is fetched ONCE per date and reused across members", async () => {
    getDb()
      .prepare(
        "INSERT INTO settings_objects (object_name, data, updated_at) VALUES ('weather', ?, ?)"
      )
      .run(JSON.stringify({ lat: 40.4, lon: -3.7 }), Date.now());
    const { __setForecastPortForTests } = await import("../../src/server/modules/weather/port");
    const portSpy = vi.fn(async () => ({
      current: { conditionKey: "clear" as const, tempC: 20, rainPct: 5 },
      hourly: [],
      daily: [
        { date: DATE_FRI, conditionKey: "clear" as const, tempMinC: 18, tempMaxC: 26, rainPct: 5 },
      ],
    }));
    __setForecastPortForTests(portSpy);
    seedMember("m1", { optedIn: true });
    seedMember("m2", { optedIn: true });

    const briefings = await generateAllBriefings(DATE_FRI);

    expect(portSpy).toHaveBeenCalledTimes(1);
    const weatherOf = (b: Briefing) =>
      b.payload.blocks.find((block) => block.type === "weather")?.data;
    expect(weatherOf(briefings[0])).toEqual(weatherOf(briefings[1]));
    __setForecastPortForTests(undefined);
  });

  it("FR-019/INV-07: a genuine quoteOfDay port failure is RECORDED failed (never silently omitted like weather)", async () => {
    seedMember("m1", { optedIn: true });
    __setQuoteSourceForTests(async () => {
      throw new Error("zenquotes unreachable");
    });

    const briefing = await generateBriefing("m1", DATE_FRI);
    expect(briefing.payload.blocks.find((b) => b.type === "quoteOfDay")).toMatchObject({
      status: "failed",
      error: "gather_failed",
    });
  });

  it("a legitimately-empty quoteOfDay resolve is OMITTED, never recorded as failed", async () => {
    seedMember("m1", { optedIn: true });
    __setQuoteSourceForTests(async () => null);

    const briefing = await generateBriefing("m1", DATE_FRI);
    expect(briefing.payload.blocks.map((b) => b.type)).not.toContain("quoteOfDay");
  });

  it("contains malformed persisted external cache entries as block failures", async () => {
    seedMember("m1", { optedIn: true });
    __setPrintingPluginActiveForTests(false);
    const cache = createDailyBlockCache(DATE_FRI);
    getDb()
      .prepare(
        "INSERT INTO daily_briefing_block_cache (date, block_type, payload, created_at) VALUES (?, 'weather', 'invalid-json', ?)"
      )
      .run(DATE_FRI, Date.now());
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const briefing = await generateBriefing("m1", DATE_FRI, cache);
      expect(briefing.status).toBe("partial");
      expect(briefing.payload.blocks.find((b) => b.type === "weather")).toMatchObject({
        status: "failed",
        error: "gather_failed",
      });
    } finally {
      error.mockRestore();
    }
  });

  it("generates an enabled onThisDay block and contains its external failure", async () => {
    seedMember("m1", { optedIn: true });
    writeMemberBlockSettings("m1", "onThisDay", { enabled: true });
    __setPrintingPluginActiveForTests(false);
    __setOnThisDaySourceForTests(async () => ({
      events: ["2000: Test event"],
      births: [],
      deaths: [],
    }));
    const first = await generateBriefing("m1", DATE_FRI);
    expect(first.payload.blocks.find((b) => b.type === "onThisDay")).toMatchObject({
      status: "ok",
      data: { events: ["2000: Test event"] },
    });
    getDb().prepare("DELETE FROM daily_briefing_block_cache WHERE block_type = 'onThisDay'").run();
    __setOnThisDaySourceForTests(async () => {
      throw new Error("source unavailable");
    });
    const failed = await generateBriefing("m1", DATE_FRI);
    expect(failed.id).toBe(first.id);
    expect(failed.payload.blocks.find((b) => b.type === "onThisDay")).toMatchObject({
      status: "failed",
      error: "gather_failed",
    });
    __setOnThisDaySourceForTests(undefined);
    expect(
      (await generateBriefing("m1", DATE_FRI)).payload.blocks.some((b) => b.type === "onThisDay")
    ).toBe(false);
  });

  //: this does NOT prove the FR-020 serial-loop fence itself — word-search's
  // `withSeededMathRandom` confinement (corpora/determinism.ts) is entirely SYNCHRONOUS, so it
  // cannot be interleaved by anything short of the loop actually running two block generations
  // concurrently (`Promise.all`), which nothing here does or could exercise via timing alone; a
  // regression that reintroduced `Promise.all` would still pass this exact assertion since
  // wordSearch's own callback never yields mid-confinement. The loop's necessity is enforced by
  // the code comment on `generateFullRegistryBlocks` ; what THIS
  // test actually re-confirms is general cross-run determinism for one specific corpus type —
  // already covered, more broadly, by the SC-003 case above (identical `blocks` end to end). Kept
  // as a narrow, honestly-framed regression guard for wordSearch specifically, since its
  // determinism depends on two INDEPENDENT seeds (selection + placement) that are
  // easy to accidentally decouple in a future edit.
  it("wordSearch's two-seed determinism (selection + placement) survives being generated inside the full 21-block loop", async () => {
    seedMember("m1", { optedIn: true });

    const first = await generateBriefing("m1", DATE_FRI);
    const second = await generateBriefing("m1", DATE_FRI);

    const wordSearchOf = (b: Briefing) =>
      b.payload.blocks.find((block) => block.type === "wordSearch");
    expect(wordSearchOf(first)?.data).toEqual(wordSearchOf(second)?.data);
  });

  it("SC-004 (bounded budget): a full 21-block generation completes well within the 60s cap under normal (cache-warm, no-network-in-tests) conditions", async () => {
    // The REAL 30s render cap (render/bridge.ts's Promise.race) and 5s-per-external-call caps
    // (external/ports.ts's AbortSignal.timeout) are proven by their own dedicated tests
    // (daily-briefing-render-probe.test.ts's timeout-cleanup case; daily-briefing-blocks-
    // external.test.ts's skip-on-failure cases). This test's own, narrower job: the SERIAL block
    // loop itself (FR-020 — 21 sequential `await`s, no batching) must not introduce latency
    // inconsistent with the spec's 60s budget under ordinary conditions — a regression here
    // (e.g. an accidentally-reintroduced real network call, or an infinite retry) would blow far
    // past this generous bound long before ever approaching the real 60s ceiling.
    seedMember("m1", { optedIn: true });
    const startedAt = Date.now();
    await generateBriefing("m1", DATE_FRI);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("printable provider serves the generated raster through the REAL 018 pipeline end to end", async () => {
    seedMember("m1", { optedIn: true });
    const briefing = await generateBriefing("m1", DATE_FRI);
    expect(briefing.status).not.toBe("render-failed");

    const recordKey = `daily-briefing:m1`;
    const outputRef = `daily-briefing:m1:${DATE_FRI}`;
    // Household tz is Europe/Madrid (default) — 10:00 UTC on DATE_FRI is safely within that
    // same household-local calendar day, matching `claimJob`'s own `todayInHouseholdTz` gate.
    const now = Date.UTC(2026, 7, 21, 10, 0, 0);
    const enqueueResult = enqueuePrintJob(
      { recordKey, targetDate: DATE_FRI, outputRef, memberId: "m1" },
      now
    );
    expect(enqueueResult.enqueued).toBe(true);
    const claimed = claimJob(now);
    expect(claimed).not.toBeNull();
    const payload = getPayload(enqueueResult.jobId, claimed?.leaseToken as string, now);
    expect(payload.length).toBeGreaterThan(0);
  });

  describe("titles (v1 titleFor port, review fold TITLES/P2-1/P2-2)", () => {
    it("a skipped block leaves a numbering gap in the FULL effective order (v1-faithful, FR-021)", async () => {
      seedMember("m1", { optedIn: true });
      seedRoutineForStreak("m1", "fri"); // DATE_FRI is a Friday — makes "streak" present.
      // ALL_BLOCK_TYPES order: shotgun(1), message(2), streak(3), … — mask "message" out on
      // EVERY weekday ([] is the "never" mask, distinct from null's "every day") so position 2
      // is skipped while position 1 (shotgun) and position 3 (streak) still land.
      writeMemberBlockSettings("m1", "message", { weekdays: [] });

      const briefing = await generateBriefing("m1", DATE_FRI);
      const types = briefing.payload.blocks.map((b) => b.type);
      expect(types).not.toContain("message");

      const shotgun = briefing.payload.blocks.find((b) => b.type === "shotgun");
      const streak = briefing.payload.blocks.find((b) => b.type === "streak");
      expect(shotgun?.index).toBe(1);
      // The gap left by "message" (position 2) is NOT compacted away — "streak" keeps its TRUE
      // full-registry position (3), not a recount-of-survivors position (2).
      expect(streak?.index).toBe(3);
      expect(streak?.title).toMatch(/^03 /);
    });

    it("the 4 v1 title overrides are exact (en household)", async () => {
      // A fresh household without a locale row uses English for structural briefing copy.
      expect(
        getDb().prepare("SELECT data FROM settings_objects WHERE object_name = 'locale'").get()
      ).toBeUndefined();
      expect(getLabels(undefined)).toEqual(getLabels("en"));
      expect(getLabels("unsupported")).toEqual(getLabels("en"));
      seedMember("m1", { optedIn: true });
      // quoteOfDay resolves to "no port available" (omitted) under test runtime unless a source
      // is injected — inject one so the block actually generates and its title is checkable.
      __setQuoteSourceForTests(async () => ({ text: "Test quote", author: "Test Author" }));
      const briefing = await generateBriefing("m1", DATE_FRI);
      const titleOf = (type: string) => briefing.payload.blocks.find((b) => b.type === type)?.title;

      expect(titleOf("quoteOfDay")).toMatch(/ QUOTE OF THE DAY$/);
      expect(titleOf("wordOfDay")).toMatch(/ WORD OF THE DAY$/);
      expect(titleOf("wordSearch")).toMatch(/ WORD SEARCH$/);
      expect(titleOf("wouldYouRather")).toMatch(/ WOULD YOU RATHER\.\.\.\?$/);

      const { readEffectiveSettings } = await import("../../src/server/modules/settings");
      for (const rawLocale of [
        JSON.stringify({ language: "es", timezone: "invalid" }),
        JSON.stringify({ language: "es", unknown: true }),
        JSON.stringify({ language: "es", weekStartDay: 9 }),
        "{invalid-json",
      ]) {
        getDb()
          .prepare(
            "INSERT INTO settings_objects (object_name, data, updated_at) VALUES ('locale', ?, ?) ON CONFLICT(object_name) DO UPDATE SET data = excluded.data"
          )
          .run(rawLocale, Date.now());
        expect(readEffectiveSettings().locale.language).toBe("en");
        const regenerated = await generateBriefing("m1", DATE_FRI);
        expect(regenerated.payload.blocks.find((b) => b.type === "wordOfDay")?.title).toMatch(
          / WORD OF THE DAY$/
        );
      }
    });

    it("the *Text titles are distinct from their visual twins (streakText/streak, weatherText/weather) (en household)", async () => {
      seedHouseholdLanguage("en");
      seedMember("m1", { optedIn: true });
      seedRoutineForStreak("m1", "fri");

      const briefing = await generateBriefing("m1", DATE_FRI);
      const titleOf = (type: string) => briefing.payload.blocks.find((b) => b.type === type)?.title;

      const streakTitle = titleOf("streak");
      const streakTextTitle = titleOf("streakText");
      expect(streakTitle).toMatch(/ STREAK$/);
      expect(streakTextTitle).toMatch(/ STREAK TEXT$/);
      expect(streakTextTitle).not.toBe(streakTitle);
    });

    it("an es household resolves titleFor's labels in Spanish, incl. one v1 override (#716)", async () => {
      seedHouseholdLanguage("es");
      seedMember("m1", { optedIn: true });
      seedRoutineForStreak("m1", "fri"); // makes "streak" present, like the numbering-gap test.

      const briefing = await generateBriefing("m1", DATE_FRI);
      const titleOf = (type: string) => briefing.payload.blocks.find((b) => b.type === type)?.title;

      // Plain (non-override) type.
      expect(titleOf("shotgun")).toMatch(/ COPILOTO$/);
      // Plain type whose *Text twin must stay distinct (mirrors the en test above).
      expect(titleOf("streak")).toMatch(/ RACHA$/);
      expect(briefing.payload.blocks.find((b) => b.type === "streak")?.data).toMatchObject({
        label: "¡Empieza tu racha hoy!",
      });
      expect(briefing.payload.blocks.find((b) => b.type === "streakText")?.data).toMatchObject({
        label: "¡Empieza tu racha hoy!",
      });
      expect(titleOf("streak")).not.toBe(titleOf("streakText"));
      // One of the 4 v1 title overrides — proves the override branch localizes too, not just
      // the algorithmic camelCase-split branch.
      expect(titleOf("wordSearch")).toMatch(/ SOPA DE LETRAS$/);
    });
  });

  //: `streakText` is a pure delegate to `streak`'s generator (blocks/streak-text.ts),
  // so its call site in `generateBlockData`'s switch must pass the SAME `language` the "streak"
  // arm passes — omitting it falls back to English regardless of a configured Spanish
  // household's real setting. Driven through the REAL `generateBriefing` (not a per-block
  // generator call, which is exactly what let this regress unnoticed — see the sibling
  // `daily-briefing-blocks-domain.test.ts` suite, which seeds `language` directly on each call
  // and so never exercises this wiring at all).
  it("issue #730/INV-06: an en household never leaks an ES-only structural label into ANY block's payload", async () => {
    seedHouseholdLanguage("en");
    seedMember("m1", { optedIn: true });
    // Preconditions for the two GENERATOR-emitted, language-resolved snapshot strings this
    // registry can produce (blocks/streak.ts's `label`, delegated by streakText; blocks/
    // birthday.ts's `ownLabel`) — both must actually generate content, or their `getLabels` call
    // never runs and the sweep proves nothing.
    seedRoutineForStreak("m1", "fri"); // DATE_FRI is a Friday.
    seedOwnBirthdayToday("m1", DATE_FRI);

    const briefing = await generateBriefing("m1", DATE_FRI);

    // Sanity: the two structural-string producers actually generated (else this test would pass
    // vacuously — nothing to leak).
    const streak = briefing.payload.blocks.find((b) => b.type === "streak");
    const streakText = briefing.payload.blocks.find((b) => b.type === "streakText");
    const birthday = briefing.payload.blocks.find((b) => b.type === "birthday");
    expect(streak?.status).toBe("ok");
    expect(streakText?.status).toBe("ok");
    expect(birthday?.status).toBe("ok");

    const forbidden = collectForbiddenEsPatterns();
    const violations: string[] = [];
    for (const block of briefing.payload.blocks) {
      const serialized = JSON.stringify(block);
      for (const { label, pattern } of forbidden) {
        if (pattern.test(serialized)) {
          violations.push(`block "${block.type}" matched ES pattern "${label}" (${pattern})`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  //: a direct unit-level proof of deriveStatus's failed branch, colocated with
  // this file's own partition tests (a synthetic-block-array case already exists in
  // daily-briefing-generate.test.ts's `it.each` table — this is the SAME guarantee, exercised
  // here too since the own suite is where the two-layer status model is otherwise proven).
  it("deriveStatus: every block failed settles the briefing failed (no survivors)", () => {
    expect(
      deriveStatus([
        { type: "dadJoke", scope: "shared", status: "failed", error: "gather_failed" },
        { type: "riddle", scope: "shared", status: "failed", error: "gather_failed" },
      ])
    ).toBe("failed");
  });
});
