// ─────────────────────────────────────────────────────────────────────
// Network Devices DTOs — pure: no I/O, no clock, no
// imports beyond shared. No IP is representable anywhere in this file
// (no column, no DTO field) — the drop is structural (NETWORK-DEVICES-INV-06).
// These shared DTOs do not expose controller IP addresses.
// ─────────────────────────────────────────────────────────────────────

/** LiveCacheState — the closed live-cache state taxonomy: each
 * state maps to one distinct localized client-visible outcome, never a
 * per-entry gate.
 */
export type LiveCacheState = "unconfigured" | "cold" | "stale" | "freshEmpty" | "fresh";

/** LiveStatus — a registered device's derived presence, never persisted
 * (NETWORK-DEVICES-INV-04). `online` = MAC present in a `fresh` cache;
 * `notDetected` = absent from a fresh cache or `lastSeenAt` beyond the
 * horizon; `unknown` = cache not fresh (cold/stale/unconfigured) —
 * conservative, never invented.
 */
export type LiveStatus = "online" | "notDetected" | "unknown";

/** RegisteredDevice — the curated, household-owned registry row as returned
 * by the API. `isBlocked` is the local BELIEF mirror of controller state
 * (NETWORK-DEVICES-INV-04/-03); `beliefDiverged` is true when a mirror write
 * failed after a controller success (AC-02), cleared by the converging poll.
 * `lastSeenAt` is observation-only (INV-10) — never defaulted.
 */
export interface RegisteredDevice {
  id: string;
  mac: string;
  alias: string;
  memberId: string | null;
  memberLabel: string | null;
  memberInactive: boolean;
  isBlocked: boolean;
  beliefDiverged: boolean;
  lastSeenAt: number | null;
  liveStatus: LiveStatus;
}

/** LiveClient — one controller-reported device in the in-process live cache.
 * NOTE: no `ip` field EXISTS on this type — the drop is structural
 * (NETWORK-DEVICES-INV-06), not a runtime redaction.
 */
export interface LiveClient {
  mac: string;
  displayName: string | null;
  isBlocked: boolean;
}

/** LiveClientsResponse and NetworkDevicesListResponse — the two GET response
 * envelopes — are declared directly in `src/shared/index.ts` (not here), so
 * `tools/check-openapi-drift.mjs --shapes`'s DTO parser (which scans
 * `index.ts`'s own source text, not files it re-exports wholesale) can match
 * them against the contract's named schemas instead of silently skipping
 * them. Every other type in this file keeps
 * the normal re-export-wholesale pattern.
 */

/** RegisterDeviceRequest — create payload. `mac` must be present in the
 * CURRENT fresh live cache (AC-03) — otherwise the write is rejected with
 * the dedicated `reselect_required` error code. A non-null `memberId` must
 * resolve to an ACTIVE member (AC-07).
 */
export interface RegisterDeviceRequest {
  mac: string;
  alias: string;
  memberId?: string | null;
}

/** EditDeviceRequest — edit payload. The MAC is NOT editable — no property
 * for it exists on this type (NETWORK-DEVICES-INV-02).
 */
export interface EditDeviceRequest {
  alias?: string;
  memberId?: string | null;
}
