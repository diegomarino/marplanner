import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { useIsolatedDb } from "../helpers/db";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import type { FastifyInstance } from "fastify";
import type { Reminder, ReminderEmission } from "../../src/shared";
import { PLUGIN_MANIFESTS } from "../../src/server/plugins/manifest";

/** Reminders assembly smoke (— ADR-059 / Constitution XIII).
 * REAL-PROCESS proof, not `app.inject`: boots the app with a real listening
 * socket (`app.listen({ port: 0 })`) and drives Quickstart Scenario A over
 * actual HTTP against that port, with the device-key cookie set the same way
 * a real client would send it. This is the front-loaded runnable-skeleton
 * task the aggregate-validity rule requires — proven before any story task.
 * RED until: /api/reminders and /api/reminders/emissions don't exist yet.
 */
describe("reminders-assembly (T002 — real-process smoke, Scenario A)", () => {
  useIsolatedDb();

  let app: FastifyInstance;
  let baseUrl: string;
  let deviceKey: string;
  let memberId: string;

  beforeEach(async () => {
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
    db.prepare(
      "UPDATE plugin_activation_registry SET state = 'active', activated_at = ?, updated_at = ? WHERE plugin_id = 'reminders'"
    ).run(new Date(now).toISOString(), new Date(now).toISOString());

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

  it("Scenario A: create an apply_to_all reminder, then read emissions over real HTTP", async () => {
    const cookieHeader = `mp_device_key=${deviceKey}`;

    // 1. POST /api/reminders — apply_to_all scheduled rule (weekdays mon,thu) -> 201
    const createRes = await fetch(`${baseUrl}/api/reminders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieHeader },
      body: JSON.stringify({
        kind: "scheduled",
        targetingMode: "apply_to_all",
        text: "saca la basura",
        weekdays: ["mon", "thu"],
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as Reminder;
    expect(created.id).toBeTypeOf("string");
    expect(created.kind).toBe("scheduled");
    expect(created.targetingMode).toBe("apply_to_all");
    expect(created.weekdays).toEqual(["mon", "thu"]);
    expect(Object.keys(created).sort()).toEqual([
      "active",
      "assignments",
      "id",
      "kind",
      "query",
      "queryFields",
      "targetingMode",
      "text",
      "weekdays",
    ]);
    expect(PLUGIN_MANIFESTS.find(({ id }) => id === "reminders")?.contributions.jobs).toEqual([]);

    // 2. GET /api/reminders/emissions on a Monday (2026-08-17) -> 200, contains the reminder
    const mondayRes = await fetch(
      `${baseUrl}/api/reminders/emissions?memberId=${memberId}&date=2026-08-17`,
      { headers: { Cookie: cookieHeader } }
    );
    expect(mondayRes.status).toBe(200);
    const mondayEmissions = (await mondayRes.json()) as ReminderEmission[];
    expect(mondayEmissions).toEqual([{ id: created.id, text: "saca la basura" }]);

    // 3. GET /api/reminders/emissions on a Tuesday (2026-08-18) -> 200, empty
    const tuesdayRes = await fetch(
      `${baseUrl}/api/reminders/emissions?memberId=${memberId}&date=2026-08-18`,
      { headers: { Cookie: cookieHeader } }
    );
    expect(tuesdayRes.status).toBe(200);
    const tuesdayEmissions = (await tuesdayRes.json()) as ReminderEmission[];
    expect(tuesdayEmissions).toEqual([]);
  });
});
