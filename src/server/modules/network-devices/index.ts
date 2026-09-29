// ─────────────────────────────────────────────────────────────────────
// Network Devices registry core — the curated household
// device list over the UniFi controller's reported clients. Reaches core
// ONLY through../../host-api (Rule B, eslint zone).
//
// Source: docs/features/network-devices.md "Table: network_devices" +
// "State transitions"; (closed live-cache taxonomy) / D6
// (picker-only registration); FR-001..FR-011, US1/US3/US4 Acceptance
// Scenarios; docs/architecture/contracts/network-devices.md Vocabulary ("notDetected —
// never seen, or last seen > 7 days") + Behaviors ("Register a device" /
// "Edit alias / member assignment" / "Delete a device").
//
// The controller integration (`UniFiClient`, `client.ts`) and the REAL
// poller-fed live cache (`cache.ts`/`poll.ts`) land in — NOT
// here. This module defines the live-cache READ seam it needs as an
// injectable dependency (`LiveCacheAccessor`, the `SchedulerDeps`/
// `ForecastPort` precedent), so the real cache module can wire itself in
// via `__setLiveCacheAccessorForTests` without this module changing shape.
// Absent an injection the accessor reports a conservative `unconfigured`
// snapshot — it never invents freshness (INV-04) — because no production
// reader exists until.
// ─────────────────────────────────────────────────────────────────────

import { randomUUID } from "node:crypto";
import { assertActiveMember, resolveMemberLabel, getDb, emit } from "../../host-api";
import { getUniFiClient, UniFiControllerRejectedError } from "./client";
import type { CacheLastError } from "./cache";
import type {
  RegisteredDevice,
  LiveClient,
  LiveCacheState,
  LiveStatus,
  NetworkDevicesListResponse,
  LiveClientsResponse,
} from "../../../shared";

export class NetworkDeviceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkDeviceValidationError";
  }
}

export class NetworkDeviceNotFoundError extends Error {
  constructor(id: string) {
    super(`Network device not found: ${id}`);
    this.name = "NetworkDeviceNotFoundError";
  }
}

/** The MAC is already registered (canonical, case-insensitive) — surfaced when the DB's own
 * UNIQUE index (not app-level locking) resolves a racing duplicate submit (INV-01, * "mac... UNIQUE resolves racing registrations at the DB"). The loser of the race gets an
 * honest rejection rather than a silently-returned winner's row (which would misrepresent this
 * call as having created/owned that row). `code` is stable API surface the future route layer
 * maps to 409, symmetric with `NetworkDeviceReselectRequiredError`'s `code`. The
 * `.message` deliberately carries NO raw MAC (FR-013/INV-07 — a raw MAC must never appear in a
 * human-facing artifact, and the natural UI fallback renders the server error string verbatim);
 * `mac` stays available as a non-message property for internal/server-side use only.
 */
export class NetworkDeviceDuplicateError extends Error {
  readonly code = "duplicate_mac" as const;

  constructor(public readonly mac: string) {
    super("This device is already registered.");
    this.name = "NetworkDeviceDuplicateError";
  }
}

/** Registration MUST be picker-only (FR-001/NETWORK-DEVICES-AC-03): the submitted
 * MAC is refused with this DEDICATED code — never a generic validation error — when it is
 * absent from the current fresh live-client cache (rotated out between render and submit) or
 * the cache is not currently fresh. `code` is stable API surface the future route layer
 * maps to 409, per. The `.message` deliberately carries NO raw MAC (FR-013/INV-07,
 * same rationale as `NetworkDeviceDuplicateError`); `mac` stays available as a non-message
 * property for internal/server-side use only.
 */
export class NetworkDeviceReselectRequiredError extends Error {
  readonly code = "reselect_required" as const;

  constructor(public readonly mac: string) {
    super(
      "The selected device is no longer present in the current fresh live-client cache; pick again from the current list."
    );
    this.name = "NetworkDeviceReselectRequiredError";
  }
}

