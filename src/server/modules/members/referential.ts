import { getDb } from "../../db/client";
import type { MemberDTO } from "../../../shared";
import { MEMBER_COLUMNS, memberFromRow, type MemberRow } from "./row";

export class MemberReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemberReferenceError";
  }
}

export function isActiveMember(id: string): boolean {
  return listActiveMembers().some((m) => m.id === id);
}

/** Lifecycle-agnostic existence check — true for both active and archived
 * members. Reads gate on existence, not active-status: an archived member's
 * historical rows stay readable (tolerant-read, DAILY-MESSAGES-FR-004/P2-B).
 */
export function memberExists(id: string): boolean {
  const db = getDb();
  const row = db.prepare("SELECT 1 FROM members WHERE id = ?").get(id);
  return row !== undefined;
}

export function assertActiveMember(id: string): void {
  if (!isActiveMember(id)) {
    throw new MemberReferenceError(`Member "${id}" is not active`);
  }
}

export function listActiveMembers(): MemberDTO[] {
  const rows = getDb()
    .prepare(
      `SELECT ${MEMBER_COLUMNS} FROM members WHERE lifecycle = 'active' ORDER BY created_at ASC`
    )
    .all() as MemberRow[];
  return rows.map(memberFromRow);
}

export function listActiveChildren(): MemberDTO[] {
  const rows = getDb()
    .prepare(
      `SELECT ${MEMBER_COLUMNS} FROM members WHERE role = 'child' AND lifecycle = 'active' ORDER BY created_at ASC`
    )
    .all() as MemberRow[];
  return rows.map(memberFromRow);
}
