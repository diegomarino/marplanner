/** "birthday" domain block ("The 21 block types", FR-013). PORTED
 * from v1 `apps/api/src/lib/daily-briefing/blocks/birthday.ts` (own + family members' upcoming
 * birthdays, leap-day Feb-29 -> Feb-28 substitution, no cap, sorted ascending by days-until).
 * v1 stored a full `YYYY-MM-DD` birth date string; v2's `MemberDTO.birthDate` shape is
 * `{month, day, year: number | null}` (year is optional — a household may not disclose it), so
 * the leap-day/next-occurrence math below is re-derived directly against `{month, day}` (pure
 * calendar-date arithmetic — a birthday's next occurrence never depends on the CURRENT clock's
 * timezone, only on the calendar date, so this is not FR-012 wall-clock/instant territory).
 * Same host-api gap as `./shotgun.ts`: enumerating every active member (to find their birthDate)
 * has no barrel export today (`modules/members/referential.ts`'s `listActiveMembers` exists but is
 * not re-exported through `src/server/host-api/index.ts`) — held behind the SAME-SHAPED
 * injectable port, `ctx.listActiveMembers`, for the same reason (see `./shotgun.ts`'s module doc
 * for the full rationale). `generate` returns `null` when the port is not supplied.
 * P1 fold addendum: `ownLabel` is a GENERATOR-emitted snapshot string ("HAPPY BIRTHDAY"
 * / "N days to your birthday") that renders VERBATIM on both paper (render/blocks/birthday.ts) and
 * the kiosk family view — DAILY-BRIEFING-INV-06 applies to it exactly as it does to the
 * render-only labels `../render/labels.ts` already covers, so it resolves through that SAME label
 * map at GENERATION time (frozen into the snapshot per INV-01).
 */
import { getLabels } from "../render/labels";

const TYPE = "birthday";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface BirthdayActiveMember {
  id: string;
  displayName: string;
  birthDate: { month: number; day: number; year: number | null } | null;
}

export interface BirthdayBlockContext {
  memberId: string;
  date: string;
  /** See the module doc above — the same host-api member-listing gap as `./shotgun.ts`. */
  listActiveMembers?: () => BirthdayActiveMember[];
  /** Household language for the `ownLabel` snapshot string (P1 fold addendum,
   * DAILY-BRIEFING-INV-06) — resolved by the caller (`index.ts`'s generator dispatch) via the same
   * settings read `../render/labels.ts#getLabels` documents. Optional — `getLabels` defaults to the
   * household's system-wide default ("en") when absent. */
  language?: string;
}

export interface BirthdayFamilyEntry {
  name: string;
  daysUntil: number;
}

export interface BirthdayBlockData {
  daysUntilOwn?: number;
  ownLabel?: string;
  family: BirthdayFamilyEntry[];
}

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Next UTC-anchored occurrence (epoch ms) of calendar `{month, day}` on/after `todayIso` — pure
 * Y-M-D arithmetic, substituting Feb-29 -> Feb-28 in a non-leap landing year (v1 parity). */
function nextOccurrenceMs(month: number, day: number, todayIso: string): number {
  const [ty, tm, td] = todayIso.split("-").map(Number);
  const todayUtc = Date.UTC(ty, tm - 1, td);
  const year = ty;
  const candidateDay = month === 2 && day === 29 && !isLeap(year) ? 28 : day;
  let candidate = Date.UTC(year, month - 1, candidateDay);
  if (candidate < todayUtc) {
    const nextYear = year + 1;
    const dayInNextYear = month === 2 && day === 29 && !isLeap(nextYear) ? 28 : day;
    candidate = Date.UTC(nextYear, month - 1, dayInNextYear);
  }
  return candidate;
}

function daysUntil(month: number, day: number, todayIso: string): number {
  const [ty, tm, td] = todayIso.split("-").map(Number);
  const todayUtc = Date.UTC(ty, tm - 1, td);
  return Math.round((nextOccurrenceMs(month, day, todayIso) - todayUtc) / MS_PER_DAY);
}

function stripEmojis(s: string): string {
  return s
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/️/g, "")
    .trim();
}

export const birthdayBlock = {
  type: TYPE,
  scope: "member" as const,
  source: "ctx.listActiveMembers (host-api member-listing gap, see module doc — same as shotgun)",
  generate(ctx: BirthdayBlockContext): BirthdayBlockData | null {
    if (!ctx.listActiveMembers) return null;
    const all = ctx.listActiveMembers();

    const own = all.find((m) => m.id === ctx.memberId);
    const ownBirth = own?.birthDate ?? null;
    const others = all.filter((m) => m.id !== ctx.memberId && m.birthDate !== null);
    if (!ownBirth && others.length === 0) return null;

    const data: BirthdayBlockData = { family: [] };

    if (ownBirth) {
      const days = daysUntil(ownBirth.month, ownBirth.day, ctx.date);
      const birthdayLabels = getLabels(ctx.language).birthday;
      data.daysUntilOwn = days;
      data.ownLabel = days === 0 ? birthdayLabels.happyBirthday : birthdayLabels.daysUntil(days);
    }

    // No cap: surfacing every active family member's next birthday is the design (v1 parity
    // rationale) — sorted ascending by daysUntil.
    data.family = others
      .map((m) => {
        const birth = m.birthDate as { month: number; day: number; year: number | null };
        return {
          name: stripEmojis(m.displayName),
          daysUntil: daysUntil(birth.month, birth.day, ctx.date),
        };
      })
      .sort((a, b) => a.daysUntil - b.daysUntil);

    return data;
  },
};