/** Block/unblock was attempted while the controller is unconfigured (`getUniFiClient` ->
 * `null`) — a distinct state from a controller REJECTION (below): "not set up
 * yet" is never conflated with "set up but the controller refused us". `code` is stable API
 * surface the future route layer maps to its own status, distinct from the 502 the two
 * error classes below map to.
 */
export class NetworkDeviceControllerUnavailableError extends Error {
  readonly code = "controller_unavailable" as const;

  constructor() {
    super("The network controller is not configured.");
    this.name = "NetworkDeviceControllerUnavailableError";
  }
}

/** The controller REJECTED the block/unblock call (401/403 — a set-but-invalid credential,
 *). Distinct from `NetworkDeviceControllerUnreachableError` below so telemetry/UI
 * never conflates "credential rejected" with "network/timeout" — both, however, share the same
 * consequence here: NOTHING is mirrored locally (— the controller call is
 * authoritative and must succeed before any local write is attempted).
 */
export class NetworkDeviceControllerRejectedError extends Error {
  readonly code = "controller_rejected" as const;

  constructor() {
    super("The network controller rejected the request.");
    this.name = "NetworkDeviceControllerRejectedError";
  }
}

/** Timeout, network-level failure, or any other non-rejection controller call failure. */
export class NetworkDeviceControllerUnreachableError extends Error {
  readonly code = "controller_unreachable" as const;

  constructor() {
    super("The network controller could not be reached.");
    this.name = "NetworkDeviceControllerUnreachableError";
  }
}

// ── Canonical MAC (INV-01/INV-02) ─────────────────────────────

const MAC_PATTERN = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;

/** Canonicalize (lowercase, colon-separated) — normalized BEFORE any DB write so the UNIQUE
 * index carries the whole dedupe guarantee (INV-01); the MAC is never re-normalized afterward
 * (immutable, INV-02 — no code path in this module ever writes `mac` after INSERT).
 */
export function canonicalizeMac(mac: unknown): string {
  if (typeof mac !== "string") {
    throw new NetworkDeviceValidationError("mac must be a string");
  }
  const trimmed = mac.trim();
  if (!MAC_PATTERN.test(trimmed)) {
    // Deliberately no raw value in the message (FR-013/INV-07 — see NetworkDeviceDuplicateError's
    // docblock for the same rationale): a malformed MAC is still a MAC-shaped/adjacent string.
    throw new NetworkDeviceValidationError(
      "Invalid MAC address: expected 6 colon-separated hex octets"
    );
  }
  return trimmed.toLowerCase();
}

/** Contract `alias` bound (openapi.yaml `RegisterDeviceRequest`/`EditDeviceRequest`:
 * `minLength: 1, maxLength: 80`) — the module is the validation source of truth; the route
 * layer only maps `NetworkDeviceValidationError` to 400, it enforces nothing itself. */
const ALIAS_MAX_LENGTH = 80;

/** Validate + normalize a submitted alias . Trimmed BEFORE both the length check and storage — mirrors
 * `modules/weather/index.ts#validateWeather`'s `label` `<=80`, trim-then-check pattern. Blank
 * (after trim) or over-length is rejected with the same `NetworkDeviceValidationError` the
 * route layer already maps to 400 — no new error class needed.
 */
function validateAlias(alias: unknown): string {
  if (typeof alias !== "string" || alias.trim().length === 0) {
    throw new NetworkDeviceValidationError("alias must be a non-blank string");
  }
  const trimmed = alias.trim();
  if (trimmed.length > ALIAS_MAX_LENGTH) {
    throw new NetworkDeviceValidationError(`alias must be at most ${ALIAS_MAX_LENGTH} characters`);
  }
  return trimmed;
}

function isUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

// ── Live-cache accessor seam (injectable — wires the real cache) ──────────

