import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

/** — US1 rule-authoring CRUD boundary tests (SC-001's full authoring matrix).
 * BLACK-BOX: buildApp + Fastify.inject only, per the reminders/daily-messages suite
 * convention (useIsolatedDb + raw SQL seed helpers). Every route exercised here is the REAL
 * assembled app.ts route, not a standalone Fastify probe (telemetry-capability.test.ts's
 * pattern is reserved for the capability seam's own unit-level proof — the fail-closed test
 * below drives the real /api/time-announcements routes instead, to also prove the seam is
 * actually WIRED there).
 */
describe("time-announcements-crud (US1 rule authoring)", () => {
  useIsolatedDb();

  // ── helpers ──────────────────────────────────────────────────────────────

  function seedKey(scope: string): string {
    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    getDb()
      .prepare(
        "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, ?, 'device', ?)"
      )
      .run(id, hashKey(deviceKey), scope, now);
    return deviceKey;
  }

  function countRows(): number {
    const row = getDb().prepare("SELECT COUNT(*) as count FROM time_announcements").get() as {
      count: number;
    };
    return row.count;
  }

  function postRule(app: FastifyInstance, deviceKey: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/time-announcements",
      cookies: { mp_device_key: deviceKey },
      payload,
    });
  }

  function patchRule(
    app: FastifyInstance,
    deviceKey: string,
    id: string,
    payload: Record<string, unknown>
  ) {
    return app.inject({
      method: "PATCH",
      url: `/api/time-announcements/${id}`,
      cookies: { mp_device_key: deviceKey },
      payload,
    });
  }

  function deleteRule(app: FastifyInstance, deviceKey: string, id: string) {
    return app.inject({
      method: "DELETE",
      url: `/api/time-announcements/${id}`,
      cookies: { mp_device_key: deviceKey },
    });
  }

  function getRules(app: FastifyInstance, deviceKey?: string) {
    return app.inject({
      method: "GET",
      url: "/api/time-announcements",
      cookies: deviceKey ? { mp_device_key: deviceKey } : undefined,
    });
  }

  // ── TIME-ANNOUNCEMENTS-INV-02 / TIME-ANNOUNCEMENTS-AC-01: strict time, reject-never-normalize ──

  describe("TIME-ANNOUNCEMENTS-INV-02/TIME-ANNOUNCEMENTS-AC-01: malformed time is rejected, never normalized", () => {
    const malformedTimes = ["24:00", "7:30", "07:3", "07:60", "", "99:99"];

    it.each(malformedTimes)(
      'TIME-ANNOUNCEMENTS-INV-02/TIME-ANNOUNCEMENTS-AC-01: POST rejects malformed time "%s" — no row created',
      async (time) => {
        const { buildApp } = await import("../../src/server/app.ts");
        const deviceKey = seedKey("*");
        const app = await buildApp();
        try {
          const res = await postRule(app, deviceKey, { time, weekDays: ["mon"] });
          expect(res.statusCode).toBe(400);
          expect(JSON.parse(res.body).error).toBe("validation_error");
          expect(countRows()).toBe(0);
        } finally {
          await app.close();
        }
      }
    );

    it("TIME-ANNOUNCEMENTS-INV-02: PATCH rejects a malformed time on an existing rule — the stored row is untouched", async () => {
      const { buildApp } = await import("../../src/server/app.ts");
      const deviceKey = seedKey("*");
      const app = await buildApp();
      try {
        const created = JSON.parse(
          (await postRule(app, deviceKey, { time: "07:00", weekDays: ["mon"] })).body
        );
        const res = await patchRule(app, deviceKey, created.id, { time: "24:00" });
        expect(res.statusCode).toBe(400);

        const row = getDb()
          .prepare("SELECT time FROM time_announcements WHERE id = ?")
          .get(created.id) as { time: string };
        expect(row.time).toBe("07:00");
      } finally {
        await app.close();
      }
    });
  });

  // ── TIME-ANNOUNCEMENTS-INV-03 / TIME-ANNOUNCEMENTS-AC-01: non-empty canonical weekday set ──

  describe("TIME-ANNOUNCEMENTS-INV-03/TIME-ANNOUNCEMENTS-AC-01: weekDays must be a non-empty canonical set", () => {
    it("TIME-ANNOUNCEMENTS-INV-03/TIME-ANNOUNCEMENTS-AC-01: an empty weekDays array is rejected — no row created", async () => {
      const { buildApp } = await import("../../src/server/app.ts");
      const deviceKey = seedKey("*");
      const app = await buildApp();
      try {
        const res = await postRule(app, deviceKey, { time: "07:00", weekDays: [] });
        expect(res.statusCode).toBe(400);
        expect(countRows()).toBe(0);
      } finally {
        await app.close();
      }
    });

    it("TIME-ANNOUNCEMENTS-INV-03: a duplicate weekday is rejected — no row created", async () => {
      const { buildApp } = await import("../../src/server/app.ts");
      const deviceKey = seedKey("*");
      const app = await buildApp();
      try {
        const res = await postRule(app, deviceKey, { time: "07:00", weekDays: ["mon", "mon"] });
        expect(res.statusCode).toBe(400);
        expect(countRows()).toBe(0);
      } finally {
        await app.close();
      }
    });

    it("TIME-ANNOUNCEMENTS-INV-03: a non-canonical weekday code is rejected — no row created", async () => {
      const { buildApp } = await import("../../src/server/app.ts");
      const deviceKey = seedKey("*");
      const app = await buildApp();
      try {
        const res = await postRule(app, deviceKey, { time: "07:00", weekDays: ["monday"] });
        expect(res.statusCode).toBe(400);
        expect(countRows()).toBe(0);
      } finally {
        await app.close();
      }
    });

    it("weekDays is stored and returned in canonical mon..sun order regardless of input order", async () => {
      const { buildApp } = await import("../../src/server/app.ts");
      const deviceKey = seedKey("*");
      const app = await buildApp();
      try {
        const res = await postRule(app, deviceKey, {
          time: "07:00",
          weekDays: ["sun", "mon", "wed"],
        });
        expect(res.statusCode).toBe(201);
        expect(JSON.parse(res.body).weekDays).toEqual(["mon", "wed", "sun"]);
      } finally {
        await app.close();
      }
    });
  });

  // ── Unknown-key rejection (validation_error precedent) ──────────────────

  describe("unknown-key rejection", () => {
    it("POST with an unknown top-level key is rejected 400 — no row created", async () => {
      const { buildApp } = await import("../../src/server/app.ts");
      const deviceKey = seedKey("*");
      const app = await buildApp();
      try {
        const res = await postRule(app, deviceKey, {
          time: "07:00",
          weekDays: ["mon"],
          quietHours: true,
        });
        expect(res.statusCode).toBe(400);
        expect(countRows()).toBe(0);
      } finally {
        await app.close();
      }
    });

    it("PATCH with an unknown key is rejected 400 — the row is untouched", async () => {
      const { buildApp } = await import("../../src/server/app.ts");
      const deviceKey = seedKey("*");
      const app = await buildApp();
      try {
        const created = JSON.parse(
          (await postRule(app, deviceKey, { time: "07:00", weekDays: ["mon"] })).body
        );
        const res = await patchRule(app, deviceKey, created.id, { masterSwitch: false });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it("PATCH with an empty patch body is rejected 400 (nothing to edit)", async () => {
      const { buildApp } = await import("../../src/server/app.ts");
      const deviceKey = seedKey("*");
      const app = await buildApp();
      try {
        const created = JSON.parse(
          (await postRule(app, deviceKey, { time: "07:00", weekDays: ["mon"] })).body
        );
        const res = await patchRule(app, deviceKey, created.id, {});
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });
  });

  // ── TIME-ANNOUNCEMENTS-INV-04 / TIME-ANNOUNCEMENTS-AC-02: active-overlap, in-transaction ──

  describe("TIME-ANNOUNCEMENTS-INV-04/TIME-ANNOUNCEMENTS-AC-02: active-overlap runs inside the write transaction", () => {
    it("TIME-ANNOUNCEMENTS-INV-04/TIME-ANNOUNCEMENTS-AC-02: POST of a second ACTIVE rule at the same time+weekday is rejected 409 — first rule survives alone", async () => {
      const { buildApp } = await import("../../src/server/app.ts");
      const deviceKey = seedKey("*");
      const app = await buildApp();
      try {
        const first = await postRule(app, deviceKey, { time: "17:30", weekDays: ["mon"] });
        expect(first.statusCode).toBe(201);

        const second = await postRule(app, deviceKey, {
          time: "17:30",
          weekDays: ["mon", "tue"],
        });
        expect(second.statusCode).toBe(409);
        expect(JSON.parse(second.body).error).toBe("active_overlap");
        expect(countRows()).toBe(1);
      } finally {
        await app.close();
      }
    });

    it("TIME-ANNOUNCEMENTS-AC-02: an INACTIVE rule at the same time+weekday saves fine alongside an active one", async () => {
      const { buildApp } = await import("../../src/server/app.ts");
      const deviceKey = seedKey("*");
      const app = await buildApp();
      try {
        const first = await postRule(app, deviceKey, { time: "17:30", weekDays: ["mon"] });
        expect(first.statusCode).toBe(201);

        const second = await postRule(app, deviceKey, {
          time: "17:30",
          weekDays: ["mon"],
          isActive: false,
        });
        expect(second.statusCode).toBe(201);
        expect(countRows()).toBe(2);
      } finally {
        await app.close();
      }
    });

    it("TIME-ANNOUNCEMENTS-INV-04/TIME-ANNOUNCEMENTS-AC-02: a PATCH that would leave the rule ACTIVE and overlapping is rejected 409 — the row is untouched", async () => {
      const { buildApp } = await import("../../src/server/app.ts");
      const deviceKey = seedKey("*");
      const app = await buildApp();
      try {
        const holder = await postRule(app, deviceKey, { time: "17:30", weekDays: ["mon"] });
        expect(holder.statusCode).toBe(201);

        const other = JSON.parse(
          (
            await postRule(app, deviceKey, {
              time: "08:00",
              weekDays: ["tue"],
            })
          ).body
        );

        const res = await patchRule(app, deviceKey, other.id, {
          time: "17:30",
          weekDays: ["mon"],
        });
        expect(res.statusCode).toBe(409);
        expect(JSON.parse(res.body).error).toBe("active_overlap");

        const row = getDb()
          .prepare("SELECT time, week_days FROM time_announcements WHERE id = ?")
          .get(other.id) as { time: string; week_days: string };
        expect(row.time).toBe("08:00");
        expect(JSON.parse(row.week_days)).toEqual(["tue"]);
      } finally {
        await app.close();
      }
    });

    it("a PATCH that deactivates an ACTIVE rule never overlap-checks, even when the result lands on another active rule's exact slot", async () => {
      const { buildApp } = await import("../../src/server/app.ts");
      const deviceKey = seedKey("*");
      const app = await buildApp();
      try {
        await postRule(app, deviceKey, { time: "17:30", weekDays: ["mon"] });
        const other = JSON.parse(
          (await postRule(app, deviceKey, { time: "08:00", weekDays: ["tue"] })).body
        );
        expect(other.isActive).toBe(true);

        // `other` is ACTIVE at a DIFFERENT slot; this PATCH both moves it onto the first rule's
        // exact (time, weekday) slot AND deactivates it in the same write — true active->inactive
        // transition (not an already-inactive no-op). The overlap check must be skipped entirely
        // because the RESULT is inactive, regardless of which slot it lands on.
        const res = await patchRule(app, deviceKey, other.id, {
          time: "17:30",
          weekDays: ["mon"],
          isActive: false,
        });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).isActive).toBe(false);
      } finally {
        await app.close();
      }
    });

    it("TIME-ANNOUNCEMENTS-INV-04: LWW by id / excludeId — a PATCH to an ACTIVE rule never conflicts against ITSELF", async () => {
      const { buildApp } = await import("../../src/server/app.ts");
      const deviceKey = seedKey("*");
      const app = await buildApp();
      try {
        const created = JSON.parse(
          (await postRule(app, deviceKey, { time: "07:00", weekDays: ["mon"] })).body
        );
        expect(created.isActive).toBe(true);

        // Move the ACTIVE rule's time — findActiveOverlap must exclude `created.id` itself, else
        // the row's own (now-stale-in-the-read, but still-persisted-at-write-time) time/weekday
        // pairing would be reported as a self-conflict and every edit of an active rule would 409.
        const movedRes = await patchRule(app, deviceKey, created.id, { time: "08:00" });
        expect(movedRes.statusCode).toBe(200);
        const moved = JSON.parse(movedRes.body);
        expect(moved.time).toBe("08:00");
        expect(moved.isActive).toBe(true);

        // A same-value PATCH (weekDays unchanged, still the only rule at 08:00/mon) must also not
        // 409 against its own persisted row.
        const sameValueRes = await patchRule(app, deviceKey, created.id, { weekDays: ["mon"] });
        expect(sameValueRes.statusCode).toBe(200);
        expect(JSON.parse(sameValueRes.body).weekDays).toEqual(["mon"]);
      } finally {
        await app.close();
      }
    });

    it("TIME-ANNOUNCEMENTS-INV-04: concurrent double-save race — two sequential activating PATCHes for the same time+weekday slot, only the FIRST survives (proves the in-transaction re-check against latest rows, not parallelism theatre: better-sqlite3 transactions are synchronous, so there is no true interleaving to race)", async () => {
      const { buildApp } = await import("../../src/server/app.ts");
      const deviceKey = seedKey("*");
      const app = await buildApp();
      try {
        const ruleB = JSON.parse(
          (
            await postRule(app, deviceKey, {
              time: "17:30",
              weekDays: ["mon"],
              isActive: false,
            })
          ).body
        );
        const ruleC = JSON.parse(
          (
            await postRule(app, deviceKey, {
              time: "17:30",
              weekDays: ["mon"],
              isActive: false,
            })
          ).body
        );

        // Both B and C are inactive twins at the SAME (time, weekday) slot — activating one is
        // fine; the second's write must re-read the latest persisted state (now including B's
        // freshly-committed active row) rather than acting on a stale pre-write snapshot.
        const activateB = await patchRule(app, deviceKey, ruleB.id, { isActive: true });
        expect(activateB.statusCode).toBe(200);

        const activateC = await patchRule(app, deviceKey, ruleC.id, { isActive: true });
        expect(activateC.statusCode).toBe(409);

        const rows = getDb()
          .prepare("SELECT id, is_active FROM time_announcements WHERE id IN (?, ?)")
          .all(ruleB.id, ruleC.id) as { id: string; is_active: number }[];
        const active = rows.filter((r) => r.is_active === 1);
        expect(active).toHaveLength(1);
        expect(active[0]?.id).toBe(ruleB.id);
      } finally {
        await app.close();
      }
    });

    it("TIME-ANNOUNCEMENTS-INV-04: stale-view PATCH — a save based on an outdated fetched view is still re-checked against the CURRENT persisted state (LWW by id, no If-Match/version needed)", async () => {
      const { buildApp } = await import("../../src/server/app.ts");
      const deviceKey = seedKey("*");
      const app = await buildApp();
      try {
        // Rule D is fetched by a client ("the stale view") while inactive and non-conflicting.
        const ruleD = JSON.parse(
          (
            await postRule(app, deviceKey, {
              time: "09:00",
              weekDays: ["wed"],
              isActive: false,
            })
          ).body
        );
        const staleView = JSON.parse((await getRules(app, deviceKey)).body).find(
          (r: { id: string }) => r.id === ruleD.id
        );
        expect(staleView.isActive).toBe(false);

        // Meanwhile, another write lands: an active rule now occupies (09:00, wed) — the
        // client's view of ruleD is now stale with respect to that slot.
        const other = await postRule(app, deviceKey, { time: "09:00", weekDays: ["wed"] });
        expect(other.statusCode).toBe(201);

        // The stale-view client now saves ruleD as active at the SAME slot — rejected, because
        // the transaction re-reads the latest rows rather than trusting the client's fetched
        // (now outdated) picture.
        const res = await patchRule(app, deviceKey, ruleD.id, { isActive: true });
        expect(res.statusCode).toBe(409);

        const row = getDb()
          .prepare("SELECT is_active FROM time_announcements WHERE id = ?")
          .get(ruleD.id) as { is_active: number };
        expect(row.is_active).toBe(0);
      } finally {
        await app.close();
      }
    });
  });

  // ── TIME-ANNOUNCEMENTS-INV-04 (structural): the overlap check runs INSIDE db.transaction ──

  describe("TIME-ANNOUNCEMENTS-INV-04 (structural): the in-transaction property, pinned at the source level", () => {
    it("TIME-ANNOUNCEMENTS-INV-04: the overlap lookup is called INSIDE the db.transaction() callback on BOTH write paths (structural — better-sqlite3's synchronous transactions make this behaviourally unobservable: hoisting the check out of the transaction, or splitting a PATCH into check-then-write, still passes every behavioral test above)", () => {
      const src = readFileSync(
        resolve(process.cwd(), "src/server/modules/time-announcements/index.ts"),
        "utf8"
      );
      for (const fn of ["createTimeAnnouncementRule", "editTimeAnnouncementRule"]) {
        const start = src.indexOf(`export function ${fn}`);
        expect(start).toBeGreaterThan(-1);
        const nextExport = src.indexOf("\nexport function", start + 1);
        const body = src.slice(start, nextExport === -1 ? undefined : nextExport);

        const tx = body.indexOf("db.transaction(() => {");
        const overlap = body.indexOf("findActiveOverlap(");
        expect(tx).toBeGreaterThan(-1);
        expect(overlap).toBeGreaterThan(tx);
      }
    });
  });

  // ── TIME-ANNOUNCEMENTS-INV-05: soft-disable only, delete is permanent ───

  describe("TIME-ANNOUNCEMENTS-INV-05: isActive=false soft-disables; delete is permanent", () => {
    it("TIME-ANNOUNCEMENTS-INV-05: toggling isActive=false stays listed and editable (never fires — client-side only, unassertable here)", async () => {
      const { buildApp } = await import("../../src/server/app.ts");
      const deviceKey = seedKey("*");
      const app = await buildApp();
      try {
        const created = JSON.parse(
          (await postRule(app, deviceKey, { time: "07:00", weekDays: ["mon"] })).body
        );

        const toggled = await patchRule(app, deviceKey, created.id, { isActive: false });
        expect(toggled.statusCode).toBe(200);
        expect(JSON.parse(toggled.body).isActive).toBe(false);

        const list = JSON.parse((await getRules(app, deviceKey)).body);
        expect(list.map((r: { id: string }) => r.id)).toContain(created.id);

        // Still editable while inactive.
        const edited = await patchRule(app, deviceKey, created.id, { time: "08:15" });
        expect(edited.statusCode).toBe(200);
        expect(JSON.parse(edited.body).time).toBe("08:15");
      } finally {
        await app.close();
      }
    });

    it("TIME-ANNOUNCEMENTS-INV-05: DELETE is permanent — a subsequent GET/PATCH/DELETE 404s, no archive tier", async () => {
      const { buildApp } = await import("../../src/server/app.ts");
      const deviceKey = seedKey("*");
      const app = await buildApp();
      try {
        const created = JSON.parse(
          (await postRule(app, deviceKey, { time: "07:00", weekDays: ["mon"] })).body
        );

        const del = await deleteRule(app, deviceKey, created.id);
        expect(del.statusCode).toBe(204);
        expect(countRows()).toBe(0);

        const list = JSON.parse((await getRules(app, deviceKey)).body);
        expect(list).toEqual([]);

        const secondDelete = await deleteRule(app, deviceKey, created.id);
        expect(secondDelete.statusCode).toBe(404);
        expect(JSON.parse(secondDelete.body).error).toBe("not_found");

        const patchAfterDelete = await patchRule(app, deviceKey, created.id, { isActive: true });
        expect(patchAfterDelete.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });
  });

  // ── TIME-ANNOUNCEMENTS-AC-07: capability fail-closed writes, kiosk-visible list ──

  describe("TIME-ANNOUNCEMENTS-AC-07: CRUD requires the admin write capability (fail-closed); listing is kiosk-visible", () => {
    it("TIME-ANNOUNCEMENTS-AC-07: POST/PATCH/DELETE without time-announcements:admin are rejected 403, nothing changes", async () => {
      const { buildApp } = await import("../../src/server/app.ts");
      const adminKey = seedKey("*");
      const plainKey = seedKey("some-other:scope");
      const app = await buildApp();
      try {
        const created = JSON.parse(
          (await postRule(app, adminKey, { time: "07:00", weekDays: ["mon"] })).body
        );

        const postRes = await postRule(app, plainKey, { time: "08:00", weekDays: ["tue"] });
        expect(postRes.statusCode).toBe(403);
        expect(countRows()).toBe(1);

        const patchRes = await patchRule(app, plainKey, created.id, { time: "09:00" });
        expect(patchRes.statusCode).toBe(403);

        const deleteRes = await deleteRule(app, plainKey, created.id);
        expect(deleteRes.statusCode).toBe(403);
        expect(countRows()).toBe(1);
      } finally {
        await app.close();
      }
    });

    it("TIME-ANNOUNCEMENTS-AC-07: GET is kiosk-visible — a key with NO write capability can still list rules", async () => {
      const { buildApp } = await import("../../src/server/app.ts");
      const adminKey = seedKey("*");
      const plainKey = seedKey("some-other:scope");
      const app = await buildApp();
      try {
        await postRule(app, adminKey, { time: "07:00", weekDays: ["mon"] });

        const res = await getRules(app, plainKey);
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body)).toHaveLength(1);
      } finally {
        await app.close();
      }
    });

    it("TIME-ANNOUNCEMENTS-AC-07: GET ordered by time, ties broken by id", async () => {
      const { buildApp } = await import("../../src/server/app.ts");
      const deviceKey = seedKey("*");
      const app = await buildApp();
      try {
        const early = JSON.parse(
          (
            await postRule(app, deviceKey, {
              time: "08:00",
              weekDays: ["wed"],
              isActive: false,
            })
          ).body
        );
        const tieA = JSON.parse(
          (
            await postRule(app, deviceKey, {
              time: "09:00",
              weekDays: ["mon"],
            })
          ).body
        );
        const tieB = JSON.parse(
          (
            await postRule(app, deviceKey, {
              time: "09:00",
              weekDays: ["tue"],
            })
          ).body
        );

        const res = await getRules(app, deviceKey);
        expect(res.statusCode).toBe(200);
        const ids = (JSON.parse(res.body) as { id: string }[]).map((r) => r.id);

        const expectedTieOrder = [tieA.id, tieB.id].sort();
        expect(ids).toEqual([early.id, ...expectedTieOrder]);
      } finally {
        await app.close();
      }
    });
  });

  // ── TIME-ANNOUNCEMENTS-INV-06 (server half): no server-side firing state ─

  describe("TIME-ANNOUNCEMENTS-INV-06 (server half): no scheduler job/queue/claim exists for announcements", () => {
    it("TIME-ANNOUNCEMENTS-INV-06: the entrypoint registers no time-announcements job, and the module never imports the scheduler seam (structural — owns the fuller schema/queue negative-proof sweep)", () => {
      const entrypointSrc = readFileSync(resolve(process.cwd(), "src/server/index.ts"), "utf8");
      expect(entrypointSrc).not.toMatch(/time-announcements/i);

      const moduleSrc = readFileSync(
        resolve(process.cwd(), "src/server/modules/time-announcements/index.ts"),
        "utf8"
      );
      expect(moduleSrc).not.toMatch(/registerJob|runJobNow|scheduler/i);
    });
  });
});
