import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { getDb } from "../../db/client";
import type { ExternalSourceProvider, ExternalSourcePublic } from "../../../shared";
import {
  beginExternalSourceReplacement,
  beginExternalSourceDeletion,
  finishExternalSourceReplacement,
  finishExternalSourceDeletion,
  getExternalSourceLifecycleVersion,
  isExternalSourceDeleting,
  isExternalSourceReplacing,
} from "./sync-coordinator";

export class ExternalSourceValidationError extends Error {
  readonly code: "invalid_external_source" | "unsafe_url";

  constructor(code: "invalid_external_source" | "unsafe_url") {
    super(code);
    this.name = "ValidationError";
    this.code = code;
  }
}

export interface ExternalSourceInput {
  id: string;
  name: string;
  provider: string;
  feedUrl: string;
  enabled?: boolean;
  pollIntervalMin?: number;
}

export type ResolvedAddress = { address: string; family: number };
export type ResolveExternalSourceHost = (hostname: string) => Promise<ResolvedAddress[]>;
export interface ExternalSourceDependencies {
  lookup?: ResolveExternalSourceHost;
}

export interface ValidatedExternalSourceUrl {
  url: URL;
  addresses: ResolvedAddress[];
}

const PROVIDERS = new Set<ExternalSourceProvider>(["google", "microsoft", "apple", "ics_generic"]);

function parseIpv4(address: string): bigint | null {
  const octets = address.split(".");
  if (octets.length !== 4) return null;
  let value = 0n;
  for (const octet of octets) {
    if (!/^\d{1,3}$/.test(octet)) return null;
    const number = Number(octet);
    if (!Number.isInteger(number) || number < 0 || number > 255) return null;
    value = (value << 8n) | BigInt(number);
  }
  return value;
}

function parseIpv6Part(part: string): number[] | null {
  if (part.length === 0) return [];
  const segments = part.split(":");
  const result: number[] = [];
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (segment.includes(".")) {
      if (index !== segments.length - 1) return null;
      const ipv4 = parseIpv4(segment);
      if (ipv4 === null) return null;
      result.push(Number((ipv4 >> 16n) & 0xffffn), Number(ipv4 & 0xffffn));
      continue;
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(segment)) return null;
    result.push(Number.parseInt(segment, 16));
  }
  return result;
}

function parseIpv6(address: string): bigint | null {
  const separator = address.indexOf("::");
  if (separator !== address.lastIndexOf("::")) return null;
  const left = parseIpv6Part(separator === -1 ? address : address.slice(0, separator));
  const right = parseIpv6Part(separator === -1 ? "" : address.slice(separator + 2));
  if (left === null || right === null) return null;
  const missing = separator === -1 ? 0 : 8 - left.length - right.length;
  if ((separator === -1 && left.length !== 8) || (separator !== -1 && missing < 1)) return null;
  const segments = [...left, ...Array<number>(missing).fill(0), ...right];
  if (segments.length !== 8) return null;
  return segments.reduce((value, segment) => (value << 16n) | BigInt(segment), 0n);
}

function isInRange(value: bigint, start: bigint, prefix: number, bits: number): boolean {
  const shift = BigInt(bits - prefix);
  return value >> shift === start >> shift;
}

const IPV4_FORBIDDEN_RANGES: ReadonlyArray<readonly [bigint, number]> = [
  [0x00000000n, 8], // "This network"
  [0x0a000000n, 8], // Private use
  [0x64400000n, 10], // Shared address space
  [0x7f000000n, 8], // Loopback
  [0xa9fe0000n, 16], // Link-local
  [0xac100000n, 12], // Private use
  [0xc0000000n, 24], // IETF protocol assignments
  [0xc0000200n, 24], // Documentation
  [0xc0586300n, 24], // Deprecated 6to4 relay anycast
  [0xc0a80000n, 16], // Private use
  [0xc6120000n, 15], // Benchmarking
  [0xc6336400n, 24], // Documentation
  [0xcb007100n, 24], // Documentation
  [0xe0000000n, 4], // Multicast
  [0xf0000000n, 4], // Reserved, including limited broadcast
];