/** The raw snapshot this module reads to validate registration + derive `liveStatus` (* "In-process live cache"). A SUPERSET of the public `LiveClientsResponse` DTO: `fetchedAt` is the
 * cache-level observation instant (never per-entry) that `register` stamps `lastSeenAt` from —
 * INV-10 forbids a wall-clock default, so this field is what makes an honest stamp possible.
 * `null` only when the cache holds no observation yet (`unconfigured`/`cold`).
 * `lastError` surfaces the SAME distinction
 * `cache.ts`'s `CacheLastError` tracks internally: `"unconfigured"` vs a set-but-`"rejected"`
 * credential vs `"unreachable"` (timeout/network/5xx) are never conflated with each other —
 *. A future admin surface needs this to render "check credentials" (a
 * rejected key) distinctly from "controller offline" (unreachable), which `state` alone cannot
 * express (both currently decay `state` toward `stale`/`cold` identically).
 */
export interface LiveCacheSnapshot {
  state: LiveCacheState;
  clients: LiveClient[];
  fetchedAt: number | null;
  lastError: CacheLastError;
}

export type LiveCacheAccessor = () => LiveCacheSnapshot;

const UNCONFIGURED_SNAPSHOT: LiveCacheSnapshot = {
  state: "unconfigured",
  clients: [],
  fetchedAt: null,
  lastError: "unconfigured",
};

let liveCacheAccessorOverride: LiveCacheAccessor | undefined;

/** the real cache module (`cache.ts`) wires its reader in via this seam
 * (`wireNetworkDevicesCache`, which calls this at production startup).
 */
export function setLiveCacheAccessor(accessor: LiveCacheAccessor | undefined): void {
  liveCacheAccessorOverride = accessor;
}

/** @deprecated Test-only alias — kept for existing call sites (the `__setForecastPortForTests`
 * naming precedent this module originally followed); delegates to `setLiveCacheAccessor`, the
 * name production code (`cache.ts`) now uses. the
 * production wiring path should not read as test-only-named machinery.
 */
export function __setLiveCacheAccessorForTests(accessor: LiveCacheAccessor | undefined): void {
  setLiveCacheAccessor(accessor);
}

function getLiveCacheAccessor(): LiveCacheAccessor {
  return liveCacheAccessorOverride ?? (() => UNCONFIGURED_SNAPSHOT);
}

/** `fresh` (populated) and `freshEmpty` (confirmed-current, zero clients) are BOTH "current data"
 * for registration/derivation purposes — the taxonomy splits them only so the UI can show an
 * explicit empty picker state vs a populated one (Edge Cases). */
function isCurrentSnapshot(state: LiveCacheState): boolean {
  return state === "fresh" || state === "freshEmpty";
}

// ── Row <-> DTO ──────────────────────────────────────────────────────────

type NetworkDeviceRow = {
  id: string;
  mac: string;
  alias: string;
  member_id: string | null;
  is_blocked: number;
  belief_diverged_at: number | null;
  last_seen_at: number | null;
  created_at: number;
  updated_at: number;
};

const SELECT_COLUMNS =
  "id, mac, alias, member_id, is_blocked, belief_diverged_at, last_seen_at, created_at, updated_at";

function findById(db: ReturnType<typeof getDb>, id: string): NetworkDeviceRow | undefined {
  return db.prepare(`SELECT ${SELECT_COLUMNS} FROM network_devices WHERE id = ?`).get(id) as
    NetworkDeviceRow | undefined;
}

/** docs/architecture/contracts/network-devices.md Vocabulary: "notDetected (never seen, or last seen > 7
 * days)". The ONLY numeric horizon this domain's canon states; reused verbatim rather than
 * invented, per the "conservative, never invented" framing.
 */
const NOT_DETECTED_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;

