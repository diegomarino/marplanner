/** Durable printing state machine: enqueue, claim, resolve payload, acknowledge,
 * retry and supersede. Claims are fenced by leases and scoped to household today;
 * HTTP callers supply the registered printer session. Plugin inactivity blocks work.
 * Providers resolve current content at execution time. Payload conversion validates
 * raster shape and device width before ESC/POS wrapping. Successful acknowledgement
 * clears superseded state; read-time status remains authoritative if events are lost.
 * The transaction-composable supersede seam lets briefing regeneration update its
 * snapshot and print state atomically.
 */
import { randomUUID } from "node:crypto";
import {
  getDb,
  emit,
  todayInHouseholdTz,
  assertActiveMember,
  isStrictCalendarDate,
} from "../../host-api";
import { generateTestPrintRaster, buildPayload } from "./artifact";
import type {
  PrintJob,
  PrintJobState,
  DerivedPrintJobState,
  ClaimResponse,
  JobsListResponse,
  TestPrintResponse,
  PrintFailureErrorCode,
} from "../../../shared";

/** 120s lease (observed real transmission ~18s + v1's 3x GATT retries + margin). */
const LEASE_DURATION_MS = 120_000;

/** the test printable's record key (dedup anchor). */
const TEST_PRINT_RECORD_KEY = "test-print";

// ── Errors ──────────────────────────────────────────────────────────────

export class PrintJobNotFoundError extends Error {
  constructor(id: string) {
    super(`Print job not found: ${id}`);
    this.name = "PrintJobNotFoundError";
  }
}

/** A lease-token mismatch, an expired/rotated lease, or an operation attempted against a job
 * in a state that cannot accept it (e.g. ack on a non-claimed job) — INV-05 fencing. The route
 * layer maps every instance of this to 409, never leaking WHICH sub-case fired (the contract
 * doesn't distinguish them either).
 */
export class PrintLeaseStaleError extends Error {
  constructor(id: string) {
    super(`Stale or invalid lease for print job: ${id}`);
    this.name = "PrintLeaseStaleError";
  }
}

/** FR-021: the calling session has no server-registered printer capability. Mapped
 * to 403 at the HTTP boundary — the check runs BEFORE any job discovery, so it never
 * leaks whether a claimable job even exists.
 */
export class PrintCapabilityMissingError extends Error {
  /** Own machine code — deliberately NOT `AUTH_SCOPE_DENIED_CODE`: that constant names an
   * API-key SCOPE gap (`requireCapability`, src/server/auth/capability.ts); this is a different
   * failure mode entirely (a live, in-scope key whose SESSION never paired a printer). */
  readonly code = "printer_capability_missing" as const;
  constructor(sessionKeyId: string) {
    super(`Session "${sessionKeyId}" has no registered printer capability`);
    this.name = "PrintCapabilityMissingError";
  }
}

/** INV-06: the Printing plugin is inactive. Thrown by `enqueuePrintJob`/`claimJob`
 * ONLY — an already-active lease's payload/ack/fail flow completes regardless (AC-06 nuance);
 * see `isPrintingPluginActive` below for the gating seam itself.
 */
export class PrintingPluginInactiveError extends Error {
  constructor() {
    super("Printing plugin is inactive");
    this.name = "PrintingPluginInactiveError";
  }
}

/** A registered provider produced no usable content (none registered for the record key, or the
 * provider threw) at fetch-execute time — a PERMANENT failure (`render_failure`, * "Failure taxonomy"): the job is dead-lettered and `printing.failed` emitted BEFORE this throws.
 */
export class PrintRenderFailureError extends Error {
  /** matches the `PrintFailureErrorCode` literal `applyPermanentFailure` always stores for
   * this path (`getPayload`'s catch block below) — the route layer's 422 body carries it as its
   * own `code`, mirroring the network-devices `{error, code}` precedent. */
  readonly code: PrintFailureErrorCode = "render_failure";
  constructor(jobId: string) {
    super(`Render failure while resolving printable content for job: ${jobId}`);
    this.name = "PrintRenderFailureError";
  }
}

/** FR-006/FR-013's own validation gap closed (Constitution IV: "Dates MUST be strictly
 * calendar-valid" — `target_date` was UNOWNED until now, validated nowhere in the pipeline).
 * Thrown by `enqueuePrintJob` — the ONE seam every `target_date` (the admin trigger route today;
 * any future producer reaching this through the host-api barrel tomorrow) must pass through — so
 * the check binds every caller, not just the HTTP route (the same INV-06 argument this module
 * already applies to plugin-active gating). Mapped to 400 at the route layer; no `code` (matches
 * this repo's `NetworkDeviceValidationError`/`DailyBriefingValidationError` precedent: a plain
 * 400 validation error carries `{error, message}` only, `code` is reserved for a genuine
 * post-validation business-state conflict).
 */
export class PrintValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrintValidationError";
  }
}

// ── CORE plugin-active gating (INV-06, analyze E1) ──────────────────────

/** Module-level plugin-active seam (analyze E1: INV-06 must bind `enqueuePrintJob`/`claimJob` in
 * the CORE, not just at the route layer — a caller reaching the barrel directly (e.g. a future
 * producer) must be gated exactly like an HTTP caller). The core runtime installs the
 * canonical activation-registry-backed predicate. The active default preserves isolated legacy
 * module tests that intentionally construct no lifecycle host; production always installs the
 * shared predicate before accepting traffic.
 */
let printingPluginLifecycleGate: () => boolean = () => true;
let printingPluginActiveOverride: boolean | undefined;

/** Installed by the core runtime assembly; omitted only in isolated pre-lifecycle tests. */
export function configurePrintingPluginLifecycleGate(gate: (() => boolean) | undefined): void {
  printingPluginLifecycleGate = gate ?? (() => true);
}

