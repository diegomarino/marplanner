import {
  CANONICAL_WEEKDAY_ORDER,
  validateWeekdays as validateWeekdayTokens,
} from "../../../shared/weekdays";
/** Daily Briefing settings layer — reads/writes for
 * the three plugin-namespaced settings tables: `daily_briefing_settings` (schedule + the
 * auto-print trigger BINDING), `daily_briefing_block_order` (the ordered block-instance list),
 * and `daily_briefing_member_block_settings` (per-member per-block enable/weekdays/params).
 * All three are single-purpose, hand-rolled validation (no zod) — same convention as
 * `../time-announcements/index.ts` and `../reminders/index.ts`. Settings writes NEVER touch the
 * `daily_briefing` table (FR-022: "Settings changes MUST NOT regenerate or invalidate existing
 * briefings implicitly") — every function below writes only its own settings table.
 */
import { assertActiveMember, getDb } from "../../host-api";
import type { BriefingSchedule, Weekday } from "../../../shared";
import {
  DEFAULT_DISABLED_BLOCK_TYPES,
  isCorpusLanguageAvailable,
  isKnownBlockType,
} from "./corpora/index";
import {
  FIRST_WORDS_MAX_COUNT,
  FIRST_WORDS_MIN_COUNT,
  isValidFirstWordsCount,
} from "./blocks/first-words";
import { DailyBriefingValidationError } from "./errors";
import { getBriefingTime, rearmDailyBriefingSchedule } from "./job";
import { listMemberSchedules } from "./schedule";

/** Thrown for the one write-boundary rejection the contract names a specific error code for
 * (contracts/openapi.planned.yaml — "400 corpus_language_unavailable"). A subclass of
 * `DailyBriefingValidationError` so it is still caught by every existing `instanceof
 * DailyBriefingValidationError` check; routes.ts checks THIS subclass first to surface the more
 * specific `error` field.
 */
export class CorpusLanguageUnavailableError extends DailyBriefingValidationError {
  constructor(message: string) {
    super(message);
    this.name = "CorpusLanguageUnavailableError";
  }
}

// ── Shared validation primitives (hand-rolled, time-announcements precedent) ─────────────────

// Strict 24h HH:MM, `00:00`-`23:59`. Reject, never normalize.
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const VALID_LEVELS = new Set(["L1", "L2", "L3", "L4"]);
const VALID_DIFFICULTIES = new Set(["easy", "medium", "hard"]);
const ALLOWED_PARAM_KEYS = new Set(["level", "difficulty", "language", "count"]);

const DEFAULT_GENERATION_TIME = "06:00";

function validateGenerationTime(value: unknown): string {
  if (typeof value !== "string" || !TIME_PATTERN.test(value)) {
    throw new DailyBriefingValidationError(
      `Invalid generationTime "${String(value)}": expected strict 24h HH:MM in 00:00-23:59`
    );
  }
  return value;
}

/** `null` clears the binding (no automatic trigger); `"morning_complete"` is the only bound kind. */
function validateAutoPrintTrigger(value: unknown): "morning_complete" | null {
  if (value === null) return null;
  if (value === "morning_complete") return value;
  throw new DailyBriefingValidationError(
    `Invalid autoPrintTrigger "${String(value)}": expected null or "morning_complete"`
  );
}

/** `null` means "all days" — an omitted-and-then-explicitly-cleared mask. A provided array is
 * validated against the canonical `mon..sun` set (batch-B EVERY entry is checked
 * BEFORE anything is accepted — a single unknown value throws immediately, so an
 * otherwise-valid array can never partially persist with the bad entry silently dropped) and
 * re-sorted into canonical order (duplicates collapse) — the accepted set is always EXACTLY the
 * 7 canonical values, never a superset. `[]` (empty array, distinct from `null`) is a legitimate,
 * accepted third state: the block is masked out on EVERY weekday, i.e. it never runs — contrast
 * with `null`'s "all days" (batch-B; see contracts/openapi.yaml's `weekdays`
 * description for the same note, since the generation-time weekday mask needs to treat these
 * two falsy-looking states differently).
 */