/** liveStatus derivation ( "online = MAC present in a fresh cache; notDetected =
 * absent from a fresh cache OR lastSeenAt beyond the horizon; unknown = cache not fresh").
 * `online` NEVER comes from `lastSeenAt` — only a direct, CURRENT (fresh/freshEmpty) cache
 * confirmation earns it, so a live re-appearance always wins even if the stored `lastSeenAt` is
 * stale (has no poller yet to keep it current — that lands in the `poll.ts`).
 * `notDetected` applies either when a current snapshot confirms absence, OR — independent of
 * cache freshness — when the device hasn't been observed within the horizon at all (a device
 * silent for a week is legitimately "not detected" even while the cache happens to be
 * momentarily stale). `unknown` is the residual: the cache can't currently confirm anything,
 * but the horizon hasn't been crossed either — genuinely unsure, never invented.
 * NOTE (admin panel): until the poller lands, "online wins over a stale stored
 * lastSeenAt" (above) means a device CAN legitimately show `liveStatus: "online"` while its own
 * `lastSeenAt` field is old (e.g. only ever stamped once, at registration). Do not render these
 * two fields side by side as if they were always consistent (e.g. "Online — last seen 8 days
 * ago" reads as a contradiction) until the poller keeps `lastSeenAt` current on every observed
 * poll — that pairing only becomes trustworthy once ships.
 */
function deriveLiveStatus(
  row: NetworkDeviceRow,
  cache: LiveCacheSnapshot,
  now: number
): LiveStatus {
  if (isCurrentSnapshot(cache.state)) {
    const present = cache.clients.some((c) => c.mac === row.mac);
    if (present) return "online";
    return "notDetected";
  }
  if (row.last_seen_at === null || now - row.last_seen_at > NOT_DETECTED_HORIZON_MS) {
    return "notDetected";
  }
  return "unknown";
}

/** Every DTO field EXCEPT `liveStatus` — split out so callers that need a non-default liveStatus
 * derivation (e.g. `edit`'s throwing-accessor fallback) don't have to route through
 * `deriveLiveStatus` at all. */
function rowToRegisteredDeviceBase(row: NetworkDeviceRow): Omit<RegisteredDevice, "liveStatus"> {
  let memberLabel: string | null = null;
  let memberInactive = false;
  if (row.member_id !== null) {
    const label = resolveMemberLabel(row.member_id);
    if (label) {
      memberLabel = label.displayName;
      memberInactive = label.readOnly;
    } else {
      // Defensive only: members are archive-only (no hard delete), so a registered
      // member_id should always resolve. Render conservatively if it somehow doesn't.
      memberInactive = true;
    }
  }

  return {
    id: row.id,
    mac: row.mac,
    alias: row.alias,
    memberId: row.member_id,
    memberLabel,
    memberInactive,
    isBlocked: row.is_blocked === 1,
    beliefDiverged: row.belief_diverged_at !== null,
    lastSeenAt: row.last_seen_at,
  };
}

/** The same DTO shape `rowToRegisteredDeviceBase` returns, but WITHOUT the `resolveMemberLabel`
 * lookup — the fixed, no-DB-query building block `setBlockedState`'s read-back fallback uses
 * when even THAT lookup can't be trusted . Reports `memberLabel:
 * null` / `memberInactive: false` regardless of `row.member_id` — best-effort, not a claim that
 * the member is unassigned.
 */
function baseDeviceFieldsNoMemberLookup(
  row: NetworkDeviceRow
): Omit<RegisteredDevice, "liveStatus"> {
  return {
    id: row.id,
    mac: row.mac,
    alias: row.alias,
    memberId: row.member_id,
    memberLabel: null,
    memberInactive: false,
    isBlocked: row.is_blocked === 1,
    beliefDiverged: row.belief_diverged_at !== null,
    lastSeenAt: row.last_seen_at,
  };
}

function rowToRegisteredDevice(
  row: NetworkDeviceRow,
  cache: LiveCacheSnapshot,
  now: number
): RegisteredDevice {
  return { ...rowToRegisteredDeviceBase(row), liveStatus: deriveLiveStatus(row, cache, now) };
}