export function isPrintingPluginActive(): boolean {
  return printingPluginActiveOverride ?? printingPluginLifecycleGate();
}

/** Test-only override — `undefined` returns control to the installed lifecycle gate. */
export function __setPrintingPluginActiveForTests(active: boolean | undefined): void {
  printingPluginActiveOverride = active;
}

export interface PrintingDrainDeps {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

const printingClaimDrainWaiters = new Set<() => void>();

function notifyPrintingClaimSettled(): void {
  for (const check of [...printingClaimDrainWaiters]) check();
}

function hasClaimedPrintingJobs(): boolean {
  return (
    getDb().prepare("SELECT 1 FROM print_jobs WHERE state = 'claimed' LIMIT 1").get() !== undefined
  );
}

/** Wait for current leases to settle without cancelling or shortening them. */
export function drainPrintingClaims(
  deadline: { readonly expiresAt: string },
  deps: PrintingDrainDeps = {
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) =>
      globalThis.clearTimeout(handle as Parameters<typeof globalThis.clearTimeout>[0]),
  }
): Promise<"drained" | "expired"> {
  if (!hasClaimedPrintingJobs()) return Promise.resolve("drained");

  const expiresAt = Date.parse(deadline.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= deps.now()) return Promise.resolve("expired");

  return new Promise((resolve) => {
    let timer: unknown = null;
    let settled = false;
    const finish = (result: "drained" | "expired") => {
      if (settled) return;
      settled = true;
      printingClaimDrainWaiters.delete(check);
      if (result === "drained" && timer !== null) deps.clearTimeout(timer);
      resolve(result);
    };
    const check = () => {
      if (!hasClaimedPrintingJobs()) finish("drained");
    };
    printingClaimDrainWaiters.add(check);
    check();
    if (!settled) timer = deps.setTimeout(() => finish("expired"), expiresAt - deps.now());
  });
}

// ── Printer-capability storage (FR-021) ─────────────────────

/** The "printer_capability" marker: a session (the executor's device-key id,
 * `api_keys.id`) registers ONCE on pairing; `claimJob` refuses any session without a row here —
 * a bare provisioned key alone cannot hold leases away from the real executor. Simplest honest
 * storage: one small PLUGIN-owned table (`printer_capabilities`, drizzle/0016), keyed by the
 * session's key id with NO FK to `api_keys` (cross-namespace — ADR-039 §3, this module's own
 * `member_id` precedent below): integrity is app-side, tolerant-on-read. Registration is
 * idempotent — re-pairing the SAME key upserts `registered_at` rather than erroring.
 */
export function registerPrinterCapability(sessionKeyId: string, now: number): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO printer_capabilities (key_id, registered_at) VALUES (?, ?)
     ON CONFLICT(key_id) DO UPDATE SET registered_at = excluded.registered_at`
  ).run(sessionKeyId, now);
}

export function hasPrinterCapability(sessionKeyId: string): boolean {
  const db = getDb();
  const row = db.prepare("SELECT 1 FROM printer_capabilities WHERE key_id = ?").get(sessionKeyId);
  return row !== undefined;
}

// ── Producer artifact seam ( ADR-041/ADR-022) ──────

export interface PrintableRaster {
  bits: Uint8Array;
  width: number;
  height: number;
}

/** A producer's artifact provider: resolved and CALLED at fetch-execute time only —
 * Printing never stores a raster (ADR-041/PRINTING-INV-03). Synchronous, per D4's own literal
 * signature (`(outputRef) => {bits, width, height}`); an async-rendering producer is out of this
 * slice's scope.
 */
export type PrintableProvider = (outputRef: string) => PrintableRaster;

const printableProviders = new Map<string, PrintableProvider>();

/** Register a provider for every record key equal to, or `:`-delimited-prefixed by,
 * `recordKeyPrefix` (e.g. 019's `daily-briefing:<memberId>` matches prefix `daily-briefing`).
 * Producer-agnostic: Printing never inspects `outputRef` beyond handing it back to the provider
 * verbatim (the seam carries only `outputRef` + metadata, FR-014).
 */
export function registerPrintableProvider(
  recordKeyPrefix: string,
  provider: PrintableProvider
): void {
  printableProviders.set(recordKeyPrefix, provider);
}

function resolveProvider(recordKey: string): PrintableProvider | undefined {
  for (const [prefix, provider] of printableProviders) {
    if (recordKey === prefix || recordKey.startsWith(`${prefix}:`)) return provider;
  }
  return undefined;
}

/** The test printable's own provider: generates the real procedural
 * raster — border frame, stripe bands, "MARPLANNER TEST" banner, and a date band — via
 * `artifact.ts#generateTestPrintRaster`, proving the exact producer seam 019's provider will
 * use. `outputRef` carries the trigger's household-local date as its own `:`-delimited suffix
 * (`enqueueTestPrint` below sets it to `${TEST_PRINT_RECORD_KEY}:${targetDate}`) — decoded here
 * so the raster VARIES per trigger date; an outputRef without a date suffix (e.g. a caller that
 * enqueues directly against this record key, as some boundary tests do) falls back to rendering
 * the outputRef itself, never throwing. Registered once at module load, exactly like every
 * producer will register its own.
 */
function testPrintProvider(outputRef: string): PrintableRaster {
  const separatorIndex = outputRef.indexOf(":");
  const dateLabel = separatorIndex === -1 ? outputRef : outputRef.slice(separatorIndex + 1);
  return generateTestPrintRaster(dateLabel);
}
registerPrintableProvider(TEST_PRINT_RECORD_KEY, testPrintProvider);

// ── Row <-> DTO ───────────────────────────────────────────────────────────

