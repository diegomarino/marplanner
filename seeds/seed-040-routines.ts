import {
  CANONICAL_WEEKDAY_ORDER,
  validateWeekdays,
  type WeekdayCode,
} from "../src/shared/weekdays";
import type { SeedModule } from "../src/server/db/seeds/types";
import { readWeekStartDay } from "../src/server/lib/household-date";

const MON_TO_FRI = ["mon", "tue", "wed", "thu", "fri"] as const;
const EVERY_DAY = CANONICAL_WEEKDAY_ORDER;
const SCHOOL_NIGHTS = ["mon", "tue", "wed", "thu", "sun"] as const;
const WEEKEND = ["sat", "sun"] as const;

const ROUTINES = [
  { id: "demo:routine:morning-launch", name: "Morning launch", dayPeriodId: "morning" },
  { id: "demo:routine:after-school", name: "After school", dayPeriodId: "afternoon" },
  { id: "demo:routine:evening-reset", name: "Evening reset", dayPeriodId: "evening" },
  { id: "demo:routine:maggie-morning", name: "Maggie's morning", dayPeriodId: "morning" },
  { id: "demo:routine:weekend-chores", name: "Weekend chores", dayPeriodId: "morning" },
  { id: "demo:routine:music-practice", name: "Music practice", dayPeriodId: "afternoon" },
  { id: "demo:routine:bedtime", name: "Bedtime", dayPeriodId: "night" },
] as const;

const CHORES = [
  {
    id: "demo:chore:morning-launch:make-bed",
    routineId: "demo:routine:morning-launch",
    name: "Make bed",
    icon: "🛏️",
    sortOrder: 0,
  },
  {
    id: "demo:chore:morning-launch:pack-backpack",
    routineId: "demo:routine:morning-launch",
    name: "Pack backpack",
    icon: "🎒",
    sortOrder: 1,
  },
  {
    id: "demo:chore:morning-launch:brush-teeth",
    routineId: "demo:routine:morning-launch",
    name: "Brush teeth",
    icon: "🪥",
    sortOrder: 2,
  },
  {
    id: "demo:chore:evening-reset:set-table",
    routineId: "demo:routine:evening-reset",
    name: "Set the table",
    icon: "🍽️",
    sortOrder: 0,
  },
  {
    id: "demo:chore:evening-reset:feed-snowball-ii",
    routineId: "demo:routine:evening-reset",
    name: "Feed Snowball II",
    icon: "🐈",
    sortOrder: 1,
  },
  {
    id: "demo:chore:evening-reset:shower",
    routineId: "demo:routine:evening-reset",
    name: "Take a shower",
    icon: "🚿",
    sortOrder: 2,
  },
  {
    id: "demo:chore:after-school:snack",
    routineId: "demo:routine:after-school",
    name: "Have a snack",
    icon: "🍎",
    sortOrder: 0,
  },
  {
    id: "demo:chore:after-school:homework",
    routineId: "demo:routine:after-school",
    name: "Homework",
    icon: "📚",
    sortOrder: 1,
  },
  {
    id: "demo:chore:after-school:water-plants",
    routineId: "demo:routine:after-school",
    name: "Water the plants",
    icon: "🪴",
    sortOrder: 2,
  },
  {
    id: "demo:chore:maggie-morning:bottle",
    routineId: "demo:routine:maggie-morning",
    name: "Morning bottle",
    icon: "🥛",
    sortOrder: 0,
  },
  {
    id: "demo:chore:maggie-morning:get-dressed",
    routineId: "demo:routine:maggie-morning",
    name: "Get dressed",
    icon: "👕",
    sortOrder: 1,
  },
  {
    id: "demo:chore:maggie-morning:playtime",
    routineId: "demo:routine:maggie-morning",
    name: "Playtime with teddy",
    icon: "🧸",
    sortOrder: 2,
  },
  {
    id: "demo:chore:weekend-chores:tidy-room",
    routineId: "demo:routine:weekend-chores",
    name: "Tidy your room",
    icon: "🧹",
    sortOrder: 0,
  },
  {
    id: "demo:chore:weekend-chores:fold-laundry",
    routineId: "demo:routine:weekend-chores",
    name: "Fold your laundry",
    icon: "🧺",
    sortOrder: 1,
  },
  {
    id: "demo:chore:weekend-chores:wash-car",
    routineId: "demo:routine:weekend-chores",
    name: "Help wash the car",
    icon: "🚗",
    sortOrder: 2,
  },
  {
    id: "demo:chore:music-practice:saxophone-scales",
    routineId: "demo:routine:music-practice",
    name: "Saxophone scales",
    icon: "🎵",
    sortOrder: 0,
  },
  {
    id: "demo:chore:music-practice:new-song",
    routineId: "demo:routine:music-practice",
    name: "Learn a new song",
    icon: "🎼",
    sortOrder: 1,
  },
  {
    id: "demo:chore:bedtime:pajamas",
    routineId: "demo:routine:bedtime",
    name: "Put on pajamas",
    icon: "👘",
    sortOrder: 0,
  },
  {
    id: "demo:chore:bedtime:story",
    routineId: "demo:routine:bedtime",
    name: "Bedtime story",
    icon: "📖",
    sortOrder: 1,
  },
  {
    id: "demo:chore:bedtime:lights-out",
    routineId: "demo:routine:bedtime",
    name: "Lights out",
    icon: "😴",
    sortOrder: 2,
  },
] as const;

