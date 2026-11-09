import {
  occurrenceOverlaps,
  type FeedItem,
  type Member,
  type MemberColorKey,
  type OccurrenceRange,
} from "../../shared";
import { localDateParts, nextOccurrenceInTz } from "../../shared/householdTime";

export interface AgendaPresentationItem {
  event: FeedItem;
  kind: "all-day" | "timed";
  temporalState: "past" | "in-progress" | "next" | "future";
  activeAssignees: { memberId: string; label: string; colorKey: MemberColorKey }[];
  fallbackAssigneeLabels: string[];
}

function householdDate(timezone: string, now: number): string {
  const { y, m, d } = localDateParts(now, timezone);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** The household day as explicit instants, household midnight to the next one. Calendar maps
 * instant bounds to the household dates they cover, so all-day events of `date` match too;
 * explicit instants also avoid the endpoint's inclusive date-only `to` conversion.
 */
export function householdDayRange(timezone: string, now: number) {
  const date = householdDate(timezone, now);
  const nextMidnight = nextOccurrenceInTz("00:00", timezone, now);
  const midnight = nextOccurrenceInTz("00:00", timezone, nextMidnight - 36 * 60 * 60 * 1000);
  return {
    date,
    from: new Date(midnight).toISOString(),
    to: new Date(nextMidnight).toISOString(),
  };
}

/** All-day rows read as groups: events for the whole active household first, then each
 * person's events by name (an event for several people sorts by its names in alphabetical
 * order), then events nobody owns. Ties keep the read order. Items are already all-day first.
 */
function sortAllDay(
  items: AgendaPresentationItem[],
  members: readonly Member[],
  locale: string | undefined
): void {
  const active = members.filter((member) => member.lifecycle === "active");
  const collator = new Intl.Collator(locale, { sensitivity: "base" });
  const rank = (item: AgendaPresentationItem) => {
    if (item.event.assignedTo.length === 0) return 2;
    const owners = new Set(item.activeAssignees.map((assignee) => assignee.memberId));
    return active.length > 1 && active.every((member) => owners.has(member.id)) ? 0 : 1;
  };
  // Archived or missing owners sort after every active name.
  const names = (item: AgendaPresentationItem) => [
    ...item.activeAssignees
      .map((assignee) => [0, assignee.label] as const)
      .sort((x, y) => collator.compare(x[1], y[1])),
    ...item.fallbackAssigneeLabels
      .map((label) => [1, label] as const)
      .sort((x, y) => collator.compare(x[1], y[1])),
  ];
  const compare = (a: AgendaPresentationItem, b: AgendaPresentationItem) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0 || rank(a) !== 1) return byRank;
    const [left, right] = [names(a), names(b)];
    for (let index = 0; index < Math.min(left.length, right.length); index++) {
      const byName =
        left[index][0] - right[index][0] || collator.compare(left[index][1], right[index][1]);
      if (byName !== 0) return byName;
    }
    return left.length - right.length;
  };
  const allDayCount = items.filter((item) => item.kind === "all-day").length;
  items.splice(0, allDayCount, ...items.slice(0, allDayCount).sort(compare));
}

export function presentAgenda(
  events: readonly FeedItem[],
  members: readonly Member[],
  timezone: string,
  now: number,
  /** UI language, so member names collate as the household reads them. */
  locale?: string
): AgendaPresentationItem[] {
  const day = householdDayRange(timezone, now);
  const nextDate = new Date(`${day.date}T00:00:00Z`);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  const today: OccurrenceRange = {
    startDay: day.date,
    endDay: nextDate.toISOString().slice(0, 10),
    startMs: Date.parse(day.from),
    endMs: Date.parse(day.to),
  };
  const profiles = new Map(members.map((member) => [member.id, member]));
  const items: AgendaPresentationItem[] = events
    // Same overlap rule as the Calendar read: an ongoing holiday or overnight event shows today.
    .filter((event) => occurrenceOverlaps(event, today))
    // Stable sort preserves the owning read's tie order, including all-day items.
    .sort((a, b) => {
      if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
      return a.allDay ? 0 : Date.parse(a.occurrenceStart) - Date.parse(b.occurrenceStart);
    })
    .map((event) => {
      const activeAssignees: AgendaPresentationItem["activeAssignees"] = [];
      const fallbackAssigneeLabels: string[] = [];
      for (const memberId of event.assignedTo) {
        const member = profiles.get(memberId);
        if (member?.lifecycle === "active") {
          activeAssignees.push({ memberId, label: member.displayName, colorKey: member.colorKey });
        } else {
          // FeedItem carries ids, not labels. Preserve the Members read's label where
          // available; never invent an active profile/colour for a stale reference.
          fallbackAssigneeLabels.push(member?.displayName ?? memberId);
        }
      }
      let temporalState: AgendaPresentationItem["temporalState"] = "future";
      if (!event.allDay && Date.parse(event.occurrenceStart) <= now) {
        temporalState =
          event.occurrenceEnd && now < Date.parse(event.occurrenceEnd) ? "in-progress" : "past";
      }
      return {
        event,
        kind: event.allDay ? "all-day" : "timed",
        temporalState,
        activeAssignees,
        fallbackAssigneeLabels,
      };
    });
  sortAllDay(items, members, locale);
  if (!items.some((item) => item.temporalState === "in-progress")) {
    const next = items.find((item) => item.kind === "timed" && item.temporalState === "future");
    if (next) next.temporalState = "next";
  }
  return items;
}
