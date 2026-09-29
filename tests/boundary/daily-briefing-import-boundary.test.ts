import path from "node:path";
import { describe, it, expect } from "vitest";
import { ESLint } from "eslint";

/** Fixture proof test for the daily-briefing PLUGIN import-boundary zone
 * (ADR-039 §2b′/Rule B, mirroring the
 * pattern of the tests/boundary/import-boundary.test.ts). Drives
 * the flat-config `import-x/no-restricted-paths` zone via the ESLint Node
 * API over inline fixtures placed at the real `src/server/modules/
 * daily-briefing` path — no fixture files are written to disk; `lintText`'s * `filePath` only needs to resolve against files that already exist in the
 * repo (calendar/index, reminders/index, routines/index, meals/index,
 * members/referential, db/client, lib/household-date, host-api) for the
 * resolver to find their targets.
 * No separate dynamic-import guard: eslint-plugin-import-x's `moduleVisitor`
 * defaults `esmodule: true`, so `no-restricted-paths` already visits dynamic
 * `import` (`ImportExpression`) the same path-aware way as static imports
 * (the `no-restricted-syntax` guard was proven redundant + removed on
 * /) — the dynamic fixture below proves this for daily-briefing.
 * The registered daily-briefing zone must reject every "forbidden" case
 * below through `import-x/no-restricted-paths`.
 */

const repoRoot = path.resolve(__dirname, "../..");

async function lint(relativeFilePath: string, code: string) {
  const eslint = new ESLint({ cwd: repoRoot });
  const results = await eslint.lintText(code, {
    filePath: path.join(repoRoot, relativeFilePath),
  });
  return results[0]?.messages ?? [];
}

function expectRestrictedPathError(messages: Awaited<ReturnType<typeof lint>>) {
  expect(messages).toEqual(
    expect.arrayContaining([expect.objectContaining({ ruleId: "import-x/no-restricted-paths" })])
  );
}

describe("import-boundary — daily-briefing PLUGIN zone (eslint-plugin-import-x no-restricted-paths)", () => {
  describe("forbidden reaches (each must error, incl. static/dynamic/path-normalized)", () => {
    it("static: daily-briefing importing calendar core internal (../calendar/index)", async () => {
      const messages = await lint(
        "src/server/modules/daily-briefing/__fixture_forbidden_calendar__.ts",
        `import { getEvents } from "../calendar/index";\nexport const use = getEvents;\n`
      );
      expectRestrictedPathError(messages);
    });

    it("static: daily-briefing importing reminders plugin internal (../reminders/index)", async () => {
      const messages = await lint(
        "src/server/modules/daily-briefing/__fixture_forbidden_reminders__.ts",
        `import { getReminders } from "../reminders/index";\nexport const use = getReminders;\n`
      );
      expectRestrictedPathError(messages);
    });

    it("static: daily-briefing importing routines core internal (../routines/index)", async () => {
      const messages = await lint(
        "src/server/modules/daily-briefing/__fixture_forbidden_routines__.ts",
        `import { getBoard } from "../routines/index";\nexport const use = getBoard;\n`
      );
      expectRestrictedPathError(messages);
    });

    it("static: daily-briefing importing meals plugin internal (../meals/index)", async () => {
      const messages = await lint(
        "src/server/modules/daily-briefing/__fixture_forbidden_meals__.ts",
        `import { getMenu } from "../meals/index";\nexport const use = getMenu;\n`
      );
      expectRestrictedPathError(messages);
    });

    it("static: daily-briefing importing a core module internal (../members/referential)", async () => {
      const messages = await lint(
        "src/server/modules/daily-briefing/__fixture_forbidden_members__.ts",
        `import { isActiveMember } from "../members/referential";\nexport const use = isActiveMember;\n`
      );
      expectRestrictedPathError(messages);
    });

    it("static: daily-briefing importing the raw DB handle (../../db/client)", async () => {
      const messages = await lint(
        "src/server/modules/daily-briefing/__fixture_forbidden_dbclient__.ts",
        `import { getDb } from "../../db/client";\nexport const use = getDb;\n`
      );
      expectRestrictedPathError(messages);
    });

    it("static: daily-briefing importing a core-data-backed platform lib (../../lib/household-date)", async () => {
      const messages = await lint(
        "src/server/modules/daily-briefing/__fixture_forbidden_lib__.ts",
        `import { weekdayOf } from "../../lib/household-date";\nexport const use = weekdayOf;\n`
      );
      expectRestrictedPathError(messages);
    });

    it("path-normalized: ../members/../members/referential still resolves to the forbidden target", async () => {
      const messages = await lint(
        "src/server/modules/daily-briefing/__fixture_forbidden_normalized__.ts",
        `import { isActiveMember } from "../members/../members/referential";\nexport const use = isActiveMember;\n`
      );
      expectRestrictedPathError(messages);
    });

    it('dynamic: daily-briefing await import("../calendar/index")', async () => {
      const messages = await lint(
        "src/server/modules/daily-briefing/__fixture_forbidden_dynamic__.ts",
        `export async function use() {\n  return await import("../calendar/index");\n}\n`
      );
      expectRestrictedPathError(messages);
    });

    it("nested-file: daily-briefing/sub/foo.ts reaching ../../../db/client", async () => {
      const messages = await lint(
        "src/server/modules/daily-briefing/sub/__fixture_forbidden_nested__.ts",
        `import { getDb } from "../../../db/client";\nexport const use = getDb;\n`
      );
      expectRestrictedPathError(messages);
    });

    it("nested-file dynamic: daily-briefing/sub/foo.ts reaching ../../../db/client via await import(...)", async () => {
      const messages = await lint(
        "src/server/modules/daily-briefing/sub/__fixture_forbidden_nested_dynamic__.ts",
        `export async function use() {\n  return await import("../../../db/client");\n}\n`
      );
      expectRestrictedPathError(messages);
    });
  });

  describe("allowed reaches (must be 0 errors)", () => {
    it("static: daily-briefing importing the host-API barrel (../../host-api)", async () => {
      const messages = await lint(
        "src/server/modules/daily-briefing/__fixture_allowed_barrel__.ts",
        `import { isActiveMember, getDb } from "../../host-api";\nexport const use = { isActiveMember, getDb };\n`
      );
      expect(messages).toHaveLength(0);
    });

    it("static: daily-briefing importing a pure src/shared DTO", async () => {
      const messages = await lint(
        "src/server/modules/daily-briefing/__fixture_allowed_shared__.ts",
        `import type { Weekday } from "../../../shared";\nexport type Use = Weekday;\n`
      );
      expect(messages).toHaveLength(0);
    });

    it('dynamic: daily-briefing await import("../../host-api")', async () => {
      const messages = await lint(
        "src/server/modules/daily-briefing/__fixture_allowed_dynamic_barrel__.ts",
        `export async function use() {\n  return await import("../../host-api");\n}\n`
      );
      expect(messages).toHaveLength(0);
    });

    it("nested-file dynamic: daily-briefing/sub/foo.ts importing its own subtree (../index) is not flagged", async () => {
      const messages = await lint(
        "src/server/modules/daily-briefing/sub/__fixture_allowed_nested_own__.ts",
        `export async function use() {\n  return await import("../index");\n}\n`
      );
      expect(messages).toHaveLength(0);
    });

    it("nested-file dynamic: daily-briefing/sub/foo.ts reaching the barrel at the depth-correct ../../../host-api", async () => {
      const messages = await lint(
        "src/server/modules/daily-briefing/sub/__fixture_allowed_nested_barrel__.ts",
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
