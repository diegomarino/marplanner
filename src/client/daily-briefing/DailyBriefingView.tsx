import { DAY_PERIOD_LABEL_KEYS } from "@/lib/day-period-labels";
export { DAY_PERIOD_LABEL_KEYS } from "@/lib/day-period-labels";
import { Component, useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { authFetch } from "@/lib/credential";
import { useHouseholdSettings } from "@/lib/householdSettings";
import { log } from "@/lib/logger";
import { useTranslation } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorNotice } from "@/components/ErrorNotice";
import { NATIVE_SELECT_CLASSES } from "@/lib/recipes";
import { SLOT_LABEL_KEYS } from "@/meals/MealsBoard";
import type {
  BlockInstance,
  BlockScope,
  BlockType,
  BoardColumn,
  Briefing,
  BriefingReadResult,
  BriefingStatus,
  FeedItem,
  ForecastDay,
  MemberDTO,
  MenuItem,
  ReminderEmission,
} from "../../shared";
import {
  AnimalFactBlock,
  BirthdayBlock,
  displayText,
  DrawingPromptBlock,
  MealsBlock,
  NumberFactBlock,
  OnThisDayBlock,
  QuoteOfDayBlock,
  RemindersBlock,
  RiddleBlock,
  ShotgunBlock,
  StreakBlock,
  TextList,
  TextOnlyBlock,
  TodayBlock,
  TriviaBlock,
  WeatherBlock,
  WeatherTextBlock,
  WordOfDayBlock,
  PhonicsBlock,
  WordSearchBlock,
  WouldYouRatherBlock,
  type AnimalFactData,
  type BirthdayData,
  type DrawingPromptData,
  type MealsV2Data,
  type NumberFactData,
  type OnThisDayData,
  type QuoteOfDayData,
  type RemindersV2Data,
  type RiddleData,
  type ShotgunData,
  type StreakData,
  type TextOnlyData,
  type TodayData,
  type TriviaData,
  type WordOfDayData,
  type PhonicsData,
  type WordSearchData,
  type WouldYouRatherData,
} from "./blockRenderers";

/** Household-today as YYYY-MM-DD in the configured IANA timezone. */
function todayInTimezone(timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
}

// ─── Label maps (SC-007) ───────────────────────────────────────────────────────────────────
// Every `as MessageKey` cast this file used to carry is replaced by a typed `Record<K,
// MessageKey>` indexed off a closed union, pinned by ITERATION in this module's own spec
// (`tests/client/daily-briefing-view.test.tsx`) — see that file for why iteration, not a
// hand-written expectation list, is what SC-007 actually asks for.

/** schemaVersion-1 rows (010-era) use only this five-type legacy vocabulary and carry no
 * `title` at all (see `blockTitle` below) — `BlockType` has 22 members but only these five
 * ever reach the untitled fallback path (backward-read, INV-01), so this map is typed over
 * the closed LEGACY subset rather than the full union: the other 17 members have no
 * `dailyBriefing.block.*` catalogue entry at all (schemaVersion-2 rows always carry a
 * server-stamped `title`, so they never need one).
 */
type LegacyBlockType = "calendar" | "chores" | "meals" | "reminders" | "weather";

export const LEGACY_BLOCK_TITLE_KEYS: Record<LegacyBlockType, MessageKey> = {
  calendar: "dailyBriefing.block.calendar",
  chores: "dailyBriefing.block.chores",
  meals: "dailyBriefing.block.meals",
  reminders: "dailyBriefing.block.reminders",
  weather: "dailyBriefing.block.weather",
};

function isLegacyBlockType(type: BlockType): type is LegacyBlockType {
  return Object.prototype.hasOwnProperty.call(LEGACY_BLOCK_TITLE_KEYS, type);
}

/** Maps each of the two block scopes to its own translation key — `BlockScope`
 * (`shared/dailyBriefing.ts`) is a closed two-member union, so this indexes it exhaustively
 * rather than casting the interpolated template string. */
export const SCOPE_LABEL_KEYS: Record<BlockScope, MessageKey> = {
  shared: "dailyBriefing.scope.shared",
  member: "dailyBriefing.scope.member",
};

/** Maps each of the five possible briefing statuses to its own translation key —
 * `BriefingStatus` (`shared/dailyBriefing.ts`) is a closed union. */
