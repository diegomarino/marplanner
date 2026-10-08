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

function assignedMembers(
  title: string,
  members: Array<{ id: string; displayName: string }>
): string[] {
  const words = title
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u);
  return members
    .filter(({ displayName }) => {
      const nameWords = displayName
        .normalize("NFD")
        .replace(/\p{M}/gu, "")
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean);
      return nameWords.length > 0 && nameWords.every((word) => words.includes(word));
    })
    .map(({ id }) => id);
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
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE calendar_external_sources SET last_success_at = ?, last_error_code = NULL,
       consecutive_failures = 0, etag = COALESCE(?, etag),
       last_modified = COALESCE(?, last_modified), content_hash = COALESCE(?, content_hash),
       updated_at = ? WHERE id = ?`
    )
    .run(
      now,
      metadata.etag ?? null,
      metadata.lastModified ?? null,
      metadata.contentHash ?? null,
      now,
      sourceId
    );
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

      db.prepare("DELETE FROM calendar_assignments WHERE event_id = ? AND id LIKE 'ext:%'").run(id);
      for (const memberId of memberIds) {
        // Manual (non-ext:) assignments from PUT /assignments survive title-derived refresh.
        // Skip re-insert when any row already claims this member to avoid UNIQUE(event_id, member_id).
        const alreadyAssigned = db
          .prepare("SELECT 1 AS ok FROM calendar_assignments WHERE event_id = ? AND member_id = ?")
          .get(id, memberId) as { ok: number } | undefined;
        if (alreadyAssigned) continue;
        db.prepare(
          "INSERT INTO calendar_assignments (id, event_id, member_id, created_at) VALUES (?, ?, ?, ?)"
        ).run(`ext:${id}:${memberId}`, id, memberId, now);
      }
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
