// ─────────────────────────────────────────────────────────────────────
// Daily Briefing kiosk view — per-block-type renderers.
//
// Flat structural rendering per docs/features/daily-briefing.md FR-023 +
// Clarifications: each block's content renders faithfully but the view never replicates
// print styling — the word search is a plain monospace character grid, the riddle answer
// renders inline visually de-emphasized (no rotation, no interactivity), and the
// text-variant twins (streakText/weatherText) render identically to their visual
// counterparts. The printable raster is never embedded here — it may not exist at all
// (DAILY-BRIEFING-AC-05).
//
// Data shapes below are the RAW envelope `block.data` payloads, ground-truthed against each
// generator's own return type in `src/server/modules/daily-briefing/blocks/*.ts` (NOT the
// print-pipeline's `render/adapter.ts`, which adapts the SAME field names for every type
// except "weather"/"weatherText" — those two carry a `ForecastDay`, shared/weather.ts,
// verbatim from `blocks/weather.ts`, since the adapter's "weather" case belongs to a
// different, not-yet-wired consumer). These interfaces are declared locally (not imported
// from `src/server/* `) — the client never imports server-side modules (import-boundary).
// ─────────────────────────────────────────────────────────────────────
import { useTranslation } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";
import { formatDayLabel } from "@/home/weatherFormat";
import { WEATHER_CONDITION_LABEL_KEYS } from "@/home/WeatherPill";
import { SLOT_LABEL_KEYS } from "@/meals/MealsBoard";
import { NotoEmoji } from "@/chores/noto-emoji";
import type { BriefingMealItem, ForecastDay } from "../../shared";

/** A single non-empty string, or `fallback` (an id) when the value is missing/blank. */
export function displayText(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim().length > 0) return value;
  return fallback;
}

/** Renders `items` as a bulleted list, or the shared "nothing to show" placeholder when empty. */
export function TextList({ items }: { items: string[] }): React.JSX.Element {
  const { t } = useTranslation();
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("dailyBriefing.block.empty")}</p>;
  }

  return (
    <ul className="space-y-1 text-base">
      {items.map((item, index) => (
        <li key={`${item}-${index}`}>{item}</li>
      ))}
    </ul>
  );
}

export interface ShotgunData {
  ranking: string[];
}

export interface TextOnlyData {
  text: string;
}

export interface StreakData {
  days: number;
  label: string;
  last7: boolean[];
}

export interface TodayData {
  bullets: string[];
}

export interface MealsV2Data {
  lunch?: BriefingMealItem[] | string;
  snack?: BriefingMealItem[] | string;
  dinner?: BriefingMealItem[] | string;
}

export interface BirthdayFamilyEntry {
  name: string;
  daysUntil: number;
}

export interface BirthdayData {
  daysUntilOwn?: number;
  ownLabel?: string;
  family: BirthdayFamilyEntry[];
}

/** `emojis` marks an image reminder (for pre-readers); `value` is then its optional description. */
export interface ReminderItemV2 {
  id?: string;
  value: string;
  emojis?: string[];
}

export interface ReminderGroupV2 {
  title?: string;
  separator?: string;
  items: ReminderItemV2[];
}

export interface RemindersV2Data {
  groups: ReminderGroupV2[];
}

export interface WordOfDayData {
  word: string;
  type: string;
  definition: string;
  example: string | null;
  pronunciation?: string;
}

export interface AnimalFactData {
  text: string;
  animal: string;
}

export interface NumberFactData {
  number: number;
  fact: string;
  kind: "math" | "trivia";
}

export interface OnThisDayData {
  events?: string[];
  births?: string[];
  deaths?: string[];
}

export interface QuoteOfDayData {
  text: string;
  author: string;
}

export interface TriviaData {
  question: string;
  options: string[];
  category: string;
  difficulty: string;
}

export interface RiddleData {
  question: string;
  answer: string;
}

export interface WouldYouRatherData {
  optionA: string;
  optionB: string;
}

export interface WordSearchData {
  difficulty: string;
  cols: number;
  rows: number;
  grid: string[][];
  words: string[];
}

export interface DrawingPromptData {
  prompt: string;
  requiresDrawingSpace: boolean;
}

/** Maps `NumberFactData`'s closed `kind` union to its own translation key (SC-007) — replaces
 * the `as MessageKey` cast a local `kindKey` variable used to need, since `data.kind` is a
 * two-member closed union, not an arbitrary string. Pinned by ITERATION in this module's own
 * spec (`tests/client/daily-briefing-view.test.tsx`). */
export const NUMBER_FACT_KIND_LABEL_KEYS: Record<NumberFactData["kind"], MessageKey> = {
  math: "dailyBriefing.view.numberFact.math",
  trivia: "dailyBriefing.view.numberFact.trivia",
};

