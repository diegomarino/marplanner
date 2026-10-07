import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LanguageProvider } from "@/i18n";
import { messages } from "@/i18n/messages";
import {
  DailyBriefingView,
  DAY_PERIOD_LABEL_KEYS,
  LEGACY_BLOCK_TITLE_KEYS,
  SCOPE_LABEL_KEYS,
  STATUS_LABEL_KEYS,
} from "@/daily-briefing/DailyBriefingView";
import { NUMBER_FACT_KIND_LABEL_KEYS } from "@/daily-briefing/blockRenderers";
import {
  Role,
  type Briefing,
  type BlockInstance,
  type BriefingReadResult,
  type MemberDTO,
} from "../../src/shared";
import {
  DensityEmptyControlSetError,
  DensityViolationError,
  assertKioskDensityCompliant,
} from "./helpers/density";
import { injectDensityStyles } from "./helpers/densityStyles";

/** docs/features/daily-briefing.md FR-023, US2 AC-4 —, extended by
 * (LAST SURFACE, token dialect, FR-012/FR-009).
 * `@/lib/householdSettings` is mocked so `LanguageProvider` resolves the household language
 * synchronously (the `daily-briefing-weather-block.test.tsx` precedent) — the view's own
 * `/api/settings` fetch (for the household timezone/date) still goes through the mocked
 * `fetch` below.
 * * additions below* are this module's own executable evidence for the verification policy
 * (verification policy): they CALL the frozen density assertion over this surface's
 * rendered control set with kiosk density active, across every reachable state, with an exact
 * control-count census per phase; assert the view's two error states (view-level load failure,
 * per-block "failed" status) are announced through `ErrorNotice`'s live region WITH its own
 * token identity (SC-011); and pin every label map the `as MessageKey` removal created, by
 * ITERATING each map (SC-007).
 * * L2 adoption, recorded once here rather than per assertion* (mirrors
 * `backups-telemetry-admin.test.tsx`'s own documented-non-adoption convention): this is a
 * KIOSK FAMILY surface (mounted by `Shell.tsx`'s composition, never react-router), not an
 * admin panel — `AdminPanel` does not apply (see `DailyBriefingView.tsx`'s own file-header doc
 * comment for the full reasoning). It has no destructive action, pressed-state toggle,
 * checkbox, radio control or weekday list anywhere, so `ConfirmDialog`/`StatusToggle`/
 * `CheckboxField`/`RadioField`/`WeekdayPicker` do not apply either. `ErrorNotice` IS adopted —
 * the one L2 whose admission test this surface's error states actually satisfy — and its
 * adoption is what the SC-011 tests below prove (identity, not just behaviour).
 */
const currentSettings = { timezone: "UTC", language: "en", weekStartDay: 1 };

vi.mock("@/lib/householdSettings", () => ({
  useHouseholdSettings: () => currentSettings,
  useHouseholdSettingsContext: () => currentSettings,
}));

type FetchCall = Parameters<typeof globalThis.fetch>;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

const MEMBER: MemberDTO = {
  id: "m1",
  displayName: "Ada",
  colorKey: "blue",
  role: Role.child,
  lifecycle: "active",
  createdAt: 1,
  updatedAt: 1,
  birthDate: null,
};

const TRIVIA_ANSWER_MARKER = "NEVER-RENDERED-CORRECT-ANSWER";

/** The full 21-type registry, schemaVersion 2 — one realistic fixture per type (data shapes
 * ground-truthed against each generator in `src/server/modules/daily-briefing/blocks/*.ts`). */