const IPV6_FORBIDDEN_RANGES: ReadonlyArray<readonly [bigint, number]> = [
  [0x00000000000000000000000000000000n, 96], // IPv4-compatible / unspecified space
  [0x01000000000000000000000000000000n, 64], // Discard-only
  [0x0064ff9b000100000000000000000000n, 48], // Local-use IPv4/IPv6 translation
  [0x20010000000000000000000000000000n, 23], // IETF special-purpose
  [0x20010010000000000000000000000000n, 28], // ORCHID
  [0x20010020000000000000000000000000n, 28], // ORCHIDv2
  [0x20010db8000000000000000000000000n, 32], // Documentation
  [0x20020000000000000000000000000000n, 16], // Deprecated 6to4
  [0x3fff0000000000000000000000000000n, 20], // Documentation
  [0x5f000000000000000000000000000000n, 16], // Segment Routing SIDs
  [0xfc000000000000000000000000000000n, 7], // Unique local
  [0xfe800000000000000000000000000000n, 10], // Link-local
  [0xfec00000000000000000000000000000n, 10], // Deprecated site-local
  [0xff000000000000000000000000000000n, 8], // Multicast
];

function isForbiddenIpv4Value(value: bigint): boolean {
  return IPV4_FORBIDDEN_RANGES.some(([start, prefix]) => isInRange(value, start, prefix, 32));
}

function isForbiddenIpv4(address: string): boolean {
  const value = parseIpv4(address);
  return value === null || isForbiddenIpv4Value(value);
}

function isForbiddenIpv6(address: string): boolean {
  const value = parseIpv6(address);
  if (value === null) return true;
  if (
    isInRange(value, 0x00000000000000000000ffff00000000n, 96, 128) ||
    isInRange(value, 0x0064ff9b000000000000000000000000n, 96, 128)
  )
    return isForbiddenIpv4Value(value & 0xffffffffn);
  return IPV6_FORBIDDEN_RANGES.some(([start, prefix]) => isInRange(value, start, prefix, 128));
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4
    ? !isForbiddenIpv4(address)
    : family === 6
      ? !isForbiddenIpv6(address)
      : false;
}

function normalizeResolvedAddresses(answers: ResolvedAddress[]): ResolvedAddress[] | null {
  const unique = new Map<string, ResolvedAddress>();
  for (const answer of answers) {
    const family = isIP(answer.address);
    if (family === 0 || family !== answer.family || !isPublicAddress(answer.address)) return null;
    unique.set(`${family}:${answer.address}`, { address: answer.address, family });
  }
  return unique.size === 0 ? null : [...unique.values()];
}

function normalizeProvider(provider: string): ExternalSourceProvider {
  const normalized = provider.trim().toLowerCase();
  return PROVIDERS.has(normalized as ExternalSourceProvider)
    ? (normalized as ExternalSourceProvider)
    : "ics_generic";
}

function toPublic(row: {
  id: string;
  name: string;
  provider: string;
  feed_url: string;
  enabled: number;
  poll_interval_min: number;
  last_attempt_at: number | null;
  last_success_at: number | null;
  last_error_code: ExternalSourcePublic["lastErrorCode"];
  consecutive_failures: number;
  last_imported_count: number;
  last_skipped_count: number;
}): ExternalSourcePublic {
  const url = new URL(row.feed_url);
  return {
    id: row.id,
    name: row.name,
    provider: normalizeProvider(row.provider),
    maskedUrl: `${url.protocol}//${url.host}/***`,
    enabled: row.enabled === 1,
    pollIntervalMin: row.poll_interval_min,
    phase: null,
    lastAttemptAt: row.last_attempt_at,
    lastSuccessAt: row.last_success_at,
    lastErrorCode: row.last_error_code,
    consecutiveFailures: row.consecutive_failures,
    lastImportedCount: row.last_imported_count,
    lastSkippedCount: row.last_skipped_count,
  };
}

