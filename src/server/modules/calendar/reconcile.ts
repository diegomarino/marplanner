import { createHash } from "node:crypto";
import { getDb } from "../../db/client";
import { listActiveMembers } from "../members/referential";
import type { ParsedCalendar, ParsedExternalOccurrence } from "./parse-ics";

export interface PublicationMetadata {
  etag?: string | null;
  lastModified?: string | null;
  contentHash?: string | null;
}

function eventId(sourceId: string, externalUid: string, recurrenceId: string): string {
  const digest = createHash("sha256")
    .update(`${sourceId}\0${externalUid}\0${recurrenceId}`)
    .digest("hex")
    .slice(0, 32);
  return `external:${digest}`;
}

type TitleMember = { id: string; displayName: string };

function foldAccents(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "");
}

function titleWords(value: string): string[] {
  return foldAccents(value)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** A name counts anywhere in the title. A first name alone counts only when no other member
 * shares it; otherwise the title must carry the whole display name.
 */
function membersNamedInTitle(title: string, members: TitleMember[]): TitleMember[] {
  const words = new Set(titleWords(title));
  const named = members.map((member) => ({ member, nameWords: titleWords(member.displayName) }));
  return named
    .filter(({ nameWords }) => {
      if (nameWords.length === 0) return false;
      if (nameWords.every((word) => words.has(word))) return true;
      const sharesFirstName = named.filter((other) => other.nameWords[0] === nameWords[0]);
      return sharesFirstName.length === 1 && words.has(nameWords[0]);
    })
    .map(({ member }) => member);
}

/** Initials are read only from the title's leading label (`NL: …`, `N y L - …`) or from the
 * word after a dash (`… - NL`), never from the body, where any acronym would match.
 */
function initialsLabels(title: string): string[] {
  const undecorated = title.replace(/^[^\p{L}\p{N}]+/u, "");
  const prefix =
    undecorated.match(/^([^:]{1,48}):/)?.[1] ?? undecorated.match(/^(.{1,48}?)\s+-\s+/)?.[1];
  const suffix = undecorated.match(/\s+-\s+(\S+)/)?.[1];
  return [prefix, suffix].filter((label): label is string => label !== undefined);
}

/** Every letter must name a member, and a letter shared by several members must be written once
 * per member (`MM` for Marge and Maggie). Anything else is ambiguous and assigns nobody.
 */
function membersFromInitials(label: string, members: TitleMember[]): TitleMember[] {
  const parts = label
    .split(/\s*[&/,]\s*|\s+(?:y|and|e)\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part !== part.toUpperCase())) return [];
  const letters = foldAccents(parts.join(""));
  if (!/^[A-Z]{1,8}$/.test(letters)) return [];

  const initialOf = (member: TitleMember) =>
    foldAccents(member.displayName.trim()).charAt(0).toUpperCase();
  const resolved: TitleMember[] = [];
  for (const letter of new Set(letters)) {
    const sharing = members.filter((member) => initialOf(member) === letter);
    const written = [...letters].filter((candidate) => candidate === letter).length;
    if (sharing.length === 0 || sharing.length !== written) return [];
    resolved.push(...sharing);
  }
  return resolved;
}

function assignedMembers(title: string, members: TitleMember[]): string[] {
  const assigned = new Set(membersNamedInTitle(title, members).map(({ id }) => id));
  for (const label of initialsLabels(title)) {
    const fromInitials = membersFromInitials(label, members);
    if (fromInitials.length === 0) continue;
    for (const { id } of fromInitials) assigned.add(id);
    break;
  }
  return members.filter(({ id }) => assigned.has(id)).map(({ id }) => id);
}

/** Replaces only the title-derived (`ext:`) rows. Manual assignments from PUT /assignments
 * survive, and a member they already claim is skipped to respect UNIQUE(event_id, member_id).
 */
function replaceTitleAssignments(eventId: string, memberIds: string[], now: number): void {
  const db = getDb();
  db.prepare("DELETE FROM calendar_assignments WHERE event_id = ? AND id LIKE 'ext:%'").run(
    eventId
  );
  for (const memberId of memberIds) {
    const alreadyAssigned = db
      .prepare("SELECT 1 AS ok FROM calendar_assignments WHERE event_id = ? AND member_id = ?")
      .get(eventId, memberId) as { ok: number } | undefined;
    if (alreadyAssigned) continue;
    db.prepare(
      "INSERT INTO calendar_assignments (id, event_id, member_id, created_at) VALUES (?, ?, ?, ?)"
    ).run(`ext:${eventId}:${memberId}`, eventId, memberId, now);
  }
}

function expired(
  row: { end_date: string | null; end_utc: string | null },
  lowerBound: number
): boolean {
  const end = row.end_date
    ? Date.parse(`${row.end_date}T00:00:00.000Z`)
    : Date.parse(row.end_utc ?? "");
  return Number.isFinite(end) && end < lowerBound;
}

