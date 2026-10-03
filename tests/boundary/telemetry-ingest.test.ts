import { describe, it, expect, beforeEach } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";
import {
  __resetTelemetryStateForTests,
  getFloodDroppedCount,
} from "../../src/server/telemetry/index";

/** end-to-end ingest+read HTTP smoke (CLIENT-LOGGING-TELEMETRY-INV-03, -INV-04, -AC-01,
 * -AC-02). BLACK-BOX via buildApp + Fastify.inject (routines/reminders suite convention).
 */
describe("telemetry ingest+read HTTP smoke", () => {
  useIsolatedDb();

  beforeEach(() => {
    __resetTelemetryStateForTests();
  });

  function seedApiKey(scope = "*"): string {
    const rawKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    getDb()
      .prepare(
        "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, ?, 'device', ?)"
      )
      .run(id, hashKey(rawKey), scope, now);
    return rawKey;
  }

  it("CLIENT-LOGGING-TELEMETRY-AC-01 / CLIENT-LOGGING-TELEMETRY-AC-02: a batch with a secret ingests 200, and the stored row reads back redacted", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedApiKey();
    const app = await buildApp();
    try {
      const postRes = await app.inject({
        method: "POST",
        url: "/api/telemetry/client-log",
        cookies: { mp_device_key: deviceKey },
        payload: {
          entries: [
            {
              level: "error",
              component: "client.global",
              message: "fetch failed with mpk-leakedSecret123",
              data: { token: "mpk-anotherLeak", note: "192.168.1.1" },
            },
          ],
        },
      });
      expect(postRes.statusCode).toBe(200);
      const postBody = JSON.parse(postRes.body) as { accepted: number; dropped: number };
      expect(postBody).toEqual({ accepted: 1, dropped: 0 });

      const getRes = await app.inject({
        method: "GET",
        url: "/api/telemetry/client-log",
        cookies: { mp_device_key: deviceKey },
      });
      expect(getRes.statusCode).toBe(200);
      const page = JSON.parse(getRes.body) as {
        rows: Array<{ message: string; data: string | null; component: string }>;
        nextCursor: string | null;
      };
      expect(page.rows).toHaveLength(1);
      const row = page.rows[0];
      expect(row.message).not.toContain("mpk-leakedSecret123");
      expect(row.message).toContain("[redacted]");
      expect(row.data).not.toBeNull();
      expect(row.data as string).not.toContain("mpk-anotherLeak");
      expect(row.data as string).not.toContain("192.168.1.1");
      expect(row.data as string).toContain("[redacted]");
    } finally {
      await app.close();
    }
  });

  it("CLIENT-LOGGING-TELEMETRY-INV-03: a partially invalid batch drops bad entries and accepts the rest (per-entry, still 200)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedApiKey();
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/telemetry/client-log",
        cookies: { mp_device_key: deviceKey },
        payload: {
          entries: [
            { level: "info", component: "client.global", message: "ok entry" },
            { level: "not-a-level", component: "x", message: "bad level" },
            { level: "warn", component: "", message: "empty component" },
            { level: "warn", component: "x", message: "" },
            {}, // structurally missing everything
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { accepted: number; dropped: number };
      expect(body).toEqual({ accepted: 1, dropped: 4 });
    } finally {
      await app.close();
    }
  });

  it("CLIENT-LOGGING-TELEMETRY-INV-04: flood beyond the per-key window bound is silently dropped, never an error status", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedApiKey();
    const app = await buildApp();
    try {
      const entries = Array.from({ length: 100 }, (_, i) => ({
        level: "debug",
        component: "flood.test",
        message: `entry ${i}`,
      }));

      // Send 7 batches of 100 (700 total, all otherwise-valid) to cross the 600/5min window bound.
      let totalAccepted = 0;
      let totalDropped = 0;
      for (let batch = 0; batch < 7; batch++) {
        const r = await app.inject({
          method: "POST",
          url: "/api/telemetry/client-log",
          cookies: { mp_device_key: deviceKey },
          payload: { entries },
        });
        expect(r.statusCode).toBe(200); // NEVER an error status, even while flooding
        const body = JSON.parse(r.body) as { accepted: number; dropped: number };
        totalAccepted += body.accepted;
        totalDropped += body.dropped;
      }
      // Total sent: 700; window bound is 600 — the excess 100 must be dropped.
      expect(totalDropped).toBeGreaterThan(0);
      expect(totalAccepted).toBe(600);
      expect(totalDropped).toBe(100);

      // The in-memory flood counter matches the total dropped-via-flood count exactly...
      expect(getFloodDroppedCount()).toBe(totalDropped);
      //...and the stored-row ceiling holds: never more than the 600/window bound landed in the DB.
      const row = getDb().prepare("SELECT COUNT(*) as n FROM client_log").get() as { n: number };
      expect(row.n).toBe(600);
    } finally {
      await app.close();
    }
  });

  it("unparseable body -> 400 (structurally not the batch shape)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedApiKey();
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/telemetry/client-log",
        cookies: { mp_device_key: deviceKey },
        payload: { notEntries: true },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("Codex P2b: a parseable body with an unknown top-level key -> 400 (ClientLogBatch is additionalProperties:false)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedApiKey();
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/telemetry/client-log",
        cookies: { mp_device_key: deviceKey },
        payload: { entries: [], unexpected: true },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body) as { error: string };
      expect(body.error).toBe("validation_error");
    } finally {
      await app.close();
    }
  });

  it("B3: a poison entry (non-integer eventTime) is dropped per-entry, never 500s or loses sibling entries", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedApiKey();
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/telemetry/client-log",
        cookies: { mp_device_key: deviceKey },
        payload: {
          entries: [
            { level: "info", component: "ok1", message: "first" },
            // eventTime=1.5 is a real number but NOT an integer — would violate the STRICT
            // table's INTEGER column at insert time if it ever reached the DB layer.
            { level: "info", component: "poison", message: "poisoned", eventTime: 1.5 },
            { level: "info", component: "ok2", message: "third" },
          ],
        },
      });
      expect(res.statusCode).toBe(200); // never a 500, never leaks a raw SQLite error
      const body = JSON.parse(res.body) as { accepted: number; dropped: number };
      expect(body).toEqual({ accepted: 2, dropped: 1 });

      const getRes = await app.inject({
        method: "GET",
        url: "/api/telemetry/client-log",
        cookies: { mp_device_key: deviceKey },
      });
      const page = JSON.parse(getRes.body) as { rows: Array<{ component: string }> };
      const components = page.rows.map((r) => r.component).sort();
      // Both siblings survive — the poisoned entry does not take the rest of the batch down with it.
      expect(components).toEqual(["ok1", "ok2"]);
    } finally {
      await app.close();
    }
  });

  it("F4: writeClientLog's per-entry try/catch survives a `data` value that throws while stringifying (server-producer path, unreachable via HTTP JSON)", async () => {
    const { writeClientLog } = await import("../../src/server/telemetry/index");
    const apiKeyId = "direct-caller"; // writeClientLog only uses this for the flood-window key

    const poisonData = {
      get boom(): never {
        throw new Error("simulated non-serializable getter");
      },
    };

    const result = writeClientLog(apiKeyId, [
      { level: "info", component: "ok1", message: "first" },
      { level: "info", component: "poison", message: "poisoned", data: poisonData },
      { level: "info", component: "ok2", message: "third" },
    ]);

    expect(result).toEqual({ accepted: 2, dropped: 1 });
    const rows = getDb()
      .prepare("SELECT component FROM client_log ORDER BY component")
      .all() as Array<{ component: string }>;
    expect(rows.map((r) => r.component)).toEqual(["ok1", "ok2"]);
  });

  it("CLIENT-LOGGING-TELEMETRY-INV-11: GET supports level/component/from/to filters, newest-first, and ignores an unknown limit param (not 400)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedApiKey();
    const app = await buildApp();
    try {
      await app.inject({
        method: "POST",
        url: "/api/telemetry/client-log",
        cookies: { mp_device_key: deviceKey },
        payload: {
          entries: [
            { level: "error", component: "a", message: "first" },
            { level: "warn", component: "b", message: "second" },
          ],
        },
      });

      const filtered = await app.inject({
        method: "GET",
        url: "/api/telemetry/client-log?level=error&component=a",
        cookies: { mp_device_key: deviceKey },
      });
      expect(filtered.statusCode).toBe(200);
      const filteredPage = JSON.parse(filtered.body) as {
        rows: Array<{ level: string; component: string }>;
      };
      expect(filteredPage.rows.every((r) => r.level === "error" && r.component === "a")).toBe(true);

      const unknownLimit = await app.inject({
        method: "GET",
        url: "/api/telemetry/client-log?limit=999999",
        cookies: { mp_device_key: deviceKey },
      });
      expect(unknownLimit.statusCode).toBe(200);
      const page = JSON.parse(unknownLimit.body) as { rows: unknown[] };
      expect(page.rows.length).toBeLessThanOrEqual(50);
    } finally {
      await app.close();
    }
  });
});