function fullRegistryBlocks(): BlockInstance[] {
  return [
    {
      type: "shotgun",
      scope: "shared",
      status: "ok",
      index: 1,
      title: "01 SHOTGUN",
      data: { ranking: ["Ada", "Ben", "Cleo"] },
    },
    {
      type: "message",
      scope: "member",
      status: "ok",
      index: 2,
      title: "02 MESSAGE",
      data: { text: "Have a great day!" },
    },
    {
      type: "streak",
      scope: "member",
      status: "ok",
      index: 3,
      title: "03 STREAK",
      data: { days: 5, label: "5 days strong", last7: [true, true, false, true, true, true, true] },
    },
    {
      type: "today",
      scope: "member",
      status: "ok",
      index: 4,
      title: "04 TODAY",
      data: { bullets: ["Pack lunch", "Feed the dog"] },
    },
    {
      type: "weather",
      scope: "shared",
      status: "ok",
      index: 5,
      title: "05 WEATHER",
      data: { date: "2026-09-04", conditionKey: "clear", tempMinC: 18, tempMaxC: 26, rainPct: 5 },
    },
    // Regression fixture: the OBJECT shape introduced — the prior view code's
    // `Array.isArray` check was false for this shape, rendering an empty placeholder.
    {
      type: "meals",
      scope: "shared",
      status: "ok",
      index: 6,
      title: "06 MEALS",
      data: { lunch: "Pasta Bolognese", snack: "Yogurt", dinner: "Tomato Soup" },
    },
    {
      type: "birthday",
      scope: "member",
      status: "ok",
      index: 7,
      title: "07 BIRTHDAY",
      data: {
        daysUntilOwn: 0,
        ownLabel: "HAPPY BIRTHDAY",
        family: [{ name: "Ben", daysUntil: 12 }],
      },
    },
    // Regression fixture: the `{groups: [...]}` object shape introduced.
    {
      type: "reminders",
      scope: "member",
      status: "ok",
      index: 8,
      title: "08 REMINDERS",
      data: { groups: [{ title: "Morning", items: [{ id: "r1", value: "Brush teeth" }] }] },
    },
    {
      type: "dadJoke",
      scope: "shared",
      status: "ok",
      index: 9,
      title: "09 DAD JOKE",
      data: { text: "Why did the scarecrow win an award? Outstanding in his field." },
    },
    {
      type: "wordOfDay",
      scope: "shared",
      status: "ok",
      index: 10,
      title: "10 WORD OF THE DAY",
      data: {
        word: "Ephemeral",
        type: "adjective",
        definition: "Lasting for a very short time",
        example: "Fame is ephemeral.",
        pronunciation: "ih-FEM-er-uhl",
      },
    },
    {
      type: "animalFact",
      scope: "shared",
      status: "ok",
      index: 11,
      title: "11 ANIMAL FACT",
      data: { text: "Octopuses have three hearts.", animal: "Octopus" },
    },
    {
      type: "numberFact",
      scope: "shared",
      status: "ok",
      index: 12,
      title: "12 NUMBER FACT",
      data: { number: 7, fact: "7 is considered a lucky number in many cultures.", kind: "trivia" },
    },
    {
      type: "onThisDay",
      scope: "shared",
      status: "ok",
      index: 13,
      title: "13 ON THIS DAY",
      data: { events: ["1969: Moon landing"], births: ["1879: Albert Einstein"] },
    },
    {
      type: "quoteOfDay",
      scope: "shared",
      status: "ok",
      index: 14,
      title: "14 QUOTE OF THE DAY",
      data: { text: "Be yourself; everyone else is already taken.", author: "Oscar Wilde" },
    },
    {
      type: "trivia",
      scope: "member",
      status: "ok",
      index: 15,
      title: "15 TRIVIA",
      // `correctAnswer` is NOT part of `TriviaData` (never read into the payload) —
      // included here anyway to prove the renderer never surfaces it even if present in raw data.
      data: {
        question: "What is the capital of France?",
        options: ["Paris", "London", "Berlin"],
        category: "Geography",
        difficulty: "easy",
        correctAnswer: TRIVIA_ANSWER_MARKER,
      },
    },
    {
      type: "riddle",
      scope: "shared",
      status: "ok",
      index: 16,
      title: "16 RIDDLE",
      data: { question: "What has keys but no locks?", answer: "A piano" },
    },
    {
      type: "wouldYouRather",
      scope: "member",
      status: "ok",
      index: 17,
      title: "17 WOULD YOU RATHER...?",
      data: { optionA: "Fly", optionB: "Be invisible" },
    },
    {
      type: "wordSearch",
      scope: "member",
      status: "ok",
      index: 18,
      title: "18 WORD SEARCH",
      data: {
        difficulty: "easy",
        cols: 3,
        rows: 2,
        grid: [
          ["C", "A", "T"],
          ["D", "O", "G"],
        ],
        words: ["CAT", "DOG"],
      },
    },
    {
      type: "drawingPrompt",
      scope: "shared",
      status: "ok",
      index: 19,
      title: "19 DRAWING PROMPT",
      data: { prompt: "Draw your favorite animal", requiresDrawingSpace: true },
    },
    {
      type: "streakText",
      scope: "member",
      status: "ok",
      index: 20,
      title: "20 STREAK TEXT",
      data: {
        days: 3,
        label: "3 days strong",
        last7: [false, true, true, true, false, true, true],
      },
    },
    {
      type: "weatherText",
      scope: "shared",
      status: "ok",
      index: 21,
      title: "21 WEATHER TEXT",
      data: { date: "2026-09-04", conditionKey: "rain", tempMinC: 10, tempMaxC: 14, rainPct: 80 },
    },
  ];
}

