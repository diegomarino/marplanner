import { CANONICAL_WEEKDAY_ORDER } from "@/components/WeekdayPicker";
import type { WeekdayCode, WeekdayLabels } from "@/components/WeekdayPicker";
import type { MessageKey } from "@/i18n/messages";
import type { BriefingSchedule, BriefingStatus } from "../../../shared";

// Pure helpers for the Daily Briefing admin: the block registry mirror, label maps and the
// rules that turn the blocks × weekdays matrix into block-settings writes (spec D4/D15).

// ── Settings-layer types (docs/api/openapi.json `DailyBriefingSettingsView`) ──
// Hand-mirrored here (not imported from src/shared) — see src/server/openapi/daily-briefing.ts
// for the source of truth these types must stay in lockstep with.

// SC-009: ONE canonical weekday definition — the shared picker's own. An earlier revision of
// this migration kept a file-local `CANONICAL_WEEKDAYS` twin: two
// independent definitions means a divergence renders a persisted `weekdays: null` ("all days")
// differently here than in the shared picker.
export type Weekday = WeekdayCode;

export const WEEKDAY_LABEL_KEYS: Record<Weekday, MessageKey> = {
  mon: "dailyBriefing.admin.weekday.mon",
  tue: "dailyBriefing.admin.weekday.tue",
  wed: "dailyBriefing.admin.weekday.wed",
  thu: "dailyBriefing.admin.weekday.thu",
  fri: "dailyBriefing.admin.weekday.fri",
  sat: "dailyBriefing.admin.weekday.sat",
  sun: "dailyBriefing.admin.weekday.sun",
};

/** Builds `WeekdayPicker`'s localized label map from this surface's own translation namespace
 * (`dailyBriefing.admin.weekday.*`) — call-site-owned, per the component's own doc comment. */
export function weekdayLabels(t: (key: MessageKey) => string): WeekdayLabels {
  return {
    mon: t(WEEKDAY_LABEL_KEYS.mon),
    tue: t(WEEKDAY_LABEL_KEYS.tue),
    wed: t(WEEKDAY_LABEL_KEYS.wed),
    thu: t(WEEKDAY_LABEL_KEYS.thu),
    fri: t(WEEKDAY_LABEL_KEYS.fri),
    sat: t(WEEKDAY_LABEL_KEYS.sat),
    sun: t(WEEKDAY_LABEL_KEYS.sun),
  };
}

export type AutoPrintTrigger = "morning_complete" | null;

export interface BlockParams {
  level?: "L1" | "L2" | "L3" | "L4";
  difficulty?: string;
  language?: string;
  count?: number;
}

export interface BlockOrderInstance {
  type: string;
  params?: BlockParams;
}

export interface MemberBlockSettings {
  memberId: string;
  blockType: string;
  enabled: boolean;
  weekdays: Weekday[] | null;
  params: BlockParams | null;
  updatedAt: number | null;
}

export interface DailyBriefingSettingsView {
  generationTime: string;
  autoPrintTrigger: AutoPrintTrigger;
  blockOrder: BlockOrderInstance[];
  memberBlockSettings: MemberBlockSettings[];
  memberSchedules?: BriefingSchedule[];
}

/** The 21-block registry universe, hand-mirrored from the server's single source of truth
 * (src/server/modules/daily-briefing/corpora/block-types.ts `ALL_BLOCK_TYPES`) — the client
 * cannot import server modules, so this list (and the two below) must be kept in sync by hand
 * if the registry ever changes.
 */
export const ALL_BLOCK_TYPES = [
  "shotgun",
  "message",
  "streak",
  "today",
  "weather",
  "meals",
  "birthday",
  "reminders",
  "dadJoke",
  "wordOfDay",
  "animalFact",
  "numberFact",
  "onThisDay",
  "quoteOfDay",
  "trivia",
  "riddle",
  "wouldYouRather",
  "wordSearch",
  "drawingPrompt",
  "streakText",
  "weatherText",
  "phonics",
] as const;

export type BlockRegistryType = (typeof ALL_BLOCK_TYPES)[number];