interface PrintRecordRow {
  id: string;
  record_key: string;
  target_date: string;
  superseded_at: number | null;
  printed_job_id: string | null;
  generation: number;
  created_at: number;
  updated_at: number;
}

interface PrintJobRow {
  id: string;
  record_id: string;
  member_id: string | null;
  target_date: string;
  state: PrintJobState;
  output_ref: string;
  attempts: number;
  lease_token: string | null;
  lease_expires_at: number | null;
  claimed_at: number | null;
  printed_at: number | null;
  failure_reason: string | null;
  payload_served_at: number | null;
  generation: number;
  created_at: number;
  updated_at: number;
}

/** Derived-state computation ("Derived states") — read-time only, never stored
 * (Constitution V). `householdToday`/`now` are BOTH explicit injected values (the class) —
 * this function never reads a wall clock itself, and never writes to the database (proven at the
 * boundary layer by a write-spy test, tests/boundary/printing-core.test.ts).
 */
function deriveState(row: PrintJobRow, now: number, householdToday: string): DerivedPrintJobState {
  if (row.state === "failed") return "dead-letter";
  if ((row.state === "pending" || row.state === "claimed") && row.target_date < householdToday) {
    return "dead-letter";
  }
  const claimable =
    row.target_date === householdToday &&
    (row.state === "pending" || (row.state === "claimed" && (row.lease_expires_at ?? 0) < now));
  if (claimable && row.attempts > 0) return "retrying";
  return row.state;
}