// ── Commands / queries ───────────────────────────────────────────

/** Register a device (US1, FR-001/FR-002/FR-003). Picker-only: the submitted MAC must be present
 * in the CURRENT (fresh/freshEmpty) live-cache snapshot — absent (rotated out, or the cache isn't
 * current) refuses with the dedicated `NetworkDeviceReselectRequiredError`, never a
 * generic validation error. `lastSeenAt` is stamped from the snapshot's OWN `fetchedAt` — the real
 * observation instant — never `Date.now` (INV-10). A non-null `memberId` must resolve to an
 * active member (FR-011/AC-07). The MAC is canonicalized before the INSERT so the table's UNIQUE
 * index is the actual race-resolution mechanism (INV-01) — a racing duplicate loses at the DB
 * layer and is surfaced honestly as `NetworkDeviceDuplicateError`, never silently returned as if
 * it had created/owned the winning row.
 */
export function register(mac: unknown, alias: unknown, memberId?: string | null): RegisteredDevice {
  const canonicalMac = canonicalizeMac(mac);
  const trimmedAlias = validateAlias(alias);

  const cache = getLiveCacheAccessor()();
  if (!isCurrentSnapshot(cache.state) || !cache.clients.some((c) => c.mac === canonicalMac)) {
    throw new NetworkDeviceReselectRequiredError(canonicalMac);
  }
  if (cache.fetchedAt === null) {
    // Contract violation, not a user-facing state: a fresh/freshEmpty snapshot MUST carry a
    // real observation instant ("In-process live cache"). Fail loudly rather
    // than silently defaulting lastSeenAt (INV-10) — see LiveCacheSnapshot's own doc comment.
    throw new Error(
      "Live cache reported a current (fresh/freshEmpty) state without a fetchedAt observation instant"
    );
  }

  if (memberId !== undefined && memberId !== null) {
    assertActiveMember(memberId);
  }

  const db = getDb();
  const id = randomUUID();
  const now = Date.now();
  try {
    db.prepare(
      `INSERT INTO network_devices
         (id, mac, alias, member_id, is_blocked, belief_diverged_at, last_seen_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, NULL, ?, ?, ?)`
    ).run(id, canonicalMac, trimmedAlias, memberId ?? null, cache.fetchedAt, now, now);
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new NetworkDeviceDuplicateError(canonicalMac);
    }
    throw err;
  }

  const row = findById(db, id);
  if (!row) {
    throw new Error(`Network device "${id}" was inserted but could not be read back`);
  }
  return rowToRegisteredDevice(row, cache, now);
}

export interface EditDeviceInput {
  alias?: string;
  memberId?: string | null;
}

/** Edit alias / member assignment (US3, FR-007/FR-011/INV-02). The MAC is structurally
 * immutable — `EditDeviceInput` has NO `mac` property, and no statement in this function (or
 * anywhere in this module) ever writes the `mac` column; no replace-MAC path exists. A NEW
 * non-null `memberId` (different from the row's current value) must resolve to an active
 * member; re-submitting the SAME (possibly inactive) `memberId`, or omitting the field entirely,
 * is not re-validated — an existing inactive link renders labeled via `resolveMemberLabel`'s * tolerant read and stays fully editable (AC-07).
 * `liveStatus` on the returned DTO IS derived from the REAL live-cache accessor — the same pure
 * read `list` uses — because a stale/synthetic snapshot here would manufacture a confident-false
 * value (e.g. a fresh cache containing the MAC + an 8-day-old stored `lastSeenAt` must still read
 * `online`, not `notDetected`). The WRITE itself never depends on the accessor, though: curation
 * stays independent of controller/cache state (US3) for its success/failure, so if the accessor
 * throws, the alias/member write above has ALREADY succeeded and `liveStatus` falls back to a
 * LITERAL `"unknown"` — no horizon math, no synthetic snapshot fed through `deriveLiveStatus`.
 */