export const STATUS_LABEL_KEYS: Record<BriefingStatus, MessageKey> = {
  pending: "dailyBriefing.status.pending",
  ready: "dailyBriefing.status.ready",
  partial: "dailyBriefing.status.partial",
  failed: "dailyBriefing.status.failed",
  "render-failed": "dailyBriefing.status.render-failed",
};

/** Maps each of the four fixed day periods to its own translation key — mirrors
 * `ChoresBoard.tsx`'s own `DAY_PERIOD_LABEL_KEYS` (not exported there, so duplicated here
 * rather than imported; see that file's doc comment for why indexing `period.id` —
 * DB-schema-enforced and already typed `PeriodId`, `shared/index.ts`'s `BoardDayPeriod` —
 * replaces trusting the server-supplied `labelKey` string). Used only by the schemaVersion-1
 * "chores" legacy render path in `BlockData` below. */

/** schemaVersion-2 rows carry a server-stamped `title` ("NN TITLE") on every
 * block instance, re-derived from the CURRENT effective order on every generation — rendered
 * verbatim, never translated (the print raster shares the exact same English title, FR-023).
 * schemaVersion-1 rows (010-era: calendar/reminders/chores/meals/weather) carry no `title` at
 * all, so those fall back to the legacy per-type translation key (backward-read, INV-01).
 */
function blockTitle(block: BlockInstance, t: (key: MessageKey) => string): string {
  if (block.title) return block.title;
  // A non-legacy type reaching here (no title AND not one of the five legacy types) is
  // unreachable in practice — every schemaVersion-2 block always carries a stamped `title`,
  // and schemaVersion-1 rows only ever use the five legacy types. The empty string is a
  // defensive default, never an observed behaviour.
  return isLegacyBlockType(block.type) ? t(LEGACY_BLOCK_TITLE_KEYS[block.type]) : "";
}

interface BlockErrorBoundaryProps {
  blockType: string;
  children: ReactNode;
}

interface BlockErrorBoundaryState {
  hasError: boolean;
}

/** P1 hardening: a malformed `ok`-status block's `data` must never blank
 * the WHOLE kiosk surface — every renderer in `blockRenderers.tsx` dereferences its `data`
 * unconditionally (e.g. `data.grid.map`), and the reminders/meals finding already proved
 * a shape mismatch reaches this view in production.
 * A plain `try { return <BlockData.../> } catch {}` around JSX does NOT catch this: JSX is
 * just `React.createElement(...)`, which returns a plain descriptor object without invoking
 * the component — the actual function call (where a malformed-data throw happens) runs later,
 * inside React's own reconciler, in a call frame outside any try/catch written in THIS
 * component's body. Only a class component's `getDerivedStateFromError`/`componentDidCatch`
 * (or an equivalent React-provided mechanism) observes a descendant's render-time throw — the
 * long-standing reason Error Boundaries are classes, not a try/catch idiom. Verified directly
 * by `tests/client/daily-briefing-view.test.tsx`'s "a malformed block renders the quiet
 * fallback, sibling cards unaffected" case (a naive try/catch version of this fold does NOT
 * pass that test).
 */
class BlockErrorBoundary extends Component<BlockErrorBoundaryProps, BlockErrorBoundaryState> {
  state: BlockErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): BlockErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown): void {
    // INV-06 (this repo's client-console lint gate, eslint.config.mjs): raw `console.*` is
    // banned everywhere on the client except `lib/logger.ts` itself — `log` is the sanctioned
    // path, and its DEV-only mirror (`mirrorToConsole`) is what actually reaches the console
    // with an English diagnostic, exactly like a direct `console.error` would in dev.
    log("error", "daily-briefing-view", "block_render_failed", {
      blockType: this.props.blockType,
      error: String(error),
    });
  }

  render(): ReactNode {
    // Quiet title-only fallback (same contract as BlockData's own unknown-type default): the
    // card's title already rendered in BriefingBlock's CardHeader, outside this boundary.
    if (this.state.hasError) return null;
    return this.props.children;
  }
}