export async function resolveExternalSourceUrl(
  rawUrl: string,
  suppliedLookup?: ResolveExternalSourceHost
): Promise<ValidatedExternalSourceUrl> {
  const lookup: ResolveExternalSourceHost =
    suppliedLookup ?? (async (hostname) => dnsLookup(hostname, { all: true, verbatim: true }));
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ExternalSourceValidationError("unsafe_url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new ExternalSourceValidationError("unsafe_url");
  if (url.username || url.password) throw new ExternalSourceValidationError("unsafe_url");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!hostname) throw new ExternalSourceValidationError("unsafe_url");
  if (isIP(hostname) !== 0) {
    if (!isPublicAddress(hostname)) throw new ExternalSourceValidationError("unsafe_url");
    return { url, addresses: [{ address: hostname, family: isIP(hostname) }] };
  }
  let answers: ResolvedAddress[];
  try {
    answers = await lookup(hostname);
  } catch {
    throw new ExternalSourceValidationError("unsafe_url");
  }
  const addresses = normalizeResolvedAddresses(answers);
  if (addresses === null) throw new ExternalSourceValidationError("unsafe_url");
  return { url, addresses };
}

export async function validateExternalSourceUrl(
  rawUrl: string,
  suppliedLookup?: ResolveExternalSourceHost
): Promise<URL> {
  return (await resolveExternalSourceUrl(rawUrl, suppliedLookup)).url;
}

function validateInput(input: ExternalSourceInput): void {
  if (typeof input.id !== "string" || input.id.trim().length === 0)
    throw new ExternalSourceValidationError("invalid_external_source");
  if (
    typeof input.name !== "string" ||
    input.name.trim().length === 0 ||
    input.name.trim().length > 120
  )
    throw new ExternalSourceValidationError("invalid_external_source");
  if (typeof input.provider !== "string" || typeof input.feedUrl !== "string")
    throw new ExternalSourceValidationError("invalid_external_source");
  if (input.enabled !== undefined && typeof input.enabled !== "boolean")
    throw new ExternalSourceValidationError("invalid_external_source");
  if (
    input.pollIntervalMin !== undefined &&
    (!Number.isInteger(input.pollIntervalMin) ||
      input.pollIntervalMin < 1 ||
      input.pollIntervalMin > 1440)
  )
    throw new ExternalSourceValidationError("invalid_external_source");
}

/** Persists configuration after URL/DNS validation; it never fetches, parses, syncs, or creates events. */
export async function upsertExternalSource(
  input: ExternalSourceInput,
  dependencies: ExternalSourceDependencies = {}
): Promise<ExternalSourcePublic> {
  validateInput(input);
  const sourceId = input.id.trim();
  const lifecycleVersion = getExternalSourceLifecycleVersion(sourceId);
  const url = await validateExternalSourceUrl(input.feedUrl, dependencies.lookup);
  if (
    isExternalSourceDeleting(sourceId) ||
    isExternalSourceReplacing(sourceId) ||
    getExternalSourceLifecycleVersion(sourceId) !== lifecycleVersion
  )
    throw new ExternalSourceValidationError("invalid_external_source");
  const now = Date.now();
  const provider = normalizeProvider(input.provider);
  const existing = getDb()
    .prepare("SELECT feed_url FROM calendar_external_sources WHERE id = ?")
    .get(sourceId) as { feed_url: string } | undefined;
  if (existing && existing.feed_url !== url.toString()) {
    const replacement = beginExternalSourceReplacement(sourceId);
    if (!replacement) throw new ExternalSourceValidationError("invalid_external_source");
    try {
      await replacement.active;
      if (
        isExternalSourceDeleting(sourceId) ||
        getExternalSourceLifecycleVersion(sourceId) !== replacement.version
      )
        throw new ExternalSourceValidationError("invalid_external_source");
      getDb().transaction(() => {
        getDb()
          .prepare(
            `DELETE FROM calendar_assignments WHERE event_id IN
             (SELECT event_id FROM calendar_external_event_meta WHERE source_id = ?)`
          )
          .run(sourceId);
        getDb()
          .prepare(
            `DELETE FROM calendar_events WHERE id IN
             (SELECT event_id FROM calendar_external_event_meta WHERE source_id = ?)`
          )
          .run(sourceId);
        getDb()
          .prepare(
            `UPDATE calendar_external_sources
             SET name = ?, provider = ?, feed_url = ?, enabled = ?, poll_interval_min = ?,
                 etag = NULL, last_modified = NULL, content_hash = NULL,
                 last_attempt_at = NULL, last_success_at = NULL, last_error_code = NULL,
                 consecutive_failures = 0, last_imported_count = 0, last_skipped_count = 0,
                 updated_at = ?
             WHERE id = ?`
          )
          .run(
            input.name.trim(),
            provider,
            url.toString(),
            input.enabled === false ? 0 : 1,
            input.pollIntervalMin ?? 15,
            now,
            sourceId
          );
      })();
    } finally {
      finishExternalSourceReplacement(sourceId);
    }
  } else {
    getDb()
      .prepare(
        `INSERT INTO calendar_external_sources (id, name, provider, feed_url, enabled, poll_interval_min, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, provider = excluded.provider, feed_url = excluded.feed_url, enabled = excluded.enabled, poll_interval_min = excluded.poll_interval_min, updated_at = excluded.updated_at`
      )
      .run(
        sourceId,
        input.name.trim(),
        provider,
        url.toString(),
        input.enabled === false ? 0 : 1,
        input.pollIntervalMin ?? 15,
        now,
        now
      );
  }
  return listExternalSources().find((source) => source.id === sourceId)!;
}