function validateWeekdays(value: unknown): Weekday[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) {
    throw new DailyBriefingValidationError("weekdays must be an array or null");
  }
  const seen = new Set<string>();
  for (const day of validateWeekdayTokens(value, DailyBriefingValidationError)) {
    seen.add(day);
  }
  return CANONICAL_WEEKDAY_ORDER.filter((day) => seen.has(day));
}

function validateEnabled(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new DailyBriefingValidationError("enabled must be a boolean");
  }
  return value;
}

/** `params` is validated generically across the three known keys (`level`/`difficulty`/
 * `language`) rather than per-block-type — the full per-type param schema belongs to each block
 * generator; this layer only enforces the write-boundary rules the contract
 * names explicitly. `language` is checked against `blockType`'s corpus availability (FR-008/
 * FR-009) regardless of whether `blockType` is even corpus-backed — a non-corpus type has an
 * empty availability set, so ANY requested language 400s there too (FR-008: "no language
 * override").
 */
function validateParams(blockType: string, value: unknown): Record<string, unknown> | null {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new DailyBriefingValidationError("params must be an object or null");
  }
  const params = value as Record<string, unknown>;
  const unknownKeys = Object.keys(params).filter((key) => !ALLOWED_PARAM_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new DailyBriefingValidationError(`Unsupported param key(s): ${unknownKeys.join(", ")}`);
  }
  if (
    params.level !== undefined &&
    (typeof params.level !== "string" || !VALID_LEVELS.has(params.level))
  ) {
    throw new DailyBriefingValidationError(
      `Invalid level "${String(params.level)}": must be one of L1, L2, L3, L4`
    );
  }
  if (
    params.difficulty !== undefined &&
    (typeof params.difficulty !== "string" || !VALID_DIFFICULTIES.has(params.difficulty))
  ) {
    throw new DailyBriefingValidationError(
      `Invalid difficulty "${String(params.difficulty)}": must be one of easy, medium, hard`
    );
  }
  if (params.count !== undefined && !isValidFirstWordsCount(params.count)) {
    throw new DailyBriefingValidationError(
      `Invalid count "${String(params.count)}": must be an integer ${FIRST_WORDS_MIN_COUNT}-${FIRST_WORDS_MAX_COUNT}`
    );
  }
  if (params.language !== undefined) {
    if (
      typeof params.language !== "string" ||
      !isCorpusLanguageAvailable(blockType, params.language)
    ) {
      throw new CorpusLanguageUnavailableError(
        `Language "${String(params.language)}" is not available for block type "${blockType}"`
      );
    }
  }
  return params;
}

// ── daily_briefing_settings (single row, id=1) ───────────────────────────────────────────────

export interface DailyBriefingSettingsSnapshot {
  generationTime: string;
  autoPrintTrigger: "morning_complete" | null;
  updatedAt: number | null;
}

type SettingsRow = {
  generation_time: string;
  auto_print_trigger: string | null;
  updated_at: number;
};

/** No row yet -> the documented defaults (`06:00`, no trigger binding); never writes a seed row. */
export function readSettings(): DailyBriefingSettingsSnapshot {
  const row = getDb()
    .prepare(
      "SELECT generation_time, auto_print_trigger, updated_at FROM daily_briefing_settings WHERE id = 1"
    )
    .get() as SettingsRow | undefined;
  if (!row) {
    return { generationTime: DEFAULT_GENERATION_TIME, autoPrintTrigger: null, updatedAt: null };
  }
  return {
    generationTime: row.generation_time,
    autoPrintTrigger: row.auto_print_trigger as "morning_complete" | null,
    updatedAt: row.updated_at,
  };
}

/** Partial update: omitted fields retain current/default values and an explicit null
 * clears autoPrintTrigger. Existing briefing snapshots are unchanged.
 * If generationTime changes, rearm the three scheduled generation jobs asynchronously.
 * Compare against getBriefingTime before writing: it includes legacy/default fallback,
 * which can differ from readSettings on a database without the newer settings row.
 * Settings writes do not wait for scheduler work; the rearm path reports failures.
 */
