import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getDb } from "../../src/server/db/client.js";
import {
  configureDailyBriefingContentSourceLifecycleGate,
  generateBriefing,
} from "../../src/server/modules/daily-briefing/index.js";
import { upsertMessage } from "../../src/server/modules/daily-messages/index.js";
import { createReminder } from "../../src/server/modules/reminders/index.js";
import { writeSettingsObject } from "../../src/server/modules/settings/index.js";
import { __setForecastPortForTests } from "../../src/server/modules/weather/port.js";
import { createServerPluginRuntime } from "../../src/server/plugins/runtime.js";
import { SqlitePluginLifecycleStore } from "../../src/server/plugins/store.js";
import type { PluginId } from "../../src/shared/plugins.js";
import { useIsolatedDb } from "../helpers/db.js";

const NOW = "2026-09-28T08:00:00.000Z";
const DATE = "2026-09-28";
const MEMBER_ID = "absence-member";
const PEERS = ["weather", "reminders", "daily-messages"] as const satisfies readonly PluginId[];

describe("Daily Briefing peer absence tolerance", () => {
  useIsolatedDb();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    __setForecastPortForTests(undefined);
    configureDailyBriefingContentSourceLifecycleGate(undefined);
    vi.useRealTimers();
  });

  it.each([
    ["weather", "inactive"],
    ["weather", "errored"],
    ["reminders", "inactive"],
    ["reminders", "errored"],
    ["daily-messages", "inactive"],
    ["daily-messages", "errored"],
  ] as const)("omits only %s content when the peer is %s", async (peerId, peerState) => {
    const { runtime, forecast } = await activeRuntimeWithPeerData();

    if (peerState === "inactive") {
      await runtime.lifecycle.deactivate(peerId);
    } else {
      await runtime.lifecycle.reportFault(peerId, { code: "contribution_failed" });
    }

    const briefing = await generateBriefing(MEMBER_ID, DATE);
    const types = briefing.payload.blocks.map(({ type }) => type);
    const expectedPresence = {
      weather: peerId !== "weather",
      reminders: peerId !== "reminders",
      message: peerId !== "daily-messages",
    };

    expect(briefing.status).toBe("ready");
    expect(types.includes("weather")).toBe(expectedPresence.weather);
    expect(types.includes("weatherText")).toBe(expectedPresence.weather);
    expect(types.includes("reminders")).toBe(expectedPresence.reminders);
    expect(types.includes("message")).toBe(expectedPresence.message);
    expect(forecast).toHaveBeenCalledTimes(peerId === "weather" ? 0 : 1);
    expect(sourceRowCounts()).toEqual({ messages: 1, reminders: 1 });
  });

  it("allows Daily Briefing to activate and generate before peers, then consumes them after independent activation", async () => {
    const db = getDb();
    seedMemberAndOptIn(db);
    seedPeerData(db);
    const forecast = installForecast();
    const runtime = createRuntime();

    await runtime.lifecycle.activate("daily-briefing");
    const withoutPeers = await generateBriefing(MEMBER_ID, DATE);
    expect(peerBlockTypes(withoutPeers.payload.blocks.map(({ type }) => type))).toEqual([]);
    expect(forecast).not.toHaveBeenCalled();

    for (const peerId of ["daily-messages", "weather", "reminders"] as const) {
      await runtime.lifecycle.activate(peerId);
    }

    const withPeers = await generateBriefing(MEMBER_ID, DATE);
    expect(peerBlockTypes(withPeers.payload.blocks.map(({ type }) => type))).toEqual([
      "message",
      "weather",
      "reminders",
      "weatherText",
    ]);
    expect(forecast).toHaveBeenCalledTimes(1);
  });
});

async function activeRuntimeWithPeerData() {
  const db = getDb();
  seedMemberAndOptIn(db);
  seedPeerData(db);
  const forecast = installForecast();
  const runtime = createRuntime();

  await runtime.lifecycle.activate("daily-briefing");
  for (const peerId of PEERS) await runtime.lifecycle.activate(peerId);

  return { runtime, forecast };
}

function createRuntime() {
  return createServerPluginRuntime({
    store: new SqlitePluginLifecycleStore(getDb()),
    now: () => NOW,
    operationId: (pluginId) => `absence-${pluginId}`,
    drainDeadline: () => ({ expiresAt: "2026-09-28T08:01:00.000Z" }),
  });
}

function seedMemberAndOptIn(db: ReturnType<typeof getDb>): void {
  const nowMs = Date.parse(NOW);
  db.prepare(
    "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, 'child', 'active', ?, ?)"
  ).run(MEMBER_ID, "Ada", nowMs, nowMs);
  db.prepare(
    "INSERT INTO daily_briefing_optin (member_id, enabled, created_at, updated_at) VALUES (?, 1, ?, ?)"
  ).run(MEMBER_ID, nowMs, nowMs);
}

function seedPeerData(db: ReturnType<typeof getDb>): void {
  writeSettingsObject("weather", { lat: 40.4168, lon: -3.7038, label: "Madrid" }, db);
  upsertMessage(MEMBER_ID, DATE, "Bring the blue folder");
  createReminder({
    kind: "scheduled",
    targetingMode: "apply_to_all",
    text: "Pack the sports bag",
    weekdays: ["mon"],
  });
}

function installForecast() {
  const forecast = vi.fn(async () => ({
    current: { conditionKey: "clear" as const, tempC: 20, rainPct: 5 },
    hourly: [],
    daily: [
      {
        date: DATE,
        conditionKey: "clear" as const,
        tempMinC: 14,
        tempMaxC: 23,
        rainPct: 5,
      },
    ],
  }));
  __setForecastPortForTests(forecast);
  return forecast;
}

function sourceRowCounts() {
  const db = getDb();
  return {
    messages: (
      db.prepare("SELECT COUNT(*) AS count FROM daily_messages").get() as { count: number }
    ).count,
    reminders: (db.prepare("SELECT COUNT(*) AS count FROM reminder").get() as { count: number })
      .count,
  };
}

function peerBlockTypes(types: readonly string[]): string[] {
  const peers = new Set(["weather", "weatherText", "reminders", "message"]);
  return types.filter((type) => peers.has(type));
}