type SeedAssignment = {
  id: string;
  routineId: string;
  memberId: string;
  weekdays: readonly WeekdayCode[];
};

const ASSIGNMENTS: readonly SeedAssignment[] = [
  {
    id: "demo:routine-assignment:morning-launch:bart",
    routineId: "demo:routine:morning-launch",
    memberId: "demo:member:bart",
    weekdays: MON_TO_FRI,
  },
  {
    id: "demo:routine-assignment:morning-launch:lisa",
    routineId: "demo:routine:morning-launch",
    memberId: "demo:member:lisa",
    weekdays: MON_TO_FRI,
  },
  {
    id: "demo:routine-assignment:evening-reset:bart",
    routineId: "demo:routine:evening-reset",
    memberId: "demo:member:bart",
    weekdays: MON_TO_FRI,
  },
  {
    id: "demo:routine-assignment:evening-reset:lisa",
    routineId: "demo:routine:evening-reset",
    memberId: "demo:member:lisa",
    weekdays: MON_TO_FRI,
  },
  {
    id: "demo:routine-assignment:after-school:lisa",
    routineId: "demo:routine:after-school",
    memberId: "demo:member:lisa",
    weekdays: ["mon", "tue", "wed", "thu"],
  },
  {
    id: "demo:routine-assignment:after-school:bart",
    routineId: "demo:routine:after-school",
    memberId: "demo:member:bart",
    weekdays: ["mon", "wed", "fri"],
  },
  {
    id: "demo:routine-assignment:maggie-morning:maggie",
    routineId: "demo:routine:maggie-morning",
    memberId: "demo:member:maggie",
    weekdays: EVERY_DAY,
  },
  {
    id: "demo:routine-assignment:weekend-chores:bart",
    routineId: "demo:routine:weekend-chores",
    memberId: "demo:member:bart",
    weekdays: WEEKEND,
  },
  {
    id: "demo:routine-assignment:weekend-chores:lisa",
    routineId: "demo:routine:weekend-chores",
    memberId: "demo:member:lisa",
    weekdays: WEEKEND,
  },
  {
    id: "demo:routine-assignment:music-practice:lisa",
    routineId: "demo:routine:music-practice",
    memberId: "demo:member:lisa",
    weekdays: ["tue", "thu", "sat"],
  },
  {
    id: "demo:routine-assignment:bedtime:maggie",
    routineId: "demo:routine:bedtime",
    memberId: "demo:member:maggie",
    weekdays: EVERY_DAY,
  },
  {
    id: "demo:routine-assignment:bedtime:bart",
    routineId: "demo:routine:bedtime",
    memberId: "demo:member:bart",
    weekdays: SCHOOL_NIGHTS,
  },
  {
    id: "demo:routine-assignment:bedtime:lisa",
    routineId: "demo:routine:bedtime",
    memberId: "demo:member:lisa",
    weekdays: SCHOOL_NIGHTS,
  },
];

/** Today's partial progress: a few ticks so the board shows a day in flight. */
const TODAY_COMPLETIONS = [
  { choreId: "demo:chore:morning-launch:make-bed", memberId: "demo:member:bart" },
  { choreId: "demo:chore:morning-launch:pack-backpack", memberId: "demo:member:lisa" },
  { choreId: "demo:chore:evening-reset:feed-snowball-ii", memberId: "demo:member:lisa" },
  { choreId: "demo:chore:maggie-morning:bottle", memberId: "demo:member:maggie" },
] as const;

/** UTC hour used for a history completion, by the routine's day period. */
const COMPLETION_HOUR_UTC: Record<string, string> = {
  morning: "06:30",
  afternoon: "15:30",
  evening: "18:30",
  night: "19:30",
};

type SeedCompletion = {
  id: string;
  legacyId: string;
  choreId: string;
  memberId: string;
  date: string;
  completedAt: number;
};

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function weekdayOfDate(date: string): WeekdayCode {
  // getUTCDay(): 0=Sunday; the canonical order starts on Monday.
  return CANONICAL_WEEKDAY_ORDER[(new Date(`${date}T00:00:00.000Z`).getUTCDay() + 6) % 7];
}

function completion(choreId: string, memberId: string, date: string, completedAt: number) {
  const legacyId = `demo:chore-completion:${choreId.slice("demo:chore:".length)}:${memberId.slice(
    "demo:member:".length
  )}`;
  return { id: `${legacyId}:${date}`, legacyId, choreId, memberId, date, completedAt };
}