export function recordUnchangedSynchronization(
  sourceId: string,
  metadata: PublicationMetadata = {}
): void {
  const db = getDb();
  const now = Date.now();
  db.transaction(() => {
    // The feed did not change, but the household may have: a member added, renamed, archived or
    // restored since the last publication changes who the retained titles name. Every such write
    // stamps members.updated_at, so an untouched household costs one read and no writes.
    const { household_changed: householdChanged } = db
      .prepare(
        `SELECT EXISTS (
           SELECT 1 FROM members WHERE updated_at >= COALESCE(
             (SELECT last_success_at FROM calendar_external_sources WHERE id = ?), 0)
         ) AS household_changed`
      )
      .get(sourceId) as { household_changed: number };
    if (householdChanged) {
      const members = listActiveMembers();
      const retained = db
        .prepare(
          `SELECT events.id, events.title FROM calendar_external_event_meta meta
           JOIN calendar_events events ON events.id = meta.event_id
           WHERE meta.source_id = ? AND meta.status = 'active'`
        )
        .all(sourceId) as Array<{ id: string; title: string }>;
      for (const { id, title } of retained) {
        replaceTitleAssignments(id, assignedMembers(title, members), now);
      }
    }
    db.prepare(
      `UPDATE calendar_external_sources SET last_success_at = ?, last_error_code = NULL,
         consecutive_failures = 0, etag = COALESCE(?, etag),
         last_modified = COALESCE(?, last_modified), content_hash = COALESCE(?, content_hash),
         updated_at = ? WHERE id = ?`
    ).run(
      now,
      metadata.etag ?? null,
      metadata.lastModified ?? null,
      metadata.contentHash ?? null,
      now,
      sourceId
    );
  })();
}

export function reconcileExternalCalendar(
  sourceId: string,
  parsed: ParsedCalendar,
  metadata: PublicationMetadata = {}
): void {
  const db = getDb();
  const now = Date.now();
  const members = listActiveMembers();
  const desired = new Map<string, { occurrence: ParsedExternalOccurrence; memberIds: string[] }>();
  for (const occurrence of parsed.occurrences) {
    const id = eventId(sourceId, occurrence.externalUid, occurrence.recurrenceId);
    desired.set(id, {
      occurrence,
      memberIds: occurrence.status === "active" ? assignedMembers(occurrence.title, members) : [],
    });
  }

  db.transaction(() => {
    const existing = db
      .prepare(
        `SELECT meta.event_id, events.end_date, events.end_utc
       FROM calendar_external_event_meta meta
       JOIN calendar_events events ON events.id = meta.event_id
       WHERE meta.source_id = ?`
      )
      .all(sourceId) as Array<{
      event_id: string;
      end_date: string | null;
      end_utc: string | null;
    }>;

    for (const [id, { occurrence, memberIds }] of desired) {
      db.prepare(
        `INSERT INTO calendar_events
           (id, source, title, all_day, start_date, end_date, start_utc, end_utc, tzid, rrule, exdates, created_at, updated_at)
         VALUES (?, 'external', ?, ?, ?, ?, ?, ?, ?, NULL, '[]', ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title, all_day = excluded.all_day,
           start_date = excluded.start_date, end_date = excluded.end_date,
           start_utc = excluded.start_utc, end_utc = excluded.end_utc,
           tzid = excluded.tzid, updated_at = excluded.updated_at`
      ).run(
        id,
        occurrence.title,
        occurrence.allDay ? 1 : 0,
        occurrence.startDate ?? null,
        occurrence.endDate ?? null,
        occurrence.startUtc ?? null,
        occurrence.endUtc ?? null,
        occurrence.tzid ?? null,
        now,
        now
      );
      db.prepare(
        `INSERT INTO calendar_external_event_meta
           (event_id, source_id, external_uid, recurrence_id, description, location, status,
            raw_hash, source_updated_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(event_id) DO UPDATE SET
           description = excluded.description, location = excluded.location,
           status = excluded.status, raw_hash = excluded.raw_hash,
           source_updated_at = excluded.source_updated_at, updated_at = excluded.updated_at`
      ).run(
        id,
        sourceId,
        occurrence.externalUid,
        occurrence.recurrenceId,
        occurrence.description ?? null,
        occurrence.location ?? null,
        occurrence.status,
        occurrence.rawHash,
        occurrence.sourceUpdatedAt ? Date.parse(occurrence.sourceUpdatedAt) : null,
        now,
        now
      );

      replaceTitleAssignments(id, memberIds, now);
    }

    for (const row of existing) {
      if (!desired.has(row.event_id)) {
        db.prepare(
          "UPDATE calendar_external_event_meta SET status = 'cancelled', updated_at = ? WHERE event_id = ?"
        ).run(now, row.event_id);
        db.prepare("DELETE FROM calendar_assignments WHERE event_id = ? AND id LIKE 'ext:%'").run(
          row.event_id
        );
      }
    }

    const lowerBound = now - 30 * 86_400_000;
    const cancelled = db
      .prepare(
        `SELECT meta.event_id, events.end_date, events.end_utc
       FROM calendar_external_event_meta meta
       JOIN calendar_events events ON events.id = meta.event_id
       WHERE meta.source_id = ? AND meta.status = 'cancelled'`
      )
      .all(sourceId) as Array<{
      event_id: string;
      end_date: string | null;
      end_utc: string | null;
    }>;
    for (const row of cancelled) {
      if (expired(row, lowerBound))
        db.prepare("DELETE FROM calendar_events WHERE id = ?").run(row.event_id);
    }

    db.prepare(
      `UPDATE calendar_external_sources SET last_success_at = ?, last_error_code = NULL,
       consecutive_failures = 0, last_imported_count = ?, last_skipped_count = ?,
       etag = ?, last_modified = ?, content_hash = ?, updated_at = ? WHERE id = ?`
    ).run(
      now,
      parsed.occurrences.filter(({ status }) => status === "active").length,
      parsed.skippedCount,
      metadata.etag ?? null,
      metadata.lastModified ?? null,
      metadata.contentHash ?? null,
      now,
      sourceId
    );
  })();
}
