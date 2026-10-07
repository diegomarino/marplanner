import { describe, it, expect } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

/** docs/features/plugin-system.md — RED per-table FK-drop
 * integrity tests (docs/features/plugin-system.md FR-005/FR-007,
 * PLUGIN-SYSTEM-INV-02). RED until (drizzle/0010_drop_member_fks.sql +
 * the schema.ts `.references` removal) lands — verified by reverting.
 * Proves, via `PRAGMA foreign_key_list(<table>)` on a real migrated DB
 * (app.inject + useIsolatedDb, per the boundary-suite convention):
 * 1. The two PLUGIN-table `member_id -> members` FKs are gone.
 * 2. The 3 CORE-table member FKs (ADR-054 integrity backstop) are untouched.
 * 3. Integrity moved app-side: a write for an inactive/nonexistent member is
 * rejected by the host-API check (400), not a raw FK constraint error.
 * 4. Tolerant-read still holds post-drop (an archived member's row renders).
 * 5. `reminder_assignments_unique_reminder_member` was re-created after the
 * table-rebuild rename (a raw duplicate insert still errors).
 */
describe("fk-drop-integrity", () => {
  useIsolatedDb();

  function seedKeys(): string {
    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    const db = getDb();
    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`${now}-device`, hashKey(deviceKey), now);
    return deviceKey;
  }

  function seedMember(lifecycle: "active" | "archived" = "active"): string {
    const db = getDb();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    db.prepare(
      "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, 'child', ?, ?, ?)"
    ).run(id, `Member ${id.slice(0, 6)}`, lifecycle, now, now);
    return id;
  }

  type FkRow = { id: number; seq: number; table: string; from: string; to: string };

  function fkList(table: string): FkRow[] {
    return getDb().prepare(`PRAGMA foreign_key_list(${table})`).all() as FkRow[];
  }

  // ── PRAGMA foreign_key_list — plugin tables (member FK gone) ─────────────

  it("reminder_assignment: member_id->members FK is ABSENT, reminder_id->reminder FK REMAINS", () => {
    const fks = fkList("reminder_assignment");
    expect(fks.find((fk) => fk.from === "member_id" && fk.table === "members")).toBeUndefined();
    const reminderFk = fks.find((fk) => fk.from === "reminder_id");
    expect(reminderFk).toBeDefined();
    expect(reminderFk?.table).toBe("reminder");
  });

  it("daily_messages: zero FK entries remain (its only FK was member_id->members)", () => {
    expect(fkList("daily_messages")).toHaveLength(0);
  });

  // ── PRAGMA foreign_key_list — core tables (member FK kept, ADR-054) ──────

  it("the 3 CORE-table member FKs stay present (calendar_assignments, routine_assignments, chore_completions)", () => {
    for (const table of ["calendar_assignments", "routine_assignments", "chore_completions"]) {
      const fks = fkList(table);
      const memberFk = fks.find((fk) => fk.from === "member_id" && fk.table === "members");
      expect(memberFk, `${table} should still FK member_id -> members`).toBeDefined();
    }
  });

  // ── App-side integrity replaces the dropped raw FK ───────────────────────

  it("reminders: create with an assignment to an inactive member -> 400 (host-API check, not a raw FK error)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedKeys();
    const ghostId = seedMember("archived");
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/reminders",
        cookies: { mp_device_key: deviceKey },
        payload: {
          kind: "scheduled",
          targetingMode: "specific",
          text: "coges el bus",
          assignments: [{ memberId: ghostId, weekdays: ["mon"] }],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toHaveProperty("error");
    } finally {
      await app.close();
    }
  });

  it("reminders: create with an assignment to a nonexistent member -> 400 (host-API check, not a raw FK error)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedKeys();
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/reminders",
        cookies: { mp_device_key: deviceKey },
        payload: {
          kind: "scheduled",
          targetingMode: "specific",
          text: "coges el bus",
          assignments: [{ memberId: "nonexistent-member-id", weekdays: ["mon"] }],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toHaveProperty("error");
    } finally {
      await app.close();
    }
  });

  it("daily-messages: PUT for an archived member -> 400 (host-API assertActiveMember, not a raw FK error)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedKeys();
    const ghostId = seedMember("archived");
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "PUT",
        url: "/api/daily-messages",
        cookies: { mp_device_key: deviceKey },
        payload: { memberId: ghostId, date: "2026-08-17", text: "no olvides la mochila" },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toHaveProperty("error");
    } finally {
      await app.close();
    }
  });

  it("daily-messages: PUT for a nonexistent member -> 400 (host-API memberExists, not a raw FK error)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedKeys();
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "PUT",
        url: "/api/daily-messages",
        cookies: { mp_device_key: deviceKey },
        payload: {
          memberId: "nonexistent-member-id",
          date: "2026-08-17",
          text: "no olvides la mochila",
        },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toHaveProperty("error");
    } finally {
      await app.close();
    }
  });

  // ── Tolerant-read still holds post-drop (ADR-054) ────────────────────────

  it("daily-messages: a member archived AFTER a write still renders the row (tolerant-read, ADR-054)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedKeys();
    const memberId = seedMember("active");
    const date = "2026-08-17";
    const app = await buildApp();
    try {
      const putRes = await app.inject({
        method: "PUT",
        url: "/api/daily-messages",
        cookies: { mp_device_key: deviceKey },
        payload: { memberId, date, text: "lleva el paraguas" },
      });
      expect(putRes.statusCode).toBe(200);

      getDb().prepare("UPDATE members SET lifecycle = 'archived' WHERE id = ?").run(memberId);

      const getRes = await app.inject({
        method: "GET",
        url: `/api/daily-messages/current?memberId=${memberId}&date=${date}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(getRes.statusCode).toBe(200);
      expect(JSON.parse(getRes.body)?.text).toBe("lleva el paraguas");
    } finally {
      await app.close();
    }
  });

  // ── reminder_assignments_unique_reminder_member re-created post-rebuild ──

  it("a raw duplicate (reminder_id, member_id) insert into reminder_assignment still errors (unique index re-created)", () => {
    const db = getDb();
    const now = Date.now();
    const reminderId = `${now}-reminder`;
    const memberId = seedMember("active");
    db.prepare(
      `INSERT INTO reminder (id, kind, targeting_mode, text, weekdays, active, created_at, updated_at)
       VALUES (?, 'scheduled', 'specific', ?, NULL, 1, ?, ?)`
    ).run(reminderId, "coges el bus", now, now);
    db.prepare(
      `INSERT INTO reminder_assignment (id, reminder_id, member_id, weekdays, active, created_at, updated_at)
       VALUES (?, ?, ?, '[]', 1, ?, ?)`
    ).run(`${now}-assignment-1`, reminderId, memberId, now, now);

    expect(() =>
      db
        .prepare(
          `INSERT INTO reminder_assignment (id, reminder_id, member_id, weekdays, active, created_at, updated_at)
           VALUES (?, ?, ?, '[]', 1, ?, ?)`
        )
        .run(`${now}-assignment-2`, reminderId, memberId, now, now)
    ).toThrow();
  });
});
