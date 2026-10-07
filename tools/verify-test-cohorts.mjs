import fs from "node:fs";
import { requireCandidate } from "./candidate-identity.mjs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function fail(message) {
  throw new Error(`Test cohort verification: ${message}`);
}
function keys(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label} missing or invalid`);
  return Object.keys(value);
}
function exact(actual, expected, label) {
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index]))
    fail(`${label} differs`);
}
export function verifyTestCohorts(expected, observed, selected = ["node", "vitest", "playwright"]) {
  if (
    !Array.isArray(selected) ||
    !selected.length ||
    new Set(selected).size !== selected.length ||
    selected.some((name) => !["node", "vitest", "playwright"].includes(name))
  )
    fail("selected runners invalid");
  if (!expected?.candidate || observed?.candidate !== expected.candidate)
    fail("candidate identity missing or stale");
  exact(
    keys(expected.runners, "expected runners").sort(),
    ["node", "playwright", "vitest"],
    "runner set"
  );
  exact(
    keys(observed.runners, "observed runners").sort(),
    [...selected].sort(),
    "observed runner set"
  );
  let files = 0,
    cases = 0;
  for (const runnerName of selected) {
    const policy = expected.runners[runnerName];
    const actual = observed.runners[runnerName];
    const fileNames = keys(policy?.files, `${runnerName} expected files`).sort();
    if (!fileNames.length || !Array.isArray(actual?.listed) || !Array.isArray(actual?.results))
      fail(`${runnerName} missing or empty artifacts`);
    exact([...actual.listed].sort(), fileNames, `${runnerName} discovered files`);
    const expectedIds = new Set();
    for (const file of fileNames) {
      const ids = policy.files[file];
      if (!Array.isArray(ids) || !ids.length) fail(`${runnerName} ${file} has no expected cases`);
      for (const id of ids) {
        if (typeof id !== "string" || !id || expectedIds.has(`${file}\0${id}`))
          fail(`${runnerName} duplicate/invalid expected case`);
        expectedIds.add(`${file}\0${id}`);
      }
    }
    const seen = new Set();
    for (const result of actual.results) {
      const key = `${result?.file}\0${result?.id}`;
      if (!expectedIds.has(key) || seen.has(key))
        fail(`${runnerName} unexpected or duplicate case ${key}`);
      if (result.status !== "passed")
        fail(`${runnerName} required case ${key} is ${result.status}`);
      seen.add(key);
    }
    if (!seen.size || seen.size !== expectedIds.size) fail(`${runnerName} missing required cases`);
    files += fileNames.length;
    cases += seen.size;
  }
  return { cases, files };
}
const relative = (root, file) => path.relative(root, file).replaceAll(path.sep, "/");
const decodeXml = (value) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
export function normalizeNodeJUnit(xml, root = process.cwd()) {
  if (!xml.includes("<testsuites>") || !xml.includes("</testsuites>"))
    fail("Node JUnit artifact malformed");
  const listed = new Set(),
    results = [];
  const cases = [
    ...xml.matchAll(/<testcase\b((?:[^>"']|"[^"]*"|'[^']*')*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g),
  ];
  if (cases.length !== [...xml.matchAll(/<testcase\b/g)].length)
    fail("Node JUnit testcase parsing lost cases");
  for (const match of cases) {
    const attrs = Object.fromEntries(
      [...match[1].matchAll(/(?:^|\s)(name|file)="([^"]*)"/g)].map((item) => [
        item[1],
        decodeXml(item[2]),
      ])
    );
    if (!attrs.file || !attrs.name) fail("Node JUnit case lacks file or name");
    const file = relative(root, attrs.file);
    listed.add(file);
    const body = match[2] ?? "";
    const status = /<failure|<error/.test(body)
      ? "failed"
      : /<skipped/.test(body)
        ? "skipped"
        : "passed";
    results.push({ file, id: attrs.name, status });
  }
  return { listed: [...listed], results };
}
export function normalizeVitest(list, report, root = process.cwd()) {
  if (!Array.isArray(list) || !Array.isArray(report?.testResults))
    fail("Vitest list/results artifact malformed");
  const listed = [...new Set(list.map((item) => relative(root, item.file)))];
  const results = [];
  for (const suite of report.testResults) {
    const file = relative(root, suite.name);
    for (const item of suite.assertionResults ?? []) {
      results.push({ file, id: item.fullName, status: item.status });
    }
  }
  if (report.numTotalTests !== results.length || report.success !== true)
    fail("Vitest result count or status mismatch");
  return { listed, results };
}
export function normalizePlaywright(list, report, root = process.cwd()) {
  if (!Array.isArray(list?.suites) || !Array.isArray(report?.suites) || !report.stats)
    fail("Playwright list/results artifact malformed");
  function collect(suites, withStatus, testDir) {
    const out = [];
    function walk(suite) {
      for (const spec of suite.specs ?? []) {
        const rawFile = spec.file ?? suite.file;
        const file = relative(
          root,
          path.isAbsolute(rawFile) ? rawFile : path.resolve(testDir, rawFile)
        );
        if (typeof spec.id !== "string" || !spec.id) fail("Playwright spec ID missing");
        const tests = spec.tests ?? [];
        if (tests.length !== 1)
          fail("Playwright project/repeat expansion requires exact single test");
        out.push({
          file,
          id: spec.id,
          status: withStatus
            ? tests[0].status === "expected"
              ? "passed"
              : tests[0].status
            : undefined,
        });
      }
      for (const child of suite.suites ?? []) walk(child);
    }
    for (const suite of suites) walk(suite);
    return out;
  }
  const discovered = collect(list.suites, false, list.config?.rootDir ?? root);
  const executed = collect(report.suites, true, report.config?.rootDir ?? root);
  if (
    report.errors?.length ||
    report.stats.expected + report.stats.unexpected + report.stats.skipped + report.stats.flaky !==
      executed.length
  )
    fail("Playwright result summary mismatch");
  return { listed: [...new Set(discovered.map((item) => item.file))], results: executed };
}
export function rejectNodeOnlySources(sources) {
  for (const [file, source] of Object.entries(sources)) {
    if (/(?:^|[^\w.])(?:test|it|describe)\.only\s*\(/m.test(source)) {
      fail(`${file} contains a Node-only modifier`);
    }
  }
}

export function observedFromRaw(
  dir,
  candidate,
  root = process.cwd(),
  selected = ["node", "vitest", "playwright"]
) {
  const read = (file) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
  const stamp = read("candidate.json");
  if (!candidate || stamp.candidate !== candidate || !Number.isSafeInteger(stamp.startedAt))
    fail("raw run candidate stamp missing or stale");
  const artifacts = {
    node: ["node-results.xml"],
    vitest: ["vitest-list.json", "vitest-results.json"],
    playwright: ["playwright-list.json", "playwright-results.json"],
  };
  for (const runner of selected) {
    if (!artifacts[runner]) fail(`unknown runner ${runner}`);
    for (const file of artifacts[runner]) {
      if (fs.statSync(path.join(dir, file)).mtimeMs < stamp.startedAt)
        fail(`${file} predates candidate run`);
    }
  }
  const standardRoot = stamp.sourceRoot ?? root;
  const runners = {};
  if (selected.includes("node"))
    runners.node = normalizeNodeJUnit(
      fs.readFileSync(path.join(dir, "node-results.xml"), "utf8"),
      standardRoot
    );
  if (selected.includes("vitest"))
    runners.vitest = normalizeVitest(
      read("vitest-list.json"),
      read("vitest-results.json"),
      standardRoot
    );
  if (selected.includes("playwright"))
    runners.playwright = normalizePlaywright(
      read("playwright-list.json"),
      read("playwright-results.json"),
      root
    );
  return { candidate, runners };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (
      (args.length !== 6 && args.length !== 8) ||
      args[0] !== "--expected" ||
      args[2] !== "--raw-dir" ||
      args[4] !== "--candidate" ||
      (args.length === 8 && args[6] !== "--runners")
    )
      fail("usage: --expected reviewed.json --raw-dir .quality --candidate P2-ID");
    const candidate = requireCandidate(args[5]);
    const expected = { ...JSON.parse(fs.readFileSync(args[1], "utf8")).testCohorts, candidate };
    const sources = Object.fromEntries(
      Object.keys(expected.runners.node.files).map((file) => [file, fs.readFileSync(file, "utf8")])
    );
    rejectNodeOnlySources(sources);
    const selected = args.length === 8 ? args[7].split(",") : ["node", "vitest", "playwright"];
    const observed = observedFromRaw(args[3], candidate, process.cwd(), selected);
    console.log(JSON.stringify(verifyTestCohorts(expected, observed, selected)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