export const BLOCK_LABEL_KEYS: Record<BlockRegistryType, MessageKey> = {
  shotgun: "dailyBriefing.admin.blockType.shotgun",
  message: "dailyBriefing.admin.blockType.message",
  streak: "dailyBriefing.admin.blockType.streak",
  today: "dailyBriefing.admin.blockType.today",
  weather: "dailyBriefing.admin.blockType.weather",
  meals: "dailyBriefing.admin.blockType.meals",
  birthday: "dailyBriefing.admin.blockType.birthday",
  reminders: "dailyBriefing.admin.blockType.reminders",
  dadJoke: "dailyBriefing.admin.blockType.dadJoke",
  wordOfDay: "dailyBriefing.admin.blockType.wordOfDay",
  animalFact: "dailyBriefing.admin.blockType.animalFact",
  numberFact: "dailyBriefing.admin.blockType.numberFact",
  onThisDay: "dailyBriefing.admin.blockType.onThisDay",
  quoteOfDay: "dailyBriefing.admin.blockType.quoteOfDay",
  trivia: "dailyBriefing.admin.blockType.trivia",
  riddle: "dailyBriefing.admin.blockType.riddle",
  wouldYouRather: "dailyBriefing.admin.blockType.wouldYouRather",
  wordSearch: "dailyBriefing.admin.blockType.wordSearch",
  drawingPrompt: "dailyBriefing.admin.blockType.drawingPrompt",
  streakText: "dailyBriefing.admin.blockType.streakText",
  weatherText: "dailyBriefing.admin.blockType.weatherText",
  phonics: "dailyBriefing.admin.blockType.phonics",
};

export function effectiveMatrixBlockTypes(blockOrder: BlockOrderInstance[]): BlockRegistryType[] {
  const configured = blockOrder
    .map((entry) => entry.type)
    .filter((type): type is BlockRegistryType =>
      ALL_BLOCK_TYPES.includes(type as BlockRegistryType)
    );
  const configuredTypes = new Set(configured);
  return [
    ...configured.filter((type, index) => configured.indexOf(type) === index),
    ...ALL_BLOCK_TYPES.filter((type) => !configuredTypes.has(type)),
  ];
}

export function reorderBlockOrderByType(
  blockOrder: BlockOrderInstance[],
  activeType: BlockRegistryType,
  overType: BlockRegistryType
): BlockOrderInstance[] {
  const orderedTypes = effectiveMatrixBlockTypes(blockOrder);
  const fromIndex = orderedTypes.indexOf(activeType);
  const toIndex = orderedTypes.indexOf(overType);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return blockOrder;

  const nextTypes = [...orderedTypes];
  const [movedType] = nextTypes.splice(fromIndex, 1);
  nextTypes.splice(toIndex, 0, movedType as BlockRegistryType);

  const instancesByType = new Map<BlockRegistryType, BlockOrderInstance[]>();
  for (const type of ALL_BLOCK_TYPES) {
    const instances = blockOrder.filter((entry) => entry.type === type);
    instancesByType.set(type, instances.length > 0 ? instances : [{ type }]);
  }
  return nextTypes.flatMap((type) => instancesByType.get(type) ?? []);
}

/** Mirrors `DEFAULT_DISABLED_BLOCK_TYPES` in block-types.ts (FR-013). */
export const DEFAULT_DISABLED_BLOCK_TYPES: ReadonlySet<BlockRegistryType> = new Set([
  "onThisDay",
  "phonics",
]);

/** Mirrors `LEVEL`-taking block types — `wordOfDay` and `phonics` (FR-022). */
export const LEVEL_BLOCK_TYPES: ReadonlySet<BlockRegistryType> = new Set(["wordOfDay", "phonics"]);

/** Mirrors `COUNT`-taking block types and the server's PHONICS_{MIN,MAX}_COUNT bounds. */
export const COUNT_BLOCK_TYPES: ReadonlySet<BlockRegistryType> = new Set(["phonics"]);
export const COUNTS = [1, 2, 3, 4, 5, 6] as const;
export const LEVELS = ["L1", "L2", "L3", "L4"] as const;

