import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

describe("member-write (US3 birthdate write-path)", () => {
  useIsolatedDb();

  const seedKeys = (db: any) => {
    const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const deviceHash = hashKey(deviceKey);
    const now = Date.now();
    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run(`${Date.now()}-device`, deviceHash, now);
    return deviceKey;
  };

  describe("POST /api/members with birthDate", () => {
    it("accepts {displayName, role='parent', birthDate:null} (no birthdate)", async () => {
      const { buildApp } = await import("../../src/server/app.ts");

      const db = getDb();
      const deviceKey = seedKeys(db);

      const app = await buildApp();

      try {
        const res = await app.inject({
          method: "POST",
          url: "/api/members",
          cookies: { mp_device_key: deviceKey },
          payload: { displayName: "Abuelita", role: "parent", birthDate: null },
        });

        expect(res.statusCode).toBe(201);

        const body = JSON.parse(res.body);
        expect(body.displayName).toBe("Abuelita");
        expect(body.role).toBe("parent");
        expect(body.birthDate).toBeNull();
      } finally {
        await app.close();
      }
    });

    it("accepts {displayName, role='child', birthDate:{month:3,day:15}} (no year)", async () => {
      const { buildApp } = await import("../../src/server/app.ts");

      const db = getDb();
      const deviceKey = seedKeys(db);

      const app = await buildApp();

      try {
        const res = await app.inject({
          method: "POST",
          url: "/api/members",
          cookies: { mp_device_key: deviceKey },
          payload: { displayName: "Peque", role: "child", birthDate: { month: 3, day: 15 } },
        });

        expect(res.statusCode).toBe(201);

        const body = JSON.parse(res.body);
        expect(body.displayName).toBe("Peque");
        expect(body.role).toBe("child");
        expect(body.birthDate).toEqual({ month: 3, day: 15, year: null });
      } finally {
        await app.close();
      }
    });

    it("accepts {displayName, role='parent', birthDate:{month:7,day:4,year:1980}} (with year)", async () => {
      const { buildApp } = await import("../../src/server/app.ts");

      const db = getDb();
      const deviceKey = seedKeys(db);

      const app = await buildApp();

      try {
        const res = await app.inject({
          method: "POST",
          url: "/api/members",
          cookies: { mp_device_key: deviceKey },
          payload: {
            displayName: "Papá",
            role: "parent",
            birthDate: { month: 7, day: 4, year: 1980 },
          },
        });

        expect(res.statusCode).toBe(201);

        const body = JSON.parse(res.body);
        expect(body.displayName).toBe("Papá");
        expect(body.role).toBe("parent");
        expect(body.birthDate).toEqual({ month: 7, day: 4, year: 1980 });
      } finally {
        await app.close();
      }
    });

    it("rejects role='admin' with 400 (FR-020/FR-024)", async () => {
      const { buildApp } = await import("../../src/server/app.ts");

      const db = getDb();
      const deviceKey = seedKeys(db);

      const app = await buildApp();

      try {
        const res = await app.inject({
          method: "POST",
          url: "/api/members",
          cookies: { mp_device_key: deviceKey },
          payload: { displayName: "AdminUser", role: "admin" },
        });

        expect(res.statusCode).toBe(400);

        const body = JSON.parse(res.body);
        expect(body).toHaveProperty("error");
      } finally {
        await app.close();
      }
    });

    it("accepts birthDate with {month:2,day:29} when no year (leap-agnostic)", async () => {
      const { buildApp } = await import("../../src/server/app.ts");

      const db = getDb();
      const deviceKey = seedKeys(db);

      const app = await buildApp();

      try {
        const res = await app.inject({
          method: "POST",
          url: "/api/members",
          cookies: { mp_device_key: deviceKey },
          payload: { displayName: "Feb29", role: "child", birthDate: { month: 2, day: 29 } },
        });

        expect(res.statusCode).toBe(201);

        const body = JSON.parse(res.body);
        expect(body.birthDate).toEqual({ month: 2, day: 29, year: null });
      } finally {
        await app.close();
      }
    });

    it("rejects birthDate with {month:2,day:29,year:2021} (non-leap year)", async () => {
      const { buildApp } = await import("../../src/server/app.ts");

      const db = getDb();
      const deviceKey = seedKeys(db);

      const app = await buildApp();

      try {
        const res = await app.inject({
          method: "POST",
          url: "/api/members",
          cookies: { mp_device_key: deviceKey },
          payload: {
            displayName: "InvalidDate",
            role: "child",
            birthDate: { month: 2, day: 29, year: 2021 },
          },
        });

        expect(res.statusCode).toBe(400);

        const body = JSON.parse(res.body);
        expect(body).toHaveProperty("error");
      } finally {
        await app.close();
      }
    });

    it("accepts birthDate with {month:2,day:29,year:2020} (leap year)", async () => {
      const { buildApp } = await import("../../src/server/app.ts");

      const db = getDb();
      const deviceKey = seedKeys(db);

      const app = await buildApp();

      try {
        const res = await app.inject({
          method: "POST",
          url: "/api/members",
          cookies: { mp_device_key: deviceKey },
          payload: {
            displayName: "LeapDay",
            role: "child",
            birthDate: { month: 2, day: 29, year: 2020 },
          },
        });

        expect(res.statusCode).toBe(201);

        const body = JSON.parse(res.body);
        expect(body.birthDate).toEqual({ month: 2, day: 29, year: 2020 });
      } finally {
        await app.close();
      }
    });

    it("accepts missing birthDate (no field at all)", async () => {
      const { buildApp } = await import("../../src/server/app.ts");

      const db = getDb();
      const deviceKey = seedKeys(db);

      const app = await buildApp();

      try {
        const res = await app.inject({
          method: "POST",
          url: "/api/members",
          cookies: { mp_device_key: deviceKey },
          payload: { displayName: "NoBirth", role: "parent" },
        });

        expect(res.statusCode).toBe(201);

        const body = JSON.parse(res.body);
        expect(body.birthDate).toBeNull();
      } finally {
        await app.close();
      }
    });
  });

  describe("PATCH /api/members/:id", () => {
    it("updates displayName only, leaving birthDate unchanged", async () => {
      const { buildApp } = await import("../../src/server/app.ts");

      const db = getDb();
      const deviceKey = seedKeys(db);

      const appId = randomUUID();
      const now = Date.now();
      db.prepare(
        "INSERT INTO members (id, display_name, role, lifecycle, birth_month, birth_day, birth_year, created_at, updated_at) VALUES (?, ?, ?, 'active', 6, 15, 1980, ?, ?)"
      ).run(appId, "OriginalName", "parent", now, now);

      const app = await buildApp();

      try {
        const res = await app.inject({
          method: "PATCH",
          url: `/api/members/${appId}`,
          cookies: { mp_device_key: deviceKey },
          payload: { displayName: "UpdatedName" },
        });

        expect(res.statusCode).toBe(200);

        const body = JSON.parse(res.body);
        expect(body.displayName).toBe("UpdatedName");
        expect(body.role).toBe("parent");
        expect(body.birthDate).toEqual({ month: 6, day: 15, year: 1980 });
      } finally {
        await app.close();
      }
    });

    it("updates role only, leaving birthDate unchanged", async () => {
      const { buildApp } = await import("../../src/server/app.ts");

      const db = getDb();
      const deviceKey = seedKeys(db);

      const appId = randomUUID();
      const now = Date.now();
      db.prepare(
        "INSERT INTO members (id, display_name, role, lifecycle, birth_month, birth_day, birth_year, created_at, updated_at) VALUES (?, ?, ?, 'active', 3, 15, null, ?, ?)"
      ).run(appId, "DisplayName", "parent", now, now);

      const app = await buildApp();

      try {
        const res = await app.inject({
          method: "PATCH",
          url: `/api/members/${appId}`,
          cookies: { mp_device_key: deviceKey },
          payload: { role: "child" },
        });

        expect(res.statusCode).toBe(200);

        const body = JSON.parse(res.body);
        expect(body.displayName).toBe("DisplayName");
        expect(body.role).toBe("child");
        expect(body.birthDate).toEqual({ month: 3, day: 15, year: null });
      } finally {
        await app.close();
      }
    });

    it("updates birthDate from null to {month,day}", async () => {
      const { buildApp } = await import("../../src/server/app.ts");

      const db = getDb();
      const deviceKey = seedKeys(db);

      const appId = randomUUID();
      const now = Date.now();
      db.prepare(
        "INSERT INTO members (id, display_name, role, lifecycle, birth_month, birth_day, birth_year, created_at, updated_at) VALUES (?, ?, ?, 'active', NULL, NULL, NULL, ?, ?)"
      ).run(appId, "DisplayName", "parent", now, now);

      const app = await buildApp();

      try {
        const res = await app.inject({
          method: "PATCH",
          url: `/api/members/${appId}`,
          cookies: { mp_device_key: deviceKey },
          payload: { birthDate: { month: 9, day: 30 } },
        });

        expect(res.statusCode).toBe(200);

        const body = JSON.parse(res.body);
        expect(body.displayName).toBe("DisplayName");
        expect(body.role).toBe("parent");
        expect(body.birthDate).toEqual({ month: 9, day: 30, year: null });
      } finally {
        await app.close();
      }
    });

    it("updates birthDate from {month,day,year} to new values", async () => {
      const { buildApp } = await import("../../src/server/app.ts");

      const db = getDb();
      const deviceKey = seedKeys(db);

      const appId = randomUUID();
      const now = Date.now();
      db.prepare(
        "INSERT INTO members (id, display_name, role, lifecycle, birth_month, birth_day, birth_year, created_at, updated_at) VALUES (?, ?, ?, 'active', 6, 15, 1980, ?, ?)"
      ).run(appId, "DisplayName", "parent", now, now);

      const app = await buildApp();

      try {
        const res = await app.inject({
          method: "PATCH",
          url: `/api/members/${appId}`,
          cookies: { mp_device_key: deviceKey },
          payload: { birthDate: { month: 3, day: 15, year: 1985 } },
        });

        expect(res.statusCode).toBe(200);

        const body = JSON.parse(res.body);
        expect(body.displayName).toBe("DisplayName");
        expect(body.role).toBe("parent");
        expect(body.birthDate).toEqual({ month: 3, day: 15, year: 1985 });
      } finally {
        await app.close();
      }
    });

    it("clears birthDate with birthDate:null", async () => {
      const { buildApp } = await import("../../src/server/app.ts");

      const db = getDb();
      const deviceKey = seedKeys(db);

      const appId = randomUUID();
      const now = Date.now();
      db.prepare(
        "INSERT INTO members (id, display_name, role, lifecycle, birth_month, birth_day, birth_year, created_at, updated_at) VALUES (?, ?, ?, 'active', 6, 15, 1980, ?, ?)"
      ).run(appId, "DisplayName", "parent", now, now);

      const app = await buildApp();

      try {
        const res = await app.inject({
          method: "PATCH",
          url: `/api/members/${appId}`,
          cookies: { mp_device_key: deviceKey },
          payload: { birthDate: null },
        });

        expect(res.statusCode).toBe(200);

        const body = JSON.parse(res.body);
        expect(body.displayName).toBe("DisplayName");
        expect(body.role).toBe("parent");
        expect(body.birthDate).toBeNull();
      } finally {
        await app.close();
      }
    });

    it("updates all fields: displayName, role, and birthDate", async () => {
      const { buildApp } = await import("../../src/server/app.ts");

      const db = getDb();
      const deviceKey = seedKeys(db);

      const appId = randomUUID();
      const now = Date.now();
      db.prepare(
        "INSERT INTO members (id, display_name, role, lifecycle, birth_month, birth_day, birth_year, created_at, updated_at) VALUES (?, ?, ?, 'active', 6, 15, 1980, ?, ?)"
      ).run(appId, "OriginalName", "parent", now, now);

      const app = await buildApp();

      try {
        const res = await app.inject({
          method: "PATCH",
          url: `/api/members/${appId}`,
          cookies: { mp_device_key: deviceKey },
          payload: {
            displayName: "NewName",
            role: "child",
            birthDate: { month: 12, day: 31, year: 2000 },
          },
        });

        expect(res.statusCode).toBe(200);

        const body = JSON.parse(res.body);
        expect(body.displayName).toBe("NewName");
        expect(body.role).toBe("child");
        expect(body.birthDate).toEqual({ month: 12, day: 31, year: 2000 });
      } finally {
        await app.close();
      }
    });

    it("rejects role='admin' with 400", async () => {
      const { buildApp } = await import("../../src/server/app.ts");

      const db = getDb();
      const deviceKey = seedKeys(db);

      const appId = randomUUID();
      const now = Date.now();
      db.prepare(
        "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)"
      ).run(appId, "OriginalName", "parent", now, now);

      const app = await buildApp();

      try {
        const res = await app.inject({
          method: "PATCH",
          url: `/api/members/${appId}`,
          cookies: { mp_device_key: deviceKey },
          payload: { role: "admin" },
        });

        expect(res.statusCode).toBe(400);

        const body = JSON.parse(res.body);
        expect(body).toHaveProperty("error");
      } finally {
        await app.close();
      }
    });

    it("returns 404 when member does not exist", async () => {
      const { buildApp } = await import("../../src/server/app.ts");

      const db = getDb();
      const deviceKey = seedKeys(db);

      const fakeId = "non-existent-id";
      const app = await buildApp();

      try {
        const res = await app.inject({
          method: "PATCH",
          url: `/api/members/${fakeId}`,
          cookies: { mp_device_key: deviceKey },
          payload: { displayName: "NewName" },
        });

        expect(res.statusCode).toBe(404);

        const body = JSON.parse(res.body);
        expect(body.error).toBe("not_found");
      } finally {
        await app.close();
      }
    });

    it("rejects invalid birthDate {month:2,day:30} with 400", async () => {
      const { buildApp } = await import("../../src/server/app.ts");

      const db = getDb();
      const deviceKey = seedKeys(db);

      const appId = randomUUID();
      const now = Date.now();
      db.prepare(
        "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)"
      ).run(appId, "OriginalName", "parent", now, now);

      const app = await buildApp();

      try {
        const res = await app.inject({
          method: "PATCH",
          url: `/api/members/${appId}`,
          cookies: { mp_device_key: deviceKey },
          payload: { birthDate: { month: 2, day: 30 } },
        });

        expect(res.statusCode).toBe(400);

        const body = JSON.parse(res.body);
        expect(body).toHaveProperty("error");
      } finally {
        await app.close();
      }
    });
  });
  describe("regression tests", () => {
    it("rejects empty patch {} with 400 (P2 regression)", async () => {
      const { buildApp } = await import("../../src/server/app.ts");

      const db = getDb();
      const deviceKey = seedKeys(db);

      const appId = randomUUID();
      const now = Date.now();
      db.prepare(
        "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)"
      ).run(appId, "DisplayName", "parent", now, now);

      const app = await buildApp();

      try {
        const res = await app.inject({
          method: "PATCH",
          url: `/api/members/${appId}`,
          cookies: { mp_device_key: deviceKey },
          payload: {},
        });

        expect(res.statusCode).toBe(400);

        const body = JSON.parse(res.body);
        expect(body.error).toBe("validation_error");
      } finally {
        await app.close();
      }
    });

    it("preserves role when patch has only displayName (P1 regression)", async () => {
      const { buildApp } = await import("../../src/server/app.ts");

      const db = getDb();
      const deviceKey = seedKeys(db);

      const appId = randomUUID();
      const now = Date.now();
      db.prepare(
        "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)"
      ).run(appId, "DisplayName", "child", now, now);

      const app = await buildApp();

      try {
        const res = await app.inject({
          method: "PATCH",
          url: `/api/members/${appId}`,
          cookies: { mp_device_key: deviceKey },
          payload: { displayName: "UpdatedName" },
        });

        expect(res.statusCode).toBe(200);

        const body = JSON.parse(res.body);
        expect(body.displayName).toBe("UpdatedName");
        expect(body.role).toBe("child");
      } finally {
        await app.close();
      }
    });
  });
});