export function edit(id: string, input: EditDeviceInput): RegisteredDevice {
  const db = getDb();
  const row = findById(db, id);
  if (!row) {
    throw new NetworkDeviceNotFoundError(id);
  }

  let nextAlias = row.alias;
  if (input.alias !== undefined) {
    nextAlias = validateAlias(input.alias);
  }

  let nextMemberId = row.member_id;
  if (input.memberId !== undefined) {
    if (input.memberId !== null && input.memberId !== row.member_id) {
      assertActiveMember(input.memberId);
    }
    nextMemberId = input.memberId;
  }

  const now = Date.now();
  db.prepare(
    `UPDATE network_devices SET alias = ?, member_id = ?, updated_at = ? WHERE id = ?`
  ).run(nextAlias, nextMemberId, now, id);

  const updated = findById(db, id);
  if (!updated) {
    throw new Error(`Network device "${id}" disappeared during edit`);
  }

  let liveStatus: LiveStatus;
  try {
    const cache = getLiveCacheAccessor()();
    liveStatus = deriveLiveStatus(updated, cache, now);
  } catch {
    // The write above already succeeded — see docblock. Literal fallback, deliberately NOT
    // routed through deriveLiveStatus (that would apply horizon math against a synthetic
    // snapshot and could manufacture "notDetected" from a merely-old stored lastSeenAt).
    liveStatus = "unknown";
  }
  return { ...rowToRegisteredDeviceBase(updated), liveStatus };
}

/** Delete a device (US3, FR-010/AC-04). Local-only, ALWAYS succeeds — no controller call is
 * ever made from this function, in this module or any other (added block/unblock elsewhere
 * in this module, never here), and this function never calls the live-cache accessor either
 * (proven against a throwing accessor). A missing id is a no-op success, never a throw —
 * mirroring the `daily-messages` delete idempotency precedent. Deleting a blocked device
 * strands any upstream block by design: ADR-053 §4 ("Ownership separation") is explicit that
 * v1's hidden unblock-on-delete side effect is REMOVED, and stranding the block is accepted as
 * the admin's responsibility — do NOT "fix" this by calling `unblockMac` here.
 * ROUTE-LAYER NOTE: a DELETE endpoint that wants to answer 404-vs-200 (e.g. to tell an
 * admin "that device is already gone" vs "deleted") needs its OWN existence read before calling
 * this function — `remove` itself is intentionally idempotent and reports no distinction. Use
 * `exists` below for that read — it keeps the `network_devices` schema a module-owned detail
 * rather than a raw SELECT reappearing at the route layer .
 */