function BriefingBlock({ block }: { block: BlockInstance }): React.JSX.Element {
  const { t } = useTranslation();

  return (
    <Card data-testid={`daily-briefing-block-${block.type}`} className="gap-3 py-4">
      <CardHeader className="flex flex-row items-center justify-between gap-3 px-4">
        <CardTitle className="text-xl">{blockTitle(block, t)}</CardTitle>
        <span className="text-sm text-muted-foreground">{t(SCOPE_LABEL_KEYS[block.scope])}</span>
      </CardHeader>

      <CardContent className="px-4">
        {block.status === "failed" ? (
          <ErrorNotice message={t("dailyBriefing.block.failed")} />
        ) : (
          <BlockErrorBoundary blockType={block.type}>
            <BlockData type={block.type} data={block.data} />
          </BlockErrorBoundary>
        )}
      </CardContent>
    </Card>
  );
}

/** Dispatch by block type — flat structural rendering (FR-023). Every case below reads the
 * RAW envelope `data` (see blockRenderers.tsx's header doc for the shape provenance). An
 * unrecognized/future type quietly falls through to the default: no content, no crash — the
 * block's title (already rendered by `BriefingBlock` above) is the only thing shown.
 */
function BlockData({ type, data }: Pick<BlockInstance, "type" | "data">): React.JSX.Element {
  const { t } = useTranslation();

  switch (type as BlockType) {
    // ── Retired tracer names — schemaVersion 1 rows only (backward-read, INV-01) ──
    case "calendar": {
      const items = Array.isArray(data) ? (data as FeedItem[]) : [];
      return <TextList items={items.map((item) => displayText(item.title, item.id))} />;
    }
    case "chores": {
      const board = data as BoardColumn | undefined;
      if (!board?.dayPeriods) return <TextList items={[]} />;
      const chores = board.dayPeriods.flatMap((period) =>
        period.chores.map(
          (chore) => `${t(DAY_PERIOD_LABEL_KEYS[period.id])}: ${displayText(chore.name, chore.id)}`
        )
      );
      return <TextList items={chores} />;
    }

    // ── "reminders"/"meals" carry BOTH shapes depending on schemaVersion: a v1 row still
    // stores the flat array the 010 tracer wrote (never rewritten, INV-01); a v2 row stores
    // the object shape introduced. `Array.isArray` discriminates the two (finding —
    // the prior code always assumed the flat shape, rendering every v2 household's TODAY
    // reminders/meals as an empty placeholder). ──
    case "reminders":
      if (Array.isArray(data)) {
        const items = data as ReminderEmission[];
        return <TextList items={items.map((item) => displayText(item.text, item.id))} />;
      }
      return <RemindersBlock data={data as RemindersV2Data} />;
    case "meals":
      if (Array.isArray(data)) {
        const items = data as MenuItem[];
        return (
          <TextList
            items={items.map(
              (item) =>
                `${t(SLOT_LABEL_KEYS[item.slot])}: ${
                  item.isTombstone
                    ? t("meals.menu.tombstoneLabel")
                    : displayText(item.label, item.entryId)
                }`
            )}
          />
        );
      }
      return <MealsBlock data={data as MealsV2Data} />;

    // ── The 21-block registry, verbatim from ALL_BLOCK_TYPES ──
    case "shotgun":
      return <ShotgunBlock data={data as ShotgunData} />;
    case "message":
    case "dadJoke":
      return <TextOnlyBlock data={data as TextOnlyData} />;
    case "streak":
    case "streakText":
      return <StreakBlock data={data as StreakData} />;
    case "today":
      return <TodayBlock data={data as TodayData} />;
    case "weather":
      return <WeatherBlock data={data as ForecastDay} />;
    case "weatherText":
      return <WeatherTextBlock data={data as ForecastDay} />;
    case "birthday":
      return <BirthdayBlock data={data as BirthdayData} />;
    case "wordOfDay":
      return <WordOfDayBlock data={data as WordOfDayData} />;
    case "phonics":
      return <PhonicsBlock data={data as PhonicsData} />;
    case "animalFact":
      return <AnimalFactBlock data={data as AnimalFactData} />;
    case "numberFact":
      return <NumberFactBlock data={data as NumberFactData} />;
    case "onThisDay":
      return <OnThisDayBlock data={data as OnThisDayData} />;
    case "quoteOfDay":
      return <QuoteOfDayBlock data={data as QuoteOfDayData} />;
    case "trivia":
      return <TriviaBlock data={data as TriviaData} />;
    case "riddle":
      return <RiddleBlock data={data as RiddleData} />;
    case "wouldYouRather":
      return <WouldYouRatherBlock data={data as WouldYouRatherData} />;
    case "wordSearch":
      return <WordSearchBlock data={data as WordSearchData} />;
    case "drawingPrompt":
      return <DrawingPromptBlock data={data as DrawingPromptData} />;
    default:
      // Unknown/future block type (FR-023): quiet generic fallback — title only, no crash.
      return <></>;
  }
}

