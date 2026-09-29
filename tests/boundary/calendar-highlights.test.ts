import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../../src/server/db/client";
import { getEvents } from "../../src/server/modules/calendar/index";
import {
  createHighlightRule,
  deleteHighlightRule,
  listHighlightRules,
  reorderHighlightRules,
  setHighlightRuleEnabled,
} from "../../src/server/modules/calendar/highlights";
import { useIsolatedDb } from "../helpers/db";

const now = Date.parse("2026-10-10T12:00:00Z");
const range = { from: "2026-10-15", to: "2026-10-15" };

function event(id: string, source: "local" | "external", title: string, description?: string) {
  getDb()
    .prepare(
      `INSERT INTO calendar_events
    (id, source, title, all_day, start_date, end_date, created_at, updated_at)
    VALUES (?, ?, ?, 1, '2026-10-15', '2026-10-16', ?, ?)`
    )
    .run(id, source, title, now, now);
  if (source === "external") {
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO calendar_external_sources
      (id, name, provider, feed_url, created_at, updated_at)
      VALUES ('feed', 'Feed', 'ics_generic', 'https://calendar.example.test/feed', ?, ?)`
      )
      .run(now, now);
    getDb()
      .prepare(
        `INSERT INTO calendar_external_event_meta
      (event_id, source_id, external_uid, recurrence_id, description, status, raw_hash, created_at, updated_at)
      VALUES (?, 'feed', ?, '', ?, 'active', ?, ?, ?)`
      )
      .run(id, id, description ?? null, "a".repeat(64), now, now);
  }
}

describe("Calendar highlight rules", () => {
  useIsolatedDb();
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
  });
  afterEach(() => vi.useRealTimers());

  it("validates and normalizes authoring input and keeps dense persisted priorities", () => {
    expect(() => createHighlightRule({ emoji: " ", keywords: ["school"] })).toThrow();
    expect(() => createHighlightRule({ emoji: "⭐", keywords: ["  "] })).toThrow();
    expect(() => createHighlightRule({ emoji: "⭐", keywords: [] })).toThrow();
    expect(() =>
      createHighlightRule({ emoji: "⭐", keywords: ["a"], extra: true } as never)
    ).toThrow();
    const first = createHighlightRule({ emoji: " ⭐ ", keywords: ["  Café  ", " CAFE "] });
    const second = createHighlightRule({ emoji: "🎈", keywords: ["party"] });
    expect(listHighlightRules()).toEqual([
      { id: first.id, emoji: "⭐", keywords: ["Café"], enabled: true, priority: 0 },
      { id: second.id, emoji: "🎈", keywords: ["party"], enabled: true, priority: 1 },
    ]);
    expect(setHighlightRuleEnabled(first.id, false)?.enabled).toBe(false);
    expect(setHighlightRuleEnabled("missing", true)).toBeNull();
    expect(deleteHighlightRule(first.id)).toBe(true);
    expect(deleteHighlightRule("missing")).toBe(false);
    expect(listHighlightRules()).toMatchObject([{ id: second.id, priority: 0 }]);
  });

  it("accepts a single keycap emoji and rejects plain text", () => {
    expect(() => createHighlightRule({ emoji: "1️⃣", keywords: ["first"] })).not.toThrow();
    expect(() => createHighlightRule({ emoji: "A", keywords: ["letter"] })).toThrow();
  });

  it("rejects incomplete or repeated IDs and rolls back a write failure", () => {
    const a = createHighlightRule({ emoji: "⭐", keywords: ["one"] });
    const b = createHighlightRule({ emoji: "🎈", keywords: ["two"] });
    const c = createHighlightRule({ emoji: "🎵", keywords: ["three"] });
    const original = listHighlightRules();
    for (const ids of [
      [b.id, a.id],
      [b.id, b.id, c.id],
      [b.id, a.id, "missing"],
    ]) {
      expect(() => reorderHighlightRules(ids)).toThrow();
      expect(listHighlightRules()).toEqual(original);
    }
    getDb().exec(`CREATE TRIGGER fail_highlight_reorder BEFORE UPDATE OF priority
      ON calendar_highlight_rules WHEN NEW.priority = 1 AND NEW.id = '${a.id}'
      BEGIN SELECT RAISE(ABORT, 'forced reorder failure'); END`);
    expect(() => reorderHighlightRules([b.id, a.id, c.id])).toThrow("forced reorder failure");
    expect(listHighlightRules()).toEqual(original);
    getDb().exec("DROP TRIGGER fail_highlight_reorder");
    expect(
      reorderHighlightRules([b.id, a.id, c.id]).map(({ id, priority }) => [id, priority])
    ).toEqual([
      [b.id, 0],
      [a.id, 1],
      [c.id, 2],
    ]);
  });

  it("decorates local titles and external descriptions by first active accent-insensitive match without writes", () => {
    event("local", "local", "  ÉCOLE   Day");
    event("external", "external", "Ordinary", "Café   morning");
    event("prefixed", "local", "⭐ école day");
    const first = createHighlightRule({ emoji: "⭐", keywords: ["ecole", " cafe morning "] });
    const second = createHighlightRule({ emoji: "🎈", keywords: ["ÉCOLE", "CAFÉ"] });
    expect(
      Object.fromEntries(
        getEvents({ source: "all", range }).map(({ id, decoratedTitle }) => [id, decoratedTitle])
      )
    ).toEqual({
      local: "⭐ ÉCOLE   Day",
      external: "⭐ Ordinary",
      prefixed: "⭐ école day",
    });
    expect(getDb().prepare("SELECT id, title FROM calendar_events ORDER BY id").all()).toEqual([
      { id: "external", title: "Ordinary" },
      { id: "local", title: "  ÉCOLE   Day" },
      { id: "prefixed", title: "⭐ école day" },
    ]);
    expect(reorderHighlightRules([second.id, first.id]).map(({ priority }) => priority)).toEqual([
      0, 1,
    ]);
    expect(
      getEvents({ source: "all", range }).find(({ id }) => id === "local")?.decoratedTitle
    ).toBe("🎈 ÉCOLE   Day");
    setHighlightRuleEnabled(second.id, false);
    expect(
      getEvents({ source: "all", range }).find(({ id }) => id === "local")?.decoratedTitle
    ).toBe("⭐ ÉCOLE   Day");
    deleteHighlightRule(first.id);
    expect(
      getEvents({ source: "all", range }).map(
        ({ decoratedTitle, title }) => decoratedTitle === title
      )
    ).toEqual([true, true, true]);
  });
});
