import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyCoverage, fromV8Coverage } from "./verify-coverage.mjs";

const metrics = (covered, total) =>
  Object.fromEntries(
    ["lines", "statements", "functions", "branches"].map((key) => [key, { covered, total }])
  );
const expected = {
  candidate: "candidate-1",
  toolchain: { node: "24.21.0", vitest: "5.0.2" },
  files: {
    "src/client/a.ts": {
      sha256: "a".repeat(64),
      layer: "client",
      minimumTotals: { lines: 10, statements: 10, functions: 10, branches: 10 },
      minimumRates: { lines: 100, statements: 100, functions: 100, branches: 100 },
    },
    "src/server/b.ts": {
      sha256: "b".repeat(64),
      layer: "server",
      minimumTotals: { lines: 10, statements: 10, functions: 10, branches: 10 },
      minimumRates: { lines: 90, statements: 90, functions: 90, branches: 90 },
    },
    "src/shared/c.ts": {
      sha256: "c".repeat(64),
      layer: "shared",
      minimumTotals: { lines: 10, statements: 10, functions: 10, branches: 10 },
      minimumRates: { lines: 90, statements: 90, functions: 90, branches: 90 },
    },
  },
};
const observed = {
  candidate: "candidate-1",
  toolchain: { node: "24.21.0", vitest: "5.0.2" },
  files: {
    "src/client/a.ts": { sha256: "a".repeat(64), metrics: metrics(10, 10) },
    "src/server/b.ts": { sha256: "b".repeat(64), metrics: metrics(10, 10) },
    "src/shared/c.ts": { sha256: "c".repeat(64), metrics: metrics(10, 10) },
  },
};
const clone = (value) => structuredClone(value);
test("accepts complete numeric evidence", () =>
  assert.equal(verifyCoverage(expected, observed).files, 3));
for (const [name, mutate] of [
  [
    "unexecuted source omitted",
    (value) => {
      delete value.files["src/server/b.ts"];
    },
  ],
  [
    "lower metric",
    (value) => {
      value.files["src/server/b.ts"].metrics.functions.covered = 8;
    },
  ],
  [
    "reduced denominator",
    (value) => {
      value.files["src/client/a.ts"].metrics.lines.total = 9;
    },
  ],
  [
    "per-file regression hidden by aggregate",
    (value) => {
      value.files["src/client/a.ts"].metrics.lines.covered = 9;
    },
  ],
  [
    "wrong source hash",
    (value) => {
      value.files["src/client/a.ts"].sha256 = "wrong".repeat(12) + "xxxx";
    },
  ],
  [
    "stale candidate",
    (value) => {
      value.candidate = "old";
    },
  ],
  [
    "wrong toolchain",
    (value) => {
      value.toolchain.node = "22.23.1";
    },
  ],
  [
    "fabricated summary",
    (value) => {
      value.files["src/shared/c.ts"].metrics.lines.covered = "100%";
    },
  ],
])
  test(`rejects ${name}`, () => {
    const actual = clone(observed);
    mutate(actual);
    assert.throws(() => verifyCoverage(expected, actual));
  });

test("raw V8 report omitting an unexecuted source is rejected", () => {
  assert.throws(() => fromV8Coverage({}, expected));
});

test("raw V8 counters preserve an unexecuted file's denominator", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "mp-coverage-"));
  try {
    writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
    const raw = {
      [join(root, "a.ts")]: {
        statementMap: { 0: { start: { line: 1 }, end: { line: 1 } } },
        s: { 0: 0 },
        f: {},
        b: {},
      },
    };
    const actual = fromV8Coverage(raw, { files: { "a.ts": {} } }, root);
    assert.deepEqual(actual["a.ts"].metrics.lines, { covered: 0, total: 1 });
    assert.deepEqual(actual["a.ts"].metrics.statements, { covered: 0, total: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("raw V8 report rejects a production file absent from reviewed policy", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "mp-coverage-extra-"));
  const entry = {
    statementMap: { 0: { start: { line: 1 }, end: { line: 1 } } },
    s: { 0: 1 },
    f: {},
    b: {},
  };
  try {
    writeFileSync(join(root, "a.ts"), "export const a=1;\n");
    writeFileSync(join(root, "extra.ts"), "export const extra=1;\n");
    const raw = { [join(root, "a.ts")]: entry, [join(root, "extra.ts")]: entry };
    assert.throws(() => fromV8Coverage(raw, { files: { "a.ts": {} } }, root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("declaration files remain visible with zero executable metrics", () => {
  const root = process.cwd();
  const file = "src/server/modules/daily-briefing/corpora/json-modules.d.ts";
  const policy = { files: { [file]: { declaration: true } } };
  const result = fromV8Coverage({}, policy, root);
  assert.deepEqual(result[file].metrics, metrics(0, 0));
  assert.throws(
    () => fromV8Coverage({}, { files: { "src/server/app.ts": { declaration: true } } }, root),
    /declaration/i
  );
});