export function updateSettings(input: {
  generationTime?: unknown;
  autoPrintTrigger?: unknown;
}): DailyBriefingSettingsSnapshot {
  const current = readSettings();
  // Captured BEFORE the write below runs — see the doc comment above for why this must be
  // `getBriefingTime` (the same precedence the live scheduler was armed from) and not merely
  // `current.generationTime`.
  const effectiveTimeBeforeWrite = getBriefingTime();
  const generationTime =
    input.generationTime !== undefined
      ? validateGenerationTime(input.generationTime)
      : current.generationTime;
  const autoPrintTrigger =
    input.autoPrintTrigger !== undefined
      ? validateAutoPrintTrigger(input.autoPrintTrigger)
      : current.autoPrintTrigger;

  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO daily_briefing_settings (id, generation_time, auto_print_trigger, updated_at)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         generation_time = excluded.generation_time,
         auto_print_trigger = excluded.auto_print_trigger,
         updated_at = excluded.updated_at`
    )
    .run(generationTime, autoPrintTrigger, now);

  if (generationTime !== effectiveTimeBeforeWrite) {
    // `rearmDailyBriefingSchedule` fully contains its own failures (logs, never rejects — see
    // its own doc comment in `./job.ts`), so this is a plain fire-and-forget dispatch.
    void rearmDailyBriefingSchedule();
  }

  return { generationTime, autoPrintTrigger, updatedAt: now };
}

// ── daily_briefing_block_order (single row, id=1) ────────────────────────────────────────────

export interface BlockOrderInstance {
  type: string;
  params?: Record<string, unknown>;
}

type BlockOrderRow = { order_json: string };

export function readBlockOrder(): BlockOrderInstance[] {
  const row = getDb()
    .prepare("SELECT order_json FROM daily_briefing_block_order WHERE id = 1")
    .get() as BlockOrderRow | undefined;
  return row ? (JSON.parse(row.order_json) as BlockOrderInstance[]) : [];
}

/** Unknown types REJECTED 400 at this write boundary (stricter than v1's silent-ignore, contracts/
 * openapi.planned.yaml) — the generation-time merge still tolerates a legacy-unknown type
 * already persisted before this validation existed. A type MAY repeat with distinct params
 * (INV-05/ADR-044) — no dedup here.
 */
export function writeBlockOrder(input: unknown): BlockOrderInstance[] {
  const validated = validateBlockOrder(input);
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO daily_briefing_block_order (id, order_json, updated_at)
       VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET order_json = excluded.order_json, updated_at = excluded.updated_at`
    )
    .run(JSON.stringify(validated), now);
  return validated;
}

function validateBlockOrder(input: unknown): BlockOrderInstance[] {
  if (!Array.isArray(input)) {
    throw new DailyBriefingValidationError("Block order must be an array");
  }
  return input.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new DailyBriefingValidationError(
        `Block order entry at index ${index} must be an object`
      );
    }
    const allowedKeys = new Set(["type", "params"]);
    const unknownKeys = Object.keys(entry).filter((key) => !allowedKeys.has(key));
    if (unknownKeys.length > 0) {
      throw new DailyBriefingValidationError(
        `Unsupported field(s) in block order entry at index ${index}: ${unknownKeys.join(", ")}`
      );
    }
    const { type, params } = entry as { type?: unknown; params?: unknown };
    if (!isKnownBlockType(type)) {
      throw new DailyBriefingValidationError(`Unknown block type "${String(type)}" in block order`);
    }
    const validatedParams =
      params === undefined ? undefined : (validateParams(type, params) ?? undefined);
    return validatedParams === undefined ? { type } : { type, params: validatedParams };
  });
}

// ── daily_briefing_member_block_settings (member_id, block_type) ────────────────────────────

export interface MemberBlockSettings {
  memberId: string;
  blockType: string;
  enabled: boolean;
  weekdays: Weekday[] | null;
  params: Record<string, unknown> | null;
  updatedAt: number | null;
}

type MemberBlockSettingsRow = {
  member_id: string;
  block_type: string;
  enabled: number;
  weekdays: string | null;
  params: string | null;
  updated_at: number;
};

function rowToMemberBlockSettings(row: MemberBlockSettingsRow): MemberBlockSettings {
  return {
    memberId: row.member_id,
    blockType: row.block_type,
    enabled: row.enabled === 1,
    weekdays: row.weekdays ? (JSON.parse(row.weekdays) as Weekday[]) : null,
    params: row.params ? (JSON.parse(row.params) as Record<string, unknown>) : null,
    updatedAt: row.updated_at,
  };
}

