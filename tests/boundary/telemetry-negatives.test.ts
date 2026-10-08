import tsEslint from "typescript-eslint";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

/** negative proofs (FR-001/FR-006/FR-011/FR-012):
 * 1. A broken telemetry pipeline blocks NO unrelated product write (INV-01, AC-06).
 * 2. Zero telemetry entries exist in the shared event-bus catalog (INV-14 — telemetry never
 * participates in the event bus).
 * 3. No legacy (v1) client-log import path exists anywhere under `src/` (AC-07 — the fresh deployment
 * store never imports the 119 legacy rows; they are evidence only, as migration evidence only).
 * 4. Telemetry is always-on with no household setting able to gate it (INV-12).
 */
describe("telemetry negative proofs", () => {
  useIsolatedDb();

  describe("1. CLIENT-LOGGING-TELEMETRY-AC-06: telemetry outage blocks no unrelated product write (FR-001)", () => {
    function seedApiKeys(): { bootstrapKey: string; deviceKey: string } {
      const db = getDb();
      const now = Date.now();
      const bootstrapKey = `mpg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      db.prepare(
        "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'bootstrap', ?)"
      ).run(`${Date.now()}-bootstrap`, hashKey(bootstrapKey), now);
      const deviceKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      db.prepare(
        "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
      ).run(`${Date.now()}-device`, hashKey(deviceKey), now);
      return { bootstrapKey, deviceKey };
    }

    it("a member write succeeds unchanged when the client_log table is gone entirely", async () => {
      const { deviceKey } = seedApiKeys();
      getDb().exec("DROP TABLE client_log");

      const { buildApp } = await import("../../src/server/app.ts");
      const app = await buildApp();
      try {
        const res = await app.inject({
          method: "POST",
          url: "/api/members",
          cookies: { mp_device_key: deviceKey },
          payload: { displayName: "Telemetry Outage Probe", role: "child" },
        });
        expect(res.statusCode).toBe(201);
        const body = JSON.parse(res.body) as { displayName: string };
        expect(body.displayName).toBe("Telemetry Outage Probe");
      } finally {
        await app.close();
      }
    });

    it("a member read succeeds unchanged when the client_log table is gone entirely", async () => {
      const { deviceKey } = seedApiKeys();
      getDb().exec("DROP TABLE client_log");

      const { buildApp } = await import("../../src/server/app.ts");
      const app = await buildApp();
      try {
        const res = await app.inject({
          method: "GET",
          url: "/api/members",
          cookies: { mp_device_key: deviceKey },
        });
        expect(res.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });

    it("writeClientLog() itself never throws when its own table is missing — it drops the entry instead", async () => {
      getDb().exec("DROP TABLE client_log");
      const { writeClientLog } = await import("../../src/server/telemetry/index");

      expect(() =>
        writeClientLog("outage-probe", [{ level: "info", component: "x", message: "y" }])
      ).not.toThrow();
      const result = writeClientLog("outage-probe", [
        { level: "info", component: "x", message: "y" },
      ]);
      expect(result).toEqual({ accepted: 0, dropped: 1 });
    });
  });

  describe("2. CLIENT-LOGGING-TELEMETRY-INV-14: zero telemetry entries in src/shared/events.ts", () => {
    it("the CoreEventCatalog source contains no telemetry-shaped event names", () => {
      const source = readFileSync(join(__dirname, "../../src/shared/events.ts"), "utf8");
      expect(source).not.toMatch(/telemetry/i);
      expect(source).not.toMatch(/client_log/i);
      expect(source).not.toMatch(/clientlog/i);
    });
  });

  describe("3. CLIENT-LOGGING-TELEMETRY-AC-07: no legacy (v1) client-log import path exists under src/", () => {
    /** Recursively collect every file under `dir` (skips node_modules-style noise by caller). */
    function collectFiles(dir: string, acc: string[] = []): string[] {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
          collectFiles(full, acc);
        } else {
          acc.push(full);
        }
      }
      return acc;
    }

    it("no source file under src/ imports a legacy v1 telemetry/client-log module or path", () => {
      const srcRoot = join(__dirname, "../../src");
      const files = collectFiles(srcRoot).filter((f) => /\.(ts|tsx)$/.test(f));

      // Markers that would indicate a legacy (v1) import path: the former module paths
      // (`apps/api/src/routes/telemetry-client-log.ts` /
      // `apps/web/src/lib/logger-browser-sink.ts`), or a generically-named import/migration
      // helper for pulling v1 client-log rows into the fresh deployment store.
      const legacyMarkers = [
        /apps\/api\/src\/routes\/telemetry-client-log/i,
        /apps\/web\/src\/lib\/logger-browser-sink/i,
        /import.*legacy.*client.?log/i,
        /migrateV1(Telemetry|ClientLog)/,
        /importLegacy(Telemetry|ClientLog)/,
      ];

      const offenders: string[] = [];
      for (const file of files) {
        const text = readFileSync(file, "utf8");
        if (legacyMarkers.some((marker) => marker.test(text))) {
          offenders.push(file);
        }
      }
      expect(offenders).toEqual([]);
    });

    it("zero client_log rows exist in a freshly-migrated database (fresh deployment store, Constitution I)", () => {
      const db = getDb();
      const row = db.prepare("SELECT COUNT(*) as n FROM client_log").get() as { n: number };
      expect(row.n).toBe(0);
    });
  });

  describe("4. CLIENT-LOGGING-TELEMETRY-INV-12: telemetry is always-on — no household setting can gate it", () => {
    it("no `settings_objects` row references telemetry, and ingest works with zero settings rows present", async () => {
      const db = getDb();
      const settingsRows = db.prepare("SELECT object_name FROM settings_objects").all() as Array<{
        object_name: string;
      }>;
      expect(settingsRows.some((r) => /telemetry/i.test(r.object_name))).toBe(false);

      // The absence of ANY settings row (a fresh, un-provisioned DB has none by default) must
      // not block ingest — there is no settings lookup anywhere in the write path.
      const { writeClientLog } = await import("../../src/server/telemetry/index");
      const result = writeClientLog("always-on-probe", [
        { level: "info", component: "x", message: "y" },
      ]);
      expect(result).toEqual({ accepted: 1, dropped: 0 });
    });

    it("no source file under src/server/telemetry or src/server/routes/telemetry.ts reads settings_objects (no gate to bypass)", () => {
      const files = [
        join(__dirname, "../../src/server/telemetry/index.ts"),
        join(__dirname, "../../src/server/routes/telemetry.ts"),
      ];
      for (const file of files) {
        const text = readFileSync(file, "utf8");
        expect(text).not.toMatch(/settings_objects/i);
        expect(text).not.toMatch(/settingsObjects/);
      }
    });
  });

  describe("5. CLIENT-LOGGING-TELEMETRY-INV-05/CLIENT-LOGGING-TELEMETRY-INV-06: the client lint net fires (P2-3/623 review — executable proof, not just eslint.config.mjs prose)", () => {
    /** `eslint.config.mjs` documents two client-only lint rules that this domain relies on as its
     * "convention + lint net" (FR-006, no taint-analysis hard gate): `no-console` (INV-06 — raw
     * console usage outside the logger is banned on the client) and `no-restricted-syntax`
     * (INV-05 — the logger's `data` argument must be structured, never free-text). Config prose
     * alone is not proof the rules actually fire; this test lints an in-memory fixture through
     * the real ESLint Node API (flat config auto-discovered from `cwd`) and asserts both rule ids
     * appear in the result.
     */
    it("a fixture with a raw console call and a template-literal `data` argument trips both rules", async () => {
      const { ESLint } = await import("eslint");
      const repoRoot = join(__dirname, "../..");
      const eslint = new ESLint({
        cwd: repoRoot,
        overrideConfig: tsEslint.configs.disableTypeChecked,
      });

      const fixture = [
        'import { log } from "../../src/client/lib/logger";',
        "",
        'console.log("bad console usage — INV-06 violation");',
        "",
        'const userInput = "x";',
        'log("info", "test.component", "message", `interpolated ${userInput}`); // INV-05 violation',
        "",
      ].join("\n");

      const results = await eslint.lintText(fixture, {
        filePath: join(repoRoot, "src/client/__telemetry-lint-probe.ts"),
      });

      expect(results).toHaveLength(1);
      const ruleIds = results[0].messages.map((m) => m.ruleId);
      expect(ruleIds).toContain("no-console");
      expect(ruleIds).toContain("no-restricted-syntax");
    });

    it("the SAME template-literal `data` argument does NOT trip no-restricted-syntax inside src/client/lib/logger.ts's own no-console exemption zone (sanity: the exemption is console-only, not a blanket opt-out)", async () => {
      const { ESLint } = await import("eslint");
      const repoRoot = join(__dirname, "../..");
      const eslint = new ESLint({
        cwd: repoRoot,
        overrideConfig: tsEslint.configs.disableTypeChecked,
      });

      const fixture = [
        "declare function log(level: string, component: string, message: string, data?: unknown): void;",
        'console.log("allowed here — logger.ts is the one console exemption");',
        "",
        'const userInput = "x";',
        'log("info", "test.component", "message", `interpolated ${userInput}`);',
        "",
      ].join("\n");

      const results = await eslint.lintText(fixture, {
        filePath: join(repoRoot, "src/client/lib/logger.ts"),
      });

      expect(results).toHaveLength(1);
      const ruleIds = results[0].messages.map((m) => m.ruleId);
      expect(ruleIds).not.toContain("no-console");
      expect(ruleIds).toContain("no-restricted-syntax");
    });
  });
});
