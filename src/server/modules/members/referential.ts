import { getDb } from "../../db/client";
import type { MemberDTO, MemberColorKey, Role } from "../../../shared";

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
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT id, display_name, color_key, role, lifecycle, created_at, updated_at, birth_month, birth_day, birth_year FROM members WHERE lifecycle = 'active' ORDER BY created_at ASC"
    )
    .all() as Array<{
    id: string;
    display_name: string;
    color_key: MemberColorKey;
    role: string;
    lifecycle: string;
    created_at: number;
    updated_at: number;
    birth_month: number | null;
    birth_day: number | null;
    birth_year: number | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    displayName: r.display_name,
    colorKey: r.color_key,
    role: r.role as Role,
    lifecycle: r.lifecycle as MemberDTO["lifecycle"],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    birthDate:
      r.birth_month !== null && r.birth_day !== null
        ? { month: r.birth_month, day: r.birth_day, year: r.birth_year }
        : null,
  }));
}

export function listActiveChildren(): MemberDTO[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT id, display_name, color_key, role, lifecycle, created_at, updated_at, birth_month, birth_day, birth_year FROM members WHERE role = 'child' AND lifecycle = 'active' ORDER BY created_at ASC"
    )
    .all() as Array<{
    id: string;
    display_name: string;
    color_key: MemberColorKey;
    role: string;
    lifecycle: string;
    created_at: number;
    updated_at: number;
    birth_month: number | null;
    birth_day: number | null;
    birth_year: number | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    displayName: r.display_name,
    colorKey: r.color_key,
    role: r.role as Role,
    lifecycle: r.lifecycle as MemberDTO["lifecycle"],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    birthDate:
      r.birth_month !== null && r.birth_day !== null
        ? { month: r.birth_month, day: r.birth_day, year: r.birth_year }
        : null,
  }));
}
