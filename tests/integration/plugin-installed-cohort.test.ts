import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createServerPluginLifecycle } from "../../src/server/plugins/http";
import { getDb } from "../../src/server/db/client";
import { createServerPluginRuntime } from "../../src/server/plugins/runtime";
import { SqlitePluginLifecycleStore } from "../../src/server/plugins/store";
import { useIsolatedDb } from "../helpers/db";

const installed = JSON.parse(readFileSync("tests/fixtures/assembly-cohort.json", "utf8"))
  .installedPluginIds as string[];

describe("complete installed plugin cohort", () => {
  useIsolatedDb({ pluginState: "inactive" });
  it("initializes durable settings through the public server lifecycle factory", async () => {
    const lifecycle = createServerPluginLifecycle();
    await lifecycle.activate("weather");
    expect(
      getDb().prepare("SELECT data FROM settings_objects WHERE object_name = ?").get("weather")
    ).toEqual({ data: JSON.stringify({ lat: null, lon: null }) });
    expect(lifecycle.isActive("weather")).toBe(true);
    await lifecycle.deactivate("weather");
    expect(lifecycle.isActive("weather")).toBe(false);
    expect(lifecycle.canClaimWork("weather")).toBe(false);
  });
  it("installs the reviewed adapters and keeps every inactive contribution unavailable", async () => {
    const runtime = createServerPluginRuntime({
      store: new SqlitePluginLifecycleStore(() => getDb()),
      now: () => "2026-09-29T12:00:00.000Z",
      operationId: (id) => `test-${id}`,
      drainDeadline: () => ({ expiresAt: "2026-09-29T12:00:30.000Z" }),
    });
    expect(runtime.adapters.map((adapter) => adapter.manifest.id).sort()).toEqual(
      [...installed].sort()
    );
    await runtime.lifecycle.reconcileAll();
    for (const adapter of runtime.adapters) {
      expect(runtime.isContributionActive(adapter.manifest.id)).toBe(false);
      expect(runtime.lifecycle.canClaimWork(adapter.manifest.id)).toBe(false);
    }
  });
});
