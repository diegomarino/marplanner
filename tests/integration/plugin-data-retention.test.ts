import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import { hashKey } from "../../src/server/auth/credentials.js";
import { getDb } from "../../src/server/db/client.js";
import { upsertMessage } from "../../src/server/modules/daily-messages/index.js";
import { createReminder } from "../../src/server/modules/reminders/index.js";
import {
  createTimeAnnouncementRule,
  listTimeAnnouncementRules,
} from "../../src/server/modules/time-announcements/index.js";
import { writeSettingsObject } from "../../src/server/modules/settings/index.js";
import { createServerPluginRuntime } from "../../src/server/plugins/runtime.js";
import { SqlitePluginLifecycleStore } from "../../src/server/plugins/store.js";
import type { PluginId } from "../../src/shared/plugins.js";
import { useIsolatedDb } from "../helpers/db.js";

const NOW = "2026-09-28T08:00:00.000Z";
const MEMBER_ID = "retention-member";
const DATE = "2026-09-28";
const RETAINED_PLUGINS = [
  "weather",
  "daily-messages",
  "time-announcements",
  "reminders",
] as const satisfies readonly PluginId[];

describe("plugin data retention", () => {
  useIsolatedDb();

  let app: FastifyInstance;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(async () => {
    await app?.close();
    vi.useRealTimers();
  });

  it("retains exact settings, domain rows, and completed migrations across deactivate/reactivate", async () => {
    const db = getDb();
    const nowMs = Date.parse(NOW);
    const deviceKey = "mpk-plugin-retention";
    db.prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    ).run("retention-device", hashKey(deviceKey), nowMs);
    db.prepare(
      "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, 'child', 'active', ?, ?)"
    ).run(MEMBER_ID, "Ada", nowMs, nowMs);

    const store = new SqlitePluginLifecycleStore(db);
    const runtime = createServerPluginRuntime({
      store,
      now: () => NOW,
      operationId: (pluginId) => `retention-${pluginId}`,
      drainDeadline: () => ({ expiresAt: "2026-09-28T08:01:00.000Z" }),
    });

    for (const pluginId of RETAINED_PLUGINS) {
      await runtime.lifecycle.activate(pluginId);
      expect(store.applyPluginMigration(pluginId, "001-retained", NOW, () => undefined)).toBe(true);
    }

    writeSettingsObject("weather", { lat: 40.4168, lon: -3.7038, label: "Madrid" }, db);
    const message = upsertMessage(MEMBER_ID, DATE, "Bring the blue folder");
    const announcement = createTimeAnnouncementRule({
      time: "07:30",
      weekDays: ["mon", "wed"],
      isActive: true,
    });
    const reminder = createReminder({
      kind: "scheduled",
      targetingMode: "apply_to_all",
      text: "Pack the sports bag",
      weekdays: ["mon"],
    });

    const snapshots = {
      settings: db
        .prepare(
          "SELECT object_name, data, updated_at FROM settings_objects WHERE object_name = 'weather'"
        )
        .all(),
      messages: db
        .prepare(
          "SELECT id, member_id, date, text, created_at, updated_at FROM daily_messages ORDER BY id"
        )
        .all(),
      announcements: db
        .prepare(
          "SELECT id, time, week_days, is_active, created_at, updated_at FROM time_announcements ORDER BY id"
        )
        .all(),
      reminders: db
        .prepare(
          "SELECT id, kind, targeting_mode, text, weekdays, query, query_fields, active, created_at, updated_at FROM reminder ORDER BY id"
        )
        .all(),
      migrations: db
        .prepare(
          `SELECT plugin_id, migration_id, applied_at
           FROM plugin_migration_journal
           WHERE plugin_id IN ('weather', 'daily-messages', 'time-announcements', 'reminders')
           ORDER BY plugin_id, migration_id`
        )
        .all(),
    };
    expect(snapshots.settings).toHaveLength(1);
    expect(snapshots.messages).toHaveLength(1);
    expect(snapshots.announcements).toHaveLength(1);
    expect(snapshots.reminders).toHaveLength(1);
    expect(snapshots.migrations).toEqual([
      { plugin_id: "daily-messages", migration_id: "001-retained", applied_at: NOW },
      { plugin_id: "reminders", migration_id: "001-retained", applied_at: NOW },
      { plugin_id: "time-announcements", migration_id: "001-retained", applied_at: NOW },
      { plugin_id: "weather", migration_id: "001-retained", applied_at: NOW },
    ]);

    const { buildApp } = await import("../../src/server/app.js");
    app = await buildApp({ pluginLifecycle: runtime.lifecycle });
    const cookies = { mp_device_key: deviceKey };

    for (const pluginId of RETAINED_PLUGINS) {
      await expect(runtime.lifecycle.deactivate(pluginId)).resolves.toMatchObject({
        id: pluginId,
        state: "inactive",
      });
    }

    expect(
      (await app.inject({ method: "GET", url: "/api/settings", cookies })).json()
    ).not.toHaveProperty("weather");
    for (const url of [
      `/api/daily-messages/current?memberId=${MEMBER_ID}&date=${DATE}`,
      "/api/time-announcements",
      "/api/reminders",
    ]) {
      const response = await app.inject({ method: "GET", url, cookies });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        code: "plugin_unavailable",
        message: "This plugin is unavailable.",
      });
    }

    expect(retainedRows(db)).toEqual(snapshots);

    for (const pluginId of RETAINED_PLUGINS) {
      await expect(runtime.lifecycle.activate(pluginId)).resolves.toMatchObject({
        id: pluginId,
        state: "active",
      });
    }

    expect(retainedRows(db)).toEqual(snapshots);
    expect(
      (await app.inject({ method: "GET", url: "/api/settings", cookies })).json<
        Record<string, unknown>
      >().weather
    ).toEqual({ lat: 40.4168, lon: -3.7038, label: "Madrid" });

    const messageResponse = await app.inject({
      method: "GET",
      url: `/api/daily-messages/current?memberId=${MEMBER_ID}&date=${DATE}`,
      cookies,
    });
    expect(messageResponse.statusCode).toBe(200);
    expect(messageResponse.json()).toEqual(message);

    const announcementsResponse = await app.inject({
      method: "GET",
      url: "/api/time-announcements",
      cookies,
    });
    expect(announcementsResponse.statusCode).toBe(200);
    expect(announcementsResponse.json()).toEqual([announcement]);
    expect(listTimeAnnouncementRules()).toEqual([announcement]);

    const remindersResponse = await app.inject({
      method: "GET",
      url: "/api/reminders",
      cookies,
    });
    expect(remindersResponse.statusCode).toBe(200);
    expect(remindersResponse.json()).toEqual([reminder]);
  });
});

function retainedRows(db: ReturnType<typeof getDb>) {
  return {
    settings: db
      .prepare(
        "SELECT object_name, data, updated_at FROM settings_objects WHERE object_name = 'weather'"
      )
      .all(),
    messages: db
      .prepare(
        "SELECT id, member_id, date, text, created_at, updated_at FROM daily_messages ORDER BY id"
      )
      .all(),
    announcements: db
      .prepare(
        "SELECT id, time, week_days, is_active, created_at, updated_at FROM time_announcements ORDER BY id"
      )
      .all(),
    reminders: db
      .prepare(
        "SELECT id, kind, targeting_mode, text, weekdays, query, query_fields, active, created_at, updated_at FROM reminder ORDER BY id"
      )
      .all(),
    migrations: db
      .prepare(
        `SELECT plugin_id, migration_id, applied_at
         FROM plugin_migration_journal
         WHERE plugin_id IN ('weather', 'daily-messages', 'time-announcements', 'reminders')
         ORDER BY plugin_id, migration_id`
      )
      .all(),
  };
}
