import { validateWeekdays, type WeekdayCode } from "../src/shared/weekdays";
import type { SeedModule } from "../src/server/db/seeds/types";

const SCHOOL_DAYS = ["mon", "tue", "wed", "thu", "fri"] as const;

type SeedReminder = {
  id: string;
  kind: "scheduled" | "calendar_gated";
  targetingMode: "specific" | "apply_to_all";
  text: string;
  /** Rule-level weekdays: only for a scheduled `apply_to_all` rule. */
  weekdays: readonly WeekdayCode[] | null;
  query: string | null;
  queryFields: readonly ("title" | "description")[] | null;
};

/** Listed oldest first; each rule's `created_at` follows this order so reads stay deterministic. */
const REMINDERS: readonly SeedReminder[] = [
  {
    id: "demo:reminder:school-bag",
    kind: "scheduled",
    targetingMode: "specific",
    text: "Pack your school bag",
    weekdays: null,
    query: null,
    queryFields: null,
  },
  {
    id: "demo:reminder:music-lesson",
    kind: "calendar_gated",
    targetingMode: "specific",
    text: "Pack your saxophone",
    weekdays: null,
    query: "music lesson",
    queryFields: ["title"],
  },
  {
    id: "demo:reminder:plant-lunch-box",
    kind: "scheduled",
    targetingMode: "specific",
    text: "Grab your lunch box before the plant shift",
    weekdays: null,
    query: null,
    queryFields: null,
  },
  {
    id: "demo:reminder:walk-the-dog",
    kind: "scheduled",
    targetingMode: "specific",
    text: "Walk Santa's Little Helper",
    weekdays: null,
    query: null,
    queryFields: null,
  },
  {
    id: "demo:reminder:grocery-run",
    kind: "scheduled",
    targetingMode: "specific",
    text: "Kwik-E-Mart grocery run",
    weekdays: null,
    query: null,
    queryFields: null,
  },
  {
    id: "demo:reminder:trash-night",
    kind: "scheduled",
    targetingMode: "apply_to_all",
    text: "Trash goes out tonight",
    weekdays: ["tue", "fri"],
    query: null,
    queryFields: null,
  },
  {
    id: "demo:reminder:bowling-ball",
    kind: "calendar_gated",
    targetingMode: "specific",
    text: "Polish your lucky bowling ball",
    weekdays: null,
    query: "bowling",
    queryFields: ["title"],
  },
  {
    id: "demo:reminder:permission-slip",
    kind: "calendar_gated",
    targetingMode: "specific",
    text: "Bring the signed permission slip",
    weekdays: null,
    query: "field trip",
    queryFields: ["title"],
  },
  {
    id: "demo:reminder:church-clothes",
    kind: "calendar_gated",
    targetingMode: "apply_to_all",
    text: "Dress up for church",
    weekdays: null,
    query: "church",
    queryFields: ["title"],
  },
];

const ASSIGNMENTS: readonly {
  id: string;
  reminderId: string;
  memberId: string;
  weekdays: readonly WeekdayCode[];
}[] = [
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
  {
    id: "demo:reminder-assignment:plant-lunch-box:homer",
    reminderId: "demo:reminder:plant-lunch-box",
    memberId: "demo:member:homer",
    weekdays: SCHOOL_DAYS,
  },
  {
    id: "demo:reminder-assignment:walk-the-dog:bart",
    reminderId: "demo:reminder:walk-the-dog",
    memberId: "demo:member:bart",
    weekdays: ["mon", "wed", "fri", "sun"],
  },
  {
    id: "demo:reminder-assignment:walk-the-dog:lisa",
    reminderId: "demo:reminder:walk-the-dog",
    memberId: "demo:member:lisa",
    weekdays: ["tue", "thu", "sat"],
  },
  {
    id: "demo:reminder-assignment:grocery-run:marge",
    reminderId: "demo:reminder:grocery-run",
    memberId: "demo:member:marge",
    weekdays: ["mon", "thu"],
  },
  {
    id: "demo:reminder-assignment:bowling-ball:homer",
    reminderId: "demo:reminder:bowling-ball",
    memberId: "demo:member:homer",
    weekdays: [],
  },
  {
    id: "demo:reminder-assignment:permission-slip:bart",
    reminderId: "demo:reminder:permission-slip",
    memberId: "demo:member:bart",
    weekdays: [],
  },
  {
    id: "demo:reminder-assignment:permission-slip:lisa",
    reminderId: "demo:reminder:permission-slip",
    memberId: "demo:member:lisa",
    weekdays: [],
  },
];

const seedReminders: SeedModule = {
  id: "reminders:demo",
  run({ db, nowMs }) {
    const upsertReminder = db.prepare(
      `INSERT INTO reminder
         (id, kind, targeting_mode, text, weekdays, query, query_fields, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
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
    REMINDERS.forEach((reminder, index) => {
      upsertReminder.run(
        reminder.id,
        reminder.kind,
        reminder.targetingMode,
        reminder.text,
        reminder.weekdays === null ? null : JSON.stringify(validateWeekdays(reminder.weekdays)),
        reminder.query,
        reminder.queryFields === null ? null : JSON.stringify(reminder.queryFields),
        nowMs + index,
        nowMs
      );
    });

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