export function remove(id: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM network_devices WHERE id = ?`).run(id);
}

/** Existence check (route-layer 404-vs-204 seam — see `remove`'s docblock above). A
 * plain, zero-derivation SELECT: no live-cache read, no `liveStatus` derivation, no member-label
 * lookup — the route only needs a yes/no.
 */
export function exists(id: string): boolean {
  const db = getDb();
  const row = db.prepare("SELECT 1 FROM network_devices WHERE id = ?").get(id);
  return row !== undefined;
}

// ── Block / unblock — controller honesty ───────────────

/** Order intent -> controller call (authoritative) -> local mirror write (AC-02):
 * the controller ALWAYS goes first. A controller failure (unconfigured/rejected/unreachable)
 * throws one of the three dedicated error classes above and mirrors NOTHING — the local row is
 * never touched. A controller SUCCESS followed by a mirror-write failure does NOT throw to the
 * caller: it sets `beliefDivergedAt` instead, so the row visibly diverges until the next poll
 * converges it (`poll.ts`'s `reconcileBlockedFlags`) — "the belief-vs-controller state IS the
 * answer" (brief), never a 500.
 * ADR-053 §2 (Minor, explicit): blocking an already-blocked device (or unblocking an
 * already-unblocked one) re-sends the intent to the controller NAIVELY — there is deliberately
 * NO "is it already in this state locally?" short-circuit here. Do not add one: a smarter
 * cross-boundary idempotency guard reads the belief-mirror `isBlocked`, which can itself be
 * stale in the divergence window, and would either wrongly refuse a correct opposite action or
 * (worse) silently skip re-asserting the real controller state. The next poll corrects any
 * redundancy; the admin can retry.
 */
async function setBlockedState(id: string, blocked: boolean): Promise<RegisteredDevice> {
  const db = getDb();
  const row = findById(db, id);
  if (!row) {
    throw new NetworkDeviceNotFoundError(id);
  }

  const client = getUniFiClient();
  if (!client) {
    throw new NetworkDeviceControllerUnavailableError();
  }

  try {
    if (blocked) {
      await client.blockMac(row.mac);
    } else {
      await client.unblockMac(row.mac);
    }
  } catch (err) {
    if (err instanceof UniFiControllerRejectedError) {
      throw new NetworkDeviceControllerRejectedError();
    }
    throw new NetworkDeviceControllerUnreachableError();
  }

  // Controller call succeeded — it is now authoritative. Mirror locally; a failure here is
  // NOT re-thrown (AC-02) — it becomes a visible divergence instead.
  const now = Date.now();
  let mirrorSucceeded = false;
  try {
    db.prepare(
      `UPDATE network_devices SET is_blocked = ?, belief_diverged_at = NULL, updated_at = ? WHERE id = ?`
    ).run(blocked ? 1 : 0, now, id);
    mirrorSucceeded = true;
  } catch {
    // a real fault here (SQLITE_BUSY, disk-full)
    // must not propagate — the controller call above already succeeded, and that fact must
    // never be discarded. Fall back to the narrower divergence-flag write.
    try {
      db.prepare(`UPDATE network_devices SET belief_diverged_at = ? WHERE id = ?`).run(now, id);
    } catch {
      // DOUBLE FAULT: even the divergence-flag write failed. Deliberately still do NOT
      // throw — a caller receiving an exception here would wrongly believe the
      // controller-authoritative block/unblock never happened, which is worse than an
      // unrecorded divergence. Nothing further is written; the row is left exactly as it
      // was before this call. `poll.ts`'s `reconcileBlockedFlags` is the real backstop —
      // it reads the controller's authoritative state directly on its next run and will
      // correct whatever this row currently holds once the DB recovers, with or without
      // the flag having ever been persisted. Falls through to the best-effort response
      // below.
    }
  }

  // network.device_blocked / network.device_unblocked — {deviceId,
  // timestamp} ONLY, no MAC, no alias. Emitted regardless of which branch above ran (even a
  // mirror-write failure still means the controller-authoritative action happened).
  emit(blocked ? "network.device_blocked" : "network.device_unblocked", {
    deviceId: id,
    timestamp: now,
  });

  // Independent the read-back must not throw the controller's already-successful
  // action away either — same double-fault posture as the mirror write above. A failed
  // read-back (SQLITE_BUSY/disk-full mid-recovery, or the row genuinely missing) falls back
  // to a RECONSTRUCTED response built from the pre-write `row` snapshot this function read at
  // entry, with only the fields this call could plausibly have changed patched in — never
  // re-deriving liveStatus from anything that could itself be down; "unknown" is the honest,
  // conservative answer. `mirrorSucceeded` decides which values the reconstruction reports:
  // a successful mirror write means the row IS now `blocked`/undiverged even though this
  // fallback can't re-confirm it by reading; a failed one means the row is still whatever it
  // was before (a "stale read", explicitly not the new intended value) with divergence
  // reported best-effort even if the flag itself never made it to disk.
  let updated: NetworkDeviceRow | undefined;
  try {
    updated = findById(db, id);
  } catch {
    updated = undefined;
  }

  if (!updated) {
    const reconstructedRow: NetworkDeviceRow = {
      ...row,
      is_blocked: mirrorSucceeded ? (blocked ? 1 : 0) : row.is_blocked,
      belief_diverged_at: mirrorSucceeded ? null : now,
    };
    // rowToRegisteredDeviceBase's OWN internal
    // `resolveMemberLabel` call is a SECOND query this fallback must not let escape either —
    // a persistent SQLITE_BUSY/disk-full fault severe enough to have already broken the
    // mirror write AND the read-back above could just as easily break this lookup too, and
    // letting THAT throw would reject the whole block/unblock call after the controller
    // has already acted — the exact "invites a dangerous retry of an already-applied action"
    // hazard this whole fallback path exists to avoid. Best-effort: drop to the no-lookup
    // shape (memberLabel null / memberInactive false) rather than re-throwing.
    let base: Omit<RegisteredDevice, "liveStatus">;
    try {
      base = rowToRegisteredDeviceBase(reconstructedRow);
    } catch {
      base = baseDeviceFieldsNoMemberLookup(reconstructedRow);
    }
    return { ...base, liveStatus: "unknown" };
  }

  let liveStatus: LiveStatus;
  try {
    const cache = getLiveCacheAccessor()();
    liveStatus = deriveLiveStatus(updated, cache, now);
  } catch {
    // Same fallback rationale as `edit` above: the controller/mirror work already happened;
    // a throwing cache accessor must not turn that into a caller-visible failure.
    liveStatus = "unknown";
  }

  // rowToRegisteredDeviceBase's OWN internal
  // `resolveMemberLabel` call must not escape HERE either — the controller call (and often
  // the mirror write) has already succeeded by this point, so letting a persistent
  // SQLITE_BUSY/disk-full fault in this SECOND query turn into a thrown exception would
  // reject the whole block/unblock call after the fact and could tempt a caller into
  // retrying an already-applied controller action. Best-effort: drop to the no-lookup shape
  // (memberLabel null / memberInactive false) rather than re-throwing.
  let base: Omit<RegisteredDevice, "liveStatus">;
  try {
    base = rowToRegisteredDeviceBase(updated);
  } catch {
    base = baseDeviceFieldsNoMemberLookup(updated);
  }
  return { ...base, liveStatus };
}

/** Block a registered device's internet access via the controller (US2, FR-008/FR-009). */
export function block(id: string): Promise<RegisteredDevice> {
  return setBlockedState(id, true);
}

/** Unblock a registered device's internet access via the controller (US2, FR-008/FR-009). */
export function unblock(id: string): Promise<RegisteredDevice> {
  return setBlockedState(id, false);
}

/** List registered devices (US4, FR-004/FR-005/FR-006, NETWORK-DEVICES-AC-01/INV-05). A PURE
 * read — a single SELECT, zero writes, no reconcile-on-read, no lastSeenAt-on-read. `now` is an
 * explicit injected instant (never `Date.now` internally) so the not-detected horizon and
 * cache-freshness-driven derivation are fully deterministic in tests.
 */
export function list(now: number): NetworkDevicesListResponse {
  const db = getDb();
  const rows = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM network_devices ORDER BY created_at ASC`)
    .all() as NetworkDeviceRow[];

  const cache = getLiveCacheAccessor()();
  return {
    devices: rows.map((row) => rowToRegisteredDevice(row, cache, now)),
    cacheState: cache.state,
  };
}

/** Picker feed (US1/US5): the controller's current live clients + the cache state gating
 * how they should be presented (contract `/api/network-devices/live-clients` GET 200). A thin
 * projection of the live-cache accessor's own snapshot down to the public contract shape —
 * `fetchedAt`/`lastError` stay internal (server-side reconciliation/derivation concerns only,
 * `register`/`deriveLiveStatus` above), never leaked onto this read-only picker surface.
 */
export function getLiveClientsSnapshot(): LiveClientsResponse {
  const cache = getLiveCacheAccessor()();
  return { state: cache.state, clients: cache.clients };
}
