import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

/** — calendar_gated discriminant hardening + assignment-only targeting boundary tests
 * (RED first; turns green).
 * app.inject boundary tests, per Quickstart Scenario D / DoD: a calendar_gated
 * create carrying weekdays (rule-level OR per-assignment) → 400 (INV-01/INV-09); a scheduled
 * create carrying query → 400 (006 preserved); a calendar_gated specific rule targets by
 * MEMBERSHIP only (AC-05) and a non-empty per-assignment weekday set → 400; a calendar_gated
 * CREATE omitting queryFields persists the default ["title","description"]; EDITING
 * a calendar_gated rule's query/queryFields via PATCH is accepted and a scheduled-rule PATCH
 * carrying query → 400; a PATCH editing ONLY query (omitting queryFields) leaves
 * the stored queryFields UNCHANGED (finding ′); PATCH weekdays on a calendar_gated rule → 400,
 * not 500 (the carry-in). Nothing persists on any 400.
 */
describe("reminders-calendar-gated-discriminant boundary tests (T006/T007)", () => {
  useIsolatedDb();

  beforeEach(() => {
    // Calendar reads enforce a moving -30d/+365d window. These discriminant fixtures use
    // 2026-08-17 throughout, so freeze the matching clock instead of coupling them to wall time.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-17T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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

  async function expectCreateRejectedAndNothingPersisted(
    app: import("fastify").FastifyInstance,
    deviceKey: string,
    payload: Record<string, unknown>
  ) {
    const res = await app.inject({
      method: "POST",
      url: "/api/reminders",
      cookies: { mp_device_key: deviceKey },
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toHaveProperty("error");

    const listRes = await app.inject({
      method: "GET",
      url: "/api/reminders",
      cookies: { mp_device_key: deviceKey },
    });
    expect(listRes.statusCode).toBe(200);
    expect(JSON.parse(listRes.body)).toEqual([]);
  }

  // ── weekdays anywhere on calendar_gated → 400 (INV-01/INV-09) ────────────────────────────

  it("calendar_gated apply_to_all create carrying rule-level weekdays → 400, nothing persisted (INV-01/INV-09)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      await expectCreateRejectedAndNothingPersisted(app, deviceKey, {
        kind: "calendar_gated",
        targetingMode: "apply_to_all",
        text: "lleva la mochila",
        query: "excursión",
        weekdays: ["mon"],
      });
    } finally {
      await app.close();
    }
  });

  it("calendar_gated specific create carrying rule-level weekdays → 400, nothing persisted (INV-01/INV-09)", async () => {
    const { deviceKey } = seedKeys();
    const memberId = seedMember();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      await expectCreateRejectedAndNothingPersisted(app, deviceKey, {
        kind: "calendar_gated",
        targetingMode: "specific",
        text: "lleva la mochila",
        query: "excursión",
        weekdays: ["mon"],
        assignments: [{ memberId }],
      });
    } finally {
      await app.close();
    }
  });

  it("calendar_gated specific create with a non-empty per-assignment weekdays → 400, nothing persisted (INV-01/INV-09)", async () => {
    const { deviceKey } = seedKeys();
    const memberId = seedMember();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      await expectCreateRejectedAndNothingPersisted(app, deviceKey, {
        kind: "calendar_gated",
        targetingMode: "specific",
        text: "lleva la mochila",
        query: "excursión",
        assignments: [{ memberId, weekdays: ["mon"] }],
      });
    } finally {
      await app.close();
    }
  });

  // ── scheduled + query → 400 (006 preserved) ───────────────────────────────────────────────

  it("scheduled create carrying query → 400, nothing persisted (006 discriminant preserved)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      await expectCreateRejectedAndNothingPersisted(app, deviceKey, {
        kind: "scheduled",
        targetingMode: "apply_to_all",
        text: "saca la basura",
        weekdays: ["mon"],
        query: "excursión",
      });
    } finally {
      await app.close();
    }
  });

  // ── calendar_gated specific: membership-only targeting (AC-05) ───────────────────────────

  it("calendar_gated specific create: assignment without weekdays succeeds — membership-only targeting (AC-05)", async () => {
    const { deviceKey } = seedKeys();
    const memberId = seedMember();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/reminders",
        cookies: { mp_device_key: deviceKey },
        payload: {
          kind: "calendar_gated",
          targetingMode: "specific",
          text: "lleva la mochila",
          query: "excursión",
          assignments: [{ memberId }],
        },
      });
      expect(res.statusCode).toBe(201);
      const created = JSON.parse(res.body);
      expect(created.kind).toBe("calendar_gated");
      expect(created.targetingMode).toBe("specific");
      expect(created.weekdays).toBeNull();
      expect(created.assignments).toEqual([
        { id: expect.any(String), memberId, weekdays: [], active: true },
      ]);
    } finally {
      await app.close();
    }
  });

  it("calendar_gated specific create: assignment with EXPLICIT empty weekdays: [] also succeeds (membership-only)", async () => {
    const { deviceKey } = seedKeys();
    const memberId = seedMember();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/reminders",
        cookies: { mp_device_key: deviceKey },
        payload: {
          kind: "calendar_gated",
          targetingMode: "specific",
          text: "lleva la mochila",
          query: "excursión",
          assignments: [{ memberId, weekdays: [] }],
        },
      });
      expect(res.statusCode).toBe(201);
      const created = JSON.parse(res.body);
      expect(created.assignments).toEqual([
        { id: expect.any(String), memberId, weekdays: [], active: true },
      ]);
    } finally {
      await app.close();
    }
  });

  it("calendar_gated specific create with an inactive member → 400, nothing persisted (membership requires active status)", async () => {
    const { deviceKey } = seedKeys();
    const db = getDb();
    const memberId = `${Date.now()}-archived`;
    const now = Date.now();
    db.prepare(
      "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, 'child', 'archived', ?, ?)"
    ).run(memberId, "Archived", now, now);
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      await expectCreateRejectedAndNothingPersisted(app, deviceKey, {
        kind: "calendar_gated",
        targetingMode: "specific",
        text: "lleva la mochila",
        query: "excursión",
        assignments: [{ memberId }],
      });
    } finally {
      await app.close();
    }
  });

  it("calendar_gated create with targetingMode outside {apply_to_all, specific} → 400, nothing persisted (no member-attribute targeting mode)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      await expectCreateRejectedAndNothingPersisted(app, deviceKey, {
        kind: "calendar_gated",
        targetingMode: "by_role",
        text: "lleva la mochila",
        query: "excursión",
      });
    } finally {
      await app.close();
    }
  });

  it("calendar_gated specific: emission is via assignment only — an unassigned active member never emits, even though it matches the query (AC-05)", async () => {
    const { deviceKey } = seedKeys();
    const memberA = seedMember();
    const memberB = seedMember();
    const now = Date.now();
    const db = getDb();
    db.prepare(
      "INSERT INTO calendar_events (id, source, title, all_day, start_date, end_date, created_at, updated_at) VALUES (?, 'local', ?, 1, ?, ?, ?, ?)"
    ).run("excursion-evt", "Excursión al museo", "2026-08-17", "2026-08-18", now, now);
    db.prepare(
      "INSERT INTO calendar_assignments (id, event_id, member_id, created_at) VALUES (?, ?, ?, ?)"
    ).run("excursion-evt-a", "excursion-evt", memberA, now);
    db.prepare(
      "INSERT INTO calendar_assignments (id, event_id, member_id, created_at) VALUES (?, ?, ?, ?)"
    ).run("excursion-evt-b", "excursion-evt", memberB, now);

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/reminders",
        cookies: { mp_device_key: deviceKey },
        payload: {
          kind: "calendar_gated",
          targetingMode: "specific",
          text: "lleva la mochila",
          query: "excursión",
          assignments: [{ memberId: memberA }],
        },
      });
      expect(createRes.statusCode).toBe(201);
      const created = JSON.parse(createRes.body);

      const emitRes = await app.inject({
        method: "GET",
        url: `/api/reminders/emissions?memberId=${memberA}&date=2026-08-17`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(JSON.parse(emitRes.body)).toEqual([{ id: created.id, text: "lleva la mochila" }]);

      // memberB matches the SAME event/query but holds no assignment on this rule — no emission.
      const notTargetedRes = await app.inject({
        method: "GET",
        url: `/api/reminders/emissions?memberId=${memberB}&date=2026-08-17`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(JSON.parse(notTargetedRes.body)).toEqual([]);
    } finally {
      await app.close();
    }
  });

  // ── queryFields default ──────────────────────────────────────────────────────

  it("calendar_gated create omitting queryFields persists the default ['title','description'] (finding #4)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/reminders",
        cookies: { mp_device_key: deviceKey },
        payload: {
          kind: "calendar_gated",
          targetingMode: "apply_to_all",
          text: "lleva la mochila",
          query: "excursión",
        },
      });
      expect(res.statusCode).toBe(201);
      const created = JSON.parse(res.body);
      expect(created.queryFields).toEqual(["title", "description"]);

      const getRes = await app.inject({
        method: "GET",
        url: `/api/reminders/${created.id}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(JSON.parse(getRes.body).queryFields).toEqual(["title", "description"]);
    } finally {
      await app.close();
    }
  });

  // ── PATCH edit-boundary discriminant ─────────────────────────────────────────

  async function createCalendarGatedRule(
    app: import("fastify").FastifyInstance,
    deviceKey: string,
    overrides: Record<string, unknown> = {}
  ) {
    const res = await app.inject({
      method: "POST",
      url: "/api/reminders",
      cookies: { mp_device_key: deviceKey },
      payload: {
        kind: "calendar_gated",
        targetingMode: "apply_to_all",
        text: "lleva la mochila",
        query: "excursión",
        ...overrides,
      },
    });
    expect(res.statusCode).toBe(201);
    return JSON.parse(res.body);
  }

  it("PATCH editing query/queryFields on a calendar_gated rule → 200, accepted (finding #5)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const created = await createCalendarGatedRule(app, deviceKey);

      const patchRes = await app.inject({
        method: "PATCH",
        url: `/api/reminders/${created.id}`,
        cookies: { mp_device_key: deviceKey },
        payload: { query: "excursion", queryFields: ["title"] },
      });
      expect(patchRes.statusCode).toBe(200);
      const patched = JSON.parse(patchRes.body);
      expect(patched.query).toBe("excursion");
      expect(patched.queryFields).toEqual(["title"]);
    } finally {
      await app.close();
    }
  });

  it("PATCH editing ONLY query (omitting queryFields) leaves the stored queryFields UNCHANGED (finding #4′)", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const created = await createCalendarGatedRule(app, deviceKey, {
        queryFields: ["title", "location"],
      });
      expect(created.queryFields).toEqual(["title", "location"]);

      const patchRes = await app.inject({
        method: "PATCH",
        url: `/api/reminders/${created.id}`,
        cookies: { mp_device_key: deviceKey },
        payload: { query: "excursion" },
      });
      expect(patchRes.statusCode).toBe(200);
      const patched = JSON.parse(patchRes.body);
      expect(patched.query).toBe("excursion");
      expect(patched.queryFields).toEqual(["title", "location"]);
    } finally {
      await app.close();
    }
  });

  it("PATCH query on a scheduled rule → 400, nothing changed (edit-boundary discriminant, finding #5)", async () => {
    const { deviceKey } = seedKeys();
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
          weekdays: ["mon"],
        },
      });
      const created = JSON.parse(createRes.body);

      const patchRes = await app.inject({
        method: "PATCH",
        url: `/api/reminders/${created.id}`,
        cookies: { mp_device_key: deviceKey },
        payload: { query: "excursión" },
      });
      expect(patchRes.statusCode).toBe(400);
      expect(JSON.parse(patchRes.body)).toHaveProperty("error");

      const getRes = await app.inject({
        method: "GET",
        url: `/api/reminders/${created.id}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(JSON.parse(getRes.body)).toEqual(created);
    } finally {
      await app.close();
    }
  });

  it("PATCH queryFields on a scheduled rule → 400, nothing changed (edit-boundary discriminant, finding #5)", async () => {
    const { deviceKey } = seedKeys();
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
          weekdays: ["mon"],
        },
      });
      const created = JSON.parse(createRes.body);

      const patchRes = await app.inject({
        method: "PATCH",
        url: `/api/reminders/${created.id}`,
        cookies: { mp_device_key: deviceKey },
        payload: { queryFields: ["title"] },
      });
      expect(patchRes.statusCode).toBe(400);
      expect(JSON.parse(patchRes.body)).toHaveProperty("error");

      const getRes = await app.inject({
        method: "GET",
        url: `/api/reminders/${created.id}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(JSON.parse(getRes.body)).toEqual(created);
    } finally {
      await app.close();
    }
  });

  // ── carry-in: PATCH weekdays on a calendar_gated row → 400, not 500 ────────────────

  it("PATCH weekdays on a calendar_gated (apply_to_all) rule → 400, not 500 (#497 carry-in), nothing changed", async () => {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const created = await createCalendarGatedRule(app, deviceKey);

      const patchRes = await app.inject({
        method: "PATCH",
        url: `/api/reminders/${created.id}`,
        cookies: { mp_device_key: deviceKey },
        payload: { weekdays: ["mon"] },
      });
      expect(patchRes.statusCode).toBe(400);
      expect(JSON.parse(patchRes.body)).toHaveProperty("error");

      const getRes = await app.inject({
        method: "GET",
        url: `/api/reminders/${created.id}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(JSON.parse(getRes.body)).toEqual(created);
    } finally {
      await app.close();
    }
  });

  it("PATCH weekdays on a calendar_gated specific rule → 400, not 500 (#497 carry-in), nothing changed", async () => {
    const { deviceKey } = seedKeys();
    const memberId = seedMember();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const created = await createCalendarGatedRule(app, deviceKey, {
        targetingMode: "specific",
        assignments: [{ memberId }],
      });

      const patchRes = await app.inject({
        method: "PATCH",
        url: `/api/reminders/${created.id}`,
        cookies: { mp_device_key: deviceKey },
        payload: { weekdays: ["mon"] },
      });
      expect(patchRes.statusCode).toBe(400);
      expect(JSON.parse(patchRes.body)).toHaveProperty("error");

      const getRes = await app.inject({
        method: "GET",
        url: `/api/reminders/${created.id}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(JSON.parse(getRes.body)).toEqual(created);
    } finally {
      await app.close();
    }
  });

  // ── PUT /api/reminders/:id/assignments kind-aware ─────────────────

  it("PUT /:id/assignments on a calendar_gated rule with [{memberId}] (no weekdays) → 200/success, membership persisted", async () => {
    const { deviceKey } = seedKeys();
    const memberId = seedMember();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const created = await createCalendarGatedRule(app, deviceKey, {
        targetingMode: "specific",
        assignments: [{ memberId }],
      });

      const otherMemberId = seedMember();
      const putRes = await app.inject({
        method: "PUT",
        url: `/api/reminders/${created.id}/assignments`,
        cookies: { mp_device_key: deviceKey },
        payload: { assignments: [{ memberId: otherMemberId }] },
      });
      expect(putRes.statusCode).toBe(200);
      expect(JSON.parse(putRes.body)).toEqual([
        { id: expect.any(String), memberId: otherMemberId, weekdays: [], active: true },
      ]);

      const getRes = await app.inject({
        method: "GET",
        url: `/api/reminders/${created.id}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(JSON.parse(getRes.body).assignments).toEqual([
        { id: expect.any(String), memberId: otherMemberId, weekdays: [], active: true },
      ]);
    } finally {
      await app.close();
    }
  });

  it("PUT /:id/assignments on a calendar_gated rule with [{memberId, weekdays:['mon']}] → 400, nothing persisted (INV-01/INV-09)", async () => {
    const { deviceKey } = seedKeys();
    const memberId = seedMember();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const created = await createCalendarGatedRule(app, deviceKey, {
        targetingMode: "specific",
        assignments: [{ memberId }],
      });

      const otherMemberId = seedMember();
      const putRes = await app.inject({
        method: "PUT",
        url: `/api/reminders/${created.id}/assignments`,
        cookies: { mp_device_key: deviceKey },
        payload: { assignments: [{ memberId: otherMemberId, weekdays: ["mon"] }] },
      });
      expect(putRes.statusCode).toBe(400);
      expect(JSON.parse(putRes.body)).toHaveProperty("error");

      const getRes = await app.inject({
        method: "GET",
        url: `/api/reminders/${created.id}`,
        cookies: { mp_device_key: deviceKey },
      });
      expect(JSON.parse(getRes.body)).toEqual(created);
    } finally {
      await app.close();
    }
  });

  it("PUT /:id/assignments on a scheduled specific rule is unaffected (regression guard) — [{memberId, weekdays}] still required", async () => {
    const { deviceKey } = seedKeys();
    const memberId = seedMember();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/reminders",
        cookies: { mp_device_key: deviceKey },
        payload: {
          kind: "scheduled",
          targetingMode: "specific",
          text: "coges el bus",
          assignments: [{ memberId, weekdays: ["mon"] }],
        },
      });
      expect(createRes.statusCode).toBe(201);
      const created = JSON.parse(createRes.body);

      const otherMemberId = seedMember();

      // membership-only shape (no weekdays), valid for calendar_gated, MUST still be rejected here.
      const rejectRes = await app.inject({
        method: "PUT",
        url: `/api/reminders/${created.id}/assignments`,
        cookies: { mp_device_key: deviceKey },
        payload: { assignments: [{ memberId: otherMemberId }] },
      });
      expect(rejectRes.statusCode).toBe(400);
      expect(JSON.parse(rejectRes.body)).toHaveProperty("error");

      // the 006 weekday-bearing shape still succeeds.
      const okRes = await app.inject({
        method: "PUT",
        url: `/api/reminders/${created.id}/assignments`,
        cookies: { mp_device_key: deviceKey },
        payload: { assignments: [{ memberId: otherMemberId, weekdays: ["tue"] }] },
      });
      expect(okRes.statusCode).toBe(200);
      expect(JSON.parse(okRes.body)).toEqual([
        { id: expect.any(String), memberId: otherMemberId, weekdays: ["tue"], active: true },
      ]);
    } finally {
      await app.close();
    }
  });
});