/** Family-facing, read-only Daily Briefing surface. The API has no list route
 * for generated snapshots, so the view enumerates the existing member list
 * and performs the contract's pure member/date reads to build its picker.
 * (LAST SURFACE, token dialect, FR-012/FR-009): this is the kiosk family
 * surface — mounted by `Shell.tsx`'s composition, never react-router, wrapped in
 * `LanguageProvider` — not an admin panel, so the admin-shaped L2 set does NOT apply here,
 * recorded once rather than per line:
 * - `AdminPanel` — its region+heading frame targets an ADMIN panel's chrome
 * (`admin/*Management.tsx`); this view already has its own `<section data-testid=
 * "daily-briefing-view">` + `<h1>` structure, which is the correct shape for a
 * kiosk-mounted family read, not an admin panel.
 * - `ConfirmDialog`/`StatusToggle`/`CheckboxField`/`RadioField`/`WeekdayPicker` — this
 * surface is entirely READ-ONLY (a member picker plus static block cards); it has no
 * destructive action, pressed-state toggle, checkbox, radio or weekday list anywhere.
 * - `ErrorNotice` (`@/components/ErrorNotice`) IS adopted — the one L2 component whose
 * admission test this surface's own error states actually satisfy (SC-011): both the
 * view-level load failure and a per-block "failed" status now route through it, closing
 * the grandfathered debt this file used to carry.
 */
