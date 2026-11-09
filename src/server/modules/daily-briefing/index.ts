import {
  assertActiveMember,
  DailyMessageNotFoundError,
  emit,
  enqueuePrintJob,
  getDb,
  getMessage,
  getPrintRecordStatus,
  hasTerminalFailedJob,
  isActiveMember,
  isPrintingPluginActive,
  isStrictCalendarDate,
  isTestRuntime,
  listActiveMembers,
  readHouseholdTimezone,
  readEffectiveSettings,
  registerPrintableProvider,
  resolveMemberLabel,
  subscribe,
  supersedePrintRecord,
  supersedePrintRecordTxn,
  todayInHouseholdTz,
  weekdayOf,
} from "../../host-api";
import type { CalendarReadContext, PrintableRaster } from "../../host-api";
import { renderBriefingBitmap, pngToPackedRaster, RASTER_WIDTH_DOTS } from "./render/index";
import type { RenderBlockInput, RenderEnvelope } from "./render/index";
import type {
  BlockInstance,
  Briefing,
  BriefingHistoryResponse,
  BriefingPayload,
  BriefingPrintResponse,
  BriefingReadResult,
  BriefingStatus,
  OptInState,
  PrintedStatus,
  Weekday,
} from "../../../shared";
import { ALL_BLOCK_TYPES, isCorpusBackedBlockType, isKnownBlockType } from "./corpora/index";
import {
  blockScope,
  isExternalBlockType,
  type BlockRegistryType,
  type ExternalBlockType,
  type InTransactionBlockType,
} from "../../../shared/dailyBriefingBlocks";
import { resolveCorpusLanguage } from "./blocks/context";
import type { CorpusBlockParams } from "./blocks/context";
import { readBlockOrder, resolveMemberBlockSettings } from "./settings";
import type { BlockOrderInstance } from "./settings";
import { createDailyBlockCache, getOrFetchOnceDaily } from "./external/shared-cache";
import type { DailyBlockCache } from "./external/shared-cache";
import { zenQuotesSource, wikipediaOnThisDaySource } from "./external/ports";
import type { QuoteSource, OnThisDaySource } from "./external/ports";
import { shotgunBlock } from "./blocks/shotgun";
import type { ShotgunActiveMember } from "./blocks/shotgun";
import { messageBlock } from "./blocks/message";
import { streakBlock } from "./blocks/streak";
import { streakTextBlock } from "./blocks/streak-text";
import { todayBlock } from "./blocks/today";
import { mealsBlock } from "./blocks/meals";
import { birthdayBlock } from "./blocks/birthday";
import type { BirthdayActiveMember } from "./blocks/birthday";
import { remindersBlock } from "./blocks/reminders";
import { generateWeatherBlock, readWeatherBlockInputs } from "./blocks/weather";
import type { WeatherBlockInputs } from "./blocks/weather";
import { generateDadJoke } from "./blocks/dad-joke";
import { generateWordOfDay } from "./blocks/word-of-day";
import { generatePhonics } from "./blocks/phonics";
import { generateAnimalFact } from "./blocks/animal-fact";
import { generateNumberFact } from "./blocks/number-fact";
import { generateTrivia } from "./blocks/trivia";
import { generateRiddle } from "./blocks/riddle";
import { generateWouldYouRather } from "./blocks/would-you-rather";
import { generateWordSearch } from "./blocks/word-search";
import { generateDrawingPrompt } from "./blocks/drawing-prompt";
import { getLabels } from "./render/labels";
import type { PluginContentSourceId, PluginId } from "../../../shared/plugins";

export { DailyBriefingValidationError } from "./errors";
export {
  DailyBriefingNotFoundError,
  DailyBriefingPausedError,
  DailyBriefingPrintUnavailableError,
  DailyBriefingRasterMissingError,
} from "./errors";
export { listMemberSchedules, setMemberSchedule } from "./schedule";
import {
  DailyBriefingNotFoundError,
  DailyBriefingPausedError,
  DailyBriefingPrintUnavailableError,
  DailyBriefingRasterMissingError,
  DailyBriefingValidationError,
} from "./errors";
import { isBriefingScheduledOn } from "./schedule";

const CONTENT_SOURCE_OWNERS = {
  weather: "weather",
  weatherText: "weather",
  meals: "meals-recipes",
  reminders: "reminders",
  message: "daily-messages",
} as const satisfies Record<PluginContentSourceId, PluginId>;

let contentSourceLifecycleGate: (pluginId: PluginId) => boolean = () => true;

/** Installed by the core runtime; content generation remains host-mediated and absence-tolerant. */
export function configureDailyBriefingContentSourceLifecycleGate(
  gate: ((pluginId: PluginId) => boolean) | undefined
): void {
  contentSourceLifecycleGate = gate ?? (() => true);
}

export function isPluginContentSourceActive(sourceId: string): boolean {
  const owner = CONTENT_SOURCE_OWNERS[sourceId as PluginContentSourceId];
  return owner === undefined || contentSourceLifecycleGate(owner);
}

export function isDailyBriefingPluginActive(): boolean {
  return contentSourceLifecycleGate("daily-briefing");
}

type DailyBriefingRow = {
  id: string;
  member_id: string;
  date: string;
  status: BriefingStatus;
  payload: string;
  created_at: number;
  updated_at: number;
  /** — the derived print-status CACHE columns (never authoritative). NULL until
   * either an event or a read-time fallback query populates them (see `derivePrintedStatus`). */
  last_print_state: "completed" | "failed" | null;
  last_print_at: number | null;
  last_print_generation: number | null;
};

type DailyBriefingReservation = Pick<DailyBriefingRow, "id" | "created_at" | "updated_at">;

