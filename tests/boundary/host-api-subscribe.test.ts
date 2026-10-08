import tsEslint from "typescript-eslint";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";
import { emit, subscribe } from "../../src/server/host-api";

/** The host-api barrel exports `subscribe` so plugin modules can listen to core events
 * without importing the event bus directly (Rule B, ADR-039 §2b′; ADR-040).
 * Two checks protect that boundary:
 * 1. RUNTIME: a caller imports `subscribe` THROUGH THE BARREL and receives a real event emitted
 * through the SAME real bus (`emit`, also barrel-exported) — not a mock, not a re-implemented
 * bus. `routines.completion_changed` provides a production-shaped fixture event.
 * 2. STATIC (Rule B regression guard): a plugin-zone fixture file that imports `subscribe` from
 * `../../host-api` must NOT trip `import-x/no-restricted-paths` — mirrors the existing
 * allowed-reach cases in tests/boundary/daily-briefing-import-boundary.test.ts (which predate
 * `subscribe`'s barrel export) via the SAME in-process ESLint Node API technique (no fixture
 * file is written to disk; `lintText`'s `filePath` only needs its import TARGETS to resolve
 * against real files, matching every other Rule-B fixture test in this repo).
 */

describe("host-api subscribe seam (research D9)", () => {
  it("a caller subscribing through the barrel receives a real event emitted through the same bus", async () => {
    const received: Array<{
      memberId: string;
      choreId: string;
      routineId: string;
      date: string;
      completed: boolean;
      timestamp: number;
    }> = [];

    subscribe("routines.completion_changed", (payload) => {
      received.push(payload);
    });

    const payload = {
      memberId: "member-1",
      choreId: "chore-1",
      routineId: "routine-1",
      date: "2026-09-08",
      completed: true,
      timestamp: Date.now(),
    };
    emit("routines.completion_changed", payload);

    // ADR-040: the bus dispatches fire-and-forget via queueMicrotask — the emitter never blocks on
    // subscribers, so the test must yield the microtask queue before asserting delivery.
    await Promise.resolve();
    await Promise.resolve();

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(payload);
    // ADR-040 fault containment: each handler gets its OWN frozen structuredClone — mutating the
    // received payload must never be possible, and it must not be the SAME object reference emit
    // was called with (proves the copy, not just the value).
    expect(received[0]).not.toBe(payload);
    expect(Object.isFrozen(received[0])).toBe(true);
  });

  describe("Rule B regression guard — the barrel's subscribe export", () => {
    const repoRoot = path.resolve(__dirname, "../..");

    async function lint(relativeFilePath: string, code: string) {
      const eslint = new ESLint({
        cwd: repoRoot,
        overrideConfig: tsEslint.configs.disableTypeChecked,
      });
      const results = await eslint.lintText(code, {
        filePath: path.join(repoRoot, relativeFilePath),
      });
      return results[0]?.messages ?? [];
    }

    it("allows a daily-briefing plugin-zone module subscribing through ../../host-api", async () => {
      const messages = await lint(
        "src/server/modules/daily-briefing/__fixture_allowed_subscribe__.ts",
        `import { subscribe } from "../../host-api";\n` +
          `subscribe("routines.completion_changed", () => {});\n`
      );
      expect(messages.filter((m) => m.ruleId === "import-x/no-restricted-paths")).toHaveLength(0);
    });

    it("still rejects a plugin-zone module reaching the event bus DIRECTLY (../../lib/event-bus)", async () => {
      const messages = await lint(
        "src/server/modules/daily-briefing/__fixture_forbidden_eventbus__.ts",
        `import { subscribe } from "../../lib/event-bus";\n` + `export const use = subscribe;\n`
      );
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ ruleId: "import-x/no-restricted-paths" }),
        ])
      );
    });
  });
});
