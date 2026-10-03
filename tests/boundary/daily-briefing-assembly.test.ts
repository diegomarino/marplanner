import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Briefing, BriefingReadResult } from "../../src/shared";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

describe("daily-briefing assembly", () => {
  const { dir } = useIsolatedDb();

  let app: FastifyInstance;
  let deviceKey: string;
  let memberId: string;
  const date = "2026-08-21";

  beforeEach(async () => {
    // Calendar reads enforce a moving -30d/+365d window. This suite deliberately uses a fixed
    // fixture date, so its clock must be fixed too; otherwise the test expires in real time.
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
      "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, 'parent', 'active', ?, ?)"
    ).run(memberId, "Ada", now, now);
    db.prepare(
      "INSERT INTO daily_briefing_optin (member_id, enabled, created_at, updated_at) VALUES (?, 1, ?, ?)"
    ).run(memberId, now, now);

    const { buildApp } = await import("../../src/server/app.ts");
    app = await buildApp();
  });

  afterEach(async () => {
    if (app) await app.close();
    vi.useRealTimers();
  });

  it("registers the generate and pure-read routes, then returns a content-only briefing shell", async () => {
    expect(app.hasRoute({ method: "POST", url: "/api/daily-briefing/generate" })).toBe(true);
    expect(app.hasRoute({ method: "GET", url: "/api/daily-briefing/:memberId/:date" })).toBe(true);

    const generate = await app.inject({
      method: "POST",
      url: "/api/daily-briefing/generate",
      headers: { cookie: `mp_device_key=${deviceKey}`, "content-type": "application/json" },
      payload: { memberId, date },
    });

    expect(generate.statusCode).toBe(200);
    const briefing = generate.json<Briefing>();
    expect(briefing.id).toEqual(expect.any(String));
    expect(briefing.memberId).toBe(memberId);
    expect(briefing.date).toBe(date);
    expect(briefing.status).toBe("ready");
    //: generateBriefing now assembles the full 21-block registry (envelope v2)
    // instead of 010's four merged domains — a household with zero domain data (no calendar
    // events, meals, reminders, chores) still gets deterministic content from the corpus-backed
    // and shotgun blocks, so `blocks` is no longer empty for a "quiet" household. This test's
    // ORIGINAL concern (route registration + a settled, error-free shell) is still proven below.
    expect(briefing.payload.schemaVersion).toBe(2);
    expect(briefing.payload.member).toEqual({ id: memberId, displayName: "Ada" });
    expect(briefing.payload.date).toBe(date);
    expect(briefing.payload.blocks.length).toBeGreaterThan(0);
    expect(briefing.payload.blocks.every((block) => block.status === "ok")).toBe(true);
    expect(briefing.payload).not.toHaveProperty("raster");
    expect(briefing).not.toHaveProperty("printedStatus");
    expect(briefing.status).not.toBe("render-failed");

    const read = await app.inject({
      method: "GET",
      url: `/api/daily-briefing/${memberId}/${date}`,
      headers: { cookie: `mp_device_key=${deviceKey}` },
    });

    expect(read.statusCode).toBe(200);
    const result = read.json<BriefingReadResult>();
    //: printedStatus is "none" — Printing is active (default) but no print job was
    // ever enqueued for this member/date in this test.
    expect(result).toEqual({ generated: true, briefing, printedStatus: "none" });
  });

  it("rejects an unknown generate field without persisting a briefing or emitting an event", async () => {
    const { eventBus } = await import("../../src/server/lib/event-bus.js");
    const emittedEvents: unknown[] = [];
    eventBus.subscribe("daily_briefing.generated", (payload) => {
      if (payload.memberId === memberId && payload.date === date) {
        emittedEvents.push(payload);
      }
    });

    const generate = await app.inject({
      method: "POST",
      url: "/api/daily-briefing/generate",
      headers: { cookie: `mp_device_key=${deviceKey}`, "content-type": "application/json" },
      payload: { memberId, date, unexpected: true },
    });

    expect(generate.statusCode).toBe(400);
    expect(generate.json()).toMatchObject({ error: "validation_error" });
    expect(
      getDb()
        .prepare("SELECT COUNT(*) AS count FROM daily_briefing WHERE member_id = ? AND date = ?")
        .get(memberId, date)
    ).toEqual({ count: 0 });

    await new Promise<void>((resolve) => {
      queueMicrotask(() => queueMicrotask(resolve));
    });
    expect(emittedEvents).toHaveLength(0);
  });

  it("emits exactly one generated event only after its briefing row is externally committed", async () => {
    const { eventBus } = await import("../../src/server/lib/event-bus.js");
    const emittedEvents: Array<{ name: string; payload: unknown }> = [];
    let committedRowWasVisibleToAnotherConnection = false;
    eventBus.subscribe("daily_briefing.generated", (payload) => {
      // The app's connection can see its own uncommitted transaction. An
      // independent reader makes this a real post-commit observation.
      const observer = new Database(join(dir(), "marplanner.db"), {
        readonly: true,
        fileMustExist: true,
      });
      try {
        committedRowWasVisibleToAnotherConnection = Boolean(
          observer
            .prepare("SELECT id FROM daily_briefing WHERE member_id = ? AND date = ?")
            .get(payload.memberId, payload.date)
        );
      } finally {
        observer.close();
      }
      emittedEvents.push({ name: "daily_briefing.generated", payload });
    });

    const generate = await app.inject({
      method: "POST",
      url: "/api/daily-briefing/generate",
      headers: { cookie: `mp_device_key=${deviceKey}`, "content-type": "application/json" },
      payload: { memberId, date },
    });

    expect(generate.statusCode).toBe(200);

    // The event bus dispatches subscribers through queueMicrotask.
    await new Promise<void>((resolve) => {
      queueMicrotask(() => queueMicrotask(resolve));
    });

    expect(committedRowWasVisibleToAnotherConnection).toBe(true);
    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0]).toEqual({
      name: "daily_briefing.generated",
      payload: { memberId, date, status: "ready" },
    });
  });

  it("keeps the Daily Briefing DTO free of raster/printed-status surface fields, and its core module reaching printing ONLY through the host-api barrel", () => {
    // / deliberately crosses this boundary in
    // the SANCTIONED way: `BriefingStatus` gains `render-failed` (the render layer's own status
    // value), and the daily-briefing CORE module now registers a printable
    // provider + gates on Printing's plugin-active flag — but only by importing THOSE named
    // seams from `../../host-api` (Rule B), never a literal `.../printing...` path. The DTO
    // itself stays free of raster bytes/printed-status fields (those live on the DB row and are
    // read through dedicated seams, not the `Briefing` shared type) — that half of the original
    // guarantee still holds unchanged.
    //
    // adds `printedStatus` to `BriefingReadResult` — a SIBLING type
    // to `Briefing`, deliberately not a field ON it (the same "dedicated seam, not the Briefing
    // shared type" principle this test's own comment already names). Two DISTINCT assertions,
    // per: `raster` stays banned from the WHOLE file (case-insensitive — a plain
    // substring match, not `\braster\b`, so it also catches a camelCase identifier like
    // `rasterBits` the earlier word-boundary regex silently let through), since raster bytes never
    // belong ANYWHERE in this DTO file; `printedStatus` is banned only from the `Briefing`
    // interface's own body (it legitimately appears elsewhere in the file, on `BriefingReadResult`).
    const root = process.cwd();
    const dtoSource = readFileSync(join(root, "src/shared/dailyBriefing.ts"), "utf8");
    const moduleSource = readFileSync(
      join(root, "src/server/modules/daily-briefing/index.ts"),
      "utf8"
    );
    const statusDefinition = dtoSource.match(/export type BriefingStatus = ([^;]+);/);
    const briefingInterface = dtoSource.match(/export interface Briefing \{[\s\S]*?\n\}/);

    expect(statusDefinition?.[1]).toContain("render-failed");
    expect(dtoSource).not.toMatch(/raster/i);
    expect(briefingInterface?.[0]).toBeDefined();
    expect(briefingInterface?.[0]).not.toMatch(/\bprintedStatus\b/);
    // The module may import printing-shaped NAMES (isPrintingPluginActive,
    // registerPrintableProvider, PrintableRaster) — but only via the host-api barrel; a literal
    // import FROM a path containing "printing" (i.e. reaching printing/index.ts directly) is
    // still forbidden and would trip this assertion.
    expect(moduleSource).not.toMatch(/from\s+["'][^"']*printing[^"']*["']/);
  });
});