function rowToBriefing(row: DailyBriefingRow): Briefing {
  return {
    id: row.id,
    memberId: row.member_id,
    date: row.date,
    status: row.status,
    payload: JSON.parse(row.payload) as BriefingPayload,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Printable provider ( FR-015/FR-016) ──────
//
// The DATED output reference is the provider-lookup / event-correlation identity:
// `daily-briefing:<memberId>:<date>` identifies exactly ONE member's briefing for ONE date
// (midnight-safe — the printed-status subscriber parses the SAME date suffix to update the
// correct dated row's cache). The RECORD KEY stays `daily-briefing:<memberId>` (the dedup anchor
// paired with `target_date` —), which is why the provider is registered against the
// prefix `daily-briefing` (no trailing colon — matches `registerPrintableProvider`'s own matching
// rule: "equal to, or `:`-delimited-prefixed by", printing/index.ts), not the full dated string.

const PRINTABLE_RECORD_KEY_PREFIX = "daily-briefing";

/** Strict parse of a dated outputRef `daily-briefing:<memberId>:<YYYY-MM-DD>`. The member id may
 * itself contain `:` (the shipped demo ids are `demo:member:<name>`), so the date is the last
 * segment and everything between the prefix and it is the member id. Throws on anything else. */
function parseDatedOutputRef(outputRef: string): { memberId: string; date: string } {
  const prefix = `${PRINTABLE_RECORD_KEY_PREFIX}:`;
  const rest = outputRef.startsWith(prefix) ? outputRef.slice(prefix.length) : "";
  const split = rest.lastIndexOf(":");
  const memberId = split > 0 ? rest.slice(0, split) : "";
  const date = split > 0 ? rest.slice(split + 1) : "";
  if (memberId.length === 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(
      `daily-briefing printable provider: malformed outputRef "${outputRef}" ` +
        `(expected "daily-briefing:<memberId>:<date>")`
    );
  }
  return { memberId, date };
}

/** Synchronous DB lookup of the EXACT member+date row's stored raster (the provider
 * never renders or decodes — that already happened at generation time). Throws when the row is
 * absent or its raster columns are NULL (no printable raster yet — Printing was inactive at
 * generation, or render failed catastrophically); Printing's own `getPayload` routes that throw
 * into the standard `render_failure` permanent-failure path (printing/index.ts).
 */
function dailyBriefingPrintableProvider(outputRef: string): PrintableRaster {
  const { memberId, date } = parseDatedOutputRef(outputRef);
  const row = getDb()
    .prepare(
      "SELECT raster_bits, raster_height FROM daily_briefing WHERE member_id = ? AND date = ?"
    )
    .get(memberId, date) as
    { raster_bits: Buffer | null; raster_height: number | null } | undefined;

  if (!row || row.raster_bits === null || row.raster_height === null) {
    throw new Error(
      `daily-briefing printable provider: no printable raster stored for member "${memberId}" date "${date}"`
    );
  }
  return {
    bits: new Uint8Array(row.raster_bits),
    width: RASTER_WIDTH_DOTS,
    height: row.raster_height,
  };
}

registerPrintableProvider(PRINTABLE_RECORD_KEY_PREFIX, dailyBriefingPrintableProvider);

// ── Printed-status derivation ( FR-005/FR-007) ─────────────────
//
// Two halves, per D11: (1) an EVENT-DRIVEN cache — `printing.completed`/`printing.failed`
// subscribed through the host-api barrel (the /batch-C precedent) trigger a REFRESH of the
// `last_print_*` columns as a HINT only (Constitution V/VII: a subscriber is never the source of
// truth — its payload's OWN state/timestamp are never trusted, only used to identify WHICH
// member/date to re-derive; see `refreshPrintedStatusCache`'s own doc comment for the P1 bug this
// resolved); (2) a READ-TIME FALLBACK — `derivePrintedStatus` (called from `readBriefing` below)
// re-derives the same value from Printing's own tables whenever the cache is absent or stale
// (generation mismatch), so a dropped event can never strand a briefing's printed-status
// (FR-005/AC-04).

/** Non-throwing variant of `parseDatedOutputRef` — a `printing.completed`/`printing.failed` event
 * fires for EVERY producer sharing the Printing plugin (test-print, any future producer), so an
 * outputRef outside this plugin's own `daily-briefing:` prefix is a normal, expected "not ours",
 * never a malformed-input error. */
function tryParseDatedOutputRef(outputRef: string): { memberId: string; date: string } | null {
  if (!outputRef.startsWith(`${PRINTABLE_RECORD_KEY_PREFIX}:`)) return null;
  try {
    return parseDatedOutputRef(outputRef);
  } catch {
    return null;
  }
}

/** Event-driven cache REFRESH (P1 fix, batch-F). The `printing.completed`/
 * `printing.failed` event is a WAKEUP HINT ONLY (Constitution V/VII) — its OWN `state`/`printedAt`
 * are deliberately NEVER trusted, and neither subscriber below passes them through. Reason,
 * reproduced by `ackJob` (printing/index.ts) emits `printing.completed` even for a
 * STALE-generation "fetched-in-flight" survivor — the accepted at-least-once-delivery case (H2/
 * ADR-022) where a job whose payload was already served is left running past a supersede and may
 * still ack afterward. If this handler had stamped the EVENT's own `completed`/`printedAt` against
 * Printing's CURRENT generation (as an earlier implementation did), a survivor's late ack would write
 * a false-fresh `{completed, generation: CURRENT}` cache row that `derivePrintedStatus` would then
 * serve OVER its own read-time query — reporting "completed" for a generation nothing has actually
 * printed. The fix: re-derive from Printing's own tables via the EXACT SAME query
 * `derivePrintedStatus`'s own fallback branch uses (`getPrintRecordStatus` +
 * `hasTerminalFailedJob`), and stamp `record.generation` from THAT query, never from the event. A
 * stale-generation survivor's completion is provably not "printed" nor "terminal-failed" for the
 * CURRENT generation, so this function returns WITHOUT WRITING — it owns nothing of this
 * generation's cache, and leaves whatever the current generation's own state already is (typically
 * NULL, from the regeneration's own clear) untouched.
 */
function refreshPrintedStatusCache(memberId: string, date: string): void {
  const recordKey = `${PRINTABLE_RECORD_KEY_PREFIX}:${memberId}`;
  const record = getPrintRecordStatus(recordKey, date);
  if (!record) return; // absence-tolerant, ADR-039 — nothing to refresh against

  let status: "completed" | "failed" | null = null;
  let printedAt: number | null = null;
  if (record.printed) {
    status = "completed";
    printedAt = record.printedAt;
  } else if (hasTerminalFailedJob(recordKey, date)) {
    status = "failed";
  }
  if (status === null) return; // a stale-generation survivor owns nothing of this generation

  getDb()
    .prepare(
      `UPDATE daily_briefing SET last_print_state = ?, last_print_at = ?, last_print_generation = ?
       WHERE member_id = ? AND date = ?`
    )
    .run(status, printedAt, record.generation, memberId, date);
}

subscribe(
  "printing.completed",
  (payload) => {
    const parsed = tryParseDatedOutputRef(payload.outputRef);
    if (!parsed) return; // not this plugin's output — every OTHER producer shares this bus too
    refreshPrintedStatusCache(parsed.memberId, parsed.date);
  },
  "daily-briefing.printing-completed"
);
subscribe(
  "printing.failed",
  (payload) => {
    const parsed = tryParseDatedOutputRef(payload.outputRef);
    if (!parsed) return;
    refreshPrintedStatusCache(parsed.memberId, parsed.date);
  },
  "daily-briefing.printing-failed"
);

/** Read-time derivation (FR-005/FR-007). Gate: Printing inactive ⇒ `unavailable`
 * (AC-11) — distinct from `none`, and deliberately checked BEFORE touching any Printing table (an
 * inactive plugin's own tables may be in an arbitrary state; this function never depends on them
 * in that branch). Otherwise: `getPrintRecordStatus` is the read-time fallback query itself — its
 * `generation` is the ground truth this function compares the local cache against; a match means
 * the cache is trustworthy (skip re-deriving, just relay it), a mismatch (or an absent cache —
 * `last_print_state === null`) means the cache is stale/missing and the status is re-derived from
 * Printing's own tables directly (`record.printed` for `completed`; `hasTerminalFailedJob` — the
 * batch-C precedent shape — for `failed`; otherwise `none`), which ALSO refreshes the cache so the
 * next read is fast again. No record at all (`getPrintRecordStatus` returns `null`) means this
 * member/date's output was never enqueued — `none`, nothing to refresh.
 */
function derivePrintedStatus(
  memberId: string,
  date: string,
  row: Pick<DailyBriefingRow, "id" | "last_print_state" | "last_print_generation">
): PrintedStatus {
  if (!isPrintingPluginActive()) return "unavailable"; // FR-007/AC-11

  const recordKey = `${PRINTABLE_RECORD_KEY_PREFIX}:${memberId}`;
  const record = getPrintRecordStatus(recordKey, date);
  if (!record) return "none"; // never enqueued for this member/date

  if (row.last_print_state !== null && row.last_print_generation === record.generation) {
    return row.last_print_state; // D11: cache fresh — trust it, no re-derivation needed
  }

  // Cache absent or stale (a dropped event, or a regeneration that bumped the generation) —
  // re-derive from Printing's own tables (FR-005/AC-04 dropped-event recovery).
  let status: PrintedStatus;
  let printedAt: number | null = null;
  if (record.printed) {
    status = "completed";
    printedAt = record.printedAt;
  } else if (hasTerminalFailedJob(recordKey, date)) {
    status = "failed";
  } else {
    status = "none";
  }

  if (status !== "none") {
    getDb()
      .prepare(
        `UPDATE daily_briefing SET last_print_state = ?, last_print_at = ?, last_print_generation = ?
         WHERE id = ?`
      )
      .run(status, printedAt, record.generation, row.id);
  }
  return status;
}

// ── Render + store ───────────────────────
//
// Render is attempted whenever Printing is active. Every "ok" data block is a
// render candidate; `render/registry.ts` registers pressedslip defs for all 21
// block types. A registry miss (should not happen in production) still surfaces
// as `unrenderedBlocks` (`render/bridge.ts#doRender` + pressedslip composeTree
// reporting), kept separate from `failedRenderBlocks` so it never demotes status
// (see `deriveOverallStatus` below).

/** Select the renderable subset: every "ok" data block, verbatim envelope v2 title. */
function selectRenderableBlocks(blocks: BlockInstance[]): RenderBlockInput[] {
  return blocks
    .filter((block) => block.status === "ok")
    .map((block) => ({ type: block.type, title: block.title ?? block.type, data: block.data }));
}

interface RenderStoreResult {
  rasterBits: Uint8Array | null;
  rasterHeight: number | null;
  png: Uint8Array | null;
  /** GENUINE render-layer failures — feeds `deriveOverallStatus`. See `render/bridge.ts#RenderBridgeResult`. */
  failedRenderBlocks: string[];
  /** Registry-miss (no pressedslip render-def yet) — persisted, EXCLUDED from status math. */
  unrenderedBlocks: string[];
}

const NO_RENDER_RESULT: RenderStoreResult = {
  rasterBits: null,
  rasterHeight: null,
  png: null,
  failedRenderBlocks: [],
  unrenderedBlocks: [],
};

/** Structural briefing copy uses the same validated locale and defaults as settings reads. */
function readHouseholdLanguage(): string {
  return readEffectiveSettings().locale.language;
}

/** Render the briefing's currently-renderable blocks and pack the result. Never
 * throws — a catastrophic bridge failure already degrades to a null bitmap
 * (`render/bridge.ts#renderBriefingBitmap`), surfaced here as an all-null result the caller
 * persists as `render-failed` (D5) when there was survivor data. A structurally invalid PNG
 * degrades the SAME way: the bridge's own PNG passed every check IT knows how to run,
 * but the packing step is a further failure point this function owns, so it gets the identical
 * all-null treatment rather than propagating and killing the whole `generateBriefing` call.
 */
async function renderAndPackBriefing(
  memberId: string,
  memberName: string,
  date: string,
  blocks: BlockInstance[],
  language: string
): Promise<RenderStoreResult> {
  const envelope: RenderEnvelope = {
    memberId,
    memberName,
    date,
    language,
    blocks: selectRenderableBlocks(blocks),
  };
  const rendered = await renderBriefingBitmap(envelope);
  if (!rendered.bitmapPng) {
    return {
      ...NO_RENDER_RESULT,
      failedRenderBlocks: rendered.failedRenderBlocks,
      unrenderedBlocks: rendered.unrenderedBlocks,
    };
  }
  try {
    const packed = pngToPackedRaster(rendered.bitmapPng);
    return {
      rasterBits: packed.bits,
      rasterHeight: packed.height,
      png: rendered.bitmapPng,
      failedRenderBlocks: rendered.failedRenderBlocks,
      unrenderedBlocks: rendered.unrenderedBlocks,
    };
  } catch (err) {
    console.error("daily-briefing.render-and-pack.raster-decode-failed", {
      memberId,
      date,
      error: String(err),
    });
    return {
      ...NO_RENDER_RESULT,
      failedRenderBlocks: rendered.failedRenderBlocks,
      unrenderedBlocks: rendered.unrenderedBlocks,
    };
  }
}

/** Overall status derivation (render-half clause).
 * The data-layer status stands unchanged unless a render was actually ATTEMPTED (Printing
 * active) — UNLESS the data layer already failed outright (nothing survived to render in the
 * first place, so there is no NEW failure to report). When a render WAS attempted, D5's full
 * rule applies: catastrophic failure (no raster produced at all) ⇒ `render-failed`; OR a GENUINE
 * render failure "for ≥ surviving blocks" (`renderResult.failedRenderBlocks` non-empty — a
 * REGISTERED block's data failed adapter validation, or pressedslip's own schema/`render`
 * throw) ⇒ `render-failed` even when the raster still partially rendered; otherwise the data
 * layer's own verdict stands. `renderResult.unrenderedBlocks` (registry-miss — no pressedslip
 * render-def for that type) is DELIBERATELY excluded from this check — see
 * `render/bridge.ts#RenderBridgeResult`'s own doc comment for why conflating the two
 * populations would report `render-failed` on every registry gap.
 */
function deriveOverallStatus(
  dataStatus: BriefingStatus,
  renderResult: RenderStoreResult,
  renderAttempted: boolean
): BriefingStatus {
  if (!renderAttempted) return dataStatus;
  if (dataStatus === "failed") return dataStatus;
  if (renderResult.rasterBits === null) return "render-failed"; // catastrophic — no raster at all
  if (renderResult.failedRenderBlocks.length > 0) return "render-failed"; // genuine failure(s) among survivors
  return dataStatus;
}

// ── Full block-registry generation (FR-011/FR-014/FR-020) ──

/** v1's `titleFor` port (— TITLES), localized per DAILY-BRIEFING-INV-06 (fold):
 * the display name per type — formerly a literal camelCase-split algorithm plus 4 hard-coded
 * English overrides — now resolves through `render/labels.ts`'s `titles` map for the household's
 * language (the SAME es/en resolution the block generators already use via `getLabels`/
 * `readHouseholdLanguage`). The `en` set is unchanged byte-for-byte from the old algorithmic
 * output (see `labels.ts`'s own doc comment), so this is a re-homing, not a behavior change, for
 * an "en" household. Splitting "streakText" -> "STREAK TEXT" / "weatherText" -> "WEATHER TEXT" is
 * what keeps the `*Text` types' titles distinct from their visual twins ("STREAK"/"WEATHER").
 */
function titleLabel(type: string, language: string): string {
  const labels = getLabels(language);
  const known = labels.titles as Record<string, string | undefined>;
  return known[type] ?? type.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toUpperCase();
}

/** "NN TITLE", zero-padded. `ordinal` is v1-faithful: the block's position
 * in the FULL effective order (`gatherLocalBlocks`'s own loop index + 1), NOT a
 * recount of survivors — a disabled/weekday-masked/null-omitted block leaves a numbering GAP,
 * matching FR-021's retry-pass re-stamp presumption (re-stamped from the CURRENT effective order
 * on every run, never persisted as a stable per-block id). `language` resolves the label text
 * only (fold) — the ordinal template and numbering-with-gaps are unaffected by locale.
 */
function titleFor(type: string, ordinal: number, language: string): string {
  return `${String(ordinal).padStart(2, "0")} ${titleLabel(type, language)}`;
}

interface EffectiveBlockInstance {
  type: BlockRegistryType;
  params?: Record<string, unknown>;
}

/** v1 `orderRegistry` merge port (`daily_briefing_block_order`): configured
 * instances first (unknown/legacy types IGNORED — a type persisted before settings.ts's
 * write-boundary validation existed, or a v1-era name, is tolerated at generation, never
 * rejected), then every UNLISTED registry type appended in registry order. A type MAY repeat
 * (INV-05/ADR-044) — no dedup.
 */
function buildEffectiveOrder(configured: BlockOrderInstance[]): EffectiveBlockInstance[] {
  const known = configured.filter((entry): entry is EffectiveBlockInstance =>
    isKnownBlockType(entry.type)
  );
  const listed = new Set(known.map((entry) => entry.type));
  const appended = ALL_BLOCK_TYPES.filter((type) => !listed.has(type)).map((type) => ({ type }));
  return [...known, ...appended];
}

function isActiveOnWeekday(weekdays: Weekday[] | null, weekday: Weekday): boolean {
  return weekdays === null || weekdays.includes(weekday);
}

/** Effective per-(member,instance) params (`daily_briefing_member_block_settings` ⊕
 * `daily_briefing_block_order`): the member's own per-block-type settings are the BASE, the
 * block-order INSTANCE's own params override matching keys — a deliberate, documented judgment
 * call (neither nor the spec pins an exact merge precedence): this is what makes a
 * REPEATED instance (e.g. two `wordOfDay` occurrences at different `level`s) meaningful even
 * though `daily_briefing_member_block_settings` has only one row per (member, blockType).
 */
function resolveEffectiveParams(
  memberId: string,
  type: string,
  instanceParams: Record<string, unknown> | undefined
): { enabled: boolean; weekdays: Weekday[] | null; params: Record<string, unknown> | undefined } {
  const settings = resolveMemberBlockSettings(memberId, type);
  const merged = { ...(settings.params ?? {}), ...(instanceParams ?? {}) };
  return {
    enabled: settings.enabled,
    weekdays: settings.weekdays,
    params: Object.keys(merged).length > 0 ? merged : undefined,
  };
}

/** `listActiveMembers` port for `shotgun`/`birthday` (handoff note /): the SAME host-api read
 * feeds both blocks' injectable `ctx.listActiveMembers`. `birthDate` is normalized from
 * `MemberDTO`'s `{...}|null|undefined` (optional AND nullable) to `birthday.ts`'s port shape
 * (`{...}|null`, no `undefined`) — load-bearing per that block's own module doc: an `undefined`
 * slipping through would crash its cast at the `family` array-build step, so this `?? null` is
 * the fix, not a stylistic nicety.
 */
function listActiveMembersPort(): Array<
  ShotgunActiveMember & Pick<BirthdayActiveMember, "birthDate">
> {
  return listActiveMembers().map((m) => ({
    id: m.id,
    displayName: m.displayName,
    birthDate: m.birthDate ?? null,
  }));
}

/** `readDailyMessage` port for `message` (handoff note): `getMessage` throws
 * `DailyMessageNotFoundError` ONLY when the member row itself doesn't exist at all
 * (`memberExists` false) — NOT for "no message row for this date", which resolves `null` (see
 * `modules/daily-messages/index.ts#getMessage`). By the time this runs, `memberId` has already
 * passed `assertActiveMember` (existence implied), so this throw path is defense-in-depth for a
 * member archived/removed mid-generation — caught here and treated as "no block" (tolerant read,
 * matching this block's own "nothing to show" convention), never a data-layer failure record.
 */
function readDailyMessagePort(memberId: string, date: string): { text: string } | null {
  try {
    return getMessage(memberId, date);
  } catch (err) {
    if (err instanceof DailyMessageNotFoundError) return null;
    throw err;
  }
}

// ── quoteOfDay/onThisDay production port resolution (test-runtime guarded) ──────────────────
//
// Mirrors `modules/weather/port.ts`'s `getForecastPort`/`__setForecastPortForTests` precedent
// EXACTLY: under `isTestRuntime` with no injected override, resolution returns `null` — "no
// port available" — rather than ever constructing a real fetch-based adapter, so the hundreds of
// pre-existing daily-briefing tests that never touch quoteOfDay/onThisDay at all cannot
// accidentally trigger a real network call (workers have no network egress; CI must never depend
// on an external host being reachable). A `null` port resolution is OMISSION, not failure — it
// means "this call was never attempted", categorically distinct from "the call was attempted and
// failed" (handoff note the RECORDED-failed case), which can only happen once a real or
// test-injected port actually runs and throws (see `generateExternalBlock` below).
let quoteSourceOverride: QuoteSource | undefined;
let onThisDaySourceOverride: OnThisDaySource | undefined;

/** Test-only injection (the `weather/port.ts` `__setForecastPortForTests` precedent). */
export function __setQuoteSourceForTests(source: QuoteSource | undefined): void {
  quoteSourceOverride = source;
}

/** Test-only injection (the `weather/port.ts` `__setForecastPortForTests` precedent). */
export function __setOnThisDaySourceForTests(source: OnThisDaySource | undefined): void {
  onThisDaySourceOverride = source;
}

function resolveQuoteSource(): QuoteSource | null {
  if (quoteSourceOverride) return quoteSourceOverride;
  if (isTestRuntime()) return null;
  return zenQuotesSource;
}

function resolveOnThisDaySource(): OnThisDaySource | null {
  if (onThisDaySourceOverride) return onThisDaySourceOverride;
  if (isTestRuntime()) return null;
  return wikipediaOnThisDaySource;
}

type BlockOutcome = { data: unknown } | { error: string } | null;

/** `getOrFetchOnceDaily` (`external/shared-cache.ts`) already swallows a thrown fetcher into an
 * UNCACHED `null` (FR-019 "no negative caching") — from the CALLER's side that is
 * indistinguishable from a legitimate "no data today" resolve. Handoff note: quoteOfDay/
 * onThisDay's INV-07 contract is "record the failed block" on a genuine call failure (unlike
 * weather's own documented WEATHER-INV-10/12 exception, which always omits) — so this wrapper
 * tracks, via a closure flag, whether OUR OWN fetcher invocation actually threw THIS call,
 * distinguishing that from a cache hit or a legitimately-resolved `null` (which never sets the
 * flag at all, since `getOrFetchOnceDaily` skips the fetcher entirely on a hit).
 */
async function generateExternalBlock<T>(
  cache: DailyBlockCache,
  blockType: string,
  port: (() => Promise<T | null>) | null
): Promise<BlockOutcome> {
  if (!port) return null;
  let threw = false;
  const result = await getOrFetchOnceDaily<T>(cache, blockType, async () => {
    try {
      return await port();
    } catch (err) {
      threw = true;
      throw err;
    }
  });
  if (threw) return { error: "gather_failed" };
  return result === null ? null : { data: result };
}

/** Dispatch one block instance's content generation. Returns `null` for a legitimate "no block"
 * (handoff note the null-omit trap: distinct from a THROW, which this function converts to
 * `{error: "gather_failed"}` and NEVER lets escape to the caller — every generator in this
 * dispatch, corpus ones especially, may throw for an invalid param — see each `case`).
 */
function generateLocalBlockData(
  type: InTransactionBlockType,
  memberId: string,
  date: string,
  params: Record<string, unknown> | undefined,
  language: string,
  txCtx: CalendarReadContext
): BlockOutcome {
  try {
    switch (type) {
      case "shotgun": {
        const data = shotgunBlock.generate({
          date,
          listActiveMembers: listActiveMembersPort,
        });
        return data === null ? null : { data };
      }
      case "message": {
        const data = messageBlock.generate({
          memberId,
          date,
          readDailyMessage: readDailyMessagePort,
        });
        return data === null ? null : { data };
      }
      case "streak": {
        const data = streakBlock.generate({
          memberId,
          date,
          language,
        });
        return data === null ? null : { data };
      }
      case "streakText": {
        const data = streakTextBlock.generate({
          memberId,
          date,
          language,
        });
        return data === null ? null : { data };
      }
      case "today": {
        const data = todayBlock.generate({ memberId, date, txCtx });
        return data === null ? null : { data };
      }
      case "meals": {
        const data = mealsBlock.generate({ date });
        return data === null ? null : { data };
      }
      case "birthday": {
        const data = birthdayBlock.generate({
          memberId,
          date,
          listActiveMembers: listActiveMembersPort,
          language,
        });
        return data === null ? null : { data };
      }
      case "reminders": {
        const data = remindersBlock.generate({ memberId, date, txCtx });
        return data === null ? null : { data };
      }
      // Corpus-backed generators are SYNCHRONOUS and throw
      // `CorpusBlockParamError` on an invalid/unavailable param — caught below like any other
      // data-layer failure (FR-020's serial-loop discipline is the CALLER's — see
      // `gatherLocalBlocks`).
      case "dadJoke":
        return { data: generateDadJoke({ date, memberId, params: params as CorpusBlockParams }) };
      case "wordOfDay":
        return {
          data: generateWordOfDay({ date, memberId, params: params as CorpusBlockParams }),
        };
      case "animalFact":
        return {
          data: generateAnimalFact({ date, memberId, params: params as CorpusBlockParams }),
        };
      case "numberFact":
        return {
          data: generateNumberFact({ date, memberId, params: params as CorpusBlockParams }),
        };
      case "trivia":
        return { data: generateTrivia({ date, memberId, params: params as CorpusBlockParams }) };
      case "riddle":
        return { data: generateRiddle({ date, memberId, params: params as CorpusBlockParams }) };
      case "wouldYouRather":
        return {
          data: generateWouldYouRather({ date, memberId, params: params as CorpusBlockParams }),
        };
      case "wordSearch":
        return {
          data: generateWordSearch({ date, memberId, params: params as CorpusBlockParams }),
        };
      case "drawingPrompt":
        return {
          data: generateDrawingPrompt({ date, memberId, params: params as CorpusBlockParams }),
        };
      case "phonics":
        return {
          data: generatePhonics({ date, memberId, params: params as CorpusBlockParams }),
        };
      default: {
        // Compile-time exhaustiveness: a catalogue type without a case fails typecheck here.
        const unhandled: never = type;
        return unhandled;
      }
    }
  } catch (err) {
    console.error("daily-briefing.generate-block.failed", {
      type,
      memberId,
      date,
      error: String(err),
    });
    return { error: "gather_failed" };
  }
}

/** Capture local outcomes and effective metadata synchronously in the caller's read transaction.
 * Keep corpus generation serial: wordSearch confines process-global Math.random (FR-020).
 */
function gatherLocalBlocks(
  memberId: string,
  date: string,
  language: string,
  txCtx: CalendarReadContext
): Array<{ block: BlockInstance; outcome: BlockOutcome; external: boolean }> {
  const tz = readHouseholdTimezone();
  const weekday = weekdayOf(date, tz);
  const effectiveOrder = buildEffectiveOrder(readBlockOrder());

  const blocks: Array<{ block: BlockInstance; outcome: BlockOutcome; external: boolean }> = [];

  // FR-020 fence — see this function's own doc comment above. Do not parallelize this loop.
  for (let i = 0; i < effectiveOrder.length; i += 1) {
    const instance = effectiveOrder[i];
    // v1-faithful numbering: the position in the FULL effective order,
    // not a recount of survivors — see `titleFor`'s own doc comment.
    const position = i + 1;
    const settings = resolveEffectiveParams(memberId, instance.type, instance.params);
    const { enabled, weekdays } = settings;
    let { params } = settings;
    if (!enabled) continue;
    if (!isActiveOnWeekday(weekdays, weekday)) continue;

    // Freeze the default before dispatch so generators and snapshot metadata share it.
    // Explicit overrides still pass through the generator validation unchanged.
    if (isCorpusBackedBlockType(instance.type) && params?.language === undefined) {
      params = {
        ...params,
        language: resolveCorpusLanguage(instance.type, params as CorpusBlockParams, language),
      };
    }

    if (!isPluginContentSourceActive(instance.type)) continue;
    const { type } = instance;
    const external = isExternalBlockType(type);
    const outcome = external
      ? null
      : generateLocalBlockData(type, memberId, date, params, language, txCtx);
    if (!external && outcome === null) continue; // handoff note: null-omit, never a recorded block.

    const block: BlockInstance = {
      type: instance.type as BlockInstance["type"],
      scope: blockScope(instance.type),
      status: "ok",
      index: position,
      title: titleFor(instance.type, position, language),
    };
    // FR-008/FR-009: `language` appears ONLY for corpus-backed types, resolved through the SAME
    // resolver `blocks/context.ts`'s generators themselves call (— single
    // source of truth for the frozen effective language, not a re-derived duplicate).
    if (isCorpusBackedBlockType(instance.type)) {
      try {
        block.language = resolveCorpusLanguage(instance.type, params as CorpusBlockParams);
      } catch {
        // The generator already recorded this AS a failed block via the SAME resolver
        // (CorpusBlockParamError) — stamp the raw requested value for diagnostic visibility,
        // never re-throw here.
        block.language = typeof params?.language === "string" ? params.language : "en";
      }
    }
    if (params !== undefined) {
      block.params = params;
    }
    blocks.push({ block, outcome, external });
  }
  return blocks;
}

async function finishBlocks(
  gathered: ReturnType<typeof gatherLocalBlocks>,
  memberId: string,
  cache: DailyBlockCache,
  date: string,
  now: number,
  weatherInputs: WeatherBlockInputs | null
): Promise<BlockInstance[]> {
  const blocks: BlockInstance[] = [];
  for (const { block, outcome: localOutcome, external } of gathered) {
    let outcome = localOutcome;
    if (external) {
      try {
        const type = block.type as ExternalBlockType;
        switch (type) {
          case "weather":
          case "weatherText": {
            const data = await generateWeatherBlock(cache, date, now, weatherInputs);
            outcome = data === null ? null : { data };
            break;
          }
          case "quoteOfDay":
            outcome = await generateExternalBlock(cache, "quoteOfDay", resolveQuoteSource());
            break;
          case "onThisDay": {
            const source = resolveOnThisDaySource();
            outcome = await generateExternalBlock(
              cache,
              "onThisDay",
              source ? () => source(date) : null
            );
            break;
          }
          default: {
            const unhandled: never = type;
            throw new Error(`no external generator for "${String(unhandled)}"`);
          }
        }
      } catch (err) {
        console.error("daily-briefing.generate-block.failed", {
          type: block.type,
          memberId: memberId,
          date,
          error: String(err),
        });
        outcome = { error: "gather_failed" };
      }
    }
    if (outcome === null) continue;
    if ("error" in outcome) {
      block.status = "failed";
      block.error = outcome.error;
    } else {
      block.data = outcome.data;
    }
    blocks.push(block);
  }
  return blocks;
}

/** Generate a content-ready Daily Briefing snapshot for one opted-in active
 * member. Local reads share one synchronous transaction; external work and rendering
 * finish before the separate atomic persistence transaction and post-commit event.
 * `sharedCache` ( mirroring the `weatherMemo` shape) is threaded through by
 * `generateAllBriefings` so a batch shares one `daily_briefing_block_cache` instance (one
 * external call per source per date per household); a direct caller (the manual single-member
 * route) gets a fresh, request-scoped cache — still correct thanks to the shared cache's own
 * DB-backed persistence + refresh-before-fetch check (`external/shared-cache.ts`).
 */
/** Internal sentinel: thrown ONLY from inside the write
 * transaction's late-eligibility recheck below, to trigger better-sqlite3's automatic rollback.
 * Never escapes `generateBriefing` itself — caught immediately around the transaction call and
 * translated into either a clean early-return (a prior frozen row exists) or a
 * `DailyBriefingValidationError` (no prior row — nothing honest to return). Kept distinct from
 * `DailyBriefingValidationError` so the two abort REASONS ("the request was invalid from the
 * start" vs "a concurrent change raced a healthy request") never get confused in a stack trace.
 */
class LateEligibilityAbortError extends Error {}
class LatePauseAbortError extends Error {}

// ── In-flight registry (spec D7) ───────────────────────────────────────────
// `pending` never escapes the write transaction, so the admin preview cannot tell "still
// rendering" from the row. This per-process counter marks (member, date) from the end of the
// read transaction until generateBriefing settles. One process, one scheduler (Constitution III).
const generationsInFlight = new Map<string, number>();

function flightKey(memberId: string, date: string): string {
  return `${memberId}:${date}`;
}

/** True while at least one generation for this member/date is running. */
export function isBriefingGenerating(memberId: string, date: string): boolean {
  return generationsInFlight.has(flightKey(memberId, date));
}

/** Constitution XIV probe hook (fold) — test-only. Forces an abort
 * IMMEDIATELY AFTER `supersedePrintRecordTxn` returns inside the write transaction below, so a
 * test can empirically prove atomicity BOTH ways: `supersedePrintRecordTxn`'s own nested
 * `db.transaction` has by then already RELEASEd its savepoint (i.e. "committed" from its own
 * point of view), yet the forced throw here still rolls the WHOLE outer transaction back —
 * proving the outer ROLLBACK discards an already-released nested savepoint too, not just the
 * outer statements. `undefined`/`false` resets to the default (no forced abort) — mirrors this
 * module's other `__set*ForTests` seams (e.g. `__setQuoteSourceForTests` above).
 */
let forcePostSupersedeAbortForTests = false;
export function __setForcePostSupersedeAbortForTests(force: boolean | undefined): void {
  forcePostSupersedeAbortForTests = force ?? false;
}
class ForcedPostSupersedeAbortError extends Error {}

export async function generateBriefing(
  memberId: string,
  requestedDate?: string,
  sharedCache?: DailyBlockCache
): Promise<Briefing> {
  if (typeof memberId !== "string" || memberId.trim().length === 0) {
    throw new DailyBriefingValidationError("memberId is required");
  }
  const db = getDb();
  const generationClock = Date.now();
  const inputs = db.transaction(() => {
    const date = resolveBusinessDate(requestedDate);
    try {
      assertActiveMember(memberId);
    } catch (err) {
      throw new DailyBriefingValidationError(
        err instanceof Error ? err.message : `Member "${memberId}" is not active`
      );
    }
    const member = resolveMemberLabel(memberId);
    if (!member) {
      throw new DailyBriefingValidationError(`Member "${memberId}" does not exist`);
    }
    if (!isOptedIn(memberId)) {
      throw new DailyBriefingValidationError(`Member "${memberId}" is not opted in`);
    }
    if (!isBriefingScheduledOn(memberId, date)) {
      throw new DailyBriefingPausedError(memberId, date);
    }

    const language = readHouseholdLanguage();
    const txCtx: CalendarReadContext = new Map();
    return {
      member,
      date,
      language,
      weather: readWeatherBlockInputs(generationClock),
      blocks: gatherLocalBlocks(memberId, date, language, txCtx),
    };
  })();
  const { member, date, language } = inputs;
  const flight = flightKey(memberId, date);
  generationsInFlight.set(flight, (generationsInFlight.get(flight) ?? 0) + 1);
  try {
    const cache = sharedCache ?? createDailyBlockCache(date);
    const blocks = await finishBlocks(
      inputs.blocks,
      memberId,
      cache,
      date,
      generationClock,
      inputs.weather
    );

    // TOCTOU re-validation ( generalized to the now-multi-call gather
    // phase): re-run the SAME two eligibility checks immediately before the transaction opens, so a
    // member who went ineligible DURING the gather can never get a stale-eligible write past this
    // strict-on-write boundary.
    try {
      assertActiveMember(memberId);
    } catch (err) {
      throw new DailyBriefingValidationError(
        err instanceof Error ? err.message : `Member "${memberId}" is not active`
      );
    }
    if (!isOptedIn(memberId)) {
      throw new DailyBriefingValidationError(`Member "${memberId}" is not opted in`);
    }
    if (!isBriefingScheduledOn(memberId, date)) {
      throw new DailyBriefingPausedError(memberId, date);
    }

    // exit condition: render whenever Printing is active (full 21-type registry;
    // see the "Render + store" section doc comment above `selectRenderableBlocks`).
    const shouldRender = isPrintingPluginActive();
    const renderResult: RenderStoreResult = shouldRender
      ? await renderAndPackBriefing(memberId, member.displayName, date, blocks, language)
      : NO_RENDER_RESULT;

    const now = Date.now();
    let briefing: Briefing;
    try {
      briefing = db.transaction((): Briefing => {
        // Printing-active render can await up to 30s — a member
        // archived or opted-out during THAT window would otherwise slip past the pre-render TOCTOU
        // check above and still get a row written. Re-check ONE MORE TIME, as the very FIRST
        // statement of the write transaction (before the reservation upsert even runs): throwing
        // here rolls back the WHOLE transaction via better-sqlite3's automatic rollback-on-throw —
        // nothing commits, not even the reservation. This is deliberately chosen over letting the
        // reservation persist as a dangling 'pending' row: a full-transaction abort sidesteps the
        // delete-vs-leave-for-next-pass dilemma entirely (there is nothing to clean up either way)
        // — a PRE-EXISTING row (if any) stays completely untouched, and a first-ever attempt
        // leaves no row at all (FR-010 purity). The sentinel is caught immediately below; it never
        // escapes this function as-is.
        if (!isActiveMember(memberId) || !isOptedIn(memberId)) {
          throw new LateEligibilityAbortError(memberId);
        }
        // A weekday paused during the render aborts the same way, before anything is written.
        if (!isBriefingScheduledOn(memberId, date)) {
          throw new LatePauseAbortError(memberId);
        }
        // The unique (member_id, date) index is the reservation: an existing row
        // keeps its stable id while its synchronous regeneration is pending. The
        // pending state never escapes this transaction; only the settled update is
        // returned to the HTTP boundary.
        const reservation = db
          .prepare(
            `INSERT INTO daily_briefing (id, member_id, date, status, payload, created_at, updated_at)
             VALUES (?, ?, ?, 'pending', '{}', ?, ?)
             ON CONFLICT(member_id, date) DO UPDATE SET
               status = 'pending',
               updated_at = MAX(daily_briefing.updated_at + 1, excluded.updated_at)
             RETURNING id, created_at, updated_at`
          )
          .get(
            globalThis.crypto.randomUUID(),
            memberId,
            date,
            now,
            now
          ) as DailyBriefingReservation;
        const payload: BriefingPayload = {
          schemaVersion: 2,
          member: { id: member.id, displayName: member.displayName },
          date,
          blocks,
        };
        const settled: Briefing = {
          id: reservation.id,
          memberId,
          date,
          status: deriveOverallStatus(deriveStatus(payload.blocks), renderResult, shouldRender),
          payload,
          createdAt: reservation.created_at,
          updatedAt: reservation.updated_at,
        };
        // (extended); drizzle/0018: raster/png/failed_render_blocks/
        // unrendered_blocks are written atomically alongside status/payload in this SAME statement —
        // a crash can never leave a committed payload update without its paired render outcome.
        // (FR-002): the local printed-status cache is ALSO cleared here, in the SAME statement —
        // a stale `last_print_*` cache must never survive a regeneration (a NULL is always correct:
        // either this is a first-ever generation, where the columns are already NULL, or it is a
        // regeneration, whose whole point is invalidating whatever the prior generation's cache said).
        db.prepare(
          `UPDATE daily_briefing
           SET status = ?, payload = ?, failed_render_blocks = ?, unrendered_blocks = ?,
               raster_bits = ?, raster_height = ?, png = ?,
               last_print_state = NULL, last_print_at = NULL, last_print_generation = NULL,
               updated_at = ?
           WHERE id = ?`
        ).run(
          settled.status,
          JSON.stringify(settled.payload),
          JSON.stringify(renderResult.failedRenderBlocks),
          JSON.stringify(renderResult.unrenderedBlocks),
          renderResult.rasterBits ? Buffer.from(renderResult.rasterBits) : null,
          renderResult.rasterHeight,
          renderResult.png ? Buffer.from(renderResult.png) : null,
          settled.updatedAt,
          settled.id
        );

        // (FR-002/FR-003/FR-004, fold): supersede this member/date's
        // daily-briefing print record IN THIS SAME TRANSACTION, via the transaction-composable
        // variant (see `printing/index.ts#supersedePrintRecordTxn`'s own doc comment for the
        // empirically-probed savepoint-nesting mechanism that makes this correct). A crash can
        // therefore never leave a committed new snapshot alongside an un-superseded print record or
        // a surviving stale pending/claimed job. Unconditional — never gated on "is this actually a
        // regeneration" — because the call is a documented no-op when no print_records row exists
        // yet (a first-ever generation), so the ONE code path is exercised by every call. No print
        // job is ever enqueued here (FR-002 forbids it) — the next trigger sweep or admin action
        // re-enqueues against the now-superseded (higher-generation) record.
        supersedePrintRecordTxn(`${PRINTABLE_RECORD_KEY_PREFIX}:${memberId}`, date, now);

        if (forcePostSupersedeAbortForTests) {
          // Constitution XIV probe (see `__setForcePostSupersedeAbortForTests`'s own doc comment) —
          // never true in production; this branch exists solely for the atomicity test. POSITION IS
          // LOAD-BEARING for what that test actually proves: this throw must fire AFTER
          // `supersedePrintRecordTxn` above has already returned (i.e. its own nested transaction has
          // RELEASEd its savepoint — "committed" from its own point of view), not before it. Moving
          // this check earlier would only prove the trivial case (an abort before ANY write) and say
          // nothing about savepoint-nesting rollback; firing it here is what proves the outer
          // ROLLBACK discards an already-released nested savepoint too, not just the outer's own
          // statements.
          throw new ForcedPostSupersedeAbortError("savepoint probe: forced abort after supersede");
        }

        return settled;
      })();
    } catch (err) {
      if (err instanceof LatePauseAbortError) {
        console.warn("daily-briefing.generate.late-pause-abort", { memberId, date });
        throw new DailyBriefingPausedError(memberId, date);
      }
      if (!(err instanceof LateEligibilityAbortError)) throw err;
      // English, machine-actionable log (repo convention) — quiet abort, never a crash: the
      // render's own work is discarded, no content or raster was ever committed.
      console.warn("daily-briefing.generate.late-eligibility-abort", { memberId, date });
      const existing = readBriefing(memberId, date);
      if (existing.generated) {
        // A prior frozen snapshot stands, completely untouched by this aborted attempt — return
        // it as-is. No `daily_briefing.generated` emit: nothing actually changed, so emitting
        // would falsely signal a fresh generation to any subscriber.
        return existing.briefing;
      }
      // First-ever generation attempt for this member/date, now abandoned — there is nothing
      // honest to return. Same observable failure as the pre-render TOCTOU checks above (a
      // concurrent archive/opt-out): a 400 to a manual caller, a quiet skip in
      // `generateAllBriefings`'s per-candidate catch.
      throw new DailyBriefingValidationError(`Member "${memberId}" is not active or opted in`);
    }

    emit("daily_briefing.generated", {
      memberId: briefing.memberId,
      date: briefing.date,
      status: briefing.status,
    });

    return briefing;
  } finally {
    const remaining = (generationsInFlight.get(flight) ?? 1) - 1;
    if (remaining > 0) generationsInFlight.set(flight, remaining);
    else generationsInFlight.delete(flight);
  }
}

/** Read-only snapshot lookup. A missing row is not generated on demand. `printedStatus` is derived at read time — see `derivePrintedStatus`'s own doc comment; deriving it
 * may refresh this row's advisory print-status cache (never creates a row, never touches content —
 * FR-010's purity is about generation, not this cache bookkeeping). */
export function readBriefing(memberId: string, date: string): BriefingReadResult {
  if (typeof memberId !== "string" || memberId.trim().length === 0) {
    throw new DailyBriefingValidationError("memberId is required");
  }
  assertStrictCalendarDate(date);
  const row = getDb()
    .prepare(
      `SELECT id, member_id, date, status, payload, created_at, updated_at,
              last_print_state, last_print_at, last_print_generation
       FROM daily_briefing WHERE member_id = ? AND date = ?`
    )
    .get(memberId, date) as DailyBriefingRow | undefined;

  if (!row) return { generated: false };
  return {
    generated: true,
    briefing: rowToBriefing(row),
    printedStatus: derivePrintedStatus(memberId, date, row),
  };
}

/** Admin preview lookup result (contracts/openapi.yaml
 * `GET /api/daily-briefing/{memberId}/{date}/preview.png`). Distinguishes "no briefing at all"
 * (`found: false` -> 404) from "briefing exists but never got a printable raster" (`found: true,
 * png: null` -> 409 `printable_raster_missing` — Printing was inactive at generation, or a
 * catastrophic render, D5) — the route layer maps these two cases to distinct status codes.
 */
export interface BriefingPngResult {
  found: boolean;
  png: Buffer | null;
  /** A generation for this member/date is in flight. */
  generating: boolean;
}

/** Serves the SAME `png` column pressedslip wrote at generation time (schema.ts: "admin/preview
 * surface only") — never re-decodes the packed 1-bit raster, never re-renders. A pure read, same
 * as `readBriefing` above: a missing row is not generated on demand (FR-010).
 */
export function readBriefingPng(memberId: string, date: string): BriefingPngResult {
  if (typeof memberId !== "string" || memberId.trim().length === 0) {
    throw new DailyBriefingValidationError("memberId is required");
  }
  assertStrictCalendarDate(date);
  const row = getDb()
    .prepare("SELECT png FROM daily_briefing WHERE member_id = ? AND date = ?")
    .get(memberId, date) as { png: Buffer | null } | undefined;

  const generating = isBriefingGenerating(memberId, date);
  if (!row) return { found: false, png: null, generating };
  return { found: true, png: row.png, generating };
}

/** How many history rows the admin list shows (reference parity). */
export const BRIEFING_HISTORY_LIMIT = 30;

/** Admin history: the member's latest briefings, newest date first, plus the household business
 * date the client uses as its default selection. A pure read (FR-010). */
export function listBriefingHistory(memberId: string): BriefingHistoryResponse {
  const rows = getDb()
    .prepare(
      `SELECT id, date, status, updated_at FROM daily_briefing
       WHERE member_id = ? ORDER BY date DESC LIMIT ?`
    )
    .all(memberId, BRIEFING_HISTORY_LIMIT) as Array<{
    id: string;
    date: string;
    status: BriefingStatus;
    updated_at: number;
  }>;
  return {
    today: resolveBusinessDate(undefined),
    entries: rows.map((row) => ({
      id: row.id,
      date: row.date,
      status: row.status,
      updatedAt: row.updated_at,
    })),
  };
}

/** Manual print (spec D6) through Printing's producer seam — never Printing internals. The job
 * targets the household TODAY (claims are day-scoped) under a per-briefing manual record key, so
 * it never touches the automatic print's dedup or this briefing's derived printed-status. A job
 * still waiting is reused; a printed record is superseded so the click prints again. */
export function printBriefing(memberId: string, date: string, now: number): BriefingPrintResponse {
  assertStrictCalendarDate(date);
  if (!isPrintingPluginActive()) throw new DailyBriefingPrintUnavailableError();
  const row = getDb()
    .prepare("SELECT raster_bits FROM daily_briefing WHERE member_id = ? AND date = ?")
    .get(memberId, date) as { raster_bits: Buffer | null } | undefined;
  if (!row) {
    throw new DailyBriefingNotFoundError(`No briefing for member "${memberId}" on ${date}`);
  }
  if (row.raster_bits === null) {
    throw new DailyBriefingRasterMissingError(
      `The briefing for member "${memberId}" on ${date} has no printable raster`
    );
  }
  try {
    assertActiveMember(memberId);
  } catch {
    throw new DailyBriefingValidationError(`Member "${memberId}" is not active`);
  }
  const params = {
    recordKey: `${PRINTABLE_RECORD_KEY_PREFIX}:${memberId}:manual:${date}`,
    targetDate: todayInHouseholdTz(now),
    outputRef: `${PRINTABLE_RECORD_KEY_PREFIX}:${memberId}:${date}`,
    memberId,
  };
  let result = enqueuePrintJob(params, now);
  if (result.alreadyPrinted) {
    supersedePrintRecord(params.recordKey, params.targetDate, now);
    result = enqueuePrintJob(params, now);
  }
  return { jobId: result.jobId, enqueued: result.enqueued };
}

/** Set Daily Briefing's own per-member opt-in state after strict active-member validation. */
export function setOptIn(memberId: string, enabled: boolean): OptInState {
  if (typeof memberId !== "string" || memberId.trim().length === 0) {
    throw new DailyBriefingValidationError("memberId is required");
  }
  if (typeof enabled !== "boolean") {
    throw new DailyBriefingValidationError("enabled must be a boolean");
  }
  try {
    assertActiveMember(memberId);
  } catch (err) {
    throw new DailyBriefingValidationError(
      err instanceof Error ? err.message : `Member "${memberId}" is not active`
    );
  }

  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO daily_briefing_optin (member_id, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(member_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`
    )
    .run(memberId, enabled ? 1 : 0, now, now);
  return { memberId, enabled };
}

/** List persisted Daily Briefing opt-in states. Members with no row remain
 * opted out by default, so this plugin-owned query never enumerates Members.
 */
export function listOptIns(): OptInState[] {
  if (!isDailyBriefingPluginActive()) return [];
  const rows = getDb()
    .prepare("SELECT member_id, enabled FROM daily_briefing_optin ORDER BY member_id ASC")
    .all() as Array<{ member_id: string; enabled: number }>;
  return rows.map((row) => ({ memberId: row.member_id, enabled: row.enabled === 1 }));
}

/** Generate one briefing for every active member explicitly opted into Daily
 * Briefing. Candidate enumeration stays within the plugin's own table; the
 * host API supplies the active-member eligibility gate for each candidate.
 * a single `DailyBlockCache` is created here and threaded through every
 * `generateBriefing` call in the batch, so a household's shared-scope external blocks
 * (weather, quoteOfDay, onThisDay) resolve to exactly ONE upstream call each regardless of how
 * many members are opted in. Candidates are generated sequentially (not `Promise.all`) to
 * preserve the prior synchronous batch's per-member reservation ordering AND FR-020's serial-loop
 * discipline (a corpus generator's confined `Math.random` must never overlap another call).
 * TOCTOU: this loop's `isActiveMember` gate is checked fresh,
 * synchronously, immediately before each candidate's own `generateBriefing` call — so it is
 * never stale relative to a PRIOR candidate's gather phase. The remaining gap is entirely
 * inside `generateBriefing` itself (its OWN gather phase), which now re-validates right
 * before its transaction opens and throws `DailyBriefingValidationError` if a concurrent
 * archive/opt-out landed during that wait. One candidate losing eligibility mid-flight must
 * not abort the rest of the batch (the exact all-or-nothing hazard this function already
 * guards against for a pre-archived candidate) — caught and skipped below.
 */
export async function generateAllBriefings(requestedDate?: string): Promise<Briefing[]> {
  const date = resolveBusinessDate(requestedDate);
  const candidates = getDb()
    .prepare("SELECT member_id FROM daily_briefing_optin WHERE enabled = 1 ORDER BY member_id ASC")
    .all() as Array<{ member_id: string }>;

  const sharedCache = createDailyBlockCache(date);
  const briefings: Briefing[] = [];
  for (const { member_id: memberId } of candidates) {
    // An opt-in row remains after archive so that reactivation self-heals; it
    // is skipped while inactive rather than treated as an all-or-nothing error.
    if (!isActiveMember(memberId)) continue;
    // A member paused on this weekday is skipped like an inactive one (spec D4).
    if (!isBriefingScheduledOn(memberId, date)) continue;
    try {
      briefings.push(await generateBriefing(memberId, date, sharedCache));
    } catch (err) {
      if (!(err instanceof DailyBriefingValidationError)) throw err;
      // A concurrent archive/opt-out raced THIS candidate's gather phase and was caught by
      // generateBriefing's post-gather re-validation — skip it, same as a pre-archived one.
    }
  }
  return briefings;
}

export function deriveStatus(blocks: BlockInstance[]): BriefingStatus {
  if (blocks.length === 0 || blocks.every((block) => block.status === "ok")) {
    return "ready";
  }
  if (blocks.every((block) => block.status === "failed")) {
    return "failed";
  }
  return "partial";
}

function resolveBusinessDate(requestedDate: string | undefined): string {
  if (requestedDate === undefined || requestedDate === null) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: readHouseholdTimezone(),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((entry) => entry.type === type)?.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  }
  assertStrictCalendarDate(requestedDate);
  return requestedDate;
}

function assertStrictCalendarDate(date: unknown): asserts date is string {
  if (typeof date !== "string" || !isStrictCalendarDate(date)) {
    throw new DailyBriefingValidationError(`Invalid date "${String(date)}"`);
  }
}

function isOptedIn(memberId: string): boolean {
  const row = getDb()
    .prepare("SELECT enabled FROM daily_briefing_optin WHERE member_id = ?")
    .get(memberId) as { enabled: number } | undefined;
  return row?.enabled === 1;
}
