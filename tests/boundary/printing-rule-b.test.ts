import tsEslint from "typescript-eslint";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { ESLint } from "eslint";

/** docs/features/printing.md — standing config-drift tripwire for the
 * printing plugin's Rule B import boundary (ADR-039 §2b′) + the operator-config
 * `process.env` ban (PLUGIN-SYSTEM-INV-09). Drives the REAL
 * `eslint.config.mjs` through the ESLint Node API against virtual fixtures at the
 * printing module path, mirroring tests/boundary/network-devices-rule-b.test.ts's technique:
 * `lintText`'s `filePath` only needs its IMPORT TARGETS to resolve against real files — the
 * fixture's own containing directory need not exist on disk at commit time. This is the
 * standing test the RED-PROOF scratch-file run (see this commit's body) backs up going
 * forward — parses the live config via the ESLint API, never regexes eslint.config.mjs's
 * source text.
 */
const repoRoot = path.resolve(__dirname, "../..");

async function lint(relativeFilePath: string, code: string) {
  const eslint = new ESLint({ cwd: repoRoot, overrideConfig: tsEslint.configs.disableTypeChecked });
  const results = await eslint.lintText(code, {
    filePath: path.join(repoRoot, relativeFilePath),
  });
  return results[0]?.messages ?? [];
}

describe("printing-rule-b — config-drift tripwire", () => {
  describe("import-x/no-restricted-paths (the printing zone)", () => {
    it("rejects a core-internal import from src/server/modules/printing (e.g. ../../db/client)", async () => {
      const messages = await lint(
        "src/server/modules/printing/__fixture_forbidden_dbclient__.ts",
        `import { getDb } from "../../db/client";\nexport const use = getDb;\n`
      );
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ ruleId: "import-x/no-restricted-paths" }),
        ])
      );
    });

    it("rejects a core module internal import (e.g. ../members/referential)", async () => {
      const messages = await lint(
        "src/server/modules/printing/__fixture_forbidden_members__.ts",
        `import { isActiveMember } from "../members/referential";\nexport const use = isActiveMember;\n`
      );
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ ruleId: "import-x/no-restricted-paths" }),
        ])
      );
    });

    it("allows the host-API barrel (../../host-api)", async () => {
      const messages = await lint(
        "src/server/modules/printing/__fixture_allowed_barrel__.ts",
        `import { getDb, emit } from "../../host-api";\nexport const use = { getDb, emit };\n`
      );
      expect(messages.filter((m) => m.ruleId === "import-x/no-restricted-paths")).toHaveLength(0);
    });

    it("allows a pure src/shared DTO import", async () => {
      const messages = await lint(
        "src/server/modules/printing/__fixture_allowed_shared__.ts",
        `import type { PrintJob } from "../../../shared";\nexport type Use = PrintJob;\n`
      );
      expect(messages.filter((m) => m.ruleId === "import-x/no-restricted-paths")).toHaveLength(0);
    });
  });

  describe("no-restricted-syntax (the process.env ban under src/server/modules/**)", () => {
    it("rejects a direct process.env read", async () => {
      const messages = await lint(
        "src/server/modules/printing/__fixture_forbidden_env__.ts",
        `export const x = process.env.SOME_KEY;\n`
      );
      expect(messages).toEqual(
        expect.arrayContaining([expect.objectContaining({ ruleId: "no-restricted-syntax" })])
      );
    });

    it('rejects a computed-key process.env read (process.env["KEY"])', async () => {
      const messages = await lint(
        "src/server/modules/printing/__fixture_forbidden_env_bracket__.ts",
        `export const x = process.env["SOME_KEY"];\n`
      );
      expect(messages).toEqual(
        expect.arrayContaining([expect.objectContaining({ ruleId: "no-restricted-syntax" })])
      );
    });

    it('rejects a computed-key read on process itself (process["env"])', async () => {
      const messages = await lint(
        "src/server/modules/printing/__fixture_forbidden_env_computed_on_process__.ts",
        `export const x = process["env"].SOME_KEY;\n`
      );
      expect(messages).toEqual(
        expect.arrayContaining([expect.objectContaining({ ruleId: "no-restricted-syntax" })])
      );
    });

    it("rejects destructuring env from process (const { env } = process)", async () => {
      const messages = await lint(
        "src/server/modules/printing/__fixture_forbidden_env_destructure__.ts",
        `const { env } = process;\nexport const x = env.SOME_KEY;\n`
      );
      expect(messages).toEqual(
        expect.arrayContaining([expect.objectContaining({ ruleId: "no-restricted-syntax" })])
      );
    });

    it("does not ban process.env OUTSIDE src/server/modules/** (e.g. host-api itself)", async () => {
      const messages = await lint(
        "src/server/host-api/__fixture_allowed_env_outside_modules__.ts",
        `export const x = process.env.SOME_KEY;\n`
      );
      expect(messages.filter((m) => m.ruleId === "no-restricted-syntax")).toHaveLength(0);
    });
  });
});