export function DailyBriefingView(): React.JSX.Element {
  const { t } = useTranslation();
  // US0 hoist: household timezone from the shared `useHouseholdSettings` context
  // (one `/api/settings` fetch per boot, `Shell.tsx`) instead of an ad-hoc GET here.
  const { timezone: householdTimezone } = useHouseholdSettings();
  const [timezone, setTimezone] = useState<string | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [availableBriefings, setAvailableBriefings] = useState<Briefing[] | null>(null);
  const [selectedMemberId, setSelectedMemberId] = useState("");
  const [selectedBriefing, setSelectedBriefing] = useState<Briefing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const availabilityRequestId = useRef(0);
  const selectionRequestId = useRef(0);

  const readBriefing = useCallback(
    async (memberId: string, forDate: string, signal?: AbortSignal) => {
      const response = await authFetch(
        `/api/daily-briefing/${encodeURIComponent(memberId)}/${encodeURIComponent(forDate)}`,
        { credentials: "include", signal }
      );
      if (!response.ok) throw new Error(`daily briefing: ${response.status}`);
      return (await response.json()) as BriefingReadResult;
    },
    []
  );

  const loadAvailableBriefings = useCallback(
    async (forDate: string, signal?: AbortSignal): Promise<void> => {
      const requestId = ++availabilityRequestId.current;
      // Include archived members so a frozen snapshot remains selectable after
      // its member is archived (tolerant read; generation itself stays strict).
      const response = await authFetch("/api/members?lifecycle=all", {
        credentials: "include",
        signal,
      });
      if (!response.ok) throw new Error(`members: ${response.status}`);
      const members = (await response.json()) as MemberDTO[];
      const reads = await Promise.all(
        members.map(async (member) => {
          const result = await readBriefing(member.id, forDate, signal);
          return result.generated ? result.briefing : null;
        })
      );

      if (requestId !== availabilityRequestId.current) return;
      const generated = reads.filter((briefing): briefing is Briefing => briefing !== null);
      setAvailableBriefings(generated);
      setSelectedMemberId((previous) => {
        if (generated.some((briefing) => briefing.memberId === previous)) return previous;
        return generated[0]?.memberId ?? "";
      });
    },
    [readBriefing]
  );

  useEffect(() => {
    if (householdTimezone === null) return;
    setTimezone(householdTimezone);
    setDate(todayInTimezone(householdTimezone));
  }, [householdTimezone]);

  useEffect(() => {
    if (date === null) return;
    const controller = new AbortController();
    setAvailableBriefings(null);
    setSelectedBriefing(null);
    setError(null);
    void loadAvailableBriefings(date, controller.signal).catch((cause: unknown) => {
      if ((cause as Error).name !== "AbortError") setError(t("dailyBriefing.view.error"));
    });
    return () => controller.abort();
  }, [date, loadAvailableBriefings, t]);

  useEffect(() => {
    if (date === null || selectedMemberId.length === 0) return;
    const controller = new AbortController();
    const requestId = ++selectionRequestId.current;
    setSelectedBriefing(null);
    void readBriefing(selectedMemberId, date, controller.signal)
      .then((result) => {
        if (requestId === selectionRequestId.current) {
          setSelectedBriefing(result.generated ? result.briefing : null);
        }
      })
      .catch((cause: unknown) => {
        if ((cause as Error).name !== "AbortError") setError(t("dailyBriefing.view.error"));
      });
    return () => controller.abort();
  }, [date, readBriefing, selectedMemberId, t]);

  useEffect(() => {
    if (timezone === null) return;
    const interval = setInterval(() => {
      const today = todayInTimezone(timezone);
      if (today !== date) setDate(today);
    }, 60_000);
    return () => clearInterval(interval);
  }, [date, timezone]);

  if (error) {
    return (
      <section className="p-6" data-testid="daily-briefing-view">
        <h1 className="mb-2 text-2xl font-bold">{t("dailyBriefing.view.title")}</h1>
        <ErrorNotice message={error} />
      </section>
    );
  }

  if (availableBriefings === null) {
    return (
      <section className="p-6" data-testid="daily-briefing-view">
        <h1 className="mb-2 text-2xl font-bold">{t("dailyBriefing.view.title")}</h1>
        <p className="text-muted-foreground">{t("dailyBriefing.view.loading")}</p>
      </section>
    );
  }

  if (availableBriefings.length === 0) {
    return (
      <section className="p-6" data-testid="daily-briefing-view">
        <h1 className="mb-2 text-2xl font-bold">{t("dailyBriefing.view.title")}</h1>
        <p className="text-muted-foreground">{t("dailyBriefing.view.noBriefingsToday")}</p>
      </section>
    );
  }

  return (
    <section className="p-6" data-testid="daily-briefing-view">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{t("dailyBriefing.view.title")}</h1>
          {date && <p className="text-sm text-muted-foreground">{date}</p>}
        </div>
        <label className="flex flex-col gap-1 text-sm">
          {t("dailyBriefing.view.member")}
          <select
            data-testid="daily-briefing-member-picker"
            value={selectedMemberId}
            onChange={(event) => setSelectedMemberId(event.target.value)}
            className={cn(NATIVE_SELECT_CLASSES, "min-w-48")}
          >
            {availableBriefings.map((briefing) => (
              <option key={briefing.memberId} value={briefing.memberId}>
                {briefing.payload.member.displayName}
              </option>
            ))}
          </select>
        </label>
      </div>

      {selectedBriefing === null ? (
        <p className="text-muted-foreground">{t("dailyBriefing.view.loading")}</p>
      ) : (
        <>
          <p className="mb-4 text-sm" data-testid="daily-briefing-view-status" aria-live="polite">
            {t("dailyBriefing.view.status")}: {t(STATUS_LABEL_KEYS[selectedBriefing.status])}
          </p>
          {selectedBriefing.payload.blocks.length === 0 ? (
            <p className="text-muted-foreground">{t("dailyBriefing.view.emptyBlocks")}</p>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {selectedBriefing.payload.blocks.map((block, index) => (
                // Keying on `selectedBriefing.id` (stable per member/date, INV-02) — not just
                // `type`+`index` — remounts every card (and its BlockErrorBoundary) fresh on a
                // member/date switch, so a tripped error boundary for one member's malformed
                // block can never bleed into another member's otherwise-healthy briefing.
                <BriefingBlock
                  key={`${selectedBriefing.id}-${block.type}-${index}`}
                  block={block}
                />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
