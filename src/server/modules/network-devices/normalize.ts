// ─────────────────────────────────────────────────────────────────────
// Live-client normalization — raw UniFi
// controller clients -> the closed `LiveClient[]` shape `src/shared` defines.
// Pure: no I/O, no clock. The IP drop is STRUCTURAL — `LiveClient` has no
// `ip` field, so this module cannot copy one across even if it tried; the
// checked-in fixture (`tests/helpers/unifi-fixtures.ts`) is deliberately
// rich in IP fields precisely to prove the drop against realistic input,
// not a pre-cleaned stub.
//
// Live finding (2026-09-05): the REAL cloud-proxied Integration v1 `/clients` projection is
// REDUCED — no `isBlocked`, no `hostname` — with blocked state riding in `access.type` instead.
// See `extractRawAccessType`'s doc comment for the full read (incl. what v1 does — nothing —
// with this field).
//
// Source: docs/features/network-devices.md; "Shared
// DTOs" (`LiveClient` — "NOTE: no ip field EXISTS"); FR-012.
// ─────────────────────────────────────────────────────────────────────

import { canonicalizeMac } from "./index";
import type { RawUniFiClient } from "./client";
import type { LiveClient } from "../../../shared";

/** Lenient canonicalization for ingestion: an invalid/absent MAC means the raw entry is
 * SKIPPED (Edge Cases / "MAC-less clients are unregisterable"), never a
 * throw — unlike `canonicalizeMac` itself, which is the strict, throwing form `register`
 * uses against a user-submitted MAC. */
function tryCanonicalizeMac(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  try {
    return canonicalizeMac(raw);
  } catch {
    return null;
  }
}

function extractDisplayName(raw: RawUniFiClient): string | null {
  // `name`/`hostname` are the SAME field names in both shapes (architect update 2026-09-05,
  // ~/Dev/p55-homelab/unifi/scripts/check-clients.sh: `.name //.hostname // "unknown"`) — no
  // camelCase variant exists for these two.
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (name.length > 0) return name;
  const hostname = typeof raw.hostname === "string" ? raw.hostname.trim() : "";
  if (hostname.length > 0) return hostname;
  return null;
}

/** MAC extraction across BOTH raw shapes (architect update 2026-09-05): Integration v1's
 * camelCase `macAddress` (LOCAL, PROVEN) is tried first, falling back to the legacy snake_case
 * `mac` (CLOUD fallback + command-response shape) — a given raw entry only ever carries ONE of
 * the two in practice, so preference order is not load-bearing.
 */
function extractRawMac(raw: RawUniFiClient): unknown {
  if (typeof raw.macAddress === "string") return raw.macAddress;
  return raw.mac;
}

/** Live finding (2026-09-05, real cloud console probe, HTTP 200, 23 clients): the CLOUD
 * Integration v1 projection carries NO `isBlocked` field at all — its blocked state instead
 * rides in `access: { type: "DEFAULT" | "BLOCKED" |... }`. v1 (`apps/api/src/routes/unifi.ts`
 * `extractBlockedFlag`) NEVER reads `access` either — it only checks `isBlocked`/`blocked`, so
 * against this exact cloud shape v1's own extractor would return `undefined` for every client,
 * which its caller (`fetchRealBlockedStatesByMac`) treats as "no signal, skip this MAC" (still
 * governed by whatever belief the DB already held) — NOT "assume unblocked". There is nothing to
 * mirror from v1 for `access.type` itself, so this is this module's own, precise-but-conservative
 * reading: `type === "BLOCKED"` -> blocked. The `"BLOCKED"` value is UNOBSERVED so far (only
 * `"DEFAULT"` has been seen live) — if a real block ever produces a different string, this must
 * be revisited; until then, treating any non-`"BLOCKED"` access.type as unblocked is the same
 * "no false negatives past unblocked" posture the cloud shape's absence of `isBlocked` already
 * forces (client-list is `listClients`'s only reconciliation signal).
 */
function extractRawAccessType(raw: RawUniFiClient): unknown {
  const access = raw.access;
  if (!access || typeof access !== "object") return undefined;
  return (access as { type?: unknown }).type;
}

/** Blocked-flag extraction across ALL THREE raw shapes, in priority order: Integration v1's
 * camelCase `isBlocked` (LOCAL, PROVEN — the primary reconciliation source, /
 * `client.ts`'s own OPEN RISK comment) tried first; then the CLOUD Integration v1 projection's
 * `access.type` (`extractRawAccessType` — live finding, no `isBlocked` field exists there at
 * all); finally the legacy `blocked` (command-response shape). A raw entry carries at most ONE
 * of `isBlocked`/`access` in practice, so this priority order is not load-bearing between those
 * two — it only matters that `access.type` is consulted BEFORE the `blocked === true` legacy
 * fallback, since an absent `blocked` field would otherwise silently read as `false` regardless
 * of what `access.type` said.
 */
function extractRawBlocked(raw: RawUniFiClient): boolean {
  if (typeof raw.isBlocked === "boolean") return raw.isBlocked;
  const accessType = extractRawAccessType(raw);
  if (typeof accessType === "string") return accessType === "BLOCKED";
  return raw.blocked === true;
}

/** Normalize one raw controller client into the closed `LiveClient` shape, or `null` when the
 * entry is unusable (no/malformed MAC — MAC-less clients are unregisterable and untrackable,
 *). Deliberately reads ONLY `macAddress`/`mac`/`name`/`hostname`/`isBlocked`/
 * `access.type`/`blocked` off the raw record — every IP-shaped field (`ip`, `ipAddress`,
 * `last_ip`, `fixed_ip`, or anything else the controller sends) is never even inspected, let
 * alone copied (NETWORK-DEVICES-INV-06) — the structural drop is unchanged by either the
 * camelCase Integration v1 shape or the reduced cloud projection landing here too.
 */
export function normalizeLiveClient(raw: RawUniFiClient): LiveClient | null {
  const mac = tryCanonicalizeMac(extractRawMac(raw));
  if (!mac) return null;

  return {
    mac,
    displayName: extractDisplayName(raw),
    isBlocked: extractRawBlocked(raw),
  };
}

/** Normalize a full raw controller client-list response (`UniFiClient.listClients`'s * resolved value) into the closed `LiveClient[]` shape the live cache stores (`cache.ts`,
 *). MAC-less/malformed entries are silently skipped, never thrown — a single unusable
 * entry must not fail the whole poll (FR-006: a controller quirk must not corrupt the cache).
 */
export function normalizeLiveClients(raw: RawUniFiClient[]): LiveClient[] {
  const out: LiveClient[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const client = normalizeLiveClient(entry);
    if (client) out.push(client);
  }
  return out;
}
