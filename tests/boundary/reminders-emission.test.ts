import { describe, it, expect } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

/** — apply_to_all emission boundary test (RED first).
 * Quickstart Scenario B (US1 / AC-03): an apply_to_all rule reaches every
 * active member on an in-set weekday and none on an out-of-set weekday.
 * 2026-08-17 is a Monday, 2026-08-18 a Tuesday (matches reminders-assembly's
 * seeded dates).
 */
describe("reminders-emission boundary test (Scenario B)", () => {
  useIsolatedDb();

  function seedKeys() {
    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    const db = getDb();
    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`${now}-device`, hashKey(deviceKey), now);
    return { deviceKey };
  }

  function seedMember(role: "parent" | "child" = "child") {
    const db = getDb();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    db.prepare(
      "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)"
    ).run(id, `Test Member ${id.slice(0, 4)}`, role, now, now);
    return id;
  }

  it("apply_to_all reaches BOTH active members on an in-set weekday, neither on an out-of-set weekday (FR-011, SC-002)", async () => {
    const { deviceKey } = seedKeys();
    const pabloId = seedMember("child");
    const lucasId = seedMember("child");

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/reminders",
        cookies: { mp_device_key: deviceKey },
        payload: {
          kind: "scheduled",
          targetingMode: "apply_to_all",
          text: "saca la basura",
          weekdays: ["mon", "thu"],
        },
      });
      expect(createRes.statusCode).toBe(201);
      const created = JSON.parse(createRes.body);

      for (const memberId of [pabloId, lucasId]) {
        const mondayRes = await app.inject({
          method: "GET",
          url: `/api/reminders/emissions?memberId=${memberId}&date=2026-08-17`,
          cookies: { mp_device_key: deviceKey },
        });
        expect(mondayRes.statusCode).toBe(200);
        expect(JSON.parse(mondayRes.body)).toEqual([{ id: created.id, text: "saca la basura" }]);

        const tuesdayRes = await app.inject({
          method: "GET",
          url: `/api/reminders/emissions?memberId=${memberId}&date=2026-08-18`,
          cookies: { mp_device_key: deviceKey },
        });
        expect(tuesdayRes.statusCode).toBe(200);
        expect(JSON.parse(tuesdayRes.body)).toEqual([]);
      }
    } finally {
      await app.close();
    }
  });
});