function baseBriefing(blocks: BlockInstance[], schemaVersion: 1 | 2 = 2): Briefing {
  return {
    id: "b1",
    memberId: "m1",
    date: "2026-09-04",
    status: "ready",
    payload: {
      schemaVersion,
      member: { id: "m1", displayName: "Ada" },
      date: "2026-09-04",
      blocks,
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

function mockFetchFor(briefing: Briefing) {
  return vi.fn(async (...args: FetchCall) => {
    const [input] = args;
    const url = String(input);
    if (url === "/api/settings") {
      return jsonResponse({ locale: currentSettings });
    }
    if (url === "/api/members?lifecycle=all") {
      return jsonResponse([MEMBER]);
    }
    if (url.startsWith("/api/daily-briefing/")) {
      const result: BriefingReadResult = { generated: true, briefing, printedStatus: "none" };
      return jsonResponse(result);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

function renderView() {
  return render(
    <LanguageProvider>
      <DailyBriefingView />
    </LanguageProvider>
  );
}

describe("DailyBriefingView — full block registry", () => {
  beforeEach(() => {
    currentSettings.timezone = "UTC";
    currentSettings.language = "en";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("renders all 21 registry block types with visible, correct content", async () => {
    vi.stubGlobal("fetch", mockFetchFor(baseBriefing(fullRegistryBlocks())));
    renderView();
    await screen.findByTestId("daily-briefing-view-status");

    const shotgun = screen.getByTestId("daily-briefing-block-shotgun");
    expect(shotgun).toHaveTextContent("01 SHOTGUN");
    expect(shotgun).toHaveTextContent("Ada");
    expect(shotgun).toHaveTextContent("Ben");
    expect(shotgun).toHaveTextContent("Cleo");

    expect(screen.getByTestId("daily-briefing-block-message")).toHaveTextContent(
      "Have a great day!"
    );

    const streak = screen.getByTestId("daily-briefing-block-streak");
    expect(streak).toHaveTextContent("5 days strong");
    expect(within(streak).getByTestId("daily-briefing-streak-last7").children).toHaveLength(7);

    expect(screen.getByTestId("daily-briefing-block-today")).toHaveTextContent("Pack lunch");
    expect(screen.getByTestId("daily-briefing-block-today")).toHaveTextContent("Feed the dog");

    const weather = screen.getByTestId("daily-briefing-block-weather");
    expect(weather).toHaveTextContent("Clear");
    expect(weather).toHaveTextContent("18");
    expect(weather).toHaveTextContent("26");

    // Regression: meals object shape — every slot label + value visible.
    const meals = screen.getByTestId("daily-briefing-block-meals");
    expect(meals).toHaveTextContent("Lunch");
    expect(meals).toHaveTextContent("Pasta Bolognese");
    expect(meals).toHaveTextContent("Snack");
    expect(meals).toHaveTextContent("Yogurt");
    expect(meals).toHaveTextContent("Dinner");
    expect(meals).toHaveTextContent("Tomato Soup");

    const birthday = screen.getByTestId("daily-briefing-block-birthday");
    expect(birthday).toHaveTextContent("HAPPY BIRTHDAY");
    expect(birthday).toHaveTextContent("Ben");
    expect(birthday).toHaveTextContent("12");

    // Regression: reminders groups shape — group title + item value visible.
    const reminders = screen.getByTestId("daily-briefing-block-reminders");
    expect(reminders).toHaveTextContent("Morning");
    expect(reminders).toHaveTextContent("Brush teeth");

    expect(screen.getByTestId("daily-briefing-block-dadJoke")).toHaveTextContent(
      "Outstanding in his field"
    );

    const wordOfDay = screen.getByTestId("daily-briefing-block-wordOfDay");
    expect(wordOfDay).toHaveTextContent("Ephemeral");
    expect(wordOfDay).toHaveTextContent("adjective");
    expect(wordOfDay).toHaveTextContent("Lasting for a very short time");
    expect(wordOfDay).toHaveTextContent("ih-FEM-er-uhl");
    expect(wordOfDay).toHaveTextContent("Fame is ephemeral");

    const animalFact = screen.getByTestId("daily-briefing-block-animalFact");
    expect(animalFact).toHaveTextContent("Octopuses have three hearts");
    expect(animalFact).toHaveTextContent("Octopus");

    const numberFact = screen.getByTestId("daily-briefing-block-numberFact");
    expect(numberFact).toHaveTextContent("7");
    expect(numberFact).toHaveTextContent("lucky number");
    expect(numberFact).toHaveTextContent("Trivia fact");

    const onThisDay = screen.getByTestId("daily-briefing-block-onThisDay");
    expect(onThisDay).toHaveTextContent("Events");
    expect(onThisDay).toHaveTextContent("Moon landing");
    expect(onThisDay).toHaveTextContent("Births");
    expect(onThisDay).toHaveTextContent("Albert Einstein");

    const quoteOfDay = screen.getByTestId("daily-briefing-block-quoteOfDay");
    expect(quoteOfDay).toHaveTextContent("Be yourself");
    expect(quoteOfDay).toHaveTextContent("Oscar Wilde");

    // Trivia: options visible, correct answer NEVER surfaced.
    const trivia = screen.getByTestId("daily-briefing-block-trivia");
    expect(trivia).toHaveTextContent("capital of France");
    expect(trivia).toHaveTextContent("Paris");
    expect(trivia).toHaveTextContent("London");
    expect(trivia).toHaveTextContent("Berlin");
    expect(trivia).not.toHaveTextContent(TRIVIA_ANSWER_MARKER);

    // Riddle: answer present but visually de-emphasized, never rotated.
    const riddle = screen.getByTestId("daily-briefing-block-riddle");
    expect(riddle).toHaveTextContent("keys but no locks");
    const riddleAnswer = within(riddle).getByTestId("daily-briefing-riddle-answer");
    expect(riddleAnswer).toHaveTextContent("A piano");
    expect(riddleAnswer.className).toContain("text-muted-foreground");
    expect(riddleAnswer.className).not.toContain("rotate");
    expect(riddleAnswer.getAttribute("style") ?? "").not.toContain("rotate");

    const wouldYouRather = screen.getByTestId("daily-briefing-block-wouldYouRather");
    expect(wouldYouRather).toHaveTextContent("Fly");
    expect(wouldYouRather).toHaveTextContent("Be invisible");

    // Word search: a flat, structural monospace grid — never the print raster's puzzle styling.
    const wordSearch = screen.getByTestId("daily-briefing-block-wordSearch");
    const grid = within(wordSearch).getByTestId("daily-briefing-wordsearch-grid");
    expect(grid.className).toContain("font-mono");
    expect(grid).toHaveTextContent("C A T");
    expect(grid).toHaveTextContent("D O G");
    expect(wordSearch).toHaveTextContent("CAT");
    expect(wordSearch).toHaveTextContent("DOG");

    expect(screen.getByTestId("daily-briefing-block-drawingPrompt")).toHaveTextContent(
      "Draw your favorite animal"
    );

    // Text-variant twins render identically to their visual counterparts (FR-023 Clarifications).
    const streakText = screen.getByTestId("daily-briefing-block-streakText");
    expect(streakText).toHaveTextContent("3 days strong");
    const weatherText = screen.getByTestId("daily-briefing-block-weatherText");
    expect(weatherText).toHaveTextContent("Rain");
    expect(weatherText).toHaveTextContent("10");
    expect(weatherText).toHaveTextContent("14");
  });

  it("renders an unrecognized/future block type as a quiet fallback — title only, no crash", async () => {
    const futureBlock = {
      type: "someFutureBlockType",
      scope: "shared",
      status: "ok",
      index: 1,
      title: "01 SOME FUTURE BLOCK TYPE",
      data: { anything: "goes-here" },
    } as unknown as BlockInstance;
    vi.stubGlobal("fetch", mockFetchFor(baseBriefing([futureBlock])));

    renderView();
    const block = await screen.findByTestId("daily-briefing-block-someFutureBlockType");
    expect(block).toHaveTextContent("01 SOME FUTURE BLOCK TYPE");
    expect(block).not.toHaveTextContent("goes-here");
  });

  it("backward-renders a schemaVersion-1 (010-era) envelope through the same renderers", async () => {
    const v1Blocks = [
      {
        type: "calendar",
        scope: "shared",
        status: "ok",
        data: [
          {
            id: "e1",
            occurrenceStart: "2026-09-04",
            source: "local",
            title: "Dentist",
            allDay: true,
            assignedTo: [],
          },
        ],
      },
      {
        type: "reminders",
        scope: "member",
        status: "ok",
        data: [{ id: "r1", text: "Water the plants" }],
      },
      {
        type: "chores",
        scope: "member",
        status: "ok",
        data: {
          memberId: "m1",
          displayName: "Ada",
          streak: 0,
          todayProgress: null,
          dayPeriods: [
            {
              id: "morning",
              labelKey: "board.period.morning",
              chores: [{ id: "c1", name: "Make bed", completed: false }],
            },
          ],
        },
      },
      {
        type: "meals",
        scope: "shared",
        status: "ok",
        data: [
          {
            entryId: "me1",
            slot: "lunch",
            label: "Sandwich",
            isTombstone: false,
            source: "oneoff",
          },
        ],
      },
      {
        type: "weather",
        scope: "shared",
        status: "ok",
        data: { date: "2026-09-04", conditionKey: "clear", tempMinC: 18, tempMaxC: 26, rainPct: 5 },
      },
    ] as unknown as BlockInstance[];
    vi.stubGlobal("fetch", mockFetchFor(baseBriefing(v1Blocks, 1)));

    renderView();
    await screen.findByTestId("daily-briefing-view-status");

    expect(screen.getByTestId("daily-briefing-block-calendar")).toHaveTextContent("Dentist");
    expect(screen.getByTestId("daily-briefing-block-reminders")).toHaveTextContent(
      "Water the plants"
    );
    expect(screen.getByTestId("daily-briefing-block-chores")).toHaveTextContent("Make bed");
    expect(screen.getByTestId("daily-briefing-block-meals")).toHaveTextContent("Sandwich");
    // No `.title` on a v1 block — falls back to the legacy translated title.
    expect(screen.getByTestId("daily-briefing-block-weather")).toHaveTextContent("Weather");
  });

  it("renders the new structural labels localized in Spanish", async () => {
    currentSettings.language = "es";
    const blocks: BlockInstance[] = [
      {
        type: "weather",
        scope: "shared",
        status: "ok",
        index: 1,
        title: "01 WEATHER",
        data: { date: "2026-09-04", conditionKey: "clear", tempMinC: 18, tempMaxC: 26, rainPct: 5 },
      },
      {
        type: "riddle",
        scope: "shared",
        status: "ok",
        index: 2,
        title: "02 RIDDLE",
        data: { question: "What has keys but no locks?", answer: "A piano" },
      },
      {
        type: "numberFact",
        scope: "shared",
        status: "ok",
        index: 3,
        title: "03 NUMBER FACT",
        data: { number: 7, fact: "Siete es un número de la suerte.", kind: "trivia" },
      },
    ];
    vi.stubGlobal("fetch", mockFetchFor(baseBriefing(blocks)));

    renderView();
    await screen.findByTestId("daily-briefing-view-status");

    expect(screen.getByTestId("daily-briefing-block-weather")).toHaveTextContent("Mín");
    expect(screen.getByTestId("daily-briefing-block-weather")).toHaveTextContent("Máx");
    expect(screen.getByTestId("daily-briefing-block-riddle")).toHaveTextContent("Respuesta:");
    expect(screen.getByTestId("daily-briefing-block-numberFact")).toHaveTextContent("Dato curioso");
  });

  it("P1 hardening: a malformed block's render-time throw falls back quietly, sibling cards unaffected", async () => {
    // `wordSearch`'s renderer dereferences `data.grid.map(...)` unconditionally — an "ok"
    // status block whose `data` is missing `grid` entirely throws synchronously during render
    // (exactly the shape-mismatch failure mode already proved reaches this view).
    const malformedWordSearch: BlockInstance = {
      type: "wordSearch",
      scope: "member",
      status: "ok",
      index: 1,
      title: "01 WORD SEARCH",
      data: {
        difficulty: "easy",
        cols: 3,
        rows: 2,
        words: ["CAT"],
      } as unknown as BlockInstance["data"],
    };
    const healthyMessage: BlockInstance = {
      type: "message",
      scope: "member",
      status: "ok",
      index: 2,
      title: "02 MESSAGE",
      data: { text: "Sibling card still renders" },
    };
    // `console.error` is banned on the client outside `lib/logger.ts` (INV-06,
    // eslint.config.mjs) — the boundary reports through the shared `log` helper instead;
    // `__peekBufferForTests` is that module's own sanctioned test seam for observing an entry
    // without a real network flush.
    const logger = await import("@/lib/logger");
    logger.__resetLoggerStateForTests();
    vi.stubGlobal("fetch", mockFetchFor(baseBriefing([malformedWordSearch, healthyMessage])));

    renderView();
    await screen.findByTestId("daily-briefing-view-status");

    // The malformed card survives as a card (title visible), with no thrown-error text and no
    // stale/leaked content — the quiet title-only fallback (P1 hardening).
    const wordSearchCard = screen.getByTestId("daily-briefing-block-wordSearch");
    expect(wordSearchCard).toHaveTextContent("01 WORD SEARCH");
    expect(wordSearchCard).not.toHaveTextContent("CAT");
    expect(screen.queryByTestId("daily-briefing-wordsearch-grid")).not.toBeInTheDocument();

    // The OTHER card is completely unaffected — the whole kiosk surface never blanks.
    expect(screen.getByTestId("daily-briefing-block-message")).toHaveTextContent(
      "Sibling card still renders"
    );

    // A diagnostic reaches the shared logger, naming the offending block type.
    const entries = logger.__peekBufferForTests();
    expect(
      entries.some(
        (entry) =>
          entry.level === "error" &&
          entry.component === "daily-briefing-view" &&
          entry.message === "block_render_failed" &&
          (entry.data as { blockType?: string } | undefined)?.blockType === "wordSearch"
      )
    ).toBe(true);
  });
});

/** Mirrors `density.ts`'s own selector/filter — see `chores-board.test.tsx`'s identical helper
 * for why this is duplicated rather than imported (the frozen file exposes no census API by
 * design). Lets THIS spec assert an exact control count per phase, not just "compliant or
 * not". */
const CENSUS_CONTROL_SELECTOR = [
  "button",
  "input",
  "select",
  "textarea",
  "a[href]",
  '[role="button"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="option"]',
  '[role="tab"]',
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

function countInteractiveControls(container: Document | Element): number {
  return Array.from(container.querySelectorAll(CENSUS_CONTROL_SELECTOR)).filter((element) => {
    if (element instanceof HTMLElement && element.hidden) return false;
    return element.getAttribute("aria-hidden") !== "true";
  }).length;
}

function mockFetchLoadingForever() {
  return vi.fn(() => new Promise<Response>(() => {}));
}

function mockFetchMembersFailure() {
  return vi.fn(async (...args: FetchCall) => {
    const [input] = args;
    const url = String(input);
    if (url === "/api/members?lifecycle=all") return new Response(null, { status: 500 });
    throw new Error(`unexpected fetch: ${url}`);
  });
}

function mockFetchNoBriefings() {
  return vi.fn(async (...args: FetchCall) => {
    const [input] = args;
    const url = String(input);
    if (url === "/api/members?lifecycle=all") return jsonResponse([MEMBER]);
    if (url.startsWith("/api/daily-briefing/")) {
      const result: BriefingReadResult = { generated: false };
      return jsonResponse(result);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

const SINGLE_HEALTHY_BLOCK: BlockInstance = {
  type: "message",
  scope: "shared",
  status: "ok",
  index: 1,
  title: "01 MESSAGE",
  data: { text: "Have a great day!" },
};

describe("DailyBriefingView — kiosk density across every reachable state (SC-001, SC-002)", () => {
  beforeEach(() => {
    currentSettings.timezone = "UTC";
    currentSettings.language = "en";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
    document.documentElement.removeAttribute("data-density");
  });

  it("Phase 1 — loading (the /api/members fetch never resolves): zero controls, the frozen helper throws DensityEmptyControlSetError (never a vacuous pass)", async () => {
    vi.stubGlobal("fetch", mockFetchLoadingForever());
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      const { container } = renderView();
      await screen.findByText("Loading today's briefing…");

      expect(countInteractiveControls(container)).toBe(0);
      expect(() => assertKioskDensityCompliant(container)).toThrow(DensityEmptyControlSetError);
    } finally {
      uninject();
    }
  });

  it("Phase 2 — view-level load error: zero controls, DensityEmptyControlSetError, and the error IS announced through ErrorNotice's own identity, not just behaviour (SC-011)", async () => {
    vi.stubGlobal("fetch", mockFetchMembersFailure());
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      const { container } = renderView();
      // IDENTITY, not just behaviour — these are ErrorNotice's own token classes
      // (`ErrorNotice.tsx`); a hand-rolled `<p role="alert">` would satisfy a behaviour-only
      // check without proving the shared component was actually adopted.
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Failed to load today's briefing.");
      expect(alert).toHaveAttribute("aria-live", "assertive");
      expect(alert.className).toMatch(/bg-destructive\/10/);
      expect(alert.className).toMatch(/border-destructive\/40/);

      expect(countInteractiveControls(container)).toBe(0);
      expect(() => assertKioskDensityCompliant(container)).toThrow(DensityEmptyControlSetError);
    } finally {
      uninject();
    }
  });

  it("Phase 3 — no briefings generated today: zero controls, DensityEmptyControlSetError", async () => {
    vi.stubGlobal("fetch", mockFetchNoBriefings());
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      const { container } = renderView();
      await screen.findByText("No briefings have been generated today.");

      expect(countInteractiveControls(container)).toBe(0);
      expect(() => assertKioskDensityCompliant(container)).toThrow(DensityEmptyControlSetError);
    } finally {
      uninject();
    }
  });

  it("Phase 4 — populated: exactly ONE control (the member picker) regardless of block count", async () => {
    vi.stubGlobal("fetch", mockFetchFor(baseBriefing([SINGLE_HEALTHY_BLOCK])));
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      const { container } = renderView();
      await screen.findByTestId("daily-briefing-view-status");

      expect(countInteractiveControls(container)).toBe(1);
      expect(() => assertKioskDensityCompliant(container)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("Phase 5 — a FAILED block still yields exactly ONE control (ErrorNotice adds no interactive control), and the failure is announced through ErrorNotice's own identity (SC-011)", async () => {
    const failedBlock: BlockInstance = {
      type: "quoteOfDay",
      scope: "shared",
      status: "failed",
      index: 1,
      title: "01 QUOTE OF THE DAY",
      error: "timeout",
    };
    vi.stubGlobal("fetch", mockFetchFor(baseBriefing([failedBlock])));
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      const { container } = renderView();
      await screen.findByTestId("daily-briefing-view-status");

      const card = screen.getByTestId("daily-briefing-block-quoteOfDay");
      const alert = within(card).getByRole("alert");
      expect(alert).toHaveTextContent("This section is unavailable.");
      expect(alert).toHaveAttribute("aria-live", "assertive");
      expect(alert.className).toMatch(/bg-destructive\/10/);
      expect(alert.className).toMatch(/border-destructive\/40/);

      expect(countInteractiveControls(container)).toBe(1);
      expect(() => assertKioskDensityCompliant(container)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("DELIBERATE NEGATIVE — forcing this surface's own member picker below the kiosk minimum makes the assertion fail, and reverting restores compliance", async () => {
    vi.stubGlobal("fetch", mockFetchFor(baseBriefing([SINGLE_HEALTHY_BLOCK])));
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      const { container } = renderView();
      await screen.findByTestId("daily-briefing-view-status");
      const picker = screen.getByTestId("daily-briefing-member-picker");

      // A real control from this surface, not a synthetic fixture.
      picker.style.height = "20px";
      picker.style.fontSize = "10px";

      let thrown: unknown;
      try {
        assertKioskDensityCompliant(container);
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(DensityViolationError);
      const message = (thrown as DensityViolationError).message;
      expect(message).toMatch(/height 20px is below the kiosk minimum 48px/);
      expect(message).toMatch(/font-size 10px is below the kiosk minimum 18px/);

      // Revert — compliance returns.
      picker.style.height = "";
      picker.style.fontSize = "";
      expect(() => assertKioskDensityCompliant(container)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("the census is not decorative — hiding the real member picker drops the count from 1 to 0, and restoring it returns to 1", async () => {
    vi.stubGlobal("fetch", mockFetchFor(baseBriefing([SINGLE_HEALTHY_BLOCK])));
    const { container } = renderView();
    await screen.findByTestId("daily-briefing-view-status");

    const picker = screen.getByTestId("daily-briefing-member-picker");
    expect(countInteractiveControls(container)).toBe(1);

    // A census that failed to actually recompute (a stale/memoized count) would still read 1.
    picker.setAttribute("aria-hidden", "true");
    expect(countInteractiveControls(container)).toBe(0);

    picker.removeAttribute("aria-hidden");
    expect(countInteractiveControls(container)).toBe(1);
  });
});

// --- Label maps: every entry pinned, mechanically ---------------------------------------------
//
// Dropping an `as MessageKey` cast in favour of a hand-transcribed map is what SC-007 asks for,
// and it TRADES ONE RISK FOR ANOTHER: `t(\`dailyBriefing.scope.${scope}\`)` was correct BY
// CONSTRUCTION, while a hand-transcribed `Record<K, MessageKey>` is correct only if someone
// typed it right — the type proves every key is present and every value is *a* message key,
// never the pairing (measured in: a swapped `breakfast`/`lunch` entry ships wrong
// headings and passes the whole client suite, tsc, eslint, the debt counter AND the e2e).
// ITERATE, never hand-write the expectations.
//
// `SLOT_LABEL_KEYS` (`@/meals/MealsBoard`) and `WEATHER_CONDITION_LABEL_KEYS`
// (`@/home/WeatherPill`) are reused here rather than redeclared — both are ALREADY pinned by
// `family-surfaces.test.tsx`, so re-asserting them here would duplicate, not add,
// coverage. Only the maps THIS batch actually created are pinned below.
describe("DailyBriefingView / blockRenderers — label maps are transcribed correctly (SC-007)", () => {
  it("LEGACY_BLOCK_TITLE_KEYS maps each schemaVersion-1 legacy block type to its own key", () => {
    const keys = Object.keys(LEGACY_BLOCK_TITLE_KEYS) as (keyof typeof LEGACY_BLOCK_TITLE_KEYS)[];
    expect(keys.length).toBe(5);
    for (const type of keys) {
      expect(LEGACY_BLOCK_TITLE_KEYS[type], `type "${type}" maps to the wrong key`).toBe(
        `dailyBriefing.block.${type}`
      );
    }
  });

  it("SCOPE_LABEL_KEYS maps each of the two block scopes to its own key", () => {
    const keys = Object.keys(SCOPE_LABEL_KEYS) as (keyof typeof SCOPE_LABEL_KEYS)[];
    expect(keys.length).toBe(2);
    for (const scope of keys) {
      expect(SCOPE_LABEL_KEYS[scope], `scope "${scope}" maps to the wrong key`).toBe(
        `dailyBriefing.scope.${scope}`
      );
    }
  });

  it("STATUS_LABEL_KEYS maps each of the five briefing statuses to its own key", () => {
    const keys = Object.keys(STATUS_LABEL_KEYS) as (keyof typeof STATUS_LABEL_KEYS)[];
    expect(keys.length).toBe(5);
    for (const status of keys) {
      expect(STATUS_LABEL_KEYS[status], `status "${status}" maps to the wrong key`).toBe(
        `dailyBriefing.status.${status}`
      );
    }
  });

  it("DAY_PERIOD_LABEL_KEYS maps each of the four fixed day periods to its own key", () => {
    const keys = Object.keys(DAY_PERIOD_LABEL_KEYS) as (keyof typeof DAY_PERIOD_LABEL_KEYS)[];
    expect(keys.length).toBe(4);
    for (const period of keys) {
      expect(DAY_PERIOD_LABEL_KEYS[period], `period "${period}" maps to the wrong key`).toBe(
        `dayPeriod.${period}`
      );
    }
  });

  it("NUMBER_FACT_KIND_LABEL_KEYS maps each of the two number-fact kinds to its own key", () => {
    const keys = Object.keys(
      NUMBER_FACT_KIND_LABEL_KEYS
    ) as (keyof typeof NUMBER_FACT_KIND_LABEL_KEYS)[];
    expect(keys.length).toBe(2);
    for (const kind of keys) {
      expect(NUMBER_FACT_KIND_LABEL_KEYS[kind], `kind "${kind}" maps to the wrong key`).toBe(
        `dailyBriefing.view.numberFact.${kind}`
      );
    }
  });

  it("every mapped key resolves to a non-empty string in BOTH locales", () => {
    const allMaps: Record<string, keyof typeof messages.en>[] = [
      LEGACY_BLOCK_TITLE_KEYS,
      SCOPE_LABEL_KEYS,
      STATUS_LABEL_KEYS,
      DAY_PERIOD_LABEL_KEYS,
      NUMBER_FACT_KIND_LABEL_KEYS,
    ];
    for (const map of allMaps) {
      for (const key of Object.values(map)) {
        expect(messages.en[key], `${key} missing in en`).toBeTruthy();
        expect(messages.es[key], `${key} missing in es`).toBeTruthy();
      }
    }
  });
});
