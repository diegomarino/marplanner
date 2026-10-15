import { validateWeekdays } from "../src/shared/weekdays";
import type { SeedModule } from "../src/server/db/seeds/types";

const MON_TO_FRI = ["mon", "tue", "wed", "thu", "fri"] as const;

const ROUTINES = [
  { id: "demo:routine:morning-launch", name: "Morning launch", dayPeriodId: "morning" },
  { id: "demo:routine:after-school", name: "After school", dayPeriodId: "afternoon" },
  { id: "demo:routine:evening-reset", name: "Evening reset", dayPeriodId: "evening" },
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
] as const;

const ASSIGNMENTS = [
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
] as const;

const COMPLETIONS = [
  {
    id: "demo:chore-completion:morning-launch:make-bed:bart",
    choreId: "demo:chore:morning-launch:make-bed",
    memberId: "demo:member:bart",
  },
  {
    id: "demo:chore-completion:morning-launch:pack-backpack:lisa",
    choreId: "demo:chore:morning-launch:pack-backpack",
    memberId: "demo:member:lisa",
  },
  {
    id: "demo:chore-completion:evening-reset:feed-snowball-ii:lisa",
    choreId: "demo:chore:evening-reset:feed-snowball-ii",
    memberId: "demo:member:lisa",
  },
] as const;

const seedRoutines: SeedModule = {
  id: "routines:demo",
  run({ db, asOfDate, nowMs }) {
    const completionTimestamp = Date.parse(`${asOfDate}T18:00:00.000Z`);
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

    const replacePriorSeedCompletion = db.prepare(
      `DELETE FROM chore_completions
       WHERE date <> ?
         AND (id = ? OR id GLOB ?)`
    );
    const upsertCompletion = db.prepare(
      `INSERT INTO chore_completions (id, chore_id, member_id, date, completed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(member_id, chore_id, date) DO UPDATE SET
         id = excluded.id,
         completed_at = excluded.completed_at
       WHERE (id = excluded.id OR id = ?)
         AND (id IS NOT excluded.id OR completed_at IS NOT excluded.completed_at)`
    );
    for (const completion of COMPLETIONS) {
      const completionId = `${completion.id}:${asOfDate}`;
      replacePriorSeedCompletion.run(asOfDate, completion.id, `${completion.id}:????-??-??`);
      upsertCompletion.run(
        completionId,
        completion.choreId,
        completion.memberId,
        asOfDate,
        completionTimestamp,
        completion.id
      );
    }
  },
};

export default seedRoutines;