/** `message` and `dadJoke` share the same `{text}` shape — one plain paragraph. */
export function TextOnlyBlock({ data }: { data: TextOnlyData }): React.JSX.Element {
  return <p className="text-base">{data.text}</p>;
}

export function ShotgunBlock({ data }: { data: ShotgunData }): React.JSX.Element {
  return (
    <ol className="list-inside list-decimal space-y-1 text-base">
      {data.ranking.map((name, index) => (
        <li key={`${name}-${index}`}>{name}</li>
      ))}
    </ol>
  );
}

/** `streak` and its text-only twin `streakText` render identically (FR-023 Clarifications). */
export function StreakBlock({ data }: { data: StreakData }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div>
      <p className="text-base">{data.label}</p>
      <div className="mt-2 flex gap-1" data-testid="daily-briefing-streak-last7">
        {data.last7.map((done, index) => (
          <span
            key={index}
            title={t(
              done ? "dailyBriefing.view.streakDayDone" : "dailyBriefing.view.streakDayMissed"
            )}
            className={done ? "text-base" : "text-base text-muted-foreground/50"}
          >
            {done ? "●" : "○"}
          </span>
        ))}
      </div>
    </div>
  );
}

export function TodayBlock({ data }: { data: TodayData }): React.JSX.Element {
  return <TextList items={data.bullets} />;
}

/** `weather` and its text-only twin `weatherText` render identically (FR-023 Clarifications). */
export function WeatherBlock({ data }: { data: ForecastDay }): React.JSX.Element {
  const { t, language } = useTranslation();
  return (
    <p className="text-base">
      {formatDayLabel(data.date, language)} — {t(WEATHER_CONDITION_LABEL_KEYS[data.conditionKey])} —{" "}
      {t("dailyBriefing.view.weatherMin")} {Math.round(data.tempMinC)}° /{" "}
      {t("dailyBriefing.view.weatherMax")} {Math.round(data.tempMaxC)}° — {data.rainPct}%
    </p>
  );
}

/** Render structured meal slots and existing scalar snapshots without rewriting either. */
export function MealsBlock({ data }: { data: MealsV2Data }): React.JSX.Element {
  const { t } = useTranslation();
  const items: string[] = [];
  for (const slot of ["lunch", "snack", "dinner"] as const) {
    const entries = data[slot];
    if (entries === undefined) continue;
    const label =
      typeof entries === "string" ? entries : entries.map((item) => item.label).join(", ");
    items.push(`${t(SLOT_LABEL_KEYS[slot])}: ${label}`);
  }
  return <TextList items={items} />;
}

export function BirthdayBlock({ data }: { data: BirthdayData }): React.JSX.Element {
  const { t } = useTranslation();
  const familyItems = data.family.map((entry) => {
    const suffix =
      entry.daysUntil === 0
        ? t("dailyBriefing.view.birthdayToday")
        : `${t("dailyBriefing.view.birthdayIn")} ${entry.daysUntil} ${t(
            "dailyBriefing.view.birthdayDaysSuffix"
          )}`;
    return `${entry.name} — ${suffix}`;
  });
  return (
    <div>
      {data.ownLabel ? <p className="text-base font-semibold">{data.ownLabel}</p> : null}
      {data.family.length > 0 ? <TextList items={familyItems} /> : null}
    </div>
  );
}

/** schemaVersion-2 "reminders" shape — `{groups: [{title?, items: [{value}]}]}`, fixing the
 * empty-render bug where `Array.isArray(data)` was false for this object shape. */
/** Size of an image reminder's emojis on screen: big enough for a pre-reader to recognise across
 * the room. Unlike the printed slip (one column), they sit side by side and wrap. */
const REMINDER_EMOJI_PX = 64;

/** Text and image reminders share one list, in emission order. An image item is announced by its
 * description, or by the emojis themselves when it has none. */
