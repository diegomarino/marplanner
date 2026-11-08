import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { requireCandidate } from "./candidate-identity.mjs";
import path from "node:path";
import { pathToFileURL } from "node:url";
// The reviewed coverage cohort is measured with exactly this toolchain; a
// different V8 provider or runtime can count statements and branches
// differently. Bump it together with `coveragePolicy.toolchain` in
// tests/fixtures/assembly-cohort.json and the exact pins in package.json.
export const PINNED_TOOLCHAIN = Object.freeze({ node: "24.21.0", vitest: "5.1.0" });
const METRICS = ["lines", "statements", "functions", "branches"];
const FLOORS = {
  total: [85, 85, 85, 80],
  client: [87, 85, 83, 78],
  server: [90, 89, 92, 83],
  shared: [96, 96, 100, 93],
};
function fail(message) {
  throw new Error(`Coverage verification: ${message}`);
}
function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label} missing or invalid`);
  return value;
}
export function preflightCoverage(policy, pkg, runtime, root = process.cwd()) {
  for (const [key, version] of Object.entries(PINNED_TOOLCHAIN)) {
    const actual = key === "node" ? runtime.node : pkg.devDependencies?.vitest;
    if (policy.toolchain?.[key] !== version || actual !== version)
      fail(`${key} toolchain mismatch`);
  }
  if (pkg.packageManager !== "npm@11.19.0" || runtime.npm !== "11.19.0")
    fail("npm toolchain mismatch");
  const files = object(policy.files, "expected files");
  const names = Object.keys(files);
  if (!names.length) fail("expected files empty");
  for (const file of names) {
    if (!fs.statSync(path.join(root, file), { throwIfNoEntry: false })?.isFile())
      fail(`${file} missing from coverage cohort`);
  }
  return { files: names.length };
}

export function preflightBrowserEnvironment(env = process.env) {
  if (env.SCHEDULER_DISABLED === "1")
    fail("inherited SCHEDULER_DISABLED=1 disables private fixture polling");
  if (env.PW_REUSE_SERVER === "1")
    fail("browser acceptance requires an independently started server");
  const port = env.PORT ?? "43173";
  const url = new URL(env.BASE_URL ?? `http://localhost:${port}`);
  if (url.port !== port) fail("BASE_URL and PORT must match");
}

