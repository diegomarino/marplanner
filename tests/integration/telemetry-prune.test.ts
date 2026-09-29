import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/server/db/client";
import { getScheduler, initScheduler } from "../../src/server/scheduler/index";
import { agedClientLogRowsExist, pruneClientLog } from "../../src/server/telemetry/index";
import { TELEMETRY_PRUNE_JOB_ID, registerTelemetryPruneJob } from "../../src/server/telemetry/job";
import { useIsolatedDb } from "../helpers/db";

/** scheduled retention prune (design/contracts/
 * client-logging-telemetry.md CLIENT-LOGGING-TELEMETRY-INV-09/-AC-04). All
 * time-boundary assertions use a FROZEN, explicitly-passed `nowMs` argument
 * to `pruneClientLog`/`agedClientLogRowsExist` — never a real wall-clock
 * read — so the retention-window cutoff math is exercised deterministically
 * regardless of when this suite actually runs (no wall-clock-dependent
 * assertions, per the timestamp-time-bomb lesson from).
 */
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const FROZEN_NOW = Date.UTC(2026, 5, 15, 12, 0, 0); // 2026-06-15T12:00:00Z — arbitrary, fixed

function seedClientLogRow(receivedAt: number, opts: { component?: string } = {}): void {
  const { component = "kiosk.boot" } = opts;
  getDb()
    .prepare(
      `INSERT INTO client_log (id, event_id, event_time, received_at, level, component, message, data)
       VALUES (?, ?, NULL, ?, 'info', ?, 'row', NULL)`
    )
    .run(`row-${receivedAt}-${component}`, `evt-${receivedAt}-${component}`, receivedAt, component);
}

function countClientLogRows(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS count FROM client_log").get() as {
    count: number;
  };
  return row.count;
}

describe("telemetry retention prune (T011 — research D7)", () => {
  useIsolatedDb();

  afterEach(async () => {
    try {
      await getScheduler().stop();
    } catch {
      // not initialized by a given test — nothing to drain
    }
  });

  describe("CLIENT-LOGGING-TELEMETRY-AC-04: zero-ingest fixture", () => {
    it("pruning an empty table returns 0 and never throws", () => {
      expect(countClientLogRows()).toBe(0);
      expect(() => pruneClientLog(FROZEN_NOW)).not.toThrow();
      expect(pruneClientLog(FROZEN_NOW)).toBe(0);
      expect(countClientLogRows()).toBe(0);
    });

    it("agedClientLogRowsExist() is false on an empty table", () => {
      expect(agedClientLogRowsExist(FROZEN_NOW)).toBe(false);
    });
  });

  describe("CLIENT-LOGGING-TELEMETRY-INV-09: strictly-older-than-cutoff deletion", () => {
    it("a row exactly AT the boundary instant (received_at === cutoff) survives", () => {
      const cutoff = FROZEN_NOW - THIRTY_DAYS_MS;
      seedClientLogRow(cutoff, { component: "boundary" });

      expect(agedClientLogRowsExist(FROZEN_NOW)).toBe(false);
      const deleted = pruneClientLog(FROZEN_NOW);

      expect(deleted).toBe(0);
      expect(countClientLogRows()).toBe(1);
    });

    it("a row strictly older than the retention window is deleted; a fresh row survives alongside it", () => {
      const cutoff = FROZEN_NOW - THIRTY_DAYS_MS;
      seedClientLogRow(cutoff - 1, { component: "aged" }); // strictly older -> deleted
      seedClientLogRow(FROZEN_NOW, { component: "fresh" }); // well within the window -> survives

      expect(agedClientLogRowsExist(FROZEN_NOW)).toBe(true);
      const deleted = pruneClientLog(FROZEN_NOW);

      expect(deleted).toBe(1);
      expect(countClientLogRows()).toBe(1);
      const remaining = getDb().prepare("SELECT component FROM client_log").get() as {
        component: string;
      };
      expect(remaining.component).toBe("fresh");
    });

    it("idempotent re-run: a second prune at the same frozen instant deletes nothing further", () => {
      const cutoff = FROZEN_NOW - THIRTY_DAYS_MS;
      seedClientLogRow(cutoff - 1, { component: "aged-1" });
      seedClientLogRow(cutoff - THIRTY_DAYS_MS, { component: "aged-2" });
      seedClientLogRow(FROZEN_NOW, { component: "fresh" });

      const firstRun = pruneClientLog(FROZEN_NOW);
      expect(firstRun).toBe(2);
      expect(countClientLogRows()).toBe(1);

      const secondRun = pruneClientLog(FROZEN_NOW);
      expect(secondRun).toBe(0);
      expect(countClientLogRows()).toBe(1);
      expect(agedClientLogRowsExist(FROZEN_NOW)).toBe(false);
    });
  });

  describe('real registration path — runJobNow("telemetry.prune")', () => {
    it("CLIENT-LOGGING-TELEMETRY-AC-04/-INV-09: prunes aged rows and keeps fresh rows through the actual registered scheduler job", async () => {
      // Real, unfrozen deps deliberately here — this test proves the
      // REGISTRATION wiring (job id, action binding), not the boundary math
      // (already pinned above with a frozen `nowMs`). A large margin
      // (well over 30 days vs. "now") keeps the aged/fresh split correct
      // regardless of the instant this test actually runs at.
      const now = Date.now();
      const wellAged = now - THIRTY_DAYS_MS - 24 * 60 * 60 * 1000; // ~31 days old
      seedClientLogRow(wellAged, { component: "aged-real" });
      seedClientLogRow(now, { component: "fresh-real" });
      expect(countClientLogRows()).toBe(2);

      initScheduler();
      registerTelemetryPruneJob();

      const result = await getScheduler().runJobNow(TELEMETRY_PRUNE_JOB_ID);

      expect(result).toMatchObject({ status: "completed" });
      expect(countClientLogRows()).toBe(1);
      const remaining = getDb().prepare("SELECT component FROM client_log").get() as {
        component: string;
      };
      expect(remaining.component).toBe("fresh-real");
    });

    it("re-running the real registered job after a prune completes without deleting anything further", async () => {
      const now = Date.now();
      const wellAged = now - THIRTY_DAYS_MS - 24 * 60 * 60 * 1000;
      seedClientLogRow(wellAged, { component: "aged-real" });

      initScheduler();
      registerTelemetryPruneJob();

      const first = await getScheduler().runJobNow(TELEMETRY_PRUNE_JOB_ID);
      expect(first).toMatchObject({ status: "completed" });
      expect(countClientLogRows()).toBe(0);

      const second = await getScheduler().runJobNow(TELEMETRY_PRUNE_JOB_ID);
      expect(second).toMatchObject({ status: "completed" });
      expect(countClientLogRows()).toBe(0);
    });
  });
});
