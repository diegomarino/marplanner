import { describe, expect, it, vi } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { createEventBus } from "../../src/server/lib/event-bus";
import { writeClientLog, writeServerLog, getClientLogPage } from "../../src/server/telemetry";
import { useIsolatedDb } from "../helpers/db";

const payload = {
  memberId: "m",
  choreId: "c",
  routineId: "r",
  date: "2026-10-08",
  completed: true,
  timestamp: 0,
};

describe("event subscriber diagnostics", () => {
  useIsolatedDb();

  it("persists unique redacted sync and async failures and exposes them through the admin query", async () => {
    const bus = createEventBus();
    const peer = vi.fn();
    bus.subscribe(
      "routines.completion_changed",
      () => {
        throw new Error("sync failure");
      },
      "test.sync"
    );
    bus.subscribe(
      "routines.completion_changed",
      async () => {
        throw new Error("Bearer abcdefghijklmnopqrstuvwxyz0123456789");
      },
      "test.async"
    );
    bus.subscribe("routines.completion_changed", peer, "test.healthy");
    expect(() => bus.emit("routines.completion_changed", payload)).not.toThrow();
    expect(peer).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(getClientLogPage({ component: "event-bus", level: "error" })?.rows).toHaveLength(2)
    );
    expect(peer).toHaveBeenCalledOnce();
    const key = "mpk-test-event-subscriber-diagnostics";
    getDb()
      .prepare(
        "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES ('diagnostic-reader', ?, '*', 'device', 0)"
      )
      .run(hashKey(key));
    const { buildApp } = await import("../../src/server/app");
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/telemetry/client-log?level=error&component=event-bus",
        cookies: { mp_device_key: key },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().rows).toHaveLength(2);
    } finally {
      await app.close();
    }
    const rows = getClientLogPage({ component: "event-bus", level: "error" })!.rows;
    const data = rows.map((row) => JSON.parse(row.data!));
    expect(new Set(rows.map((row) => row.eventId)).size).toBe(2);
    expect(new Set(data.map((row) => row.failureId)).size).toBe(2);
    expect(data.map((row) => row.subscriber).sort()).toEqual(["test.async", "test.sync"]);
    for (const row of rows) {
      expect(row.message).toBe("event-bus.subscriber-failed");
      expect(row.data).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
      expect(JSON.parse(row.data!).event).toBe("routines.completion_changed");
    }
  });

  it("deduplicates anonymous registrations and preserves their identity across deliveries", async () => {
    const bus = createEventBus();
    const handler = () => {
      throw "plain failure";
    };
    bus.subscribe("routines.completion_changed", handler);
    bus.subscribe("routines.completion_changed", handler);
    bus.emit("routines.completion_changed", payload);
    bus.emit("routines.completion_changed", payload);
    await vi.waitFor(() =>
      expect(getClientLogPage({ component: "event-bus" })!.rows).toHaveLength(2)
    );
    const data = getClientLogPage({ component: "event-bus" })!.rows.map((row) =>
      JSON.parse(row.data!)
    );
    expect(data[0].subscriber).toBe(data[1].subscriber);
    expect(data[0].failureId).not.toBe(data[1].failureId);
    expect(data[0].error).toBe("plain failure");
  });

  it("contains diagnostic serialization failures and retains a unique stderr breadcrumb", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const error of [
        Object.assign(new Error("bad code"), { code: 1n }),
        Object.defineProperty(new Error("bad getter"), "message", {
          get() {
            throw new Error("unreadable");
          },
        }),
      ]) {
        const bus = createEventBus();
        bus.subscribe(
          "routines.completion_changed",
          () => {
            throw error;
          },
          "test.serialization"
        );
        bus.emit("routines.completion_changed", payload);
      }
      await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
      expect(spy.mock.calls[0][0]).toBe("event-bus.subscriber-failed");
      expect(spy.mock.calls[0][1]).toMatch(/^[0-9a-f-]{36}$/);
      expect(JSON.parse(spy.mock.calls[1][0] as string).data).toMatchObject({
        subscriber: "test.serialization",
        error: "Error details unavailable",
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps internal failures queryable beyond the client flood bound and rejects client impersonation", () => {
    const entry = {
      level: "error",
      component: "event-bus",
      message: "event-bus.subscriber-failed",
    };
    expect(writeClientLog("client", [entry])).toEqual({ accepted: 0, dropped: 1 });
    for (let n = 0; n < 601; n++)
      expect(writeServerLog(entry)).toEqual({ accepted: 1, dropped: 0 });
    expect(
      getDb().prepare("SELECT COUNT(*) AS n FROM client_log WHERE component = 'event-bus'").get()
    ).toEqual({ n: 601 });
  });

  it("falls back to redacted stderr when storage is unavailable while containing the fault", async () => {
    getDb().exec(
      "CREATE TEMP TRIGGER reject_log BEFORE INSERT ON client_log BEGIN SELECT RAISE(ABORT, 'unavailable'); END"
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const bus = createEventBus();
      bus.subscribe(
        "routines.completion_changed",
        () => {
          throw new Error("Bearer abcdefghijklmnopqrstuvwxyz0123456789");
        },
        "test.storage"
      );
      bus.emit("routines.completion_changed", payload);
      await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce());
      const line = spy.mock.calls[0][0] as string;
      expect(line).toContain("event-bus.subscriber-failed");
      expect(line).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
      expect(JSON.parse(line).data).toMatchObject({
        subscriber: "test.storage",
        event: "routines.completion_changed",
      });
    } finally {
      spy.mockRestore();
    }
  });
});
