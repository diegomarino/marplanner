// ─────────────────────────────────────────────────────────────────────
// Printing DTOs — pure: no I/O, no clock, no imports
// beyond shared. No raster bytes are representable anywhere in this file
// (no column, no DTO field) — the server owns the entire artifact
// pipeline (ADR-066); the executor only ever receives final printer-ready
// bytes over the dedicated binary payload route, never through a DTO.
//
// The `components/schemas`-matching envelope types
// (ErrorResponse, PrintJob, ClaimResponse, JobsListResponse,
// TestPrintResponse) moved to src/shared/index.ts itself (the
// networkDevices.ts precedent — LiveClientsResponse/
// NetworkDevicesListResponse) so tools/check-openapi-drift.mjs --shapes's
// DTO parser (which scans index.ts's OWN source text, never a wholesale
// re-export target) can actually match them against
// the API contract. What stays here has no top-level named schema
// counterpart to match against in the first place (see index.ts's own
// doc comment on the re-export line below).
//
// The job and record shapes are shared before the printing runtime is installed.
// ─────────────────────────────────────────────────────────────────────

/** Portable 80 mm render context; local transport details are deliberately separate. */
export const DEFAULT_PRINTER_SETTINGS = { paperWidthDots: 576 } as const;

/** PrintJobState — the stored state face only.
 * `dead-letter`/`retrying` are read-time REFINEMENTS (Constitution V) — see
 * `DerivedPrintJobState` — never persisted as a `state` value. An INLINE enum on the `PrintJob`
 * schema, not its own top-level `components/schemas` entry — the shapes gate
 * only compares top-level named schemas, so this type has nothing to match regardless of which
 * file declares it.
 */
export type PrintJobState = "pending" | "claimed" | "printed" | "failed" | "cancelled";

/** DerivedPrintJobState — the read-time refinement:
 * `dead-letter` covers a stale (`target_date < householdToday`) pending/claimed job OR a
 * terminal `failed` (permanent codes dead-letter immediately); `retrying` is a claimable
 * job with `attempts > 0`. Computed on read, never stored. Also an INLINE enum (see
 * `PrintJobState` above).
 */
export type DerivedPrintJobState = PrintJobState | "dead-letter" | "retrying";

/** PrintFailureErrorCode — the closed permanent failure vocabulary. Recoverable
 * failures (transport drop, no printer) are not part
 * of this closed set — they release the lease back to `pending` with `attempts + 1` and never
 * emit `printing.failed`; only these three terminal codes dead-letter immediately and emit it.
 * Inline on the `fail` request body, not a top-level schema.
 */
export type PrintFailureErrorCode = "render_failure" | "unsupported_transport" | "secure_context";

/** AckRequest — the executor's byte-level success acknowledgement payload (ADR-019, FR-004/FR-008).
 * Inline request-body shape (never `$ref`'d as a named schema).
 */
export interface AckRequest {
  leaseToken: string;
}

/** FailRequest — the executor-reported transport failure payload (FR-009). `permanentCode`
 * present (non-null) means the executor itself knows the failure is PERMANENT (contract
 * vocabulary); absent/null means RECOVERABLE (attempts+1, immediately re-claimable). Inline
 * request-body shape (see `AckRequest` above), wired to `POST /jobs/{id}/fail`.
 */
export interface FailRequest {
  leaseToken: string;
  reason: string;
  permanentCode?: PrintFailureErrorCode | null;
}

/** TestPrintRequest — the admin trigger's optional body. `targetDate`,
 * when present, overrides the household-local "today" the trigger would otherwise compute
 * (`enqueueTestPrint`'s default) — the one HTTP-reachable seam this module exposes for the
 * `target_date` calendar-validity check (`enqueuePrintJob`'s own `PrintValidationError`, mapped to
 * 400 at the route) to be genuinely observable over HTTP, not only through a future producer
 * calling the host-api barrel directly. Omitting the field (or the whole body) keeps the
 * pre-existing "always today" behavior unchanged. Inline request-body shape (see `AckRequest`
 * above) — not `$ref`'d as a named schema.
 */
export interface TestPrintRequest {
  targetDate?: string;
}
