import { randomUUID } from "node:crypto";
import { z } from "zod";
import { MEMBER_COLOR_KEYS, chooseMemberColorKey } from "../../../shared/member-color";
import { parseCelebration, type MemberCelebration } from "../../../shared/celebration";
import { getDb } from "../../db/client";
import type { MemberDTO, MemberColorKey } from "../../../shared";
import { listActiveMembers } from "./referential";
import { parseBirthDate } from "./birthdate";
import { MEMBER_COLUMNS, celebrationColumns, memberFromRow, type MemberRow } from "./row";

export { listActiveMembers } from "./referential";

function readMemberRow(id: string): MemberRow | undefined {
  return getDb().prepare(`SELECT ${MEMBER_COLUMNS} FROM members WHERE id = ?`).get(id) as
    MemberRow | undefined;
}

/** Archive a member: set lifecycle = 'archived' and bump updated_at.
 * True idempotent no-op: if already archived, do NOT update (no updated_at change).
 * Never deletes the row (Principle VI, MEMBERS-INV-04).
 * @returns {MemberDTO} The current member state.
 * @throws MemberNotFoundError if the member doesn't exist.
 */
export function archiveMember(id: string): MemberDTO {
  const row = readMemberRow(id);
  if (!row) {
    throw new MemberNotFoundError(id);
  }

  // If already archived, return current state (true idempotent no-op)
  if (row.lifecycle === "archived") {
    return memberFromRow(row);
  }

  const now = Date.now();
  getDb()
    .prepare("UPDATE members SET lifecycle = 'archived', updated_at = ? WHERE id = ?")
    .run(now, id);

  return memberFromRow({ ...row, lifecycle: "archived", updated_at: now });
}

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

/** Restore an archived member: set lifecycle = 'active' and bump updated_at.
 * True idempotent no-op: if already active, do NOT update (no updated_at change).
 * Never deletes the row (Principle VI, MEMBERS-INV-04).
 * @returns {MemberDTO} The current member state.
 * @throws MemberNotFoundError if the member doesn't exist.
 */
export function restoreMember(id: string): MemberDTO {
  const db = getDb();
  const row = readMemberRow(id);
  if (!row) {
    throw new MemberNotFoundError(id);
  }

  // If already active, return current state (true idempotent no-op)
  if (row.lifecycle === "active") {
    return memberFromRow(row);
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

  return memberFromRow({ ...row, lifecycle: "active", color_key: colorKey, updated_at: now });
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

/** The shared celebration rule, as a zod field so it reports through the same error path. */
const celebrationField = z.unknown().transform((value, ctx): MemberCelebration => {
  const parsed = parseCelebration(value);
  if (parsed.ok) return parsed.value;
  ctx.addIssue({ code: "custom", message: parsed.message });
  return z.NEVER;
});

/** Edit an existing member's displayName, role, colorKey, birthDate and/or celebration.
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
    celebration?: unknown;
  }
): MemberDTO {
  const parsed = editMemberSchema.safeParse(patch);

  if (!parsed.success) {
    throw new MemberValidationError(parsed.error.message);
  }

  const { displayName, role, birthDate, colorKey, celebration } = parsed.data;

  // Reject patch with no fields to update
  if (
    displayName === undefined &&
    role === undefined &&
    birthDate === undefined &&
    colorKey === undefined &&
    celebration === undefined
  ) {
    throw new MemberValidationError(
      "Edit request must include at least one field to update (displayName, role, birthDate, colorKey, or celebration)."
    );
  }

  const row = readMemberRow(id);
  if (!row) {
    throw new MemberNotFoundError(id);
  }

  // Keeping one's own colour is always allowed, and an archived member reserves nothing.
  if (colorKey !== undefined && colorKey !== row.color_key && row.lifecycle === "active") {
    assertColorAvailable(colorKey, id);
  }

  const now = Date.now();
  let birthMonth = row.birth_month;
  let birthDay = row.birth_day;
  let birthYear = row.birth_year;
  if (birthDate === null) {
    birthMonth = null;
    birthDay = null;
    birthYear = null;
  } else if (birthDate !== undefined) {
    birthMonth = birthDate.month;
    birthDay = birthDate.day;
    birthYear = birthDate.year ?? null;
  }
  if (birthMonth === null || birthDay === null) {
    birthMonth = null;
    birthDay = null;
    birthYear = null;
  }
  const stored = celebration
    ? celebrationColumns(celebration)
    : { preset: row.celebration_preset, emojis: row.celebration_emojis };

  const next: MemberRow = {
    ...row,
    display_name: displayName ?? row.display_name,
    role: role ?? row.role,
    color_key: colorKey ?? row.color_key,
    birth_month: birthMonth,
    birth_day: birthDay,
    birth_year: birthYear,
    celebration_preset: stored.preset,
    celebration_emojis: stored.emojis,
    updated_at: now,
  };

  getDb()
    .prepare(
      "UPDATE members SET display_name = ?, role = ?, color_key = ?, birth_month = ?, birth_day = ?, birth_year = ?, celebration_preset = ?, celebration_emojis = ?, updated_at = ? WHERE id = ?"
    )
    .run(
      next.display_name,
      next.role,
      next.color_key,
      next.birth_month,
      next.birth_day,
      next.birth_year,
      next.celebration_preset,
      next.celebration_emojis,
      now,
      id
    );

  return memberFromRow(next);
}

const createMemberSchema = z.object({
  displayName: z.string().trim().min(1),
  role: z.enum(["parent", "child"]),
  birthDate: parseBirthDate.optional(),
  colorKey: z.enum(MEMBER_COLOR_KEYS).optional(),
  celebration: celebrationField.optional(),
});

const editMemberSchema = z.object({
  displayName: z.string().trim().min(1).optional(),
  role: z.enum(["parent", "child"]).optional(),
  birthDate: parseBirthDate.optional().nullable(),
  colorKey: z.enum(MEMBER_COLOR_KEYS).optional(),
  celebration: celebrationField.optional(),
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
  const celebration = celebrationColumns(parsed.data.celebration ?? { preset: "confetti" });

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
        "INSERT INTO members (id, display_name, color_key, role, lifecycle, birth_month, birth_day, birth_year, celebration_preset, celebration_emojis, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        id,
        displayName,
        assigned,
        role,
        birthDate?.month ?? null,
        birthDate?.day ?? null,
        birthDate?.year ?? null,
        celebration.preset,
        celebration.emojis,
        now,
        now
      );
      return assigned;
    })
    .immediate();

  return memberFromRow({
    id,
    display_name: displayName,
    color_key: colorKey,
    role,
    lifecycle: "active",
    birth_month: birthDate?.month ?? null,
    birth_day: birthDate?.day ?? null,
    birth_year: birthDate?.year ?? null,
    celebration_preset: celebration.preset,
    celebration_emojis: celebration.emojis,
    created_at: now,
    updated_at: now,
  });
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
  const rows = getDb()
    .prepare(
      `SELECT ${MEMBER_COLUMNS} FROM members WHERE lifecycle = 'archived' ORDER BY created_at ASC`
    )
    .all() as MemberRow[];
  return rows.map(memberFromRow);
}

/** List all members regardless of lifecycle (active + archived).
 */
export function listAllMembers(): MemberDTO[] {
  const rows = getDb()
    .prepare(
      `SELECT ${MEMBER_COLUMNS} FROM members WHERE lifecycle IN ('active', 'archived') ORDER BY created_at ASC`
    )
    .all() as MemberRow[];
  return rows.map(memberFromRow);
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
