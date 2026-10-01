import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

/** — US3 member-lifecycle + live-read boundary tests (RED first).
 * BLACK-BOX: buildApp + Fastify.inject only, per the reminders-crud/
 * reminders-assignments suite convention (useIsolatedDb + raw SQL seed
 * helpers). 2026-08-17 is a Monday (matches reminders-assembly/emission's
 * seeded dates).
 * Quickstart Scenario F (archived-member self-heal, FR-004/REMINDERS-INV-02)
 * + Scenario G (active:false silences without deleting, SC-006/AC-04), plus
 * the assignment-omission silencing path (assignment.active gate, INV-02).
 * RED until completes the tolerant read in getReminders.
 */
describe("reminders-member-lifecycle boundary tests (T010/T011)", () => {
  useIsolatedDb();

  // ── helpers ──────────────────────────────────────────────────────────────

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
    const id = randomUUID();
    const now = Date.now();
    db.prepare(
      "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)"
    ).run(id, `Test Member ${id.slice(0, 4)}`, role, now, now);
    return id;
  }

  async function createSpecificReminder(
    app: import("fastify").FastifyInstance,
    deviceKey: string,
    assignments: Array<{ memberId: string; weekdays: string[] }>
  ) {
    const res = await app.inject({
      method: "POST",
      url: "/api/reminders",
      cookies: { mp_device_key: deviceKey },
      payload: {
        kind: "scheduled",
        targetingMode: "specific",
        text: "coges el bus",
        assignments,
      },
    });
    expect(res.statusCode).toBe(201);
    return JSON.parse(res.body) as { id: string };
  }

  async function createApplyToAllReminder(
    app: import("fastify").FastifyInstance,
    deviceKey: string,
    weekdays: string[]
  ) {
    const res = await app.inject({
      method: "POST",
      url: "/api/reminders",
      cookies: { mp_device_key: deviceKey },
      payload: {
        kind: "scheduled",
        targetingMode: "apply_to_all",
        text: "saca la basura",
        weekdays,
      },
    });
    expect(res.statusCode).toBe(201);
    return JSON.parse(res.body) as { id: string };
  }

  async function getEmissions(
    app: import("fastify").FastifyInstance,
    deviceKey: string,
    memberId: string,
    date: string
  ) {
    const res = await app.inject({
      method: "GET",
      url: `/api/reminders/emissions?memberId=${memberId}&date=${date}`,
      cookies: { mp_device_key: deviceKey },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as Array<{ id: string; text: string }>;
  }

  // ── Scenario F — archived-member self-heal ──────────────────────────────

  it("archiving an assigned member silences their emission live, without touching the assignment row or siblings; reactivation self-heals with no re-assignment (FR-004, REMINDERS-INV-02)", async () => {
    const { deviceKey } = seedKeys();
    const pabloId = seedMember("child");
    const lucasId = seedMember("child");

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const created = await createSpecificReminder(app, deviceKey, [
        { memberId: pabloId, weekdays: ["mon"] },
        { memberId: lucasId, weekdays: ["mon"] },
      ]);

      // Baseline: both active members emit on Monday.
      expect(await getEmissions(app, deviceKey, pabloId, "2026-08-17")).toEqual([
        { id: created.id, text: "coges el bus" },
      ]);
      expect(await getEmissions(app, deviceKey, lucasId, "2026-08-17")).toEqual([
        { id: created.id, text: "coges el bus" },
      ]);

      // Archive Pablo via the members API — no reminders-side data change.
      const archiveRes = await app.inject({
        method: "POST",
        url: `/api/members/${pabloId}/archive`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(archiveRes.statusCode).toBe(200);

      // Pablo's emission drops live; Lucas (still active) is unaffected.
      expect(await getEmissions(app, deviceKey, pabloId, "2026-08-17")).toEqual([]);
      expect(await getEmissions(app, deviceKey, lucasId, "2026-08-17")).toEqual([
        { id: created.id, text: "coges el bus" },
      ]);

      // Reactivate Pablo — emission resumes with no re-assignment step.
      const restoreRes = await app.inject({
        method: "POST",
        url: `/api/members/${pabloId}/restore`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(restoreRes.statusCode).toBe(200);

      expect(await getEmissions(app, deviceKey, pabloId, "2026-08-17")).toEqual([
        { id: created.id, text: "coges el bus" },
      ]);
    } finally {
      await app.close();
    }
  });

  it("archiving a member silences an apply_to_all rule's emission for them live, without touching the rule or other active members; reactivation self-heals (FR-004, REMINDERS-INV-02)", async () => {
    const { deviceKey } = seedKeys();
    const pabloId = seedMember("child");
    const lucasId = seedMember("child");

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const created = await createApplyToAllReminder(app, deviceKey, ["mon"]);

      // Baseline: apply_to_all reaches every active member on an in-set weekday.
      expect(await getEmissions(app, deviceKey, pabloId, "2026-08-17")).toEqual([
        { id: created.id, text: "saca la basura" },
      ]);
      expect(await getEmissions(app, deviceKey, lucasId, "2026-08-17")).toEqual([
        { id: created.id, text: "saca la basura" },
      ]);

      // Archive Pablo — a naive impl gating member-active ONLY in the specific
      // branch would keep emitting apply_to_all to him; assert it does not.
      const archiveRes = await app.inject({
        method: "POST",
        url: `/api/members/${pabloId}/archive`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(archiveRes.statusCode).toBe(200);

      expect(await getEmissions(app, deviceKey, pabloId, "2026-08-17")).toEqual([]);
      expect(await getEmissions(app, deviceKey, lucasId, "2026-08-17")).toEqual([
        { id: created.id, text: "saca la basura" },
      ]);

      // Reactivate Pablo — emission resumes with no change to the rule itself.
      const restoreRes = await app.inject({
        method: "POST",
        url: `/api/members/${pabloId}/restore`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(restoreRes.statusCode).toBe(200);

      expect(await getEmissions(app, deviceKey, pabloId, "2026-08-17")).toEqual([
        { id: created.id, text: "saca la basura" },
      ]);
    } finally {
      await app.close();
    }
  });

  // ── Assignment-omission silencing (assignment.active gate) ──────────────

  it("omitting a member from an assignment set-replace deactivates their assignment and silences their emission, without affecting a still-assigned sibling (REMINDERS-INV-02)", async () => {
    const { deviceKey } = seedKeys();
    const pabloId = seedMember("child");
    const lucasId = seedMember("child");

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const created = await createSpecificReminder(app, deviceKey, [
        { memberId: pabloId, weekdays: ["mon"] },
        { memberId: lucasId, weekdays: ["mon"] },
      ]);

      expect(await getEmissions(app, deviceKey, pabloId, "2026-08-17")).toEqual([
        { id: created.id, text: "coges el bus" },
      ]);

      // Set-replace with Lucas only — Pablo is omitted (deactivated, not deleted).
      const replaceRes = await app.inject({
        method: "PUT",
        url: `/api/reminders/${created.id}/assignments`,
        cookies: { mp_device_key: deviceKey },
        payload: { assignments: [{ memberId: lucasId, weekdays: ["mon"] }] },
      });
      expect(replaceRes.statusCode).toBe(200);

      // Pablo (still an ACTIVE member) no longer emits; Lucas still does.
      expect(await getEmissions(app, deviceKey, pabloId, "2026-08-17")).toEqual([]);
      expect(await getEmissions(app, deviceKey, lucasId, "2026-08-17")).toEqual([
        { id: created.id, text: "coges el bus" },
      ]);

      // Omission deactivates by ROW, never hard-deletes ( ADR-054
      // precedent) — a hard-delete would pass the emission assertion above but
      // break reactivation self-heal and violate the retained-row guarantee.
      const pabloAssignmentRow = getDb()
        .prepare("SELECT active FROM reminder_assignment WHERE reminder_id = ? AND member_id = ?")
        .get(created.id, pabloId) as { active: number } | undefined;
      expect(pabloAssignmentRow).toBeDefined();
      expect(pabloAssignmentRow?.active).toBe(0);
    } finally {
      await app.close();
    }
  });

  // ── Scenario G — active:false silences without deleting, live read ──────

  it("PATCH active:false on a specific rule silences emission for every assigned member with no regenerate step; reactivating resumes it (SC-006, REMINDERS-AC-04)", async () => {
    const { deviceKey } = seedKeys();
    const pabloId = seedMember("child");

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const created = await createSpecificReminder(app, deviceKey, [
        { memberId: pabloId, weekdays: ["mon"] },
      ]);

      expect(await getEmissions(app, deviceKey, pabloId, "2026-08-17")).toEqual([
        { id: created.id, text: "coges el bus" },
      ]);

      const deactivateRes = await app.inject({
        method: "PATCH",
        url: `/api/reminders/${created.id}`,
        cookies: { mp_device_key: deviceKey },
        payload: { active: false },
      });
      expect(deactivateRes.statusCode).toBe(200);

      // Live read reflects the rule's active flag directly — no regenerate step.
      expect(await getEmissions(app, deviceKey, pabloId, "2026-08-17")).toEqual([]);

      const reactivateRes = await app.inject({
        method: "PATCH",
        url: `/api/reminders/${created.id}`,
        cookies: { mp_device_key: deviceKey },
        payload: { active: true },
      });
      expect(reactivateRes.statusCode).toBe(200);

      expect(await getEmissions(app, deviceKey, pabloId, "2026-08-17")).toEqual([
        { id: created.id, text: "coges el bus" },
      ]);
    } finally {
      await app.close();
    }
  });
});