function rowToJob(
  row: PrintJobRow,
  recordKey: string,
  now: number,
  householdToday: string
): PrintJob {
  return {
    id: row.id,
    recordKey,
    outputRef: row.output_ref,
    targetDate: row.target_date,
    memberId: row.member_id,
    state: row.state,
    derivedState: deriveState(row, now, householdToday),
    attempts: row.attempts,
    failureReason: row.failure_reason,
    claimedAt: row.claimed_at,
    printedAt: row.printed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getRecordKeyForJob(db: ReturnType<typeof getDb>, recordId: string): string {
  const record = db.prepare("SELECT record_key FROM print_records WHERE id = ?").get(recordId) as
    Pick<PrintRecordRow, "record_key"> | undefined;
  // A print_jobs row's record_id is an intra-namespace FK — a missing record here would mean a
  // corrupt DB, not a normal runtime condition; there is no honest DTO to return.
  if (!record) throw new Error(`print_records row missing for id ${recordId} (FK integrity fault)`);
  return record.record_key;
}

/** PERMANENT-failure fencing + write, shared by `getPayload` (missing/erroring provider) and
 * `failJob` (an executor-reported permanent code) — same token-fenced `state = 'claimed'` WHERE,
 * matching `ackJob`'s own single-statement fence style. Emits `printing.failed` post-commit
 * and returns the updated row for the caller's own DTO construction.
 */
function applyPermanentFailure(
  db: ReturnType<typeof getDb>,
  jobId: string,
  leaseToken: string,
  now: number,
  errorCode: PrintFailureErrorCode,
  reason: string
): PrintJobRow {
  const row = db
    .prepare(
      `UPDATE print_jobs SET state = 'failed', failure_reason = ?, updated_at = ?
       WHERE id = ? AND lease_token = ? AND state = 'claimed'
       RETURNING *`
    )
    .get(reason, now, jobId, leaseToken) as PrintJobRow | undefined;

  if (!row) {
    const exists = db.prepare("SELECT id FROM print_jobs WHERE id = ?").get(jobId);
    if (!exists) throw new PrintJobNotFoundError(jobId);
    throw new PrintLeaseStaleError(jobId);
  }

  emit("printing.failed", { jobId: row.id, outputRef: row.output_ref, errorCode });
  notifyPrintingClaimSettled();
  return row;
}

// ── Producer-agnostic enqueue seam ──────────────────────────────────────

export interface EnqueuePrintJobParams {
  recordKey: string;
  targetDate: string;
  outputRef: string;
  memberId?: string | null;
}

export interface EnqueuePrintJobResult {
  enqueued: boolean;
  jobId: string;
  alreadyPrinted: boolean;
}

/** The producer-agnostic enqueue seam (FR-001/FR-012). Full dedup matrix:
 * - * printed* the record already carries a `printed_job_id` and is NOT superseded -> report
 * it, no new job (FR-012/AC-05).
 * - * fresh/in-flight* a `pending` or `claimed` job of the record's CURRENT generation already
 * exists -> return THAT job, never a second one — the disclosed INV-05 transient closed: at
 * most ONE pending/claimed job PER GENERATION per record.
 * - * superseded/never-printed* create a new job against the (possibly pre-existing,
 * re-printable) record — reachable via `supersedePrintRecord` below.
 * Gated by `isPrintingPluginActive` (INV-06) for EVERY caller, including the host-API barrel
 * seam a producer reaches this through — not just the HTTP trigger route (analyze E1).
 * `memberId`, when present, is validated strict-on-write via the host-API barrel
 * (`assertActiveMember`) — tolerant-on-read thereafter, matching every other plugin's convention.
 * the in-flight check is scoped to `generation =
 * existing.generation` (the record's CURRENT epoch) — WITHOUT this, a supersede that leaves a
 * FETCHED in-flight job running (H2 accepted) would make the very next enqueue dedupe onto that
 * STALE job instead of creating the new-generation one, so the regenerated output would never
 * get queued at all. INV-05's "at most one pending/claimed job per record" now reads PER
 * GENERATION: at most one STALE in-flight survivor (finishing out its H2-accepted transmission)
 * plus one CURRENT-generation job may legitimately coexist for the same record.
 */
export function enqueuePrintJob(params: EnqueuePrintJobParams, now: number): EnqueuePrintJobResult {
  if (!isPrintingPluginActive()) throw new PrintingPluginInactiveError();
  if (!isStrictCalendarDate(params.targetDate)) {
    throw new PrintValidationError(
      `Invalid targetDate "${params.targetDate}": must be a strictly calendar-valid YYYY-MM-DD date`
    );
  }
  if (params.memberId) assertActiveMember(params.memberId);

  const db = getDb();
  const { recordKey, targetDate, outputRef } = params;
  const memberId = params.memberId ?? null;

  return db.transaction(() => {
    const existing = db
      .prepare("SELECT * FROM print_records WHERE record_key = ? AND target_date = ?")
      .get(recordKey, targetDate) as PrintRecordRow | undefined;

    if (existing && existing.printed_job_id !== null && existing.superseded_at === null) {
      return { enqueued: false, jobId: existing.printed_job_id, alreadyPrinted: true };
    }

    let recordId: string;
    let generation = 0;
    if (existing) {
      recordId = existing.id;
      generation = existing.generation;
      const inFlight = db
        .prepare(
          `SELECT id FROM print_jobs WHERE record_id = ? AND generation = ? AND state IN ('pending','claimed')
           ORDER BY created_at ASC LIMIT 1`
        )
        .get(recordId, generation) as { id: string } | undefined;
      if (inFlight) {
        return { enqueued: false, jobId: inFlight.id, alreadyPrinted: false };
      }
    } else {
      recordId = randomUUID();
      db.prepare(
        "INSERT INTO print_records (id, record_key, target_date, superseded_at, printed_job_id, generation, created_at, updated_at) VALUES (?, ?, ?, NULL, NULL, 0, ?, ?)"
      ).run(recordId, recordKey, targetDate, now, now);
    }

    const jobId = randomUUID();
    db.prepare(
      `INSERT INTO print_jobs
        (id, record_id, member_id, target_date, state, output_ref, attempts,
         lease_token, lease_expires_at, claimed_at, printed_at, failure_reason,
         payload_served_at, generation, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, 0, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`
    ).run(jobId, recordId, memberId, targetDate, outputRef, generation, now, now);

    return { enqueued: true, jobId, alreadyPrinted: false };
  })();
}

/** The admin trigger (FR-018) — a thin wrapper over the producer-agnostic seam above (D9: "the
 * test printable... calls the SAME seam"). Day-scoping derives from the injected clock via the
 * household timezone, never from a direct `Date.now` read, UNLESS the caller
 * (the HTTP route) supplies an explicit `targetDateOverride` — the one place in this module's
 * HTTP surface an externally-supplied date reaches the enqueue seam, letting the route's own
 * Constitution IV validity test be genuinely HTTP-observable rather than only reachable through a
 * future producer. An invalid override still throws `PrintValidationError` from `enqueuePrintJob`
 * below — validated ONCE, at the shared seam, not duplicated here. `outputRef` carries the
 * resolved target date as a `:`-delimited suffix — the seam's own producer metadata,
 * resolved by `testPrintProvider` above to vary the procedural raster per trigger date (research
 * D3); Printing itself never inspects it beyond handing it back to the provider.
 */
export function enqueueTestPrint(now: number, targetDateOverride?: string): TestPrintResponse {
  const targetDate = targetDateOverride ?? todayInHouseholdTz(now);
  return enqueuePrintJob(
    {
      recordKey: TEST_PRINT_RECORD_KEY,
      targetDate,
      outputRef: `${TEST_PRINT_RECORD_KEY}:${targetDate}`,
    },
    now
  );
}

/** (ADR-022, H2 comment): invalidate a stale print record on regeneration —
 * cancels `pending` jobs AND `claimed`-but-NOT-YET-FETCHED jobs (`payload_served_at IS NULL`); a
 * job whose payload endpoint has ALREADY been hit (fetched-in-flight — tens of seconds of chunked
 * BT writes) is left to continue and may print superseded content. That is an ACCEPTED, recorded
 * consequence of at-least-once delivery (grill decision H2, ADR-022) whose remedy is a manual
 * reprint, not racing a cancellation against an in-progress physical transmission. No-op if no
 * record exists for (recordKey, targetDate) — supersede is idempotent-safe against an output that
 * was never enqueued.
 * increments `generation` in the SAME transaction as the
 * cancel + `superseded_at` write. This is what makes any fetched-in-flight survivor left running
 * past this call STALE-generation from this instant forward — `enqueuePrintJob`'s in-flight dedup
 * ignores it (P1-a fix) and `ackJob` refuses to let its eventual ack re-canonicalize this record
 * (P1-b fix, see `ackJob`'s own doc comment).
 * (fold) — TRANSACTION-COMPOSABLE: this function's body is its own
 * `db.transaction` call, DELIBERATELY not wrapped a second time by anything else, because
 * better-sqlite3 already makes it composable with zero special-casing. EMPIRICALLY PROBED
 * (Constitution XIV; see `tests/integration/daily-briefing-regen.test.ts`'s dedicated savepoint
 * probe, and `node_modules/better-sqlite3/lib/methods/transaction.js`): `db.transaction(fn)`
 * checks `db.inTransaction` at CALL TIME and transparently substitutes SAVEPOINT/RELEASE/
 * ROLLBACK TO for BEGIN/COMMIT/ROLLBACK whenever it is invoked from inside an already-open
 * transaction — so a caller building its OWN write transaction (daily-briefing's regeneration,
 * `modules/daily-briefing/index.ts#generateBriefing`) can call this function DIRECTLY from inside
 * that transaction and get true one-transaction atomicity (FR-003): if the outer transaction later
 * throws, its ROLLBACK discards everything back to its own BEGIN, INCLUDING this function's
 * already-"committed" (RELEASEd) savepoint — commit-together and rollback-together, both proven
 * empirically by the probe test. Called with no outer transaction open (the standalone entry
 * point below), it behaves exactly as before: a plain top-level BEGIN/COMMIT/ROLLBACK.
 */
export function supersedePrintRecordTxn(recordKey: string, targetDate: string, now: number): void {
  const db = getDb();
  db.transaction(() => {
    const record = db
      .prepare("SELECT * FROM print_records WHERE record_key = ? AND target_date = ?")
      .get(recordKey, targetDate) as PrintRecordRow | undefined;
    if (!record) return;

    db.prepare(
      `UPDATE print_jobs SET state = 'cancelled', updated_at = ?
       WHERE record_id = ?
         AND (state = 'pending' OR (state = 'claimed' AND payload_served_at IS NULL))`
    ).run(now, record.id);

    db.prepare(
      "UPDATE print_records SET superseded_at = ?, generation = generation + 1, updated_at = ? WHERE id = ?"
    ).run(now, now, record.id);
  })();
}

/** Standalone entry point — identical behavior to the pre- implementation, now delegating to
 * the transaction-composable variant above (its own `db.transaction` runs as a plain top-level
 * transaction when there is no outer transaction already open).
 */
export function supersedePrintRecord(recordKey: string, targetDate: string, now: number): void {
  supersedePrintRecordTxn(recordKey, targetDate, now);
  notifyPrintingClaimSettled();
}

// ── Core operations ────────────────────────────────────────────────────

/** The atomic claim: ONE UPDATE statement whose WHERE clause covers both a fresh
 * `pending` job AND a `claimed` job whose lease has expired (derived expiry — Constitution V,
 * never a separate sweep), day-scoped to `householdToday` so a stale prior day's job is
 * structurally unclaimable. better-sqlite3 is single-writer, so the statement is atomic by
 * construction — two racing calls can never both return the same job (FR-011). Returns `null`
 * when nothing is claimable (204 at the route layer).
 * The outer UPDATE repeats the subquery's `(state = 'pending' OR (state = 'claimed' AND
 * lease_expires_at < now))` condition as a defense-in-depth guard (the own canonical
 * form) — belt-and-suspenders consistency matching `ackJob`'s single-statement fence
 * style, not a fix for a real race (better-sqlite3's synchronous single-writer execution already
 * makes the SELECT-then-UPDATE subquery-in-WHERE atomic by construction).
 * `sessionKeyId` is OPTIONAL (see this file's header note above): when provided, FR-021 requires
 * a matching `printer_capabilities` row or the claim is refused BEFORE any job discovery runs
 * (`PrintCapabilityMissingError` — never leaks whether a job exists); when omitted, the
 * capability gate is skipped for this call. This is NOT an open non-HTTP claim-hole — `claimJob`
 * isn't re-exported through../../host-api, so `routes/printing.ts` (which passes the real
 * session key id on EVERY call) is this function's only caller; the parameter stays
 * optional purely so this file's own boundary/lease-fencing tests can exercise claim/ack/fail
 * mechanics without needing a paired session on every setup call.
 * `isPrintingPluginActive` (INV-06), by contrast, is NOT optional — it applies to every caller
 * unconditionally.
 * (real AC-08 gap, reproduced): resets `payload_served_at` to NULL on EVERY
 * claim — a NEW lease has, by definition, not yet fetched anything under it, so the
 * claimed-not-yet-fetched/fetched-in-flight distinction `supersedePrintRecord` reads must start
 * fresh per lease. Without this, a job that was fetched under a PRIOR lease (e.g. printer-off ->
 * `failJob` recoverable release -> re-claim) kept the old lease's stamp, so a supersede against
 * the re-claimed job wrongly read it as "fetched-in-flight" and skipped cancelling it — a real
 * FR-015 violation on the slice's own headline recovery path.
 */
export function claimJob(now: number, sessionKeyId?: string): ClaimResponse | null {
  if (!isPrintingPluginActive()) throw new PrintingPluginInactiveError();
  if (sessionKeyId !== undefined && !hasPrinterCapability(sessionKeyId)) {
    throw new PrintCapabilityMissingError(sessionKeyId);
  }

  const db = getDb();
  const householdToday = todayInHouseholdTz(now);
  const leaseToken = randomUUID();
  const leaseExpiresAt = now + LEASE_DURATION_MS;

  const row = db
    .prepare(
      `UPDATE print_jobs
       SET state = 'claimed', lease_token = ?, lease_expires_at = ?, claimed_at = ?, updated_at = ?,
           payload_served_at = NULL
       WHERE id = (
         SELECT id FROM print_jobs
         WHERE target_date = ?
           AND (state = 'pending' OR (state = 'claimed' AND lease_expires_at < ?))
         ORDER BY created_at ASC
         LIMIT 1
       )
       AND (state = 'pending' OR (state = 'claimed' AND lease_expires_at < ?))
       RETURNING *`
    )
    .get(leaseToken, leaseExpiresAt, now, now, householdToday, now, now) as PrintJobRow | undefined;

  if (!row) return null;

  const recordKey = getRecordKeyForJob(db, row.record_id);
  return {
    job: rowToJob(row, recordKey, now, householdToday),
    leaseToken,
    leaseExpiresAt,
  };
}

/** Fetch the job's payload. Requires an ACTIVE lease: token match, `state = 'claimed'`, AND `lease_expires_at >= now` — all three in the SAME
 * conditional UPDATE, not a pre-check followed by an unconditional write. An executor that
 * resumes AFTER its lease expired but BEFORE anyone re-claims (so its token is still, technically,
 * the row's current token) must NOT be able to extend that expired lease — doing so would
 * monopolize the job against the promised reclaimability (a `claimed` job with
 * `lease_expires_at < now` IS claimable). A single-statement fence (matching `claimJob`'s own
 * atomicity style) closes the TOCTOU window a separate check-then-write would leave open; the
 * expired-lease case is rejected with the SAME `PrintLeaseStaleError`/409 body as a stale/rotated
 * token (the contract doesn't distinguish them either), and — because the UPDATE's WHERE simply
 * doesn't match — the lease is provably NOT extended. Stamps `payload_served_at` on first
 * (successful) fetch only (the claimed-not-yet-fetched vs fetched-in-flight distinction the * supersede relies on).
 * Resolves the job's record key against the registered provider seam, then routes
 * the provider's CURRENT raw raster through `artifact.ts#buildPayload` (
 * ADR-066) — packed-invariant + device-width validation, then the pure ESC/POS wrap — before
 * returning it. A missing/throwing provider OR a structurally invalid/device-incompatible raster
 * is a PERMANENT `render_failure` (FR-017, FR-007/analyze E2: device incompatibility is
 * absence-tolerant, never a crash): the job is dead-lettered and `printing.failed` emitted before
 * this throws `PrintRenderFailureError`.
 */
export function getPayload(jobId: string, leaseToken: string, now: number): Buffer {
  const db = getDb();
  const refreshedExpiry = now + LEASE_DURATION_MS;

  const row = db
    .prepare(
      `UPDATE print_jobs
       SET lease_expires_at = ?, payload_served_at = COALESCE(payload_served_at, ?), updated_at = ?
       WHERE id = ? AND lease_token = ? AND state = 'claimed' AND lease_expires_at >= ?
       RETURNING *`
    )
    .get(refreshedExpiry, now, now, jobId, leaseToken, now) as PrintJobRow | undefined;

  if (!row) {
    // The fence above already made the real authorization call (it either matched and wrote, or
    // matched nothing and wrote nothing) — this second read is classification-only, distinguishing
    // "no such job" (404) from "wrong/stale/expired lease" (409), never a second decision point.
    const exists = db.prepare("SELECT id FROM print_jobs WHERE id = ?").get(jobId);
    if (!exists) throw new PrintJobNotFoundError(jobId);
    throw new PrintLeaseStaleError(jobId);
  }

  const recordKey = getRecordKeyForJob(db, row.record_id);
  const provider = resolveProvider(recordKey);

  let wrapped: Uint8Array;
  try {
    if (!provider) {
      throw new Error(`no printable provider registered for record key "${recordKey}"`);
    }
    const raster = provider(row.output_ref);
    wrapped = buildPayload(raster.bits, raster.width, raster.height);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "render_failure: provider error";
    applyPermanentFailure(db, jobId, leaseToken, now, "render_failure", reason);
    throw new PrintRenderFailureError(jobId);
  }

  return Buffer.from(wrapped);
}

/** Byte-level success acknowledgement (ADR-019, FR-004/FR-008): stamps the job's OWN `printed_at`
 * ALWAYS — the byte transmission truthfully happened, regardless of which content generation it
 * carried (FR-004's own "paper-out after a successful send is still success" honesty extends to
 * "stale content after a successful send is still a successful send"). Whether that transmission
 * also settles `print_records` — writes `printed_job_id` and clears `superseded_at`, so a job
 * that prints AFTER a prior supersede correctly reads back as "printed", not perpetually
 * "superseded" (FR-012's dedup check keys off exactly this pair) — is now GENERATION-SCOPED
 * only when `job.generation === record.generation` at ack time. A
 * fetched-in-flight job left running past a supersede (H2 accepted) is, by the time it acks,
 * carrying a STALE generation — its ack must NOT re-canonicalize the record as "printed", or the
 * documented manual-reprint remedy for H2 would be silently defeated (a further trigger would
 * wrongly report `alreadyPrinted` for content nobody actually got). Emits the canonical
 * `printing.completed` event POST-COMMIT (— notification-only, never inside the
 * write transaction) — the EVENT still fires for a stale-generation ack too (a byte transmission
 * genuinely completed); only the print_records write is generation-gated. Idempotent per lease
 * (INV-05): re-acking an already-`printed` job under the SAME lease token is a no-op success,
 * never a double-stamp or a duplicate emission.
 * DELIBERATELY accepts the LATEST lease token even if `lease_expires_at < now` — this is the
 * mirror image of `getPayload`'s expiry fence above, NOT an oversight: a late-but-truthful ack records a transmission that DID physically happen. The
 * contract's own promise (US2-AS4 / Edge Cases: "the job is re-claimable... never a
 * false success, never stranded until lease expiry") is that an expired lease makes the job
 * RE-CLAIMABLE, not that a subsequent truthful ack from the original executor must be discarded
 * — rejecting it here would force a real, physically-completed print into the at-least-once
 * duplicate-delivery path (Edge Cases' own accepted trade) for no honesty gained. The instant
 * ANYONE re-claims this job, `lease_token` rotates and this exact zombie's ack starts 409ing on
 * the plain token-mismatch check below — no separate expiry check is needed to close that
 * window. `failJob` below applies the SAME expiry-tolerant-while-`lease_token`-matches fencing
 * for the identical reason — a late recoverable-failure report is still truthful signal, not a
 * race to guard against.
 * FR-010 holds BY CONSTRUCTION: this signature admits no paper-state input anywhere — `(jobId,
 * leaseToken, now)` is the entire surface (asserted at the boundary, tests/boundary/
 * printing-core.test.ts, via `ackJob.length`).
 */
export function ackJob(jobId: string, leaseToken: string, now: number): PrintJob {
  const db = getDb();
  const householdToday = todayInHouseholdTz(now);

  const { row, alreadyAcked } = db.transaction(() => {
    const current = db.prepare("SELECT * FROM print_jobs WHERE id = ?").get(jobId) as
      PrintJobRow | undefined;
    if (!current) throw new PrintJobNotFoundError(jobId);
    if (current.lease_token !== leaseToken) throw new PrintLeaseStaleError(jobId);

    if (current.state === "printed") {
      // Idempotent: this exact lease already satisfied this job (INV-05) — no re-emission.
      return { row: current, alreadyAcked: true };
    }
    if (current.state !== "claimed") {
      throw new PrintLeaseStaleError(jobId);
    }

    // Single-statement fence (defense in depth, matching getPayload's style above) — token AND
    // state='claimed' in the WHERE itself, deliberately WITHOUT a lease_expires_at bound (see
    // this function's doc comment). better-sqlite3's synchronous single-writer transaction
    // already makes the read-check-write above race-free within this process; this WHERE is
    // belt-and-suspenders consistency, not a fix for a real race.
    const updateResult = db
      .prepare(
        "UPDATE print_jobs SET state = 'printed', printed_at = ?, updated_at = ? WHERE id = ? AND lease_token = ? AND state = 'claimed'"
      )
      .run(now, now, jobId, leaseToken);
    if (updateResult.changes !== 1) {
      throw new PrintLeaseStaleError(jobId);
    }

    //: only a CURRENT-generation ack settles the record. A
    // stale-generation survivor's ack still stamped this job's OWN printed_at above (truthful
    // paper) but must not re-canonicalize a record a producer has already moved past.
    const record = db
      .prepare("SELECT generation FROM print_records WHERE id = ?")
      .get(current.record_id) as Pick<PrintRecordRow, "generation">;
    if (current.generation === record.generation) {
      db.prepare(
        "UPDATE print_records SET printed_job_id = ?, superseded_at = NULL, updated_at = ? WHERE id = ?"
      ).run(jobId, now, current.record_id);
    }

    const updated: PrintJobRow = { ...current, state: "printed", printed_at: now, updated_at: now };
    return { row: updated, alreadyAcked: false };
  })();

  const recordKey = getRecordKeyForJob(db, row.record_id);
  const job = rowToJob(row, recordKey, now, householdToday);

  if (!alreadyAcked) {
    emit("printing.completed", { jobId: job.id, outputRef: job.outputRef, printedAt: now });
  }
  notifyPrintingClaimSettled();

  return job;
}

/** Executor-reported delivery failure (FR-009, "Failure taxonomy"). Same
 * expiry-tolerant fencing style as `ackJob` above (token match AND `state = 'claimed'`,
 * DELIBERATELY without a `lease_expires_at` bound) — `ackJob`'s own doc comment
 * names exactly this symmetry: a late-but-truthful failure report is still real signal, not a
 * race to guard against.
 * `permanentCode` present -> PERMANENT: terminal `failed`, immediate dead-letter,
 * `printing.failed` emitted, `attempts` untouched. Absent/null -> RECOVERABLE: `attempts + 1`,
 * lease released (token/expiry/claimed_at cleared), back to `pending` — IMMEDIATELY re-claimable
 * (the printer-off -> printer-on recovery), no event emitted.
 * the RECOVERABLE release also resets `payload_served_at` to NULL (belt and
 * suspenders alongside `claimJob`'s own reset above) — a released lease's fetch stamp must not
 * survive into whatever comes next for this job, exactly like every other lease-scoped column
 * this branch already clears.
 */
export function failJob(
  jobId: string,
  leaseToken: string,
  now: number,
  reason: string,
  permanentCode?: PrintFailureErrorCode | null
): PrintJob {
  const db = getDb();
  const householdToday = todayInHouseholdTz(now);

  let row: PrintJobRow;
  if (permanentCode) {
    row = applyPermanentFailure(db, jobId, leaseToken, now, permanentCode, reason);
  } else {
    const updated = db
      .prepare(
        `UPDATE print_jobs
         SET state = 'pending', attempts = attempts + 1, lease_token = NULL,
             lease_expires_at = NULL, claimed_at = NULL, payload_served_at = NULL,
             failure_reason = ?, updated_at = ?
         WHERE id = ? AND lease_token = ? AND state = 'claimed'
         RETURNING *`
      )
      .get(reason, now, jobId, leaseToken) as PrintJobRow | undefined;
    if (!updated) {
      const exists = db.prepare("SELECT id FROM print_jobs WHERE id = ?").get(jobId);
      if (!exists) throw new PrintJobNotFoundError(jobId);
      throw new PrintLeaseStaleError(jobId);
    }
    row = updated;
  }

  const recordKey = getRecordKeyForJob(db, row.record_id);
  notifyPrintingClaimSettled();
  return rowToJob(row, recordKey, now, householdToday);
}

/** Admin list read (SC-003 visibility) — every job, derived states included. */
export function listJobs(now: number): JobsListResponse {
  const db = getDb();
  const householdToday = todayInHouseholdTz(now);
  const rows = db
    .prepare("SELECT * FROM print_jobs ORDER BY created_at DESC")
    .all() as PrintJobRow[];

  const jobs = rows.map((row) => {
    const recordKey = getRecordKeyForJob(db, row.record_id);
    return rowToJob(row, recordKey, now, householdToday);
  });

  return { jobs };
}

/** Minimal SELECT-only read for a level-triggered PRODUCER (e.g. daily-briefing's auto-print
 * trigger) to gate its own re-enqueue: is the MOST RECENT job, OF THE RECORD'S CURRENT
 * GENERATION, terminally `failed` (dead-lettered)? A `failed` state is terminal
 * (`applyPermanentFailure` never transitions out of it) — `enqueuePrintJob`'s own dedup
 * deliberately does NOT treat it as "already handled" (it matches neither the `printed` branch nor
 * the in-flight pending/claimed branch), by design: an admin's manual retry after dead-letter
 * (supersede, or a direct re-enqueue) is the legitimate remedy and must stay reachable. That
 * permissiveness is exactly what would let an unattended level-triggered caller re-enqueue a doomed
 * job every sweep forever — this read exists so THAT caller can gate itself; printing's own enqueue
 * semantics are unchanged.
 * "Most recent" (by `created_at`) rather than "any failed job ever" is what makes the admin
 * remedy actually unblock this gate: a supersede-then-re-enqueue creates a NEW job row with a
 * later `created_at`, so this read naturally reports the new (non-failed) job once one exists —
 * no separate reset/clear operation needed.
 * GENERATION-SCOPED (fix, on): the "most recent" lookup is additionally
 * filtered to `print_jobs.generation = print_records.generation` — WITHOUT this, a regeneration
 * (which bumps the record's generation but deliberately leaves a PRIOR generation's already-
 * terminal `failed` job in place — `supersedePrintRecordTxn` only ever cancels `pending`/
 * claimed-not-yet-fetched jobs, never a `failed` one, since there is nothing left to cancel) would
 * still report that OLD failure as gating the fresh generation — daily-briefing's trigger would
 * then skip a freshly regenerated, entirely unpoisoned briefing forever, since no NEW job of the
 * new generation would ever get created to supersede it ( reproduced by
 * generate -> enqueue -> claim -> failJob(permanent) -> regenerate -> trigger should re-enqueue).
 * A job's own `generation` column (`print_jobs.generation`, drizzle schema.ts) is copied from
 * `print_records.generation` at enqueue time — the
 * SAME column `getPrintRecordStatus`'s `printed` predicate already keys off of one level up
 * (`print_records.generation` vs. the job that set `printed_job_id`), so this fix aligns
 * `hasTerminalFailedJob` with that same current-generation-only discipline. Every caller of this
 * function (the trigger's dead-letter gate, and `modules/daily-briefing/index.ts`'s * `refreshPrintedStatusCache`/`derivePrintedStatus`) inherits the fix automatically — none of them
 * needed their own change.
 * Deliberately minimal: a boolean gate is all a producer needs
 * today. `getPrintRecordStatus` (printed-status recovery for daily-briefing's own reads,
 * DAILY-BRIEFING-AC-04) adds the fuller per-record status read — this function is not a stand-in
 * for that.
 */
export function hasTerminalFailedJob(recordKey: string, targetDate: string): boolean {
  const db = getDb();
  const record = db
    .prepare("SELECT id, generation FROM print_records WHERE record_key = ? AND target_date = ?")
    .get(recordKey, targetDate) as { id: string; generation: number } | undefined;
  if (!record) return false;

  const latestJob = db
    .prepare(
      `SELECT state FROM print_jobs
       WHERE record_id = ? AND generation = ?
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(record.id, record.generation) as { state: PrintJobState } | undefined;
  return latestJob?.state === "failed";
}

/** `getPrintRecordStatus`'s result shape. */
export interface PrintRecordStatus {
  /** `true` iff the record's `printed_job_id` is set AND it is NOT currently superseded — the
   * SAME "printed" predicate `enqueuePrintJob`'s own dedup uses above. */
  printed: boolean;
  /** The record's CURRENT generation (bumped by every `supersedePrintRecordTxn` call) — the value
   * a caller compares against its own cached generation to decide whether that cache is fresh. */
  generation: number;
  /** The printed job's `printed_at`, present only when `printed` is true; `null` otherwise
   * (including when the record exists but has never been printed, or was superseded). */
  printedAt: number | null;
}

/** Minimal SELECT-only read for a CONSUMER (e.g. daily-briefing's printed-status derivation,
 * DAILY-BRIEFING-AC-04) to recover canonical printed-status at read time when its own locally
 * derived cache is absent or stale — the read-time fallback half of ("event cache +
 * read-time fallback": events update the cache as a hint; Constitution VII requires this query to
 * fully recover the truth on its own when an event is dropped). Absence-tolerant per ADR-039:
 * returns `null` when no `print_records` row exists for (recordKey, targetDate) at all — "never
 * enqueued", distinct from "enqueued but not yet printed" (`{printed: false,...}`).
 * Deliberately narrower than a full `PrintJob` read (mirrors `hasTerminalFailedJob`'s own
 * "minimal, not a stand-in for a fuller read" precedent above): a `false` `printed` value does NOT
 * distinguish pending/claimed/cancelled/dead-lettered from each other — a caller that also needs
 * to know "was the most recent job dead-lettered" combines this with `hasTerminalFailedJob`
 * (exactly what `modules/daily-briefing/index.ts#derivePrintedStatus` does to produce its own
 * `completed|failed|none` classification).
 */
export function getPrintRecordStatus(
  recordKey: string,
  targetDate: string
): PrintRecordStatus | null {
  const db = getDb();
  const record = db
    .prepare("SELECT * FROM print_records WHERE record_key = ? AND target_date = ?")
    .get(recordKey, targetDate) as PrintRecordRow | undefined;
  if (!record) return null;

  const printed = record.printed_job_id !== null && record.superseded_at === null;
  let printedAt: number | null = null;
  if (printed && record.printed_job_id !== null) {
    const job = db
      .prepare("SELECT printed_at FROM print_jobs WHERE id = ?")
      .get(record.printed_job_id) as Pick<PrintJobRow, "printed_at"> | undefined;
    printedAt = job?.printed_at ?? null;
  }

  return { printed, generation: record.generation, printedAt };
}