/** Mirrors `DIFFICULTY`-taking block types — `trivia` and `wordSearch` (FR-022). */
export const DIFFICULTY_BLOCK_TYPES: ReadonlySet<BlockRegistryType> = new Set([
  "trivia",
  "wordSearch",
]);
export const DIFFICULTIES = ["easy", "medium", "hard"] as const;
export const DIFFICULTY_LABEL_KEYS: Record<(typeof DIFFICULTIES)[number], MessageKey> = {
  easy: "dailyBriefing.admin.difficulty.easy",
  medium: "dailyBriefing.admin.difficulty.medium",
  hard: "dailyBriefing.admin.difficulty.hard",
};

/** Mirrors `CORPUS_LANGUAGE_AVAILABILITY` in block-types.ts (FR-008/FR-009) — the ONLY types
 * offering a `params.language` override, each restricted to the languages with an on-disk
 * corpus. A type absent from this map renders no language control at all (FR-008).
 */
export const CORPUS_LANGUAGE_AVAILABILITY: Partial<Record<BlockRegistryType, readonly string[]>> = {
  dadJoke: ["en"],
  wordOfDay: ["en"],
  animalFact: ["en", "es"],
  numberFact: ["en", "es"],
  trivia: ["en"],
  riddle: ["en"],
  wouldYouRather: ["en", "es"],
  wordSearch: ["en"],
  drawingPrompt: ["en", "es"],
  phonics: ["en"],
};

export function defaultMemberBlockSettings(
  memberId: string,
  blockType: BlockRegistryType
): MemberBlockSettings {
  return {
    memberId,
    blockType,
    enabled: !DEFAULT_DISABLED_BLOCK_TYPES.has(blockType),
    weekdays: null,
    params: null,
    updatedAt: null,
  };
}

/** A Schedule-tab result cell: a stored status, or why a generate-all produced nothing. */
export type MemberResult = BriefingStatus | "paused" | "notGenerated";

export function resolveMemberBlockSettings(
  list: readonly MemberBlockSettings[],
  memberId: string,
  blockType: BlockRegistryType
): MemberBlockSettings {
  return (
    list.find((row) => row.memberId === memberId && row.blockType === blockType) ??
    defaultMemberBlockSettings(memberId, blockType)
  );
}

/** The days a block prints (spec D4): `enabled` and `weekdays` collapsed into one set. */
export function effectiveBlockDays(settings: MemberBlockSettings): WeekdayCode[] {
  if (!settings.enabled) return [];
  if (settings.weekdays === null) return [...CANONICAL_WEEKDAY_ORDER];
  const days = new Set(settings.weekdays);
  return CANONICAL_WEEKDAY_ORDER.filter((day) => days.has(day));
}

/** The block-settings PUT body for toggling one matrix cell (spec D4). */
export function cellToggleInput(
  settings: MemberBlockSettings,
  day: WeekdayCode
): { enabled: boolean; weekdays: WeekdayCode[] | null } {
  const days = new Set(effectiveBlockDays(settings));
  if (days.has(day)) days.delete(day);
  else days.add(day);
  const next = CANONICAL_WEEKDAY_ORDER.filter((d) => days.has(d));
  return {
    enabled: next.length > 0,
    weekdays: next.length === CANONICAL_WEEKDAY_ORDER.length ? null : next,
  };
}

/** The block-settings PUT body for a row's "every day" control: off on every day while any day
 * is on, otherwise on every day. Same shapes a cell writes for no day / all seven days. */
export function rowToggleInput(settings: MemberBlockSettings): {
  enabled: boolean;
  weekdays: WeekdayCode[] | null;
} {
  return effectiveBlockDays(settings).length > 0
    ? { enabled: false, weekdays: [] }
    : { enabled: true, weekdays: null };
}

const JS_DAY_TO_CODE: readonly WeekdayCode[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** The weekday of a plain `YYYY-MM-DD` date — a calendar date has no timezone (spec A3). */
export function weekdayOfDate(date: string): WeekdayCode | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(day.getTime()) ? null : (JS_DAY_TO_CODE[day.getUTCDay()] ?? null);
}
