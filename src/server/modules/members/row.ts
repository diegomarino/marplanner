import type { MemberColorKey, MemberDTO, Role } from "../../../shared";
import {
  DEFAULT_CELEBRATION,
  parseCelebration,
  type MemberCelebration,
} from "../../../shared/celebration";

/** The `members` columns every member read selects, in `MemberRow` order. */
export const MEMBER_COLUMNS =
  "id, display_name, color_key, role, lifecycle, birth_month, birth_day, birth_year, celebration_preset, celebration_emojis, created_at, updated_at";

export interface MemberRow {
  id: string;
  display_name: string;
  color_key: MemberColorKey;
  role: string;
  lifecycle: string;
  birth_month: number | null;
  birth_day: number | null;
  birth_year: number | null;
  celebration_preset: string;
  celebration_emojis: string | null;
  created_at: number;
  updated_at: number;
}

/** Read the stored celebration back. The CHECKs keep the columns consistent and the JSON valid;
 * anything that still fails validation (e.g. an emoji the shared rule no longer accepts) reads as
 * the default rather than breaking every member list.
 */
export function celebrationFromRow(
  row: Pick<MemberRow, "celebration_preset" | "celebration_emojis">
): MemberCelebration {
  const parsed = parseCelebration(
    row.celebration_emojis === null
      ? { preset: row.celebration_preset }
      : { preset: row.celebration_preset, emojis: JSON.parse(row.celebration_emojis) as unknown }
  );
  return parsed.ok ? parsed.value : DEFAULT_CELEBRATION;
}

/** The two column values a celebration is stored as. */
export function celebrationColumns(celebration: MemberCelebration): {
  preset: string;
  emojis: string | null;
} {
  return {
    preset: celebration.preset,
    emojis: celebration.preset === "custom" ? JSON.stringify(celebration.emojis) : null,
  };
}

export function memberFromRow(row: MemberRow): MemberDTO {
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
    celebration: celebrationFromRow(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
