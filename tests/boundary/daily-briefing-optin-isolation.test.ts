import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Briefing, OptInState } from "../../src/shared";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import * as hostApi from "../../src/server/host-api";
import { getScheduler, initScheduler } from "../../src/server/scheduler/index";
import {
  DAILY_BRIEFING_JOB_ID,
  registerDailyBriefingJob,
} from "../../src/server/modules/daily-briefing/job";
import * as dailyBriefingModule from "../../src/server/modules/daily-briefing/index";
import { useIsolatedDb } from "../helpers/db";

/** RED contract for. It drives the real HTTP boundary: generation
 * eligibility is Daily Briefing-owned, while source failures are observable in
 * the frozen snapshot rather than escaping to the caller.
 */
describe("daily-briefing opt-in + failure-isolation boundary (T012)", () => {
  useIsolatedDb();

  let app: FastifyInstance;
  let deviceKey: string;
  let optedInMemberId: string;
  let nonOptedInMemberId: string;
  let archivedOptedInMemberId: string;
  const date = "2026-08-21";
  // hoisted so `afterEach` can release an
  // in-flight collision gate UNCONDITIONALLY, even when the test that armed
  // it fails an assertion first. Left unreleased, `getScheduler.stop`
  // below hangs draining the still-in-flight run and every subsequent test
  // in this file dies with "already initialized".
  let releaseCollisionGate: (() => void) | undefined;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-21T12:00:00.000Z"));
    const now = Date.now();
    const db = getDb();
    deviceKey = `mpk-${now}-${Math.random().toString(36).slice(2)}`;
    optedInMemberId = `opted-in-${now}`;
    nonOptedInMemberId = `non-opted-in-${now}`;
    archivedOptedInMemberId = `archived-opted-in-${now}`;

    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`device-${now}`, hashKey(deviceKey), now);
    seedMember(optedInMemberId, "Ada", "active", now);
    seedMember(nonOptedInMemberId, "Bea", "active", now);
    seedMember(archivedOptedInMemberId, "Cleo", "archived", now);
    seedOptIn(optedInMemberId, now);
    seedOptIn(archivedOptedInMemberId, now);
    db.prepare(
      "UPDATE plugin_activation_registry SET state = 'active', activated_at = ?, updated_at = ?"
    ).run(new Date(now).toISOString(), new Date(now).toISOString());

    const { buildApp } = await import("../../src/server/app.ts");
    app = await buildApp();

    //: `buildApp` stays scheduler-free (FR-015 structural
    // gating) so the route's `runJobNow` needs a live singleton wired in
    // manually here — the real entrypoint does this via `startScheduler`
    // (src/server/index.ts) after `app.listen`, never inside `buildApp`.
    // Never `scheduler.start`: these tests only ever drive the job through
    // its manual entry point, so no wall-clock trigger should ever arm.
    initScheduler();
    registerDailyBriefingJob();
  });

  afterEach(async () => {
    //: release BEFORE anything else, unconditionally —
    // if the collision test failed its own assertion before calling this
    // itself, the gate is still pending and `getScheduler.stop` below
    // would otherwise hang draining the in-flight run for the full hook
    // timeout, cascading into every later test in this file.
    releaseCollisionGate?.();
    releaseCollisionGate = undefined;
    vi.restoreAllMocks();
    vi.useRealTimers();
    try {
      await getScheduler().stop();
    } catch {
      // not initialized by a given test path — nothing to drain.
    }
    await app?.close();
  });

  function seedMember(
    id: string,
    displayName: string,
    lifecycle: "active" | "archived",
    now: number
  ): void {
    getDb()
      .prepare(
        "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, 'child', ?, ?, ?)"
      )
      .run(id, displayName, lifecycle, now, now);
  }

  function seedOptIn(memberId: string, now = Date.now()): void {
    getDb()
      .prepare(
        "INSERT INTO daily_briefing_optin (member_id, enabled, created_at, updated_at) VALUES (?, 1, ?, ?)"
      )
      .run(memberId, now, now);
  }

  function auth() {
    return { mp_device_key: deviceKey };
  }

  async function generateAll(payload: Record<string, unknown> = {}) {
    return app.inject({
      method: "POST",
      url: "/api/daily-briefing/generate-all",
      cookies: auth(),
      payload,
    });
  }

  async function generateOne(memberId = optedInMemberId) {
    return app.inject({
      method: "POST",
      url: "/api/daily-briefing/generate",
      cookies: auth(),
      payload: { memberId, date },
    });
  }

  it("lists explicit opt-ins only, so an absent row remains opt-out by default", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/daily-briefing/opt-in",
      cookies: auth(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<OptInState[]>()).toEqual(
      expect.arrayContaining([
        { memberId: optedInMemberId, enabled: true },
        { memberId: archivedOptedInMemberId, enabled: true },
      ])
    );
    expect(response.json<OptInState[]>()).not.toContainEqual({
      memberId: nonOptedInMemberId,
      enabled: true,
    });
  });

  it.each(["inactive", "errored"] as const)(
    "withholds event-driven opt-in candidates while Daily Briefing is %s",
    (state) => {
      getDb()
        .prepare(
          `UPDATE plugin_activation_registry
           SET state = ?,
               error_code = ?,
               error_message = ?
           WHERE plugin_id = 'daily-briefing'`
        )
        .run(
          state,
          state === "errored" ? "contribution_failed" : null,
          state === "errored" ? "A plugin contribution failed." : null
        );

      expect(dailyBriefingModule.listOptIns()).toEqual([]);
      expect(
        getDb()
          .prepare("SELECT member_id, enabled FROM daily_briefing_optin ORDER BY member_id")
          .all()
      ).toEqual([
        { member_id: archivedOptedInMemberId, enabled: 1 },
        { member_id: optedInMemberId, enabled: 1 },
      ]);
    }
  );

  it("rejects opt-in writes for an archived member and unknown opt-in body keys", async () => {
    const archived = await app.inject({
      method: "PUT",
      url: `/api/daily-briefing/opt-in/${archivedOptedInMemberId}`,
      cookies: auth(),
      payload: { enabled: false },
    });
    expect(archived.statusCode).toBe(400);

    const unknownKey = await app.inject({
      method: "PUT",
      url: `/api/daily-briefing/opt-in/${optedInMemberId}`,
      cookies: auth(),
      payload: { enabled: true, unexpected: true },
    });
    expect(unknownKey.statusCode).toBe(400);
  });

  it("generate-all creates snapshots for active opted-in members only", async () => {
    const response = await generateAll({ date });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "completed",
      count: 1,
      generated: [{ memberId: optedInMemberId, status: "ready" }],
    });
    expect(
      getDb().prepare("SELECT member_id FROM daily_briefing ORDER BY member_id").all()
    ).toEqual([{ member_id: optedInMemberId }]);
  });

  it("BACKGROUND-JOBS-SCHEDULER-AC-02 / BACKGROUND-JOBS-SCHEDULER-INV-02: a collision with an in-flight run of the same job returns already_running at 200 with zero duplicate rows", async () => {
    const realGenerateAllBriefings = dailyBriefingModule.generateAllBriefings;
    const gate = new Promise<void>((resolve) => {
      releaseCollisionGate = resolve;
    });
    vi.spyOn(dailyBriefingModule, "generateAllBriefings").mockImplementation(
      (requestedDate?: string) => gate.then(() => realGenerateAllBriefings(requestedDate)) as never
    );

    // Occupies the scheduler's shared per-job guard synchronously (the guard
    // is check-and-set before any await, src/server/scheduler/index.ts
    // runGuarded/executeGuarded) — by the time this line returns, the job is
    // provably in flight, so the HTTP collision below is deterministic, not
    // a timing race.
    const inFlightRun = getScheduler().runJobNow(DAILY_BRIEFING_JOB_ID, { date });

    const collision = await generateAll({ date });
    expect(collision.statusCode).toBe(200);
    expect(collision.json()).toEqual({ status: "already_running" });
    expect(
      getDb()
        .prepare("SELECT COUNT(*) AS count FROM daily_briefing WHERE member_id = ?")
        .get(optedInMemberId)
    ).toEqual({ count: 0 });

    releaseCollisionGate?.();
    const firstResult = await inFlightRun;
    expect(firstResult).toMatchObject({ status: "completed" });

    // The collision performed NO generation of its own — exactly one row,
    // never two.
    expect(
      getDb()
        .prepare("SELECT COUNT(*) AS count FROM daily_briefing WHERE member_id = ?")
        .get(optedInMemberId)
    ).toEqual({ count: 1 });
  });

  it("F1 (PR #630 review) / #633 follow-up: a non-validation action throw surfaces as 500 internal_error, never a crash", async () => {
    // executeGuarded (src/server/scheduler/index.ts) never REJECTS — the manual entry point
    // (runJobNow) now surfaces a thrown action as a typed `{status:"failed", error}` result
    // (follow-up) instead of always resolving `completed` with an undefined result. This
    // route maps that back through the SAME handleDailyBriefingError used everywhere else: a
    // plain Error (not a DailyBriefingValidationError) still maps to the opaque 500
    // internal_error, exactly as it did before the seam change.
    vi.spyOn(dailyBriefingModule, "generateAllBriefings").mockImplementation(() => {
      throw new Error("member went inactive mid-generation");
    });

    const response = await generateAll({ date });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: "internal_error",
      message: "An unexpected error occurred",
    });
  });

  it("#633 follow-up: a DailyBriefingValidationError thrown by the action now surfaces as 400, not the opaque 500", async () => {
    // Distinct from the test above: the scheduler seam (src/server/scheduler/index.ts) now
    // forwards a manual run's raw thrown error to this route's `handleDailyBriefingError`, which
    // already `instanceof`-checks for DailyBriefingValidationError to answer 400 for every OTHER
    // generate-all failure mode (unknown fields, invalid date, etc.) — this proves the same
    // mapping now also applies to an error thrown from INSIDE the scheduler-guarded action, not
    // only to one thrown before `runJobNow` is ever called.
    vi.spyOn(dailyBriefingModule, "generateAllBriefings").mockImplementation(() => {
      throw new dailyBriefingModule.DailyBriefingValidationError(
        "member went inactive mid-generation"
      );
    });

    const response = await generateAll({ date });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "validation_error",
      message: "member went inactive mid-generation",
    });
  });

  //: "today"/"streak" replace 010's "calendar"/"chores" (same host-api reads,
  // new registry type names — see the equivalent note in daily-briefing-generate.test.ts). The
  // full registry also generates plenty of content these mocks never touch (corpus-backed
  // blocks, shotgun) — the second scenario below therefore settles `partial`, never `failed`,
  // since not EVERY block in the briefing fails, only the four domain ones under mock.
  it("isolates one failed gather and marks every failed gather as failed", async () => {
    vi.spyOn(hostApi, "getEvents").mockImplementation(() => {
      throw new Error("calendar unavailable");
    });
    vi.spyOn(hostApi, "getReminders").mockReturnValue([{ id: "reminder", text: "Pack bag" }]);
    vi.spyOn(hostApi, "getBoard").mockReturnValue([]);
    vi.spyOn(hostApi, "getMenu").mockReturnValue([
      {
        entryId: "meal",
        slot: "lunch",
        label: "Soup",
        isTombstone: false,
        source: "oneoff",
        recipeId: null,
        note: "Soup",
      },
    ]);

    const partial = await generateOne();
    expect(partial.statusCode).toBe(200);
    const partialBriefing = partial.json<Briefing>();
    expect(partialBriefing.status).toBe("partial");
    expect(partialBriefing.payload.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "today", status: "failed", error: "gather_failed" }),
        expect.objectContaining({ type: "reminders", status: "ok" }),
        expect.objectContaining({ type: "meals", status: "ok" }),
      ])
    );

    vi.restoreAllMocks();
    vi.spyOn(hostApi, "getEvents").mockImplementation(() => {
      throw new Error("calendar unavailable");
    });
    vi.spyOn(hostApi, "getReminders").mockImplementation(() => {
      throw new Error("reminders unavailable");
    });
    vi.spyOn(hostApi, "getBoard").mockImplementation(() => {
      throw new Error("chores unavailable");
    });
    vi.spyOn(hostApi, "getMenu").mockImplementation(() => {
      throw new Error("meals unavailable");
    });

    const failed = await generateOne();
    expect(failed.statusCode).toBe(200);
    const failedBriefing = failed.json<Briefing>();
    // NOT "failed": the full registry's corpus-backed/shotgun blocks are untouched by these
    // mocks and still succeed, so survivors exist — deriveStatus correctly settles "partial".
    expect(failedBriefing.status).toBe("partial");
    expect(failedBriefing.payload.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "today", status: "failed", error: "gather_failed" }),
        expect.objectContaining({ type: "reminders", status: "failed", error: "gather_failed" }),
        expect.objectContaining({ type: "streak", status: "failed", error: "gather_failed" }),
        expect.objectContaining({ type: "meals", status: "failed", error: "gather_failed" }),
      ])
    );
    expect(failedBriefing.payload.blocks.some((block) => block.status === "ok")).toBe(true);
  });

  it("rejects unknown generate-all properties and an invalid date before candidate enumeration", async () => {
    expect((await generateAll({ unexpected: true })).statusCode).toBe(400);
    const explicitNull = await app.inject({
      method: "POST",
      url: "/api/daily-briefing/generate-all",
      cookies: auth(),
      headers: { "content-type": "application/json" },
      payload: "null",
    });
    expect(explicitNull.statusCode).toBe(400);

    getDb().prepare("DELETE FROM daily_briefing_optin").run();
    const invalidDate = await generateAll({ date: "2026-02-31" });
    expect(invalidDate.statusCode).toBe(400);
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM daily_briefing").get()).toEqual({
      count: 0,
    });
  });
});
