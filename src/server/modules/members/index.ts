import { randomUUID } from "node:crypto";
import { z } from "zod";
import { MEMBER_COLOR_KEYS, chooseMemberColorKey } from "../../../shared/member-color";
import { getDb } from "../../db/client";
import type { MemberDTO, MemberColorKey, Role } from "../../../shared";
import { listActiveMembers } from "./referential";
import { parseBirthDate } from "./birthdate";

export { listActiveMembers } from "./referential";

/** Archive a member: set lifecycle = 'archived' and bump updated_at.
 * True idempotent no-op: if already archived, do NOT update (no updated_at change).
 * Never deletes the row (Principle VI, MEMBERS-INV-04).
 * @returns {MemberDTO} The current member state (id, displayName, role, lifecycle, birthDate, createdAt, updatedAt).
 * @throws MemberNotFoundError if the member doesn't exist.
 */
export function archiveMember(id: string): MemberDTO {
  const db = getDb();

  // Fetch current member
  const row = db
    .prepare(
      "SELECT id, display_name, color_key, role, lifecycle, birth_month, birth_day, birth_year, created_at, updated_at FROM members WHERE id = ?"
    )
    .get(id) as
    | {
        id: string;
        display_name: string;
        color_key: MemberColorKey;
        role: string;
        lifecycle: string;
        birth_month: number | null;
        birth_day: number | null;
        birth_year: number | null;
        created_at: number;
        updated_at: number;
      }
    | undefined;

  if (!row) {
    throw new MemberNotFoundError(id);
  }

  // If already archived, return current state (true idempotent no-op)
  if (row.lifecycle === "archived") {
    return {
      id: row.id,
      displayName: row.display_name,
      colorKey: row.color_key,
      role: row.role as Role,
      lifecycle: row.lifecycle as MemberDTO["lifecycle"],
      birthDate:
        row.birth_month !== null && row.birth_day !== null
          ? { month: row.birth_month, day: row.birth_day, year: row.birth_year }
          : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // Update lifecycle to archived and bump updated_at
  const now = Date.now();
  db.prepare("UPDATE members SET lifecycle = 'archived', updated_at = ? WHERE id = ?").run(now, id);

  return {
    id: row.id,
    displayName: row.display_name,
    colorKey: row.color_key,
    role: row.role as Role,
    lifecycle: "archived" as MemberDTO["lifecycle"],
    birthDate:
      row.birth_month !== null && row.birth_day !== null
        ? { month: row.birth_month, day: row.birth_day, year: row.birth_year }
        : null,
    createdAt: row.created_at,
    updatedAt: now,
  };
}

/** Restore an archived member: set lifecycle = 'active' and bump updated_at.
 * True idempotent no-op: if already active, do NOT update (no updated_at change).
 * Never deletes the row (Principle VI, MEMBERS-INV-04).
 * @returns {MemberDTO} The current member state (id, displayName, role, lifecycle, birthDate, createdAt, updatedAt).
 * @throws MemberNotFoundError if the member doesn't exist.
 */
/** Colours held by active members, optionally leaving one member out. Archived members hold
 * none.
 */
function activeColorKeys(exceptId?: string): MemberColorKey[] {
  return (
    getDb().prepare("SELECT id, color_key FROM members WHERE lifecycle = 'active'").all() as {
      id: string;
      color_key: MemberColorKey;
    }[]
  )
    .filter((row) => row.id !== exceptId)
    .map((row) => row.color_key);
}

/** An explicit colour must be free while any colour still is. Once every colour is held a
 * repeat is unavoidable, so any colour is accepted again.
 */
function assertColorAvailable(colorKey: MemberColorKey, exceptId?: string): void {
  const held = new Set(activeColorKeys(exceptId));
  if (!held.has(colorKey)) return;
  if (MEMBER_COLOR_KEYS.every((key) => held.has(key))) return;
  throw new MemberValidationError(`Colour "${colorKey}" is already used by another active member.`);
}

export function restoreMember(id: string): MemberDTO {
  const db = getDb();

  // Fetch current member
  const row = db
    .prepare(
      "SELECT id, display_name, color_key, role, lifecycle, birth_month, birth_day, birth_year, created_at, updated_at FROM members WHERE id = ?"
    )
    .get(id) as
    | {
        id: string;
        display_name: string;
        color_key: MemberColorKey;
        role: string;
        lifecycle: string;
        birth_month: number | null;
        birth_day: number | null;
        birth_year: number | null;
        created_at: number;
        updated_at: number;
      }
    | undefined;

  if (!row) {
    throw new MemberNotFoundError(id);
  }

  // If already active, return current state (true idempotent no-op)
  if (row.lifecycle === "active") {
    return {
      id: row.id,
      displayName: row.display_name,
      colorKey: row.color_key,
      role: row.role as Role,
      lifecycle: row.lifecycle as MemberDTO["lifecycle"],
      birthDate:
        row.birth_month !== null && row.birth_day !== null
          ? { month: row.birth_month, day: row.birth_day, year: row.birth_year }
          : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // An archived member holds no colour, so someone may have taken theirs meanwhile. They come
  // back with it if it is still free, and with the first free colour otherwise.
  const now = Date.now();
  const colorKey = db
    .transaction(() => {
      const held = activeColorKeys(id);
      const restored = held.includes(row.color_key) ? chooseMemberColorKey(held) : row.color_key;
      db.prepare(
        "UPDATE members SET lifecycle = 'active', color_key = ?, updated_at = ? WHERE id = ?"
      ).run(restored, now, id);
      return restored;
    })
    .immediate();

  return {
    id: row.id,
    displayName: row.display_name,
    colorKey,
    role: row.role as Role,
    lifecycle: "active" as MemberDTO["lifecycle"],
    birthDate:
      row.birth_month !== null && row.birth_day !== null
        ? { month: row.birth_month, day: row.birth_day, year: row.birth_year }
        : null,
    createdAt: row.created_at,
    updatedAt: now,
  };
}

/** Error thrown when a member reference is not found.
 */
export class MemberNotFoundError extends Error {
  constructor(id: string) {
    super(`Member not found: ${id}`);
    this.name = "MemberNotFoundError";
  }
}

/** Validation error — thrown by createMember when input fails Zod validation
 * so the route can map it to HTTP 400.
 */
export class MemberValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemberValidationError";
  }
}

/** Edit an existing member's displayName, role, and/or birthDate.
 * - ABSENT field: leaves the existing value unchanged.
 * - PRESENT field: updates to new value.
 * - birthDate:null: explicitly clears the birth date.
 * @returns {MemberDTO} The updated member state.
 * @throws MemberNotFoundError if the member doesn't exist.
 */
export function editMember(
  id: string,
  patch: {
    displayName?: string;
    role?: "parent" | "child";
    colorKey?: MemberColorKey;
    birthDate?: typeof parseBirthDate._output | null;
  }
): MemberDTO {
  const parsed = editMemberSchema.safeParse(patch);

  if (!parsed.success) {
    throw new MemberValidationError(parsed.error.message);
  }

  const { displayName, role, birthDate, colorKey } = parsed.data;

  // Reject patch with no fields to update
  if (
    displayName === undefined &&
    role === undefined &&
    birthDate === undefined &&
    colorKey === undefined
  ) {
    throw new MemberValidationError(
      "Edit request must include at least one field to update (displayName, role, birthDate, or colorKey)."
    );
  }

  const db = getDb();

  // Fetch current member
  const row = db
    .prepare(
      "SELECT id, display_name, color_key, role, lifecycle, birth_month, birth_day, birth_year, created_at, updated_at FROM members WHERE id = ?"
    )
    .get(id) as
    | {
        id: string;
        display_name: string;
        color_key: MemberColorKey;
        role: string;
        lifecycle: string;
        birth_month: number | null;
        birth_day: number | null;
        birth_year: number | null;
        created_at: number;
        updated_at: number;
      }
    | undefined;

  if (!row) {
    throw new MemberNotFoundError(id);
  }

  // Keeping one's own colour is always allowed, and an archived member reserves nothing.
  if (colorKey !== undefined && colorKey !== row.color_key && row.lifecycle === "active") {
    assertColorAvailable(colorKey, id);
  }

  const now = Date.now();

  const displayNameOut = displayName ?? row.display_name;
  const roleOut: Role = (role ?? row.role) as Role;
  let birthMonth: number | null;
  let birthDay: number | null;
  let birthYear: number | null;

  if (birthDate === undefined) {
    birthMonth = row.birth_month;
    birthDay = row.birth_day;
    birthYear = row.birth_year;
  } else if (birthDate === null) {
    birthMonth = null;
    birthDay = null;
    birthYear = null;
  } else {
    birthMonth = birthDate.month;
    birthDay = birthDate.day;
    birthYear = birthDate.year ?? null;
  }

  if (birthMonth === null || birthDay === null) {
    db.prepare(
      "UPDATE members SET display_name = ?, role = ?, color_key = ?, birth_month = NULL, birth_day = NULL, birth_year = NULL, updated_at = ? WHERE id = ?"
    ).run(displayNameOut, roleOut, colorKey ?? row.color_key, now, id);
  } else {
    db.prepare(
      "UPDATE members SET display_name = ?, role = ?, color_key = ?, birth_month = ?, birth_day = ?, birth_year = ?, updated_at = ? WHERE id = ?"
    ).run(
      displayNameOut,
      roleOut,
      colorKey ?? row.color_key,
      birthMonth,
      birthDay,
      birthYear,
      now,
      id
    );
  }

  return {
    id: row.id,
    displayName: displayNameOut,
    colorKey: colorKey ?? row.color_key,
    role: roleOut,
    lifecycle: row.lifecycle as MemberDTO["lifecycle"],
    birthDate:
      birthMonth !== null && birthDay !== null
        ? { month: birthMonth, day: birthDay, year: birthYear }
        : null,
    createdAt: row.created_at,
    updatedAt: now,
  };
}

const createMemberSchema = z.object({
  displayName: z.string().trim().min(1),
  role: z.enum(["parent", "child"]),
  birthDate: parseBirthDate.optional(),
  colorKey: z.enum(MEMBER_COLOR_KEYS).optional(),
});

const editMemberSchema = z.object({
  displayName: z.string().trim().min(1).optional(),
  role: z.enum(["parent", "child"]).optional(),
  birthDate: parseBirthDate.optional().nullable(),
  colorKey: z.enum(MEMBER_COLOR_KEYS).optional(),
});

/** Validate member input and create exactly ONE members row in a single
 * transaction. Role `admin` or any unknown role is rejected by the Zod
 * schema. Blank display names are rejected by the `.trim.min(1)` chain.
 * Writes nothing else (no Daily Briefing rows/config — FR-022/023).
 * Returns the created MemberDTO shape matching the Member schema.
 */
export async function createMember(input: unknown): Promise<MemberDTO> {
  const parsed = createMemberSchema.safeParse(input);

  if (!parsed.success) {
    throw new MemberValidationError(parsed.error.message);
  }

  const { displayName, role, birthDate } = parsed.data;

  const id = randomUUID();
  const now = Date.now();

  const db = getDb();

  // Assignment and insert share one write transaction, so another writer cannot
  // reserve a key between the active-member read and this primary write.
  const colorKey = db
    .transaction(() => {
      const activeKeys = db
        .prepare("SELECT color_key FROM members WHERE lifecycle = 'active'")
        .all() as { color_key: MemberColorKey }[];
      if (parsed.data.colorKey) assertColorAvailable(parsed.data.colorKey);
      const assigned =
        parsed.data.colorKey ?? chooseMemberColorKey(activeKeys.map((row) => row.color_key));
      db.prepare(
        "INSERT INTO members (id, display_name, color_key, role, lifecycle, birth_month, birth_day, birth_year, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)"
      ).run(
        id,
        displayName,
        assigned,
        role,
        birthDate?.month ?? null,
        birthDate?.day ?? null,
        birthDate?.year ?? null,
        now,
        now
      );
      return assigned;
    })
    .immediate();

  return {
    id,
    displayName,
    colorKey,
    role: role as Role,
    lifecycle: "active",
    birthDate:
      birthDate === undefined || birthDate === null
        ? null
        : { month: birthDate.month, day: birthDate.day, year: birthDate.year ?? null },
    createdAt: now,
    updatedAt: now,
  };
}

/** List active members only (delegates to listActiveMembers — docs/features/auth-sessions.md SC-003 re-read).
 * Full member management (filters, pagination, archive) remains in the Members slice.
 */
export function listMembers(): MemberDTO[] {
  return listActiveMembers();
}

/** List only archived members.
 */
export function listArchivedMembers(): MemberDTO[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT id, display_name, color_key, role, lifecycle, created_at, updated_at, birth_month, birth_day, birth_year FROM members WHERE lifecycle = 'archived' ORDER BY created_at ASC"
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

/** List all members regardless of lifecycle (active + archived).
 */
export function listAllMembers(): MemberDTO[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT id, display_name, color_key, role, lifecycle, created_at, updated_at, birth_month, birth_day, birth_year FROM members WHERE lifecycle IN ('active', 'archived') ORDER BY created_at ASC"
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

/** Lifecycle-aware listMembers with optional lifecycle filter.
 * - No query or ?lifecycle=active -> active only via listMembers
 * - ?lifecycle=archived -> archived only via listArchivedMembers
 * - ?lifecycle=all -> both via listAllMembers
 * Unknown lifecycle value throws MemberValidationError (mapped to 400 by route).
 */
export function listMembersWithLifecycle(lifecycleFilter?: string): MemberDTO[] {
  if (lifecycleFilter === undefined || lifecycleFilter === "active") {
    return listMembers();
  }

  if (lifecycleFilter === "archived") {
    return listArchivedMembers();
  }

  if (lifecycleFilter === "all") {
    return listAllMembers();
  }

  throw new MemberValidationError(
    `Invalid lifecycle filter "${lifecycleFilter}". Valid values: "active", "archived", "all".`
  );
}
