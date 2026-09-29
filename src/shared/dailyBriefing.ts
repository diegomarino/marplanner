// ─────────────────────────────────────────────────────────────────────
// Daily Briefing DTOs — pure types, no I/O, no deps.
// The payload shapes remain available before the daily-briefing plugin is installed.
// ─────────────────────────────────────────────────────────────────────

/** BriefingStatus — derived over included (non-empty) blocks only.
 * `pending` is a defined reservation value but not externally observable under
 * synchronous single-transaction generation.
 * `render-failed`: survivor data + a catastrophic render-layer
 * failure (Printing active, render step died with no per-block failures) — never conflated with
 * `ready` missing a printable image. Distinct from Printing being inactive,
 * where the printable image is legitimately absent and status derives from data alone.
 */
export type BriefingStatus = "pending" | "ready" | "partial" | "failed" | "render-failed";

/** BlockType — the block-type vocabulary a stored envelope's blocks may use.
 * `"calendar"`/`"chores"` are the retired schemaVersion 1 names. `readBriefing` never
 * rewrites an existing row, so its payload keeps reading back exactly as generated
 * (INV-01). The 21-name registry vocabulary below is what schemaVersion 2 rows use; `"today"` replaces
 * `"calendar"`'s role and `"streak"` replaces `"chores"`'s.
 * `weather` (the briefing weather block) is scope
 * `shared`, present only when the household's daily[] forecast covers the briefing's
 * household-local date (WEATHER-INV-05) and never emitted with `status: "failed"`
 * (WEATHER-INV-10/12 — a failed/absent forecast contributes no block at all).
 * The block instance `type` follows the `ALL_BLOCK_TYPES` registry.
 */
export type BlockType =
  // Retired schemaVersion 1 names.
  | "calendar"
  | "chores"
  // The 21-block registry, verbatim from `ALL_BLOCK_TYPES`.
  | "shotgun"
  | "message"
  | "streak"
  | "today"
  | "weather"
  | "meals"
  | "birthday"
  | "reminders"
  | "dadJoke"
  | "wordOfDay"
  | "animalFact"
  | "numberFact"
  | "onThisDay"
  | "quoteOfDay"
  | "trivia"
  | "riddle"
  | "wouldYouRather"
  | "wordSearch"
  | "drawingPrompt"
  | "streakText"
  | "weatherText";

/** BlockScope — `chores`/`reminders` = member; `calendar`/`meals` = shared.
 */
export type BlockScope = "shared" | "member";

/** BlockInstance — one gathered block in the payload envelope. `data` present iff `status`
 * is `ok`; `error` present iff `status` is `failed`. A block that is DISABLED (settings) or
 * excluded by its weekday mask is OMITTED from `blocks` entirely — never stored as a third
 * state — matching schemaVersion 1's "empty blocks are omitted, never stored" precedent.
 * schemaVersion 2 additions: `index`/`title` are
 * the block's ordinal position + "NN TITLE" display title, re-stamped from the CURRENT effective
 * order on every generation (never persisted across regenerations as a stable id); `language` is
 * present only for a corpus-backed block instance (FR-008/FR-009 — a non-corpus type never
 * carries this field); `params` is the instance's frozen, effective configuration (member
 * settings merged with the block-order instance's own override, instance wins per key).
 */
export interface BlockInstance {
  type: BlockType;
  scope: BlockScope;
  status: "ok" | "failed";
  data?: unknown;
  error?: string;
  /** schemaVersion 2 only — 1-based ordinal position among this member's INCLUDED blocks. */
  index?: number;
  /** schemaVersion 2 only — "NN TITLE", zero-padded, re-stamped from `index` at generation. */
  title?: string;
  /** schemaVersion 2 only, corpus-backed types only (FR-008/FR-009) — the resolved+frozen variant. */
  language?: string;
  /** schemaVersion 2 only — the instance's frozen, effective params (member settings ⊕ order override). */
  params?: Record<string, unknown>;
}

/** BriefingPayload — the JSON envelope stored in `daily_briefing.payload`.
 * `schemaVersion: 1` rows are the four merged domains, ordered
 * calendar -> reminders -> chores -> meals; a pre-existing v1 row is NEVER rewritten by a reader
 * (readBriefing is pure) and keeps reading back exactly as generated (INV-01).
 * `schemaVersion: 2` rows carry the full 21-block
 * registry in the household's EFFECTIVE order (configured block-order instances first, then
 * unlisted registry types appended in registry order — the `daily_briefing_block_order`
 * merge rule); `member` stays the same frozen identity snapshot shape both versions share.
 */
export interface BriefingPayload {
  schemaVersion: 1 | 2;
  member: { id: string; displayName: string };
  date: string;
  blocks: BlockInstance[];
}

/** Briefing — one current row per (member, date); `id` stable across regeneration (INV-02).
 */
export interface Briefing {
  id: string;
  memberId: string;
  date: string;
  status: BriefingStatus;
  payload: BriefingPayload;
  createdAt: number;
  updatedAt: number;
}

/** PrintedStatus — derived, never stored as Printing's own canonical state.
 * `completed`/`failed` reflect the current generation's printing outcome (from the
 * local event-cache when fresh, or Printing's own record via a read-time fallback query when the
 * cache is absent/stale — FR-005/AC-04 dropped-event recovery); `none` means Printing is active
 * but no printable output has ever completed or dead-lettered for this member/date yet;
 * `unavailable` means the Printing plugin itself is inactive (FR-007/AC-11) — deliberately
 * distinct from `none` (a false negative would misreport "nothing happened" for "we cannot know").
 */
export type PrintedStatus = "completed" | "failed" | "none" | "unavailable";

/** BriefingReadResult — pure read result. Missing row -> `{ generated: false }`, no row created
 * (AC-08). `printedStatus` is present only alongside a generated briefing — it is
 * derived at read time, never part of the stored envelope itself.
 */
export type BriefingReadResult =
  { generated: false } | { generated: true; briefing: Briefing; printedStatus: PrintedStatus };

/** OptInState — a member's daily-briefing opt-in flag. Absent row = off (default off, ADR-027).
 */
export interface OptInState {
  memberId: string;
  enabled: boolean;
}
