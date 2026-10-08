import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { spawnSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";

const eslint = new ESLint({
  cwd: fileURLToPath(new URL("../", import.meta.url)),
  // Each probe replaces the same virtual file; CI must not reuse its previous type program.
  overrideConfig: {
    languageOptions: { parserOptions: { disallowAutomaticSingleRunInference: true } },
  },
});

async function messages(code, filePath = "src/shared/index.ts") {
  return (await eslint.lintText(code, { filePath }))[0].messages;
}

test("lint excludes local storage, worktrees and generated reports", async () => {
  for (const path of [
    ".data/browser/extension.js",
    ".data-fresh/browser/extension.js",
    ".worktrees/worker/src/index.ts",
    "coverage/index.js",
    "playwright-report/index.js",
    "test-results/result.js",
    ".quality/report.js",
  ]) {
    assert.equal(await eslint.isPathIgnored(path), true, path);
  }
  assert.equal(await eslint.isPathIgnored("src/shared/index.ts"), false);
});

test("TypeScript lint understands type members and rejects unused bindings", async () => {
  assert.deepEqual(await messages("export type Handler = (value: string) => void;"), []);
  const found = await messages("const unused = 1; export {}; ");
  assert.ok(found.some((m) => m.ruleId === "@typescript-eslint/no-unused-vars"));
});

test("type-aware lint rejects ignored and misplaced promises", async () => {
  const found = await messages(
    "Promise.resolve(1); if (Promise.resolve(true)) { console.log('invalid'); } await 1;"
  );
  for (const rule of ["no-floating-promises", "no-misused-promises", "await-thenable"]) {
    assert.ok(
      found.some((m) => m.ruleId === `@typescript-eslint/${rule}`),
      rule
    );
  }
});

test("TypeScript suppression requires a reason and rejects blanket escapes", async () => {
  for (const directive of ["@ts-ignore", "@ts-nocheck", "@ts-expect-error"]) {
    const found = await messages(`// ${directive}\nexport const value = 1;`);
    assert.ok(
      found.some((m) => m.ruleId === "@typescript-eslint/ban-ts-comment"),
      directive
    );
  }
  assert.deepEqual(
    await messages(
      "// @ts-expect-error -- Exercises a deliberately invalid assignment.\nexport const value: number = 'invalid';"
    ),
    []
  );
});

test("lint suppressions require named rules and a reason", async () => {
  for (const directive of [
    "// eslint-disable-next-line no-debugger",
    "// eslint-disable-next-line -- No rules named.",
    "/* eslint-disable no-debugger */",
  ]) {
    const found = await messages(`${directive}\ndebugger;`, "tools/policy-fixture.mjs");
    assert.ok(
      found.some((m) => m.ruleId === "quality/justified-disable"),
      directive
    );
  }
  assert.deepEqual(
    await messages(
      "// eslint-disable-next-line no-debugger -- Debugger is intentional in this fixture.\ndebugger;",
      "tools/policy-fixture.mjs"
    ),
    []
  );
});

test("lint command rejects a blanket suppression that hides the policy rule itself", () => {
  const fixture = new URL(`./lint-policy-fixture-${process.pid}.mjs`, import.meta.url);
  writeFileSync(fixture, "/* eslint-disable -- No rules named. */\ndebugger;\n");
  try {
    const result = spawnSync(process.execPath, ["tools/lint.mjs", fileURLToPath(fixture)], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8",
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /quality\/justified-disable/);
    writeFileSync(
      fixture,
      "/* eslint-disable no-debugger -- Debugger is deliberate in this fixture. */\ndebugger;\n"
    );
    const clean = spawnSync(process.execPath, ["tools/lint.mjs", fileURLToPath(fixture)], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8",
    });
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    writeFileSync(fixture, '/* eslint no-debugger: "warn" */\ndebugger;\n');
    const warning = spawnSync(process.execPath, ["tools/lint.mjs", fileURLToPath(fixture)], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8",
    });
    assert.equal(warning.status, 1, warning.stdout + warning.stderr);
    assert.match(warning.stdout, /warning.*Unexpected 'debugger'/);
  } finally {
    rmSync(fixture);
  }
});
