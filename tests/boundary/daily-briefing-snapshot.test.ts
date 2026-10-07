import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Briefing, BriefingReadResult } from "../../src/shared";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

/** RED contract for. It drives the real registered HTTP surface so
 * snapshot lifecycle and the no-FK archived-member boundary stay observable.
 */
describe("daily-briefing snapshot + regeneration boundary", () => {
  useIsolatedDb();

  let app: FastifyInstance;
  let deviceKey: string;
  let memberId: string;
  const date = "2026-08-21";

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-21T12:00:00.000Z"));
    const now = Date.now();
    const db = getDb();
    deviceKey = `mpk-${now}-${Math.random().toString(36).slice(2)}`;
    memberId = `member-${now}`;

    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`device-${now}`, hashKey(deviceKey), now);
    db.prepare(
      "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, 'child', 'active', ?, ?)"
    ).run(memberId, "Ada", now, now);
    db.prepare(
      "INSERT INTO daily_briefing_optin (member_id, enabled, created_at, updated_at) VALUES (?, 1, ?, ?)"
    ).run(memberId, now, now);

    const { buildApp } = await import("../../src/server/app.ts");
    app = await buildApp();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await app?.close();
  });

  function auth() {
    return { mp_device_key: deviceKey };
  }

  function seedCalendar(title: string): void {
    const now = Date.now();
    getDb()
      .prepare(
        "INSERT INTO calendar_events (id, source, title, all_day, start_date, end_date, created_at, updated_at) VALUES ('calendar-t010', 'local', ?, 1, ?, ?, ?, ?)"
      )
      .run(title, date, "2026-08-22", now, now);
    //: "today" (blocks/today.ts) queries getEvents with `assignedTo: memberId` —
    // an explicit assignment row is required for the event to surface in this member's briefing.
    getDb()
      .prepare(
        "INSERT INTO calendar_assignments (id, event_id, member_id, created_at) VALUES ('assignment-calendar-t010', 'calendar-t010', ?, ?)"
      )
      .run(memberId, now);
  }

  async function generate() {
    return app.inject({
      method: "POST",
      url: "/api/daily-briefing/generate",
      cookies: auth(),
      payload: { memberId, date },
    });
  }

  async function read(): Promise<BriefingReadResult> {
    const response = await app.inject({
      method: "GET",
      url: `/api/daily-briefing/${memberId}/${date}`,
      cookies: auth(),
    });
    expect(response.statusCode).toBe(200);
    return response.json<BriefingReadResult>();
  }

  //: "today" (blocks/today.ts) replaces 010's "calendar" block — its `data` is
  // `{bullets: string[]}` (a formatted, already-truncated display string per event), not the
  // raw event-array 010 stored. An ALL-DAY event's bullet is the (emoji-stripped) title verbatim
  // (no time prefix — see `today.ts`), so a `.includes(title)` match is the right granularity.
  function calendarTitle(briefing: Briefing, title: string): boolean {
    const today = briefing.payload.blocks.find((block) => block.type === "today");
    const bullets = (today?.data as { bullets: string[] } | undefined)?.bullets ?? [];
    return bullets.some((bullet) => bullet.includes(title));
  }

  it("freezes source data until regeneration, then replaces the payload in place with a settled status", async () => {
    seedCalendar("Frozen appointment");
    const initialResponse = await generate();
    expect(initialResponse.statusCode).toBe(200);
    const initial = initialResponse.json<Briefing>();
    expect(calendarTitle(initial, "Frozen appointment")).toBe(true);

    vi.setSystemTime(new Date("2026-08-21T12:01:00.000Z"));
    getDb()
      .prepare("UPDATE calendar_events SET title = ?, updated_at = ? WHERE id = 'calendar-t010'")
      .run("Changed after generation", Date.now());

    const frozen = await read();
    //: printedStatus is "none" — Printing is active (default) but no print job was
    // ever enqueued for this member/date in this test.
    expect(frozen).toEqual({ generated: true, briefing: initial, printedStatus: "none" });

    const regeneratedResponse = await generate();
    expect(regeneratedResponse.statusCode).toBe(200);
    const regenerated = regeneratedResponse.json<Briefing>();
    expect(regenerated).toMatchObject({
      id: initial.id,
      memberId,
      date,
      status: "ready",
    });
    expect(regenerated.status).not.toBe("pending");
    expect(regenerated.updatedAt).toBeGreaterThan(initial.updatedAt);
    expect(calendarTitle(regenerated, "Changed after generation")).toBe(true);
    await expect(read()).resolves.toEqual({
      generated: true,
      briefing: regenerated,
      printedStatus: "none",
    });
    expect(
      getDb()
        .prepare("SELECT COUNT(*) AS count FROM daily_briefing WHERE member_id = ? AND date = ?")
        .get(memberId, date)
    ).toEqual({ count: 1 });
  });

  it("tolerates archived snapshots on read without revalidating the member", async () => {
    const response = await generate();
    expect(response.statusCode).toBe(200);
    const generated = response.json<Briefing>();

    getDb().prepare("UPDATE members SET lifecycle = 'archived' WHERE id = ?").run(memberId);

    await expect(read()).resolves.toEqual({
      generated: true,
      briefing: generated,
      printedStatus: "none",
    });
  });

  it("rejects regeneration for a member archived after generation and leaves the frozen snapshot unchanged", async () => {
    seedCalendar("Original snapshot");
    const initialResponse = await generate();
    expect(initialResponse.statusCode).toBe(200);
    const initial = initialResponse.json<Briefing>();

    getDb().prepare("UPDATE members SET lifecycle = 'archived' WHERE id = ?").run(memberId);
    getDb()
      .prepare("UPDATE calendar_events SET title = ? WHERE id = 'calendar-t010'")
      .run("Must not refresh");

    const regenerate = await generate();
    expect(regenerate.statusCode).toBe(400);
    await expect(read()).resolves.toEqual({
      generated: true,
      briefing: initial,
      printedStatus: "none",
    });
  });
});
