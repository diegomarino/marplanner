import { validateWeekdays, type WeekdayCode } from "../src/shared/weekdays";
import type { SeedModule } from "../src/server/db/seeds/types";

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri"] as const;

const TIME_ANNOUNCEMENTS: readonly {
  id: string;
  time: string;
  weekDays: readonly WeekdayCode[];
}[] = [
  { id: "demo:time-announcement:morning", time: "07:00", weekDays: WEEKDAYS },
  { id: "demo:time-announcement:school-bus", time: "08:15", weekDays: WEEKDAYS },
  { id: "demo:time-announcement:weekend-breakfast", time: "09:30", weekDays: ["sat", "sun"] },
  { id: "demo:time-announcement:evening", time: "19:00", weekDays: WEEKDAYS },
  {
    id: "demo:time-announcement:bedtime",
    time: "20:30",
    weekDays: ["mon", "tue", "wed", "thu", "sun"],
  },
];

/** Seed rule data only; firing, speech, dispatch, and execution state remain absent. */
const seedTimeAnnouncements: SeedModule = {
  id: "time:announcements:demo",
  run({ db, nowMs }) {
    const upsertRule = db.prepare(
      `INSERT INTO time_announcements
         (id, time, week_days, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         time = excluded.time,
         week_days = excluded.week_days,
         is_active = excluded.is_active,
         updated_at = excluded.updated_at
       WHERE time IS NOT excluded.time
          OR week_days IS NOT excluded.week_days
          OR is_active IS NOT excluded.is_active`
    );
    for (const announcement of TIME_ANNOUNCEMENTS) {
      upsertRule.run(
        announcement.id,
        announcement.time,
        JSON.stringify(validateWeekdays(announcement.weekDays)),
        nowMs,
        nowMs
      );
    }
  },
};

export default seedTimeAnnouncements;