/** Client-facing source configurations. Raw feed URLs never cross this boundary. */
export function listExternalSources(): ExternalSourcePublic[] {
  const rows = getDb()
    .prepare(
      `SELECT id, name, provider, feed_url, enabled, poll_interval_min, last_attempt_at, last_success_at,
              last_error_code, consecutive_failures, last_imported_count, last_skipped_count
       FROM calendar_external_sources ORDER BY id`
    )
    .all() as Array<{
    id: string;
    name: string;
    provider: string;
    feed_url: string;
    enabled: number;
    poll_interval_min: number;
    last_attempt_at: number | null;
    last_success_at: number | null;
    last_error_code: ExternalSourcePublic["lastErrorCode"];
    consecutive_failures: number;
    last_imported_count: number;
    last_skipped_count: number;
  }>;
  return rows.map(toPublic);
}

/** Toggle only the enabled flag; imported rows and polling policy are retained. */
export function setExternalSourceEnabled(
  sourceId: string,
  enabled: boolean
): ExternalSourcePublic | null {
  if (isExternalSourceDeleting(sourceId)) return null;
  const now = Date.now();
  const updated = getDb()
    .prepare("UPDATE calendar_external_sources SET enabled = ?, updated_at = ? WHERE id = ?")
    .run(enabled ? 1 : 0, now, sourceId);
  return updated.changes === 0
    ? null
    : (listExternalSources().find((source) => source.id === sourceId) ?? null);
}

/** Wait for the claimed source's active run before removing its complete snapshot. */
export async function deleteExternalSource(sourceId: string): Promise<boolean> {
  const exists = getDb()
    .prepare("SELECT 1 FROM calendar_external_sources WHERE id = ?")
    .get(sourceId);
  if (!exists) return false;
  const active = beginExternalSourceDeletion(sourceId);
  if (!active) return false;
  try {
    await active;
    getDb().transaction(() => {
      getDb()
        .prepare(
          `DELETE FROM calendar_assignments WHERE event_id IN
           (SELECT event_id FROM calendar_external_event_meta WHERE source_id = ?)`
        )
        .run(sourceId);
      getDb()
        .prepare(
          `DELETE FROM calendar_events WHERE id IN
           (SELECT event_id FROM calendar_external_event_meta WHERE source_id = ?)`
        )
        .run(sourceId);
      getDb().prepare("DELETE FROM calendar_external_sources WHERE id = ?").run(sourceId);
    })();
    return true;
  } finally {
    finishExternalSourceDeletion(sourceId);
  }
}
