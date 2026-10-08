import { randomUUID } from "node:crypto";
import { assertActiveMember, memberExists, isStrictCalendarDate, getDb } from "../../host-api";
import type { DailyMessage } from "../../../shared";

const MAX_TEXT_LEN = 500;
const MAX_WINDOW_DAYS = 60;

export class DailyMessageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DailyMessageValidationError";
  }
}

export class DailyMessageNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DailyMessageNotFoundError";
  }
}

type DailyMessageRow = {
  id: string;
  member_id: string;
  date: string;
  text: string;
  created_at: number;
  updated_at: number;
};

function rowToDailyMessage(row: DailyMessageRow): DailyMessage {
  return {
    id: row.id,
    memberId: row.member_id,
    date: row.date,
    text: row.text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Create or replace the message for (memberId, date) — upsert via
 * ON CONFLICT(member_id, date) DO UPDATE (DAILY-MESSAGES-INV-01/AC-01).
 * Strict-write: rejects an inactive/archived/unknown member
 * (DAILY-MESSAGES-AC-02/FR-004, reusing members/referential
 * assertActiveMember), a whitespace-only text (DAILY-MESSAGES-AC-03, trim
 * used only to check emptiness), and verbatim text over MAX_TEXT_LEN
 * (DAILY-MESSAGES-FR-005 — the cap is measured on the verbatim value,
 * never the trimmed copy, so cap-length content wrapped in surrounding
 * whitespace is rejected rather than truncated). The stored/returned text
 * is always the original verbatim value (DAILY-MESSAGES-AC-07).
 */
export function upsertMessage(memberId: string, date: string, text: string): DailyMessage {
  assertActiveMember(memberId);
  if (!isStrictCalendarDate(date)) {
    throw new DailyMessageValidationError(`Invalid date "${date}"; expected strict YYYY-MM-DD`);
  }
  if (typeof text !== "string") {
    throw new DailyMessageValidationError("Message text must be a string");
  }
  if (text.trim().length === 0) {
    throw new DailyMessageValidationError("Message text must not be blank");
  }
  if (text.length > MAX_TEXT_LEN) {
    throw new DailyMessageValidationError(`Message text exceeds ${MAX_TEXT_LEN} characters`);
  }

  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO daily_messages (id, member_id, date, text, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(member_id, date) DO UPDATE SET
       text = excluded.text,
       updated_at = MAX(excluded.updated_at, daily_messages.updated_at + 1)`
  ).run(randomUUID(), memberId, date, text, now, now);

  const row = db
    .prepare(
      "SELECT id, member_id, date, text, created_at, updated_at FROM daily_messages WHERE member_id = ? AND date = ?"
    )
    .get(memberId, date) as DailyMessageRow;

  return rowToDailyMessage(row);
}

function addDaysToDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** The current message for (memberId, date) — the outbound read Daily Briefing will consume,
 * computed LIVE every call (no stored snapshot). Tolerant read (DAILY-MESSAGES-INV-08/AC-04,
 * P2-B): gates on member EXISTENCE not active-status, so an archived member's historical row
 * stays readable — only a non-existent member throws.
 */
export function getMessage(memberId: string, date: string): DailyMessage | null {
  if (!isStrictCalendarDate(date)) {
    throw new DailyMessageValidationError(`Invalid date "${date}"; expected strict YYYY-MM-DD`);
  }
  if (!memberExists(memberId)) {
    throw new DailyMessageNotFoundError(`Member "${memberId}" does not exist`);
  }

  const db = getDb();
  const row = db
    .prepare(
      "SELECT id, member_id, date, text, created_at, updated_at FROM daily_messages WHERE member_id = ? AND date = ?"
    )
    .get(memberId, date) as DailyMessageRow | undefined;

  return row ? rowToDailyMessage(row) : null;
}

/** The window read (admin authoring surface) — date-ascending messages over the half-open
 * window `[from, from+days)`, missing dates absent (DAILY-MESSAGES-INV-08). `days` outside
 * `[1, MAX_WINDOW_DAYS]` rejects (DAILY-MESSAGES-AC-05). Tolerant read: gates on member
 * existence not active-status, same as `getMessage` (P2-B).
 */
export function listMessages(memberId: string, from: string, days: number): DailyMessage[] {
  if (!Number.isInteger(days) || days < 1 || days > MAX_WINDOW_DAYS) {
    throw new DailyMessageValidationError(`days must be an integer in [1, ${MAX_WINDOW_DAYS}]`);
  }
  if (!isStrictCalendarDate(from)) {
    throw new DailyMessageValidationError(`Invalid date "${from}"; expected strict YYYY-MM-DD`);
  }
  if (!memberExists(memberId)) {
    throw new DailyMessageNotFoundError(`Member "${memberId}" does not exist`);
  }

  const windowEnd = addDaysToDate(from, days);
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT id, member_id, date, text, created_at, updated_at FROM daily_messages WHERE member_id = ? AND date >= ? AND date < ? ORDER BY date ASC"
    )
    .all(memberId, from, windowEnd) as DailyMessageRow[];

  return rows.map(rowToDailyMessage);
}

/** Delete the message for (memberId, date) — a SEPARATE idempotent command, never implied by a
 * blank write (DAILY-MESSAGES-AC-03/FR-006). A missing message OR an unknown member is a no-op
 * success, never a 404. A malformed date still rejects 400 (DAILY-MESSAGES-INV-03 binds every
 * endpoint, including delete) — idempotency covers a valid-but-absent (member, date), not a
 * malformed one.
 */
export function deleteMessage(memberId: string, date: string): void {
  if (!isStrictCalendarDate(date)) {
    throw new DailyMessageValidationError(`Invalid date "${date}"; expected strict YYYY-MM-DD`);
  }
  const db = getDb();
  db.prepare("DELETE FROM daily_messages WHERE member_id = ? AND date = ?").run(memberId, date);
}