export function RemindersBlock({ data }: { data: RemindersV2Data }): React.JSX.Element {
  const totalItems = data.groups.reduce((sum, group) => sum + group.items.length, 0);
  if (totalItems === 0) return <TextList items={[]} />;
  return (
    <div className="space-y-3">
      {data.groups.map((group, groupIndex) => (
        <div key={groupIndex}>
          {group.title ? <p className="text-sm font-semibold">{group.title}</p> : null}
          <ul className="space-y-1 text-base">
            {group.items.map((item, itemIndex) => {
              const key = item.id ?? String(itemIndex);
              if (item.emojis && item.emojis.length > 0) {
                return (
                  <li key={key}>
                    <span
                      role="img"
                      aria-label={displayText(item.value, item.emojis.join(" "))}
                      data-testid="briefing-reminder-emojis"
                      className="flex flex-wrap gap-3 py-1"
                    >
                      {item.emojis.map((emoji, emojiIndex) => (
                        <NotoEmoji
                          key={`${emoji}-${emojiIndex}`}
                          emoji={emoji}
                          size={REMINDER_EMOJI_PX}
                        />
                      ))}
                    </span>
                  </li>
                );
              }
              return <li key={key}>{displayText(item.value, key)}</li>;
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function WordOfDayBlock({ data }: { data: WordOfDayData }): React.JSX.Element {
  return (
    <div>
      <p className="text-xl font-semibold">
        {data.word}
        {data.pronunciation ? (
          <span className="ml-2 text-sm font-normal text-muted-foreground">
            /{data.pronunciation}/
          </span>
        ) : null}
      </p>
      <p className="text-sm italic text-muted-foreground">{data.type}</p>
      <p className="mt-1 text-base">{data.definition}</p>
      {data.example ? <p className="mt-1 text-sm italic">“{data.example}”</p> : null}
    </div>
  );
}

export function AnimalFactBlock({ data }: { data: AnimalFactData }): React.JSX.Element {
  return (
    <div>
      <p className="text-base">{data.text}</p>
      <p className="mt-1 text-sm italic text-muted-foreground">{data.animal}</p>
    </div>
  );
}

export function NumberFactBlock({ data }: { data: NumberFactData }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div>
      <p className="text-base">
        <strong>{data.number}</strong> — {data.fact}
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        {t(NUMBER_FACT_KIND_LABEL_KEYS[data.kind])}
      </p>
    </div>
  );
}

export function OnThisDayBlock({ data }: { data: OnThisDayData }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      {data.events && data.events.length > 0 ? (
        <div>
          <p className="text-sm font-semibold">{t("dailyBriefing.view.onThisDayEvents")}</p>
          <TextList items={data.events} />
        </div>
      ) : null}
      {data.births && data.births.length > 0 ? (
        <div>
          <p className="text-sm font-semibold">{t("dailyBriefing.view.onThisDayBirths")}</p>
          <TextList items={data.births} />
        </div>
      ) : null}
      {data.deaths && data.deaths.length > 0 ? (
        <div>
          <p className="text-sm font-semibold">{t("dailyBriefing.view.onThisDayDeaths")}</p>
          <TextList items={data.deaths} />
        </div>
      ) : null}
    </div>
  );
}

export function QuoteOfDayBlock({ data }: { data: QuoteOfDayData }): React.JSX.Element {
  return (
    <blockquote className="text-base italic">
      “{data.text}”
      <footer className="mt-1 text-sm not-italic text-muted-foreground">— {data.author}</footer>
    </blockquote>
  );
}

/** No `answer` field in this local type — the correct choice is never read out of the
 * envelope's data into this component (v1/adapter parity). */
export function TriviaBlock({ data }: { data: TriviaData }): React.JSX.Element {
  return (
    <div>
      <p className="text-base">{data.question}</p>
      <ul className="mt-2 space-y-1 text-base" data-testid="daily-briefing-trivia-options">
        {data.options.map((option, index) => (
          <li key={`${option}-${index}`}>{option}</li>
        ))}
      </ul>
      <p className="mt-2 text-sm text-muted-foreground">
        {data.category} · {data.difficulty}
      </p>
    </div>
  );
}

/** The riddle's answer is present but visually de-emphasized inline — no rotation, no
 * interactivity (FR-023 Clarifications, distinct from the print raster's upside-down text). */
export function RiddleBlock({ data }: { data: RiddleData }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div>
      <p className="text-base">{data.question}</p>
      <p className="mt-2 text-sm">
        <span className="text-muted-foreground">{t("dailyBriefing.view.riddleAnswerLabel")}</span>{" "}
        <span
          data-testid="daily-briefing-riddle-answer"
          className="italic text-muted-foreground/70"
        >
          {data.answer}
        </span>
      </p>
    </div>
  );
}

export function WouldYouRatherBlock({ data }: { data: WouldYouRatherData }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <p className="text-base">
      {data.optionA}
      <span className="mx-2 text-muted-foreground">{t("dailyBriefing.view.wouldYouRatherOr")}</span>
      {data.optionB}
    </p>
  );
}

/** Flat structural rendering (FR-023 Clarifications): a plain monospace character grid, never
 * the print raster's visual puzzle styling. */
export function WordSearchBlock({ data }: { data: WordSearchData }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div>
      <div
        data-testid="daily-briefing-wordsearch-grid"
        className="font-mono text-sm leading-relaxed tracking-widest"
      >
        {data.grid.map((row, rowIndex) => (
          <div key={rowIndex}>{row.join(" ")}</div>
        ))}
      </div>
      <p className="mt-3 text-sm text-muted-foreground">
        {t("dailyBriefing.view.wordSearchWordsLabel")} {data.words.join(", ")}
      </p>
    </div>
  );
}

export function DrawingPromptBlock({ data }: { data: DrawingPromptData }): React.JSX.Element {
  return <p className="text-base">{data.prompt}</p>;
}