/**
 * Deterministic completion history: every scheduled chore from the first day of the previous
 * household week up to yesterday, with an occasional miss so streaks look lived-in, plus a
 * partially completed today. Nothing is ever completed in the future.
 */
export function buildSeedCompletions(asOfDate: string, weekStartDay: number): SeedCompletion[] {
  const weekday = new Date(`${asOfDate}T00:00:00.000Z`).getUTCDay();
  const historyStart = addDays(asOfDate, -((weekday - weekStartDay + 7) % 7) - 7);
  const periodOf = new Map<string, string>(ROUTINES.map((r) => [r.id, r.dayPeriodId]));
  const completions: SeedCompletion[] = [];
  for (let date = historyStart, day = 0; date < asOfDate; date = addDays(date, 1), day += 1) {
    const dayOfWeek = weekdayOfDate(date);
    ASSIGNMENTS.forEach((assignment, memberSlot) => {
      if (!assignment.weekdays.includes(dayOfWeek)) return;
      const completedAt = Date.parse(
        `${date}T${COMPLETION_HOUR_UTC[periodOf.get(assignment.routineId) ?? "evening"]}:00.000Z`
      );
      CHORES.filter((chore) => chore.routineId === assignment.routineId).forEach((chore) => {
        if ((day * 3 + chore.sortOrder + memberSlot) % 7 === 0) return; // an occasional miss
        completions.push(completion(chore.id, assignment.memberId, date, completedAt));
      });
    });
  }
  const todayAt = Date.parse(`${asOfDate}T18:00:00.000Z`);
  for (const { choreId, memberId } of TODAY_COMPLETIONS) {
    completions.push(completion(choreId, memberId, asOfDate, todayAt));
  }
  return completions;
}

const seedRoutines: SeedModule = {
  id: "routines:demo",
  run({ db, asOfDate, nowMs }) {
    const upsertRoutine = db.prepare(
      `INSERT INTO routines (id, name, day_period_id, active, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         day_period_id = excluded.day_period_id,
         active = excluded.active,
         updated_at = excluded.updated_at
       WHERE name IS NOT excluded.name
          OR day_period_id IS NOT excluded.day_period_id
          OR active IS NOT excluded.active`
    );
    for (const routine of ROUTINES) {
      upsertRoutine.run(routine.id, routine.name, routine.dayPeriodId, nowMs, nowMs);
    }

    const upsertChore = db.prepare(
      `INSERT INTO chores (id, routine_id, name, icon, sort_order, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         routine_id = excluded.routine_id,
         name = excluded.name,
         icon = excluded.icon,
         sort_order = excluded.sort_order,
         active = excluded.active,
         updated_at = excluded.updated_at
       WHERE routine_id IS NOT excluded.routine_id
          OR name IS NOT excluded.name
          OR icon IS NOT excluded.icon
          OR sort_order IS NOT excluded.sort_order
          OR active IS NOT excluded.active`
    );
    for (const chore of CHORES) {
      upsertChore.run(
        chore.id,
        chore.routineId,
        chore.name,
        chore.icon,
        chore.sortOrder,
        nowMs,
        nowMs
      );
    }

    const upsertAssignment = db.prepare(
      `INSERT INTO routine_assignments
         (id, routine_id, member_id, weekdays, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(routine_id, member_id) DO UPDATE SET
         id = excluded.id,
         weekdays = excluded.weekdays,
         active = excluded.active,
         updated_at = excluded.updated_at
       WHERE id IS NOT excluded.id
          OR weekdays IS NOT excluded.weekdays
          OR active IS NOT excluded.active`
    );
    for (const assignment of ASSIGNMENTS) {
      upsertAssignment.run(
        assignment.id,
        assignment.routineId,
        assignment.memberId,
        JSON.stringify(validateWeekdays(assignment.weekdays)),
        nowMs,
        nowMs
      );
    }

    const completions = buildSeedCompletions(asOfDate, readWeekStartDay());
    const keep = new Set(completions.map((entry) => entry.id));
    const removeStale = db.prepare("DELETE FROM chore_completions WHERE id = ?");
    const seedOwned = db
      .prepare("SELECT id FROM chore_completions WHERE id GLOB 'demo:chore-completion:*'")
      .all() as { id: string }[];
    for (const { id } of seedOwned) {
      if (!keep.has(id)) removeStale.run(id);
    }
    const upsertCompletion = db.prepare(
      `INSERT INTO chore_completions (id, chore_id, member_id, date, completed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(member_id, chore_id, date) DO UPDATE SET
         id = excluded.id,
         completed_at = excluded.completed_at
       WHERE (id = excluded.id OR id = ?)
         AND (id IS NOT excluded.id OR completed_at IS NOT excluded.completed_at)`
    );
    for (const entry of completions) {
      upsertCompletion.run(
        entry.id,
        entry.choreId,
        entry.memberId,
        entry.date,
        entry.completedAt,
        entry.legacyId
      );
    }
  },
};

export default seedRoutines;
