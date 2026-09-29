import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyTestCohorts } from "./verify-test-cohorts.mjs";

const expected = {
  candidate: "candidate-1",
  runners: {
    node: { files: { "tools/a.test.mjs": ["passes"] } },
    vitest: { files: { "tests/client/b.test.ts": ["renders"] } },
    playwright: { files: { "tests/e2e/c.spec.ts": ["starts"] } },
  },
};
const observed = {
  candidate: "candidate-1",
  runners: {
    node: {
      listed: ["tools/a.test.mjs"],
      results: [{ file: "tools/a.test.mjs", id: "passes", status: "passed" }],
    },
    vitest: {
      listed: ["tests/client/b.test.ts"],
      results: [{ file: "tests/client/b.test.ts", id: "renders", status: "passed" }],
    },
    playwright: {
      listed: ["tests/e2e/c.spec.ts"],
      results: [{ file: "tests/e2e/c.spec.ts", id: "starts", status: "passed" }],
    },
  },
};
const clone = (value) => structuredClone(value);

test("accepts exact independently expected files and runtime case IDs", () => {
  assert.deepEqual(verifyTestCohorts(expected, observed), { cases: 3, files: 3 });
});
for (const [name, mutate] of [
  [
    "empty selection",
    (value) => {
      value.runners.node.listed = [];
      value.runners.node.results = [];
    },
  ],
  [
    "one missing file",
    (value) => {
      value.runners.vitest.listed = [];
      value.runners.vitest.results = [];
    },
  ],
  [
    "skipped case",
    (value) => {
      value.runners.node.results[0].status = "skipped";
    },
  ],
  [
    "todo case",
    (value) => {
      value.runners.node.results[0].status = "todo";
    },
  ],
  [
    "failed case",
    (value) => {
      value.runners.node.results[0].status = "failed";
    },
  ],
  [
    "duplicate case ID",
    (value) => {
      value.runners.node.results.push(value.runners.node.results[0]);
    },
  ],
  [
    "missing runner artifact",
    (value) => {
      delete value.runners.playwright.results;
    },
  ],
  [
    "unexpected file",
    (value) => {
      value.runners.node.listed.push("tools/extra.test.mjs");
    },
  ],
  [
    "stale identity",
    (value) => {
      value.candidate = "older";
    },
  ],
]) {
  test(`rejects ${name}`, () => {
    const actual = clone(observed);
    mutate(actual);
    assert.throws(() => verifyTestCohorts(expected, actual));
  });
}

import {
  normalizeNodeJUnit,
  normalizeVitest,
  normalizePlaywright,
  rejectNodeOnlySources,
} from "./verify-test-cohorts.mjs";
test("normalizes real Node JUnit case attributes and skip status", () => {
  const xml =
    '<testsuites><testcase name="works &amp; returns" file="/repo/tools/a.test.mjs"/><testcase name="later" file="/repo/tools/a.test.mjs"><skipped/></testcase></testsuites>';
  assert.deepEqual(normalizeNodeJUnit(xml, "/repo"), {
    listed: ["tools/a.test.mjs"],
    results: [
      { file: "tools/a.test.mjs", id: "works & returns", status: "passed" },
      { file: "tools/a.test.mjs", id: "later", status: "skipped" },
    ],
  });
});
test("keeps Node cases whose names contain a literal greater-than sign", () => {
  const xml =
    '<testsuites><testcase name="renders &lt;li onClick> wrapper" classname="test" file="/repo/tools/a.test.mjs"/></testsuites>';
  assert.deepEqual(normalizeNodeJUnit(xml, "/repo").results, [
    { file: "tools/a.test.mjs", id: "renders <li onClick> wrapper", status: "passed" },
  ]);
});
test("normalizes Vitest list and result case names separately", () => {
  const list = [{ file: "/repo/tests/client/b.test.ts", name: "suite > renders" }];
  const result = {
    success: true,
    numTotalTests: 1,
    testResults: [
      {
        name: "/repo/tests/client/b.test.ts",
        assertionResults: [{ fullName: "suite renders", status: "passed" }],
      },
    ],
  };
  assert.deepEqual(normalizeVitest(list, result, "/repo"), {
    listed: ["tests/client/b.test.ts"],
    results: [{ file: "tests/client/b.test.ts", id: "suite renders", status: "passed" }],
  });
});
test("normalizes Playwright stable spec ID and expected status", () => {
  const suite = {
    file: "/repo/tests/e2e/c.spec.ts",
    specs: [{ file: "/repo/tests/e2e/c.spec.ts", id: "spec-1", tests: [{ status: "expected" }] }],
  };
  const list = { suites: [suite] },
    report = { suites: [suite], stats: { expected: 1, unexpected: 0, skipped: 0, flaky: 0 } };
  assert.deepEqual(normalizePlaywright(list, report, "/repo"), {
    listed: ["tests/e2e/c.spec.ts"],
    results: [{ file: "tests/e2e/c.spec.ts", id: "spec-1", status: "passed" }],
  });
});

test("rejects a Node-only modifier even when the runner executes all cases", () => {
  assert.throws(() =>
    rejectNodeOnlySources({ "tools/a.test.mjs": "test." + 'only("hidden", () => {})' })
  );
  assert.doesNotThrow(() =>
    rejectNodeOnlySources({ "tools/a.test.mjs": 'test("visible", () => {})' })
  );
});

test("standard gate checks Node and Vitest without a Playwright artifact", () => {
  const standard = clone(observed);
  delete standard.runners.playwright;
  assert.deepEqual(verifyTestCohorts(expected, standard, ["node", "vitest"]), {
    cases: 2,
    files: 2,
  });
  standard.runners.vitest.listed = [];
  assert.throws(() => verifyTestCohorts(expected, standard, ["node", "vitest"]));
});
