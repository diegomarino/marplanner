import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { useIsolatedDb } from "../helpers/db";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import type { FastifyInstance } from "fastify";
import type { Reminder, ReminderEmission } from "../../src/shared";

/** Calendar-gated reminders assembly smoke (— ADR-059 / Constitution XIII).
 * REAL-PROCESS proof, not `app.inject`: boots the app with a real listening socket
 * (`app.listen({ port: 0 })`) and drives Quickstart Scenario A over actual HTTP against that
 * port, with the device-key cookie set the same way a real client would send it — author a
 * calendar_gated rule, seed a query-matching assigned calendar event, and read the live emission.
 * RED until: kind=calendar_gated is rejected by createReminder (006-only), and getEvents
 * throws on query/queryFields (004 "reserved" params).
 */
describe("reminders-calendar-gated-assembly (real-process smoke, Quickstart Scenario A)", () => {
  useIsolatedDb();

  // ── date helpers (mirror src/server/lib/household-date.ts's timezone-invariant weekday
  // derivation) — the smoke's dates MUST be clock-relative, not hard-coded: getEvents enforces a
  // fixed -30d/+365d window, so a hard-coded date eventually ages out and fails purely from time
  // passing. ──────────────────────────────────────────────────────────────

  function todayHouseholdDate(): string {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Madrid",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const parts = formatter.formatToParts(new Date());
    const year = parts.find((p) => p.type === "year")!.value;
    const month = parts.find((p) => p.type === "month")!.value;
    const day = parts.find((p) => p.type === "day")!.value;
    return `${year}-${month}-${day}`;
  }

  function addDays(dateStr: string, delta: number): string {
    const [y, m, d] = dateStr.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + delta);
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(dt.getUTCDate()).padStart(2, "0");
    return `${yy}-${mm}-${dd}`;
  }

  let app: FastifyInstance;
  let baseUrl: string;
  let deviceKey: string;
  let memberId: string;
  let matchDate: string;
  let noMatchDate: string;

  beforeEach(async () => {
    matchDate = todayHouseholdDate();
    noMatchDate = addDays(matchDate, 1);

    deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const deviceHash = hashKey(deviceKey);
    const now = Date.now();
    const db = getDb();

    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`${now}-device`, deviceHash, now);

    memberId = `${now}-member`;
    db.prepare(
      "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, 'child', 'active', ?, ?)"
    ).run(memberId, "Pablo", now, now);

    const { buildApp } = await import("../../src/server/app.ts");
    app = await buildApp();
    await app.listen({ port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected a real TCP address from app.listen({ port: 0 })");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await app.close();
  });

  it("Scenario A: author a calendar_gated rule, seed an assigned matching event, emits over real HTTP", async () => {
    const cookieHeader = `mp_device_key=${deviceKey}`;

    // 1. POST /api/reminders — calendar_gated apply_to_all rule (query: "excursión") -> 201
    const createRes = await fetch(`${baseUrl}/api/reminders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieHeader },
      body: JSON.stringify({
        kind: "calendar_gated",
        targetingMode: "apply_to_all",
        text: "lleva la mochila",
        query: "excursión",
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as Reminder;
    expect(created.id).toBeTypeOf("string");
    expect(created.kind).toBe("calendar_gated");
    expect(created.targetingMode).toBe("apply_to_all");
    expect(created.weekdays).toBeNull();
    expect(created.query).toBe("excursión");
    expect(created.queryFields).toEqual(["title", "description"]);

    // 2. Seed an assigned matching event "Excursión al museo" on matchDate (today, household tz),
    // via the 004 calendar HTTP surface (create + assign — real-listen, same seam as the
    // reminder under test). Clock-relative so the smoke never ages out of the -30d/+365d window.
    const eventRes = await fetch(`${baseUrl}/api/calendar/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieHeader },
      body: JSON.stringify({
        title: "Excursión al museo",
        allDay: true,
        startDate: matchDate,
        endDate: noMatchDate,
      }),
    });
    expect(eventRes.status).toBe(201);
    const event = (await eventRes.json()) as { id: string };

    const assignRes = await fetch(`${baseUrl}/api/calendar/events/${event.id}/assignments`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookieHeader },
      body: JSON.stringify({ memberIds: [memberId] }),
    });
    expect(assignRes.status).toBe(200);

    // 3. GET /api/reminders/emissions on the matching date -> 200, contains the reminder
    const matchRes = await fetch(
      `${baseUrl}/api/reminders/emissions?memberId=${memberId}&date=${matchDate}`,
      { headers: { Cookie: cookieHeader } }
    );
    expect(matchRes.status).toBe(200);
    const matchEmissions = (await matchRes.json()) as ReminderEmission[];
    expect(matchEmissions).toEqual([{ id: created.id, text: "lleva la mochila" }]);

    // 4. A day with no matching event -> 200, empty
    const noEventRes = await fetch(
      `${baseUrl}/api/reminders/emissions?memberId=${memberId}&date=${noMatchDate}`,
      { headers: { Cookie: cookieHeader } }
    );
    expect(noEventRes.status).toBe(200);
    const noEventEmissions = (await noEventRes.json()) as ReminderEmission[];
    expect(noEventEmissions).toEqual([]);
  });

  it("POST /api/reminders rejects an unknown top-level key with 400, nothing persisted (REWORK #3, #397 allow-list)", async () => {
    const cookieHeader = `mp_device_key=${deviceKey}`;

    const res = await fetch(`${baseUrl}/api/reminders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieHeader },
      body: JSON.stringify({
        kind: "calendar_gated",
        targetingMode: "apply_to_all",
        text: "lleva la mochila",
        query: "excursión",
        weekdyas: ["mon"], // typo — must be rejected, not silently discarded (contradicts ReminderInput's additionalProperties:false)
      }),
    });
    expect(res.status).toBe(400);

    const listRes = await fetch(`${baseUrl}/api/reminders`, { headers: { Cookie: cookieHeader } });
    expect((await listRes.json()) as Reminder[]).toEqual([]);
  });

  it("emissions read stays 200 for an out-of-window date, scheduled reminders still returned (REWORK #2)", async () => {
    const cookieHeader = `mp_device_key=${deviceKey}`;

    // A scheduled apply_to_all rule covering every weekday, so it emits regardless of which
    // weekday the out-of-window date lands on — proves scheduled emissions are unaffected by
    // the calendar_gated gate's WindowError.
    const scheduledRes = await fetch(`${baseUrl}/api/reminders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieHeader },
      body: JSON.stringify({
        kind: "scheduled",
        targetingMode: "apply_to_all",
        text: "cepíllate los dientes",
        weekdays: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
      }),
    });
    expect(scheduledRes.status).toBe(201);
    const scheduled = (await scheduledRes.json()) as Reminder;

    // A calendar_gated rule whose gate calls getEvents with a date outside the Calendar
    // -30d/+365d window — that must throw WindowError internally and be treated as "no match",
    // never abort (500) the whole emissions read.
    const cgRes = await fetch(`${baseUrl}/api/reminders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieHeader },
      body: JSON.stringify({
        kind: "calendar_gated",
        targetingMode: "apply_to_all",
        text: "lleva la mochila",
        query: "excursión",
      }),
    });
    expect(cgRes.status).toBe(201);

    const outOfWindowDate = addDays(matchDate, -40); // well past the -30d Calendar window

    const res = await fetch(
      `${baseUrl}/api/reminders/emissions?memberId=${memberId}&date=${outOfWindowDate}`,
      { headers: { Cookie: cookieHeader } }
    );
    expect(res.status).toBe(200);
    const emissions = (await res.json()) as ReminderEmission[];
    expect(emissions).toEqual([{ id: scheduled.id, text: "cepíllate los dientes" }]);
  });
});