export function verifyCoverage(expected, observed) {
  if (!expected?.candidate || observed?.candidate !== expected.candidate)
    fail("candidate identity missing or stale");
  for (const [key, version] of Object.entries(PINNED_TOOLCHAIN)) {
    if (expected.toolchain?.[key] !== version || observed.toolchain?.[key] !== version)
      fail(`${key} toolchain mismatch`);
  }
  const policies = object(expected.files, "expected files");
  const actuals = object(observed.files, "observed files");
  const fileNames = Object.keys(policies).sort();
  if (
    !fileNames.length ||
    JSON.stringify(fileNames) !== JSON.stringify(Object.keys(actuals).sort())
  )
    fail("production file inventory differs");
  const sums = Object.fromEntries(
    Object.keys(FLOORS).map((layer) => [
      layer,
      Object.fromEntries(METRICS.map((metric) => [metric, { covered: 0, total: 0 }])),
    ])
  );
  for (const file of fileNames) {
    const policy = object(policies[file], `${file} policy`);
    const actual = object(actuals[file], `${file} report`);
    if (!["client", "server", "shared"].includes(policy.layer)) fail(`${file} layer invalid`);
    for (const metric of METRICS) {
      const { covered, total } = object(actual.metrics?.[metric], `${file} ${metric}`);
      const minimum = policy.minimumTotals?.[metric];
      const minimumRate = policy.minimumRates?.[metric];
      if (!Number.isFinite(minimumRate) || minimumRate < 0 || minimumRate > 100) {
        fail(`${file} ${metric} reviewed minimum rate missing or invalid`);
      }
      if (
        ![covered, total, minimum].every(Number.isSafeInteger) ||
        covered < 0 ||
        total < 0 ||
        covered > total ||
        total < minimum
      )
        fail(`${file} ${metric} numerator or denominator invalid`);
      if (total > 0 && 100 * covered < minimumRate * total) {
        fail(`${file} ${metric} below reviewed file rate`);
      }
      for (const layer of ["total", policy.layer]) {
        sums[layer][metric].covered += covered;
        sums[layer][metric].total += total;
      }
    }
  }
  for (const [layer, floors] of Object.entries(FLOORS)) {
    for (const [index, metric] of METRICS.entries()) {
      const { covered, total } = sums[layer][metric];
      if (!total || 100 * covered < floors[index] * total)
        fail(`${layer} ${metric} below ${floors[index]}% or empty`);
    }
  }
  return { files: fileNames.length, sums };
}
export function fromV8Coverage(raw, policy, root = process.cwd(), sourceRoot = root) {
  const files = {};
  const rawFiles = object(raw, "raw V8 report");
  const rawNames = Object.keys(rawFiles)
    .map((file) =>
      path.relative(sourceRoot, path.resolve(sourceRoot, file)).replaceAll(path.sep, "/")
    )
    .sort();
  const declarations = Object.keys(policy.files).filter((file) => policy.files[file].declaration);
  if (declarations.some((file) => !file.endsWith(".d.ts"))) fail("invalid declaration file policy");
  const reviewedNames = Object.keys(policy.files)
    .filter((file) => !declarations.includes(file))
    .sort();
  if (JSON.stringify(rawNames) !== JSON.stringify(reviewedNames))
    fail("raw V8 production inventory differs from reviewed cohort");
  for (const file of Object.keys(policy.files)) {
    const absolute = path.resolve(root, file);
    if (!fs.statSync(absolute, { throwIfNoEntry: false })?.isFile())
      fail(`${file} missing from checkout`);
    if (declarations.includes(file)) {
      files[file] = {
        metrics: Object.fromEntries(METRICS.map((metric) => [metric, { covered: 0, total: 0 }])),
      };
      continue;
    }
    const item = rawFiles[path.resolve(sourceRoot, file)] ?? rawFiles[file];
    if (!item || !item.s || !item.f || !item.b || !item.statementMap)
      fail(`${file} absent from raw V8 report`);
    const values = (array) => Object.values(array).flat();
    const aggregate = (counts) => ({
      covered: counts.filter((value) => value > 0).length,
      total: counts.length,
    });
    const lineHits = new Map();
    for (const [id, location] of Object.entries(item.statementMap)) {
      const line = location.start?.line;
      if (!Number.isSafeInteger(line)) fail(`${file} statement line invalid`);
      lineHits.set(line, Math.max(lineHits.get(line) ?? 0, item.s[id]));
    }
    files[file] = {
      metrics: {
        lines: aggregate([...lineHits.values()]),
        statements: aggregate(values(item.s)),
        functions: aggregate(values(item.f)),
        branches: aggregate(values(item.b)),
      },
    };
  }
  return files;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (["--preflight", "--preflight-browser"].includes(args[0])) {
      if (args.length !== 5 || args[1] !== "--expected" || args[3] !== "--candidate")
        fail("usage: --preflight[-browser] --expected reviewed.json --candidate P1-ID");
      const candidate = requireCandidate(args[4]);
      const policy = JSON.parse(fs.readFileSync(args[2], "utf8")).coveragePolicy;
      const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
      const npm = execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
      const result = preflightCoverage(policy, pkg, { node: process.versions.node, npm });
      if (args[0] === "--preflight-browser") {
        preflightBrowserEnvironment();
        const stamp = JSON.parse(fs.readFileSync(".quality/candidate.json", "utf8"));
        if (stamp.candidate !== candidate || !Number.isSafeInteger(stamp.startedAt))
          fail("raw run candidate stamp missing or stale");
      }
      console.log(
        JSON.stringify({ candidate, ...result, toolchain: { node: process.versions.node, npm } })
      );
    } else {
      if (
        args.length !== 6 ||
        args[0] !== "--expected" ||
        args[2] !== "--coverage-final" ||
        args[4] !== "--candidate"
      )
        fail(
          "usage: --expected reviewed.json --coverage-final coverage-final.json --candidate P1-ID"
        );
      const candidate = requireCandidate(args[5]);
      const expected = {
        ...JSON.parse(fs.readFileSync(args[1], "utf8")).coveragePolicy,
        candidate,
      };
      const stamp = JSON.parse(fs.readFileSync(".quality/candidate.json", "utf8"));
      if (stamp.candidate !== candidate || fs.statSync(args[3]).mtimeMs < stamp.startedAt)
        fail("coverage artifact predates or differs from candidate run");
      const raw = JSON.parse(fs.readFileSync(args[3], "utf8"));
      const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
      const observed = {
        candidate,
        toolchain: { node: process.versions.node, vitest: pkg.devDependencies.vitest },
        files: fromV8Coverage(raw, expected, process.cwd(), stamp.sourceRoot ?? process.cwd()),
      };
      console.log(JSON.stringify(verifyCoverage(expected, observed)));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
