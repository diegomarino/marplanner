import { validateWeekdays } from "../src/shared/weekdays";
import type { SeedModule } from "../src/server/db/seeds/types";

const SCHOOL_DAYS = ["mon", "tue", "wed", "thu", "fri"] as const;

const REMINDERS = [
  {
    id: "demo:reminder:school-bag",
    kind: "scheduled",
    targetingMode: "specific",
    text: "Pack your school bag",
    query: null,
    queryFields: null,
  },
  {
    id: "demo:reminder:music-lesson",
    kind: "calendar_gated",
    targetingMode: "specific",
    text: "Pack your saxophone",
    query: "music lesson",
    queryFields: ["title"],
  },
] as const;

const ASSIGNMENTS = [
  {
    id: "demo:reminder-assignment:school-bag:bart",
    reminderId: "demo:reminder:school-bag",
    memberId: "demo:member:bart",
    weekdays: SCHOOL_DAYS,
  },
  {
    id: "demo:reminder-assignment:school-bag:lisa",
    reminderId: "demo:reminder:school-bag",
    memberId: "demo:member:lisa",
    weekdays: SCHOOL_DAYS,
  },
  {
    id: "demo:reminder-assignment:music-lesson:lisa",
    reminderId: "demo:reminder:music-lesson",
    memberId: "demo:member:lisa",
    weekdays: [],
  },
] as const;

const seedReminders: SeedModule = {
  id: "reminders:demo",
  run({ db, nowMs }) {
    const upsertReminder = db.prepare(
      `INSERT INTO reminder
         (id, kind, targeting_mode, text, weekdays, query, query_fields, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind,
         targeting_mode = excluded.targeting_mode,
         text = excluded.text,
         weekdays = excluded.weekdays,
         query = excluded.query,
         query_fields = excluded.query_fields,
         active = excluded.active,
         updated_at = excluded.updated_at
       WHERE kind IS NOT excluded.kind
          OR targeting_mode IS NOT excluded.targeting_mode
          OR text IS NOT excluded.text
          OR weekdays IS NOT excluded.weekdays
          OR query IS NOT excluded.query
          OR query_fields IS NOT excluded.query_fields
          OR active IS NOT excluded.active`
    );
    for (const reminder of REMINDERS) {
      upsertReminder.run(
        reminder.id,
        reminder.kind,
        reminder.targetingMode,
        reminder.text,
        reminder.query,
        reminder.queryFields === null ? null : JSON.stringify(reminder.queryFields),
        nowMs,
        nowMs
      );
    }

    const upsertAssignment = db.prepare(
      `INSERT INTO reminder_assignment
         (id, reminder_id, member_id, weekdays, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(reminder_id, member_id) DO UPDATE SET
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
        assignment.reminderId,
        assignment.memberId,
        JSON.stringify(validateWeekdays(assignment.weekdays)),
        nowMs,
        nowMs
      );
    }
  },
};

export default seedReminders;
