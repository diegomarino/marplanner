import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { useIsolatedDb } from "../helpers/db";

/** / — Day Periods active-endpoint boundary test (RED first, before implementation).
 * BLACK-BOX: Uses buildApp + Fastify.inject only.
 * Clock-injection approach: vitest fake timers + setSystemTime (per U1 brief decision).
 * Tests assert deterministic results by fixing the wall clock to known instants.
 * Scenario (per User Story 3, acceptance scenarios):
 * 1. Seed device key + active periods.
 * 2. Fix clock to 13:00 (household tz) → GET /api/day-periods/active returns activeId='afternoon'.
 * 3. Fix clock to 02:00 (household tz) → activeId='night' (before first start, wraps).
 * 4. No device cookie → 401.
 */
describe("day-periods-active (RED boundary test)", () => {
  useIsolatedDb();

  // ──────────────────────────────────────────────────────────────────
  // Test helpers — insert auth key (periods are auto-seeded via migration)
  // ──────────────────────────────────────────────────────────────────

  async function setupActiveKey(rawKey: string): Promise<void> {
    const { getDb } = await import("../../src/server/db/client");
    const now = Date.now();
    const db = getDb();

    // Seed an active device key (mimicking provisioning).
    db.prepare(
      `INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)`
    ).run(
      `${Date.now()}-device`,
      (await import("../../src/server/auth/credentials")).hashKey(rawKey),
      now
    );
  }

  // ──────────────────────────────────────────────────────────────────
  // Fake timers setup/teardown (U1: wall-clock-dependent test MUST be deterministic)
  // ──────────────────────────────────────────────────────────────────

  // Store original methods to restore later
  let realSetTimeout: typeof setTimeout;
  let realClearTimeout: typeof clearTimeout;

  beforeAll(() => {
    realSetTimeout = globalThis.setTimeout;
    realClearTimeout = globalThis.clearTimeout;
  });

  afterAll(() => {
    // Restore real timers
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    // Date.now cannot be fully patched on global, but tests use vi.setSystemTime
  });

  // ──────────────────────────────────────────────────────────────────
  // Tests
  // ──────────────────────────────────────────────────────────────────

  it("FIXED clock at 13:00 → GET /api/day-periods/active returns activeId='afternoon' (FR-007)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    // Create device key
    const { generateKey } = await import("../../src/server/auth/credentials");
    const rawKey = generateKey();

    // Setup db with key (periods auto-seeded via migration)
    await setupActiveKey(rawKey);

    // Use fake timers and fix the clock to 13:00 in household timezone (Europe/Madrid)
    vi.useFakeTimers();
    const fixedDate13 = new Date("2026-07-30T13:00:00+02:00"); // 13:00 CEST
    vi.setSystemTime(fixedDate13);

    try {
      const app = await buildApp();

      try {
        const res = await app.inject({
          method: "GET",
          url: "/api/day-periods/active",
          cookies: { mp_device_key: rawKey },
        });

        expect(res.statusCode).toBe(200);

        const body = JSON.parse(res.payload);
        expect(body).toHaveProperty("activeId");
        expect(body.activeId).toBe("afternoon");
      } finally {
        await app.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("FIXED clock at 02:00 → GET /api/day-periods/active returns activeId='night' (wrap, before first start)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    // Create device key
    const { generateKey } = await import("../../src/server/auth/credentials");
    const rawKey = generateKey();

    // Setup db with key (periods auto-seeded via migration)
    await setupActiveKey(rawKey);

    // Fix clock to 02:00 (before morning's 05:00 start → wraps to night)
    vi.useFakeTimers();
    const fixedDate02 = new Date("2026-07-30T02:00:00+02:00"); // 02:00 CEST
    vi.setSystemTime(fixedDate02);

    try {
      const app = await buildApp();

      try {
        const res = await app.inject({
          method: "GET",
          url: "/api/day-periods/active",
          cookies: { mp_device_key: rawKey },
        });

        expect(res.statusCode).toBe(200);

        const body = JSON.parse(res.payload);
        expect(body).toHaveProperty("activeId");
        expect(body.activeId).toBe("night");
      } finally {
        await app.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("FIXED clock at 04:59 → GET /api/day-periods/active returns activeId='night' (before first start, FR-008)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    // Create device key
    const { generateKey } = await import("../../src/server/auth/credentials");
    const rawKey = generateKey();

    // Setup db with key (periods auto-seeded via migration)
    await setupActiveKey(rawKey);

    // Fix clock to 04:59 (just before morning's 05:00 start → wraps to night)
    vi.useFakeTimers();
    const fixedDate0459 = new Date("2026-07-30T04:59:00+02:00"); // 04:59 CEST
    vi.setSystemTime(fixedDate0459);

    try {
      const app = await buildApp();

      try {
        const res = await app.inject({
          method: "GET",
          url: "/api/day-periods/active",
          cookies: { mp_device_key: rawKey },
        });

        expect(res.statusCode).toBe(200);

        const body = JSON.parse(res.payload);
        expect(body).toHaveProperty("activeId");
        expect(body.activeId).toBe("night");
      } finally {
        await app.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("FIXED clock at 05:00 → GET /api/day-periods/active returns activeId='morning' (start-inclusive)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    // Create device key
    const { generateKey } = await import("../../src/server/auth/credentials");
    const rawKey = generateKey();

    // Setup db with key (periods auto-seeded via migration)
    await setupActiveKey(rawKey);

    // Fix clock to 05:00 exactly (morning's start time → should be morning per AC-04)
    vi.useFakeTimers();
    const fixedDate05 = new Date("2026-07-30T05:00:00+02:00"); // 05:00 CEST
    vi.setSystemTime(fixedDate05);

    try {
      const app = await buildApp();

      try {
        const res = await app.inject({
          method: "GET",
          url: "/api/day-periods/active",
          cookies: { mp_device_key: rawKey },
        });

        expect(res.statusCode).toBe(200);

        const body = JSON.parse(res.payload);
        expect(body).toHaveProperty("activeId");
        expect(body.activeId).toBe("morning");
      } finally {
        await app.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("FIXED clock at 21:00 → GET /api/day-periods/active returns activeId='night' (period start-inclusive)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    // Create device key
    const { generateKey } = await import("../../src/server/auth/credentials");
    const rawKey = generateKey();

    // Setup db with key (periods auto-seeded via migration)
    await setupActiveKey(rawKey);

    // Fix clock to 21:00 exactly (night's start time → should be night per AC-04)
    vi.useFakeTimers();
    const fixedDate21 = new Date("2026-07-30T21:00:00+02:00"); // 21:00 CEST
    vi.setSystemTime(fixedDate21);

    try {
      const app = await buildApp();

      try {
        const res = await app.inject({
          method: "GET",
          url: "/api/day-periods/active",
          cookies: { mp_device_key: rawKey },
        });

        expect(res.statusCode).toBe(200);

        const body = JSON.parse(res.payload);
        expect(body).toHaveProperty("activeId");
        expect(body.activeId).toBe("night");
      } finally {
        await app.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("FIXED clock at 00:00 → GET /api/day-periods/active returns activeId='night' (midnight within night band)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    // Create device key
    const { generateKey } = await import("../../src/server/auth/credentials");
    const rawKey = generateKey();

    // Setup db with key (periods auto-seeded via migration)
    await setupActiveKey(rawKey);

    // Fix clock to 00:00 (midnight, within night band 21:00..05:00) → should be night
    vi.useFakeTimers();
    const fixedDate00 = new Date("2026-07-30T00:00:00+02:00"); // 00:00 CEST
    vi.setSystemTime(fixedDate00);

    try {
      const app = await buildApp();

      try {
        const res = await app.inject({
          method: "GET",
          url: "/api/day-periods/active",
          cookies: { mp_device_key: rawKey },
        });

        expect(res.statusCode).toBe(200);

        const body = JSON.parse(res.payload);
        expect(body).toHaveProperty("activeId");
        expect(body.activeId).toBe("night");
      } finally {
        await app.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("FIXED clock at 18:00 → GET /api/day-periods/active returns activeId='evening'", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    // Create device key
    const { generateKey } = await import("../../src/server/auth/credentials");
    const rawKey = generateKey();

    // Setup db with key (periods auto-seeded via migration)
    await setupActiveKey(rawKey);

    // Fix clock to 18:00 (evening's start time) → should be evening
    vi.useFakeTimers();
    const fixedDate18 = new Date("2026-07-30T18:00:00+02:00"); // 18:00 CEST
    vi.setSystemTime(fixedDate18);

    try {
      const app = await buildApp();

      try {
        const res = await app.inject({
          method: "GET",
          url: "/api/day-periods/active",
          cookies: { mp_device_key: rawKey },
        });

        expect(res.statusCode).toBe(200);

        const body = JSON.parse(res.payload);
        expect(body).toHaveProperty("activeId");
        expect(body.activeId).toBe("evening");
      } finally {
        await app.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("FIXED clock at 19:00 → GET /api/day-periods/active returns activeId='evening'", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    // Create device key
    const { generateKey } = await import("../../src/server/auth/credentials");
    const rawKey = generateKey();

    // Setup db with key (periods auto-seeded via migration)
    await setupActiveKey(rawKey);

    // Fix clock to 19:00 (between evening 18:00 and night 21:00) → should be evening
    vi.useFakeTimers();
    const fixedDate19 = new Date("2026-07-30T19:00:00+02:00"); // 19:00 CEST
    vi.setSystemTime(fixedDate19);

    try {
      const app = await buildApp();

      try {
        const res = await app.inject({
          method: "GET",
          url: "/api/day-periods/active",
          cookies: { mp_device_key: rawKey },
        });

        expect(res.statusCode).toBe(200);

        const body = JSON.parse(res.payload);
        expect(body).toHaveProperty("activeId");
        expect(body.activeId).toBe("evening");
      } finally {
        await app.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("FIXED clock at 06:00 → GET /api/day-periods/active returns activeId='morning'", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    // Create device key
    const { generateKey } = await import("../../src/server/auth/credentials");
    const rawKey = generateKey();

    // Setup db with key (periods auto-seeded via migration)
    await setupActiveKey(rawKey);

    // Fix clock to 06:00 (after morning's 05:00 start) → should be morning
    vi.useFakeTimers();
    const fixedDate06 = new Date("2026-07-30T06:00:00+02:00"); // 06:00 CEST
    vi.setSystemTime(fixedDate06);

    try {
      const app = await buildApp();

      try {
        const res = await app.inject({
          method: "GET",
          url: "/api/day-periods/active",
          cookies: { mp_device_key: rawKey },
        });

        expect(res.statusCode).toBe(200);

        const body = JSON.parse(res.payload);
        expect(body).toHaveProperty("activeId");
        expect(body.activeId).toBe("morning");
      } finally {
        await app.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("no device cookie → GET /api/day-periods/active returns 401", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    // Periods are auto-seeded via migration; no key is inserted (no auth).

    const app = await buildApp();

    try {
      // No cookies provided
      const res = await app.inject({
        method: "GET",
        url: "/api/day-periods/active",
      });

      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("FIXED clock + persisted Asia/Tokyo → GET /api/day-periods/active returns activeId='afternoon' (proves tz is read from settings)", async () => {
    const { buildApp } = await import("../../src/server/app.ts");

    // Create device key
    const { generateKey } = await import("../../src/server/auth/credentials");
    const rawKey = generateKey();

    // Setup db with key (periods auto-seeded via migration)
    await setupActiveKey(rawKey);

    // Persist Asia/Tokyo timezone (as settings-coldread.test.ts does)
    const { getDb } = await import("../../src/server/db/client");
    const db = getDb();
    const now = Date.now();
    const localeDataTokyo = JSON.stringify({
      timezone: "Asia/Tokyo",
      language: "es",
      weekStartDay: 1,
    });
    db.prepare(
      "INSERT INTO settings_objects (object_name, data, updated_at) VALUES ('locale', ?, ?)"
    ).run(localeDataTokyo, now);

    // Fix clock to 2026-07-30T04:00:00Z (04:00 UTC)
    vi.useFakeTimers();
    const fixedDateUTC = new Date("2026-07-30T04:00:00Z"); // 04:00 UTC
    vi.setSystemTime(fixedDateUTC);

    try {
      const app = await buildApp();

      try {
        const res = await app.inject({
          method: "GET",
          url: "/api/day-periods/active",
          cookies: { mp_device_key: rawKey },
        });

        expect(res.statusCode).toBe(200);

        const body = JSON.parse(res.payload);
        expect(body).toHaveProperty("activeId");

        // At 04:00 UTC:
        // - Asia/Tokyo (UTC+9) = 13:00 → afternoon
        // - Europe/Madrid (UTC+2, summer) = 06:00 → morning
        // This test proves the endpoint READS settings, not hardcoded Madrid.
        expect(body.activeId).toBe("afternoon");
      } finally {
        await app.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
