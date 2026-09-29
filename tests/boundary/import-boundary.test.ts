import path from "node:path";
import { describe, it, expect } from "vitest";
import { ESLint } from "eslint";

/** RED fixture proof test for the path-aware PLUGIN import-boundary
 * (ADR-039 §2b′/Rule B, /AC-01/FR-002/FR-003/FR-009/FR-012).
 * Drives the flat-config `import-x/no-restricted-paths` zones via the ESLint
 * Node API over inline fixtures placed at real plugin paths — no fixture
 * files are written to disk; `lintText`'s `filePath` only needs to resolve
 * against files that already exist in the repo (members/referential,
 * calendar/index, db/client, lib/household-date, host-api, reminders/index)
 * for the resolver to find their targets.
 * No separate dynamic-import guard: eslint-plugin-import-x's `moduleVisitor`
 * defaults `esmodule: true`, so `no-restricted-paths` already visits dynamic
 * `import` (`ImportExpression`) the same path-aware way as static imports
 * — including nested files, where a fixed-depth regex guard would wrongly
 * red a valid own-subtree or depth-correct barrel import (REWORK on).
 * The nested-file fixtures below (both static and dynamic) prove this.
 * RED until registers the plugin + zones (docs/features/plugin-system.md
 * /R7); every "forbidden" case below currently passes with 0
 * errors because no rule is wired yet.
 */

const repoRoot = path.resolve(__dirname, "../..");

async function lint(relativeFilePath: string, code: string) {
  const eslint = new ESLint({ cwd: repoRoot });
  const results = await eslint.lintText(code, {
    filePath: path.join(repoRoot, relativeFilePath),
  });
  return results[0]?.messages ?? [];
}

describe("import-boundary — path-aware PLUGIN zones (eslint-plugin-import-x no-restricted-paths)", () => {
  describe("forbidden reaches (each must error, incl. static/dynamic/nested/path-normalized)", () => {
    it("static: reminders importing a core module internal (../members/referential)", async () => {
      const messages = await lint(
        "src/server/modules/reminders/__fixture_forbidden_members__.ts",
        `import { isActiveMember } from "../members/referential";\nexport const use = isActiveMember;\n`
      );
      expect(messages.length).toBeGreaterThanOrEqual(1);
    });

    it("static: reminders importing another core module internal (../calendar/index)", async () => {
      const messages = await lint(
        "src/server/modules/reminders/__fixture_forbidden_calendar__.ts",
        `import { getEvents } from "../calendar/index";\nexport const use = getEvents;\n`
      );
      expect(messages.length).toBeGreaterThanOrEqual(1);
    });

    it("static: reminders importing the raw DB handle (../../db/client)", async () => {
      const messages = await lint(
        "src/server/modules/reminders/__fixture_forbidden_dbclient__.ts",
        `import { getDb } from "../../db/client";\nexport const use = getDb;\n`
      );
      expect(messages.length).toBeGreaterThanOrEqual(1);
    });

    it("static: reminders importing a core-data-backed platform lib (../../lib/household-date)", async () => {
      const messages = await lint(
        "src/server/modules/reminders/__fixture_forbidden_lib__.ts",
        `import { weekdayOf } from "../../lib/household-date";\nexport const use = weekdayOf;\n`
      );
      expect(messages.length).toBeGreaterThanOrEqual(1);
    });

    it("path-normalized: ../members/../members/referential still resolves to the forbidden target", async () => {
      const messages = await lint(
        "src/server/modules/reminders/__fixture_forbidden_normalized__.ts",
        `import { isActiveMember } from "../members/../members/referential";\nexport const use = isActiveMember;\n`
      );
      expect(messages.length).toBeGreaterThanOrEqual(1);
    });

    it("nested-file: reminders/sub/foo.ts reaching ../../../db/client (three levels: sub/→reminders/→modules/→server/)", async () => {
      const messages = await lint(
        "src/server/modules/reminders/sub/__fixture_forbidden_nested__.ts",
        `import { getDb } from "../../../db/client";\nexport const use = getDb;\n`
      );
      expect(messages.length).toBeGreaterThanOrEqual(1);
    });

    it("nested-file dynamic: reminders/sub/foo.ts reaching ../../../db/client via await import(...)", async () => {
      const messages = await lint(
        "src/server/modules/reminders/sub/__fixture_forbidden_nested_dynamic__.ts",
        `export async function use() {\n  return await import("../../../db/client");\n}\n`
      );
      expect(messages.length).toBeGreaterThanOrEqual(1);
    });

    it('dynamic: reminders await import("../members/referential")', async () => {
      const messages = await lint(
        "src/server/modules/reminders/__fixture_forbidden_dynamic__.ts",
        `export async function use() {\n  return await import("../members/referential");\n}\n`
      );
      expect(messages.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("allowed reaches (must be 0 errors)", () => {
    it("static: reminders importing the host-API barrel (../../host-api)", async () => {
      const messages = await lint(
        "src/server/modules/reminders/__fixture_allowed_barrel__.ts",
        `import { isActiveMember, getDb } from "../../host-api";\nexport const use = { isActiveMember, getDb };\n`
      );
      expect(messages).toHaveLength(0);
    });

    it("static: reminders importing a pure src/shared DTO", async () => {
      const messages = await lint(
        "src/server/modules/reminders/__fixture_allowed_shared__.ts",
        `import type { Weekday } from "../../../shared";\nexport type Use = Weekday;\n`
      );
      expect(messages).toHaveLength(0);
    });

    it('dynamic: reminders await import("../../host-api")', async () => {
      const messages = await lint(
        "src/server/modules/reminders/__fixture_allowed_dynamic_barrel__.ts",
        `export async function use() {\n  return await import("../../host-api");\n}\n`
      );
      expect(messages).toHaveLength(0);
    });

    it("nested-file dynamic: reminders/sub/foo.ts importing its own subtree (../index) is not flagged", async () => {
      const messages = await lint(
        "src/server/modules/reminders/sub/__fixture_allowed_nested_own__.ts",
        `export async function use() {\n  return await import("../index");\n}\n`
      );
      expect(messages).toHaveLength(0);
    });

    it("nested-file dynamic: reminders/sub/foo.ts reaching the barrel at the depth-correct ../../../host-api", async () => {
      const messages = await lint(
        "src/server/modules/reminders/sub/__fixture_allowed_nested_barrel__.ts",
        `export async function use() {\n  return await import("../../../host-api");\n}\n`
      );
      expect(messages).toHaveLength(0);
    });

    it("core-path file importing a sibling is not flagged (out of scope)", async () => {
      const messages = await lint(
        "src/server/modules/calendar/__fixture_core_sibling__.ts",
        `import { isActiveMember } from "../members/referential";\nexport const use = isActiveMember;\n`
      );
      expect(messages).toHaveLength(0);
    });
  });
});