/** All persisted per-member per-block rows — the RAW admin-editable settings (not effective-default-resolved). */
export function listMemberBlockSettings(): MemberBlockSettings[] {
  const rows = getDb()
    .prepare(
      "SELECT member_id, block_type, enabled, weekdays, params, updated_at FROM daily_briefing_member_block_settings ORDER BY member_id ASC, block_type ASC"
    )
    .all() as MemberBlockSettingsRow[];
  return rows.map(rowToMemberBlockSettings);
}

/** FR-013 default-resolution rule (the "onThisDay default-disabled bootstrap"): an absent row
 * resolves to enabled EXCEPT for `DEFAULT_DISABLED_BLOCK_TYPES` (today: only `onThisDay`), which
 * resolves to disabled — entirely in this READ path, no seed row ever written. This is the
 * function the full generation calls to decide whether a block instance is active for a
 * member; the admin GET /settings surface (below) returns the raw persisted rows instead, for
 * editing.
 */
export function resolveMemberBlockSettings(
  memberId: string,
  blockType: string
): MemberBlockSettings {
  const row = getDb()
    .prepare(
      "SELECT member_id, block_type, enabled, weekdays, params, updated_at FROM daily_briefing_member_block_settings WHERE member_id = ? AND block_type = ?"
    )
    .get(memberId, blockType) as MemberBlockSettingsRow | undefined;
  if (row) return rowToMemberBlockSettings(row);
  return {
    memberId,
    blockType,
    enabled: !DEFAULT_DISABLED_BLOCK_TYPES.has(blockType),
    weekdays: null,
    params: null,
    updatedAt: null,
  };
}

/** Upserts one (memberId, blockType) row. An omitted field keeps its current persisted value (or
 * the FR-013 default-resolution value, for a row that does not exist yet). `memberId` is
 * validated the same way `setOptIn` validates it (`../index.ts`) — active-member, mapped to
 * `DailyBriefingValidationError` on failure.
 */
export function writeMemberBlockSettings(
  memberId: string,
  blockType: unknown,
  input: { enabled?: unknown; weekdays?: unknown; params?: unknown }
): MemberBlockSettings {
  if (typeof memberId !== "string" || memberId.trim().length === 0) {
    throw new DailyBriefingValidationError("memberId is required");
  }
  try {
    assertActiveMember(memberId);
  } catch (err) {
    throw new DailyBriefingValidationError(
      err instanceof Error ? err.message : `Member "${memberId}" is not active`
    );
  }
  if (!isKnownBlockType(blockType)) {
    throw new DailyBriefingValidationError(`Unknown block type "${String(blockType)}"`);
  }

  const current = resolveMemberBlockSettings(memberId, blockType);
  const enabled = input.enabled !== undefined ? validateEnabled(input.enabled) : current.enabled;
  const weekdays =
    input.weekdays !== undefined ? validateWeekdays(input.weekdays) : current.weekdays;
  const params =
    input.params !== undefined ? validateParams(blockType, input.params) : current.params;

  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO daily_briefing_member_block_settings
         (member_id, block_type, enabled, weekdays, params, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(member_id, block_type) DO UPDATE SET
         enabled = excluded.enabled,
         weekdays = excluded.weekdays,
         params = excluded.params,
         updated_at = excluded.updated_at`
    )
    .run(
      memberId,
      blockType,
      enabled ? 1 : 0,
      weekdays ? JSON.stringify(weekdays) : null,
      params ? JSON.stringify(params) : null,
      now,
      now
    );

  return { memberId, blockType, enabled, weekdays, params, updatedAt: now };
}

// ── Aggregate read (GET /api/daily-briefing/settings) ────────────────────────────────────────

export interface DailyBriefingSettingsView {
  generationTime: string;
  autoPrintTrigger: "morning_complete" | null;
  blockOrder: BlockOrderInstance[];
  memberBlockSettings: MemberBlockSettings[];
  memberSchedules: BriefingSchedule[];
}

export function readAllSettings(): DailyBriefingSettingsView {
  const settings = readSettings();
  return {
    generationTime: settings.generationTime,
    autoPrintTrigger: settings.autoPrintTrigger,
    blockOrder: readBlockOrder(),
    memberBlockSettings: listMemberBlockSettings(),
    memberSchedules: listMemberSchedules(),
  };
}
