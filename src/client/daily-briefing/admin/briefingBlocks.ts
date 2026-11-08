import { CANONICAL_WEEKDAY_ORDER } from "@/components/WeekdayPicker";
import type { WeekdayCode, WeekdayLabels } from "@/components/WeekdayPicker";
import type { MessageKey } from "@/i18n/messages";
import type { BriefingSchedule, BriefingStatus } from "../../../shared";
import {
  ALL_BLOCK_TYPES,
  BLOCK_DIFFICULTIES,
  BLOCK_LEVELS,
  CORPUS_LANGUAGE_AVAILABILITY,
  DEFAULT_DISABLED_BLOCK_TYPES,
  blockParamSpec,
  type BlockRegistryType,
} from "../../../shared/dailyBriefingBlocks";

// Pure helpers for the Daily Briefing admin: the block registry, label maps and the
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

// The block registry comes from the shared catalogue (src/shared/dailyBriefingBlocks.ts), the
// same declaration the server derives its lists from.
export { ALL_BLOCK_TYPES, CORPUS_LANGUAGE_AVAILABILITY, DEFAULT_DISABLED_BLOCK_TYPES };
export type { BlockRegistryType };

type BlockLabelKey = `dailyBriefing.admin.blockType.${BlockRegistryType}`;
// Compile-time check: every catalogue type has an admin label in `messages.ts`.
const blockLabelKeysExist: BlockLabelKey extends MessageKey ? true : never = true;
void blockLabelKeysExist;

export const BLOCK_LABEL_KEYS: Record<BlockRegistryType, MessageKey> = Object.fromEntries(
  ALL_BLOCK_TYPES.map((type) => [type, `dailyBriefing.admin.blockType.${type}` as BlockLabelKey])
) as Record<BlockRegistryType, MessageKey>;

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

function typesWithParam(param: "level" | "difficulty" | "count"): ReadonlySet<BlockRegistryType> {
  return new Set(ALL_BLOCK_TYPES.filter((type) => blockParamSpec(type)[param] !== undefined));
}

/** Block types that read `params.level` / `params.count` / `params.difficulty` (FR-022). */
export const LEVEL_BLOCK_TYPES = typesWithParam("level");
export const COUNT_BLOCK_TYPES = typesWithParam("count");
export const DIFFICULTY_BLOCK_TYPES = typesWithParam("difficulty");
export const LEVELS = BLOCK_LEVELS;
export const DIFFICULTIES = BLOCK_DIFFICULTIES;

/** The count choices a block declares, `min`..`max` inclusive; empty when it takes no count. */
export function countOptions(type: BlockRegistryType): number[] {
  const spec = blockParamSpec(type).count;
  if (!spec) return [];
  return Array.from({ length: spec.max - spec.min + 1 }, (_, index) => spec.min + index);
}

export const DIFFICULTY_LABEL_KEYS: Record<(typeof DIFFICULTIES)[number], MessageKey> = {
  easy: "dailyBriefing.admin.difficulty.easy",
  medium: "dailyBriefing.admin.difficulty.medium",
  hard: "dailyBriefing.admin.difficulty.hard",
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
