import type { MemberColorKey } from "../src/shared";
import type { SeedModule } from "../src/server/db/seeds/types";

type DemoMember = {
  id: string;
  displayName: string;
  role: "parent" | "child";
  colorKey: MemberColorKey;
  birthDate: { month: number; day: number; year: number | null };
};

const CANONICAL_MEMBERS: readonly DemoMember[] = [
  {
    id: "demo:member:homer",
    displayName: "Homer",
    role: "parent",
    colorKey: "blue",
    birthDate: { month: 5, day: 12, year: null },
  },
  {
    id: "demo:member:marge",
    displayName: "Marge",
    role: "parent",
    colorKey: "sky",
    birthDate: { month: 5, day: 19, year: null },
  },
  {
    id: "demo:member:bart",
    displayName: "Bart",
    role: "child",
    colorKey: "red",
    birthDate: { month: 2, day: 23, year: null },
  },
  {
    id: "demo:member:lisa",
    displayName: "Lisa",
    role: "child",
    colorKey: "violet",
    birthDate: { month: 5, day: 9, year: null },
  },
  {
    id: "demo:member:maggie",
    displayName: "Maggie",
    role: "child",
    colorKey: "cyan",
    birthDate: { month: 1, day: 12, year: null },
  },
];

const seedMembers: SeedModule = {
  id: "members:demo",
  run({ db, nowMs }) {
    const upsert = db.prepare(
      `INSERT INTO members
        (id, display_name, color_key, role, lifecycle, birth_month, birth_day, birth_year, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         display_name = excluded.display_name,
         color_key = excluded.color_key,
         role = excluded.role,
         lifecycle = excluded.lifecycle,
         birth_month = excluded.birth_month,
         birth_day = excluded.birth_day,
         birth_year = excluded.birth_year,
         updated_at = excluded.updated_at
       WHERE display_name IS NOT excluded.display_name
          OR color_key IS NOT excluded.color_key
          OR role IS NOT excluded.role
          OR lifecycle IS NOT excluded.lifecycle
          OR birth_month IS NOT excluded.birth_month
          OR birth_day IS NOT excluded.birth_day
          OR birth_year IS NOT excluded.birth_year`
    );

    for (const member of CANONICAL_MEMBERS) {
      upsert.run(
        member.id,
        member.displayName,
        member.colorKey,
        member.role,
        member.birthDate.month,
        member.birthDate.day,
        member.birthDate.year,
        nowMs,
        nowMs
      );
    }
  },
};

export default seedMembers;
