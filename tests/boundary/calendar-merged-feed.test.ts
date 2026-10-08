import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../../src/server/db/client";
import { getEvents, type CalendarReadContext } from "../../src/server/modules/calendar/index";
import { useIsolatedDb } from "../helpers/db";

const range = { from: "2026-10-14", to: "2026-10-16" };
const now = Date.parse("2026-10-10T12:00:00Z");

function source(id: string, enabled = 1, provider = "google"): void {
  getDb()
    .prepare(
      `INSERT INTO calendar_external_sources
       (id, name, provider, feed_url, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, id, provider, `https://calendar.example.test/${id}?token=secret`, enabled, now, now);
}

function event(id: string, kind: "local" | "external", title: string, date = "2026-10-15"): void {
  const end = new Date(`${date}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  getDb()
    .prepare(
      `INSERT INTO calendar_events
       (id, source, title, all_day, start_date, end_date, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?)`
    )
    .run(id, kind, title, date, end.toISOString().slice(0, 10), now, now);
}

function meta(
  id: string,
  sourceId: string,
  status: "active" | "cancelled" = "active",
  description: string | null = null,
  recurrenceId = ""
): void {
  getDb()
    .prepare(
      `INSERT INTO calendar_external_event_meta
       (event_id, source_id, external_uid, recurrence_id, description, status, raw_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      sourceId,
      recurrenceId ? "shared-uid" : id,
      recurrenceId,
      description,
      status,
      "a".repeat(64),
      now,
      now
    );
}

describe("Calendar merged feed read", () => {
  useIsolatedDb();
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
  });
  afterEach(() => vi.useRealTimers());

  it("merges local and active external occurrences with masked, stable provenance", () => {
    source("enabled");
    event("local", "local", "Local");
    event("external-a", "external", "External A");
    meta("external-a", "enabled", "active", "Private description");

    const first = getEvents({ source: "all", range });
    expect(first).toHaveLength(2);
    expect(first.find((item) => item.id === "local")).toMatchObject({
      source: "local",
      provider: null,
      sourceRef: null,
    });
    expect(first.find((item) => item.id === "external-a")).toMatchObject({
      source: "external",
      title: "External A",
      occurrenceStart: "2026-10-15",
      occurrenceEnd: "2026-10-16",
      provider: "google",
      sourceRef: "https://calendar.example.test/***",
    });
    expect(first[1]).not.toHaveProperty("description");
    expect(JSON.stringify(first)).not.toContain("secret");
    expect(getEvents({ source: "all", range })).toEqual(first);
    expect(getEvents({ source: "local", range }).map((item) => item.id)).toEqual(["local"]);
    expect(getEvents({ source: "external", range }).map((item) => item.id)).toEqual(["external-a"]);
  });

  it("excludes disabled, cancelled, and orphaned external rows from every source filter", () => {
    source("enabled");
    source("disabled", 0);
    event("visible", "external", "Visible");
    meta("visible", "enabled");
    event("cancelled", "external", "Cancelled");
    meta("cancelled", "enabled", "cancelled");
    event("hidden", "external", "Hidden");
    meta("hidden", "disabled");
    event("orphan", "external", "Orphan");
    getDb()
      .prepare(
        `INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at)
         VALUES ('member', 'Alex', 'child', 'active', ?, ?)`
      )
      .run(now, now);
    for (const id of ["visible", "cancelled", "hidden", "orphan"]) {
      getDb()
        .prepare(
          `INSERT INTO calendar_assignments (id, event_id, member_id, created_at)
           VALUES (?, ?, 'member', ?)`
        )
        .run(`assignment-${id}`, id, now);
    }

    for (const filter of ["all", "external"]) {
      expect(getEvents({ source: filter, range }).map((item) => item.id)).toEqual(["visible"]);
      expect(
        getEvents({ source: filter, assignedTo: "member", range }).map((item) => item.id)
      ).toEqual(["visible"]);
    }
    expect(getDb().prepare("SELECT id FROM calendar_events").all()).toHaveLength(4);
  });

  it("requires an explicit active assignment for member-scoped external reads", () => {
    source("enabled");
    event("assigned", "external", "Assigned");
    meta("assigned", "enabled");
    event("unassigned", "external", "Unassigned");
    meta("unassigned", "enabled");
    getDb()
      .prepare(
        `INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at)
         VALUES ('active-member', 'Alex', 'child', 'active', ?, ?),
                ('archived-member', 'Sam', 'child', 'archived', ?, ?)`
      )
      .run(now, now, now, now);
    getDb()
      .prepare(
        `INSERT INTO calendar_assignments (id, event_id, member_id, created_at)
         VALUES ('a', 'assigned', 'active-member', ?),
                ('b', 'assigned', 'archived-member', ?)`
      )
      .run(now, now);

    expect(getEvents({ source: "external", assignedTo: "active-member", range })).toMatchObject([
      { id: "assigned", assignedTo: ["active-member"] },
    ]);
    expect(getEvents({ source: "external", assignedTo: "archived-member", range })).toEqual([]);
    expect(getEvents({ source: "external", range }).map((item) => item.id)).toEqual([
      "assigned",
      "unassigned",
    ]);
  });

  it("matches external description internally without exposing it on FeedItem", () => {
    source("enabled");
    event("external-a", "external", "Ordinary title");
    meta("external-a", "enabled", "active", "Médico privado");

    const matches = getEvents({ source: "external", range, query: "medico" });
    expect(matches.map((item) => item.id)).toEqual(["external-a"]);
    expect(matches[0]).not.toHaveProperty("description");
    expect(
      getEvents({ source: "external", range, query: "medico", queryFields: ["title"] })
    ).toEqual([]);
  });

  it("ADR-043: reuses one event read while preserving private query fields and transaction scope", () => {
    source("enabled");
    event("external", "external", "Ordinary title");
    meta("external", "enabled", "active", "Médico privado");
    getDb()
      .prepare(
        "UPDATE calendar_external_event_meta SET location = 'Clínica' WHERE event_id = 'external'"
      )
      .run();
    const db = getDb();
    const txCtx: CalendarReadContext = new Map();
    expect(() => getEvents({ source: "all", range, txCtx })).toThrow("active DB transaction");
    const prepare = vi.spyOn(db, "prepare");
    try {
      db.transaction(() => {
        expect(
          getEvents({ source: "all", range, txCtx, query: "MEDICO" }).map((e) => e.id)
        ).toEqual(["external"]);
        expect(
          getEvents({
            source: "all",
            range,
            txCtx,
            query: "clinica",
            queryFields: ["location"],
          }).map((e) => e.id)
        ).toEqual(["external"]);
        expect(
          getEvents({ source: "all", range, txCtx, query: "medico", queryFields: ["title"] })
        ).toEqual([]);
        expect(getEvents({ source: "all", range, txCtx })[0]).not.toHaveProperty("description");
        expect(() => getEvents({ source: "all", range, txCtx, queryFields: ["invalid"] })).toThrow(
          "Invalid queryFields"
        );
      })();
      expect(prepare.mock.calls.filter(([sql]) => sql.includes("calendar_events.id,")).length).toBe(
        1
      );
    } finally {
      prepare.mockRestore();
    }
    db.prepare("UPDATE calendar_events SET title = 'Updated' WHERE id = 'external'").run();
    expect(
      db.transaction(() => getEvents({ source: "all", range, txCtx: new Map() }))()[0].title
    ).toBe("Updated");
  });

  it("keeps distinct recurrence identities and the household date range", () => {
    source("enabled");
    event("first-occurrence", "external", "Series", "2026-10-15");
    meta("first-occurrence", "enabled", "active", null, "2026-10-15");
    event("second-occurrence", "external", "Series", "2026-10-16");
    meta("second-occurrence", "enabled", "active", null, "2026-10-16");

    expect(getEvents({ source: "external", range }).map((item) => item.id)).toEqual([
      "first-occurrence",
      "second-occurrence",
    ]);
    expect(
      getEvents({ source: "external", range: { from: "2026-10-15", to: "2026-10-15" } }).map(
        (item) => item.id
      )
    ).toEqual(["first-occurrence"]);
  });
});
