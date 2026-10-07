import { describe, it, expect, beforeEach } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";
import { __resetTelemetryStateForTests } from "../../src/server/telemetry/index";

/** deep boundary-test suite for the admin read route. The surface itself shipped COMPLETE
 * The surface shipped earlier; this suite is the dedicated deep pass over it: every filter alone and
 * combined, the server-hard page cap (a caller cannot escape it via any `limit` it sends), cursor
 * round-trip across page boundaries, cursor stability under rows inserted BETWEEN two page
 * fetches, invalid-filter/invalid-cursor rejection, an unrecognized `limit` being silently
 * ignored (never a 400), and a hostile row coming back byte-for-byte as stored — the read route
 * performs NO extra sanitization of its own; that responsibility lives at the render boundary
 *.
 * Rows are inserted DIRECTLY at the DB layer (bypassing `writeClientLog`'s * validate/bound/flood/redact pipeline, already covered by `telemetry-ingest.test.ts`) so the
 * read route's own filter/cap/cursor logic can be exercised deterministically.
 * *(Traces: CLIENT-LOGGING-TELEMETRY-INV-11 — server half)*
 */
describe("telemetry read route deep suite", () => {
  useIsolatedDb();

  beforeEach(() => {
    __resetTelemetryStateForTests();
  });

  function seedApiKey(): string {
    const rawKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    getDb()
      .prepare(
        "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
      )
      .run(id, hashKey(rawKey), Date.now());
    return rawKey;
  }

  let seq = 0;
  interface RowOverrides {
    id?: string;
    eventId?: string;
    eventTime?: number | null;
    receivedAt?: number;
    level?: string;
    component?: string;
    message?: string;
    data?: string | null;
  }

  /** Direct insert into `client_log` — deterministic fixtures, independent of ingest concerns. */
  function insertRow(overrides: RowOverrides = {}): { id: string; receivedAt: number } {
    seq += 1;
    const id = overrides.id ?? `row-${seq}`;
    const receivedAt = overrides.receivedAt ?? seq;
    getDb()
      .prepare(
        `INSERT INTO client_log (id, event_id, event_time, received_at, level, component, message, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        overrides.eventId ?? `event-${seq}`,
        overrides.eventTime ?? null,
        receivedAt,
        overrides.level ?? "info",
        overrides.component ?? "test.component",
        overrides.message ?? `message ${seq}`,
        overrides.data ?? null
      );
    return { id, receivedAt };
  }

  type App = Awaited<ReturnType<typeof import("../../src/server/app.ts").buildApp>>;

  async function get(app: App, deviceKey: string, qs = "") {
    return app.inject({
      method: "GET",
      url: `/api/telemetry/client-log${qs}`,
      cookies: { mp_device_key: deviceKey },
    });
  }

  describe("every filter alone", () => {
    it("level alone", async () => {
      const { buildApp } = await import("../../src/server/app.ts");
      const deviceKey = seedApiKey();
      const app = await buildApp();
      try {
        insertRow({ level: "error", component: "a" });
        insertRow({ level: "warn", component: "b" });
        insertRow({ level: "error", component: "c" });

        const res = await get(app, deviceKey, "?level=error");
        expect(res.statusCode).toBe(200);
        const page = JSON.parse(res.body) as { rows: Array<{ level: string }> };
        expect(page.rows).toHaveLength(2);
        expect(page.rows.every((r) => r.level === "error")).toBe(true);
      } finally {
        await app.close();
      }
    });

    it("component alone", async () => {
      const { buildApp } = await import("../../src/server/app.ts");
      const deviceKey = seedApiKey();
      const app = await buildApp();
      try {
        insertRow({ component: "kiosk.fetch" });
        insertRow({ component: "kiosk.fetch" });
        insertRow({ component: "i18n" });

        const res = await get(app, deviceKey, "?component=kiosk.fetch");
        expect(res.statusCode).toBe(200);
        const page = JSON.parse(res.body) as { rows: Array<{ component: string }> };
        expect(page.rows).toHaveLength(2);
        expect(page.rows.every((r) => r.component === "kiosk.fetch")).toBe(true);
      } finally {
        await app.close();
      }
    });

    it("from alone", async () => {
      const { buildApp } = await import("../../src/server/app.ts");
      const deviceKey = seedApiKey();
      const app = await buildApp();
      try {
        insertRow({ receivedAt: 100, id: "old" });
        insertRow({ receivedAt: 200, id: "mid" });
        insertRow({ receivedAt: 300, id: "new" });

        const res = await get(app, deviceKey, "?from=200");
        expect(res.statusCode).toBe(200);
        const page = JSON.parse(res.body) as { rows: Array<{ id: string; receivedAt: number }> };
        expect(page.rows.map((r) => r.id).sort()).toEqual(["mid", "new"]);
        expect(page.rows.every((r) => r.receivedAt >= 200)).toBe(true);
      } finally {
        await app.close();
      }
    });

    it("to alone", async () => {
      const { buildApp } = await import("../../src/server/app.ts");
      const deviceKey = seedApiKey();
      const app = await buildApp();
      try {
        insertRow({ receivedAt: 100, id: "old" });
        insertRow({ receivedAt: 200, id: "mid" });
        insertRow({ receivedAt: 300, id: "new" });

        const res = await get(app, deviceKey, "?to=200");
        expect(res.statusCode).toBe(200);
        const page = JSON.parse(res.body) as { rows: Array<{ id: string; receivedAt: number }> };
        expect(page.rows.map((r) => r.id).sort()).toEqual(["mid", "old"]);
        expect(page.rows.every((r) => r.receivedAt <= 200)).toBe(true);
      } finally {
        await app.close();
      }
    });
  });

  describe("filters combined", () => {
    it("level + component together narrow to the intersection", async () => {
      const { buildApp } = await import("../../src/server/app.ts");
      const deviceKey = seedApiKey();
      const app = await buildApp();
      try {
        insertRow({ level: "error", component: "a", id: "hit" });
        insertRow({ level: "error", component: "b", id: "wrong-component" });
        insertRow({ level: "warn", component: "a", id: "wrong-level" });

        const res = await get(app, deviceKey, "?level=error&component=a");
        expect(res.statusCode).toBe(200);
        const page = JSON.parse(res.body) as { rows: Array<{ id: string }> };
        expect(page.rows.map((r) => r.id)).toEqual(["hit"]);
      } finally {
        await app.close();
      }
    });

    it("level + component + from + to together narrow to the intersection", async () => {
      const { buildApp } = await import("../../src/server/app.ts");
      const deviceKey = seedApiKey();
      const app = await buildApp();
      try {
        insertRow({ level: "warn", component: "a", receivedAt: 150, id: "hit" });
        insertRow({ level: "warn", component: "a", receivedAt: 50, id: "too-early" });
        insertRow({ level: "warn", component: "a", receivedAt: 250, id: "too-late" });
        insertRow({ level: "error", component: "a", receivedAt: 150, id: "wrong-level" });
        insertRow({ level: "warn", component: "b", receivedAt: 150, id: "wrong-component" });

        const res = await get(app, deviceKey, "?level=warn&component=a&from=100&to=200");
        expect(res.statusCode).toBe(200);
        const page = JSON.parse(res.body) as { rows: Array<{ id: string }> };
        expect(page.rows.map((r) => r.id)).toEqual(["hit"]);
      } finally {
        await app.close();
      }
    });
  });

  it("CLIENT-LOGGING-TELEMETRY-INV-11: the server hard cap (50) wins even when 55 rows exist and no limit is requested", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedApiKey();
    const app = await buildApp();
    try {
      for (let i = 0; i < 55; i++) {
        insertRow({ receivedAt: i, id: `row-${i}` });
      }

      const firstPage = await get(app, deviceKey);
      expect(firstPage.statusCode).toBe(200);
      const page1 = JSON.parse(firstPage.body) as {
        rows: Array<{ id: string }>;
        nextCursor: string | null;
      };
      expect(page1.rows).toHaveLength(50);
      expect(page1.nextCursor).not.toBeNull();

      const secondPage = await get(
        app,
        deviceKey,
        `?cursor=${encodeURIComponent(page1.nextCursor as string)}`
      );
      expect(secondPage.statusCode).toBe(200);
      const page2 = JSON.parse(secondPage.body) as {
        rows: Array<{ id: string }>;
        nextCursor: string | null;
      };
      expect(page2.rows).toHaveLength(5);
      expect(page2.nextCursor).toBeNull();

      const allIds = new Set([...page1.rows.map((r) => r.id), ...page2.rows.map((r) => r.id)]);
      expect(allIds.size).toBe(55);
    } finally {
      await app.close();
    }
  });

  it("an unrecognized `limit` query param is silently IGNORED — never a 400, and the server cap still wins", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedApiKey();
    const app = await buildApp();
    try {
      for (let i = 0; i < 55; i++) {
        insertRow({ receivedAt: i, id: `row-${i}` });
      }

      const res = await get(app, deviceKey, "?limit=999999");
      expect(res.statusCode).toBe(200);
      const page = JSON.parse(res.body) as { rows: unknown[] };
      expect(page.rows.length).toBe(50);
    } finally {
      await app.close();
    }
  });

  it("cursor round-trip across MULTIPLE page boundaries visits every row exactly once", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedApiKey();
    const app = await buildApp();
    try {
      for (let i = 0; i < 120; i++) {
        insertRow({ receivedAt: i, id: `row-${i}` });
      }

      const seenIds: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const qs: string = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
        const res = await get(app, deviceKey, qs);
        expect(res.statusCode).toBe(200);
        const page = JSON.parse(res.body) as {
          rows: Array<{ id: string }>;
          nextCursor: string | null;
        };
        seenIds.push(...page.rows.map((r) => r.id));
        cursor = page.nextCursor;
        pages += 1;
        expect(pages).toBeLessThan(10); // guard against an infinite-loop regression
      } while (cursor !== null);

      expect(pages).toBe(3); // 50 + 50 + 20
      expect(new Set(seenIds).size).toBe(120);
      expect(seenIds).toHaveLength(120);
    } finally {
      await app.close();
    }
  });

  it("#626 review (P3): cursor tiebreaker — 51 rows sharing ONE identical receivedAt still round-trip to 51 unique ids (exercises the `id DESC` tiebreaker clause)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedApiKey();
    const app = await buildApp();
    try {
      for (let i = 0; i < 51; i++) {
        insertRow({ receivedAt: 5000, id: `tie-${String(i).padStart(2, "0")}` });
      }

      const seenIds: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const qs: string = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
        const res = await get(app, deviceKey, qs);
        expect(res.statusCode).toBe(200);
        const page = JSON.parse(res.body) as {
          rows: Array<{ id: string }>;
          nextCursor: string | null;
        };
        seenIds.push(...page.rows.map((r) => r.id));
        cursor = page.nextCursor;
        pages += 1;
        expect(pages).toBeLessThan(5); // guard against an infinite-loop regression
      } while (cursor !== null);

      expect(pages).toBe(2); // 50 + 1 — the tiebreaker must still terminate cleanly
      expect(new Set(seenIds).size).toBe(51);
      expect(seenIds).toHaveLength(51);
    } finally {
      await app.close();
    }
  });

  it("#626 review (P3): rows come back in a non-increasing receivedAt sequence on a mixed fixture (newest-first ordering holds across ties too)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedApiKey();
    const app = await buildApp();
    try {
      const values = [50, 10, 999, 3, 42, 42, 7, 500, 1];
      values.forEach((v, i) => insertRow({ receivedAt: v, id: `mixed-${i}` }));

      const res = await get(app, deviceKey);
      expect(res.statusCode).toBe(200);
      const page = JSON.parse(res.body) as { rows: Array<{ receivedAt: number }> };
      expect(page.rows).toHaveLength(values.length);
      for (let i = 1; i < page.rows.length; i++) {
        expect(page.rows[i].receivedAt).toBeLessThanOrEqual(page.rows[i - 1].receivedAt);
      }
    } finally {
      await app.close();
    }
  });

  it("cursor pagination is STABLE under inserts landing between two page fetches — new rows never leak into an older page, and no row is skipped or duplicated", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedApiKey();
    const app = await buildApp();
    try {
      // 60 rows at receivedAt 1000..1059 — newest-first means row-59 (1059) leads.
      for (let i = 0; i < 60; i++) {
        insertRow({ receivedAt: 1000 + i, id: `row-${i}` });
      }

      const firstRes = await get(app, deviceKey);
      const page1 = JSON.parse(firstRes.body) as {
        rows: Array<{ id: string }>;
        nextCursor: string | null;
      };
      expect(page1.rows).toHaveLength(50);
      expect(page1.nextCursor).not.toBeNull();

      // Simulate NEW telemetry arriving after page 1 was fetched but before page 2 is — these
      // must never appear in the continuation page, since they are newer than the cursor point.
      for (let i = 0; i < 5; i++) {
        insertRow({ receivedAt: 5000 + i, id: `interleaved-${i}` });
      }

      const secondRes = await get(
        app,
        deviceKey,
        `?cursor=${encodeURIComponent(page1.nextCursor as string)}`
      );
      const page2 = JSON.parse(secondRes.body) as {
        rows: Array<{ id: string }>;
        nextCursor: string | null;
      };

      const page2Ids = page2.rows.map((r) => r.id);
      expect(page2Ids).toHaveLength(10); // the original 10 leftover rows (1000..1009)
      expect(page2Ids.some((id) => id.startsWith("interleaved-"))).toBe(false);
      expect(page2.nextCursor).toBeNull();

      const page1Ids = new Set(page1.rows.map((r) => r.id));
      expect(page2Ids.every((id) => !page1Ids.has(id))).toBe(true); // no duplicates across pages
    } finally {
      await app.close();
    }
  });

  describe("invalid filter/cursor -> 400", () => {
    it("an unrecognized level value -> 400", async () => {
      const { buildApp } = await import("../../src/server/app.ts");
      const deviceKey = seedApiKey();
      const app = await buildApp();
      try {
        const res = await get(app, deviceKey, "?level=not-a-level");
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it("a non-numeric `from` -> 400", async () => {
      const { buildApp } = await import("../../src/server/app.ts");
      const deviceKey = seedApiKey();
      const app = await buildApp();
      try {
        const res = await get(app, deviceKey, "?from=not-a-number");
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it("a non-numeric `to` -> 400", async () => {
      const { buildApp } = await import("../../src/server/app.ts");
      const deviceKey = seedApiKey();
      const app = await buildApp();
      try {
        const res = await get(app, deviceKey, "?to=not-a-number");
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it("a structurally malformed cursor (not valid base64 JSON) -> 400", async () => {
      const { buildApp } = await import("../../src/server/app.ts");
      const deviceKey = seedApiKey();
      const app = await buildApp();
      try {
        const res = await get(app, deviceKey, "?cursor=not-a-real-cursor%25%25%25");
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it("a cursor decoding to the wrong shape (valid base64+JSON, missing fields) -> 400", async () => {
      const { buildApp } = await import("../../src/server/app.ts");
      const deviceKey = seedApiKey();
      const app = await buildApp();
      try {
        const badCursor = Buffer.from(JSON.stringify({ foo: "bar" }), "utf8").toString("base64");
        const res = await get(app, deviceKey, `?cursor=${encodeURIComponent(badCursor)}`);
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });
  });

  it("CLIENT-LOGGING-TELEMETRY-INV-11: hostile rows return byte-for-byte exactly as stored — the read route performs no extra sanitization of its own", async () => {
    const { buildApp } = await import("../../src/server/app.ts");
    const deviceKey = seedApiKey();
    const app = await buildApp();
    try {
      const hostileMessage = '<img src=x onerror="alert(1)">';
      const hostileData = JSON.stringify({ payload: "<script>alert(1)</script>" });
      insertRow({ id: "hostile", message: hostileMessage, data: hostileData });

      const res = await get(app, deviceKey);
      expect(res.statusCode).toBe(200);
      const page = JSON.parse(res.body) as {
        rows: Array<{ id: string; message: string; data: string | null }>;
      };
      const row = page.rows.find((r) => r.id === "hostile");
      expect(row).toBeDefined();
      expect(row?.message).toBe(hostileMessage);
      expect(row?.data).toBe(hostileData);
    } finally {
      await app.close();
    }
  });
});
