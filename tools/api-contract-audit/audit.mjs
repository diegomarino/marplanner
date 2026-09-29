#!/usr/bin/env node
// Audit synthetic HTTP observations against the maintained OpenAPI contracts.
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  openSync,
  closeSync,
  symlinkSync,
  copyFileSync,
  mkdtempSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve, join, relative, dirname, isAbsolute } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

const methods = ["get", "post", "put", "patch", "delete", "head", "options"];
const normalize = (route) => route.replace(/:([^/]+)/g, "{$1}");
const media = (value) =>
  String(value ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
const hash = (value) => createHash("sha256").update(value).digest("hex");
const pointer = (name) => name.replaceAll("~", "~0").replaceAll("/", "~1");

function dereference(doc, value) {
  const seen = new Set();
  while (value?.$ref) {
    if (!value.$ref.startsWith("#/") || seen.has(value.$ref))
      throw Error(`Unsupported reference: ${value.$ref}`);
    seen.add(value.$ref);
    value = value.$ref
      .slice(2)
      .split("/")
      .reduce((v, key) => v?.[key.replaceAll("~1", "/").replaceAll("~0", "~")], doc);
    if (value === undefined) throw Error("Unresolved OpenAPI reference");
  }
  return value;
}

function references(doc, value, seen = new Set()) {
  if (!value || typeof value !== "object") return seen;
  if (value.$ref && !seen.has(value.$ref)) {
    seen.add(value.$ref);
    // Keep broken/external references in the inventory; compilation reports the failure.
    if (value.$ref.startsWith("#/")) {
      try {
        references(doc, dereference(doc, value), seen);
      } catch {
        /* reported by Ajv */
      }
    }
  }
  for (const [key, child] of Object.entries(value))
    if (key !== "$ref") references(doc, child, seen);
  return seen;
}

export function audit(documents, rows, { Ajv, formats }) {
  const bodies = [],
    operations = [],
    schemas = [],
    findings = [],
    unmatched = new Map();
  const addFinding = (finding) => {
    const identity = { ...finding };
    delete identity.observation;
    delete identity.test;
    const key = JSON.stringify(identity);
    const previous = findings.find((f) => f.key === key);
    if (previous) previous.count++;
    else findings.push({ ...finding, count: 1, key });
  };
  for (const { path, doc, skipped = [] } of documents) {
    if (doc.openapi !== "3.1.0") throw Error(`Unsupported dialect in ${path}: ${doc.openapi}`);
    const ajv = new Ajv({
      allErrors: true,
      strict: true,
      strictTypes: false,
      strictRequired: false,
      allowUnionTypes: true,
      coerceTypes: false,
      useDefaults: false,
      removeAdditional: false,
    });
    formats(ajv);
    // OpenAPI annotations have no validation semantics. Unknown validation keywords still fail.
    for (const keyword of ["components", "example", "xml", "externalDocs"]) ajv.addKeyword(keyword);
    const compile = (schema) => {
      try {
        return {
          validate: ajv.compile({
            allOf: [schema],
            components: doc.components ?? {},
          }),
        };
      } catch (error) {
        return { compileError: error.message };
      }
    };
    for (const name of Object.keys(doc.components?.schemas ?? {})) {
      const { compileError } = compile({
        $ref: `#/components/schemas/${pointer(name)}`,
      });
      if (compileError)
        addFinding({
          kind: "schema-error",
          contract: path,
          schema: name,
          error: compileError,
        });
      schemas.push({
        contract: path,
        name,
        compileError,
        previouslySkipped: skipped.includes(name),
        uses: [],
      });
    }
    const addBody = (operation, direction, status, type, schema) => {
      const id = `${path} ${operation.method} ${operation.route} ${direction} ${status} ${type}`;
      const entry = {
        id,
        direction,
        status,
        type,
        observed: 0,
        invalid: 0,
        ...(schema === undefined ? { compileError: "No body schema declared" } : compile(schema)),
      };
      if (entry.compileError)
        addFinding({
          kind: "body-schema-error",
          body: id,
          error: entry.compileError,
        });
      bodies.push(entry);
      for (const ref of references(doc, schema)) {
        const found = schemas.find(
          (s) => s.contract === path && `#/components/schemas/${pointer(s.name)}` === ref
        );
        if (found) found.uses.push(id);
      }
      return entry;
    };
    for (const [route, itemRef] of Object.entries(doc.paths ?? {})) {
      const item = dereference(doc, itemRef);
      for (const method of methods) {
        if (!item[method]) continue;
        const op = dereference(doc, item[method]);
        const operation = {
          contract: path,
          route,
          method: method.toUpperCase(),
          observed: 0,
          requests: {},
          responses: {},
        };
        const request = dereference(doc, op.requestBody);
        operation.requestRequired = request?.required === true;
        for (const [type, content] of Object.entries(request?.content ?? {})) {
          operation.requests[type] = addBody(
            operation,
            "request",
            "accepted",
            type,
            content.schema
          );
        }
        for (const [status, responseRef] of Object.entries(op.responses ?? {})) {
          const response = dereference(doc, responseRef);
          operation.responses[status] = {};
          for (const [type, content] of Object.entries(response.content ?? {})) {
            operation.responses[status][type] = addBody(
              operation,
              "response",
              status,
              type,
              content.schema
            );
          }
        }
        operations.push(operation);
      }
    }
  }
  const check = (entry, value, kind, where) => {
    if (!entry.validate) return;
    entry.observed++;
    if (!entry.validate(value)) {
      entry.invalid++;
      addFinding({
        kind,
        ...where,
        body: entry.id,
        errors: structuredClone(entry.validate.errors),
      });
    }
  };
  for (const [index, row] of rows.entries()) {
    const route = normalize(row.route ?? "");
    const matching = operations.filter((op) => op.method === row.method && op.route === route);
    if (!matching.length) {
      const key = `${row.method} ${route || "(unregistered)"} ${row.status}`;
      unmatched.set(key, (unmatched.get(key) ?? 0) + 1);
    }
    for (const op of matching) {
      op.observed++;
      const where = {
        contract: op.contract,
        operation: `${op.method} ${op.route}`,
        status: row.status,
        observation: index + 1,
        test: row.test,
      };
      const content =
        op.responses[row.status] ??
        op.responses[`${Math.floor(row.status / 100)}XX`] ??
        op.responses.default;
      if (!content) addFinding({ kind: "undocumented-status", ...where });
      else if (Object.keys(content).length) {
        const type = media(row.contentType);
        const entry = content[type] ?? content[`${type.split("/")[0]}/*`] ?? content["*/*"];
        if (entry) check(entry, row.body, "invalid-response", where);
        else addFinding({ kind: "undocumented-media-type", ...where, type });
      }
      // Rejected requests may intentionally violate the schema; only acceptance is a conflict.
      if (row.status >= 200 && row.status < 300) {
        const type = media(row.requestContentType);
        const request =
          op.requests[type] ?? op.requests[`${type.split("/")[0]}/*`] ?? op.requests["*/*"];
        if (row.requestBody === undefined && op.requestRequired)
          addFinding({ kind: "accepted-missing-request", ...where });
        else if (request && row.requestBody !== undefined)
          check(request, row.requestBody, "accepted-invalid-request", where);
        else if (row.requestBody !== undefined && Object.keys(op.requests).length)
          addFinding({
            kind: "accepted-undocumented-media-type",
            ...where,
            type,
          });
      }
    }
  }
  for (const schema of schemas) {
    schema.observedUses = schema.uses.filter((id) => bodies.find((b) => b.id === id).observed > 0);
    schema.invalidUses = schema.uses.filter((id) => bodies.find((b) => b.id === id).invalid > 0);
  }
  return {
    observations: rows.length,
    findings: findings.map(({ key, ...finding }) => finding),
    schemas,
    bodies: bodies.map(({ validate, ...body }) => body),
    unobservedBodies: bodies.filter((b) => !b.observed).map((b) => b.id),
    unobservedOperations: operations
      .filter((op) => !op.observed)
      .map((op) => `${op.contract} ${op.method} ${op.route}`),
    unmatched: Object.fromEntries(unmatched),
  };
}

export function prepareRun(
  values,
  defaultProduct = fileURLToPath(new URL("../../", import.meta.url))
) {
  if (values.observations && values["run-tests"]) {
    throw Error("Choose either --observations <jsonl> or --run-tests, not both.");
  }
  const source = resolve(values.product ?? defaultProduct);
  const cohort = JSON.parse(readFileSync(join(source, "tests/fixtures/assembly-cohort.json")));
  if (!Array.isArray(cohort.productFiles) || !cohort.productFiles.length)
    throw Error("Maintained inventory missing");
  const out = values.out
    ? resolve(values.out)
    : mkdtempSync(join(tmpdir(), "marplanner-api-audit-"));
  if (values.out) mkdirSync(out, { recursive: false });
  const product = join(out, "product");
  mkdirSync(product);
  for (const name of cohort.productFiles) {
    if (typeof name !== "string" || isAbsolute(name) || name.split(/[\\/]/).includes(".."))
      throw Error("Unsafe maintained path");
    const destination = join(product, name);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(source, name), destination);
  }
  symlinkSync(join(source, "node_modules"), join(product, "node_modules"));
  return { product, out, source, runTests: !values.observations };
}

async function main() {
  const { values } = parseArgs({
    options: {
      product: { type: "string" },
      out: { type: "string" },
      observations: { type: "string" },
      "run-tests": { type: "boolean" },
    },
  });
  const { product, out, source, runTests } = prepareRun(values);
  console.log(`Auditing an isolated copy of ${source}`);
  console.log(`Report: ${join(out, "report.json")}`);
  const require = createRequire(join(product, "package.json"));
  const dependencyRequire = createRequire(require.resolve("ajv-formats"));
  const Ajv = dependencyRequire("ajv/dist/2020.js"),
    formats = require("ajv-formats");
  const yaml = require("js-yaml");
  const checker = await import(pathToFileURL(join(product, "tools/check-openapi-drift.mjs")));
  const { candidateIdentity } = await import(
    pathToFileURL(join(product, "tools/candidate-identity.mjs"))
  );
  const candidateBefore = candidateIdentity(product);
  const paths = checker.discoverContracts(join(product, "docs/api"));
  const cohort = JSON.parse(readFileSync(join(product, "tests/fixtures/assembly-cohort.json")));
  checker.validateContractCohort(
    cohort.apiContracts,
    paths.map((p) => relative(product, p))
  );
  const dto = readFileSync(join(product, "src/shared/index.ts"), "utf8");
  const types = new Set([
    ...checker.parseDtoInterfaces(dto).keys(),
    ...checker.parseDtoEnums(dto).keys(),
  ]);
  const documents = paths.map((path) => ({
    path: relative(product, path),
    doc: yaml.load(readFileSync(path, "utf8")),
    skipped: checker
      .parseContractSchemas(path)
      .filter((s) => !types.has(s.name))
      .map((s) => s.name),
  }));
  // Inventory broken schemas too; a compile failure becomes an explicit finding.
  audit(documents, [], { Ajv, formats });
  let observations = values.observations && resolve(values.observations),
    testExit = null;
  if (runTests) {
    observations = join(out, "observations.jsonl");
    writeFileSync(observations, "");
    symlinkSync(join(product, "node_modules"), join(out, "node_modules"));
    const setup = readFileSync(new URL("./capture.mjs", import.meta.url), "utf8");
    writeFileSync(join(out, "capture.mjs"), setup);
    writeFileSync(
      join(out, "vitest.config.mjs"),
      `import base from ${JSON.stringify(join(product, "vitest.config.ts"))};
const projects = base.test.projects.filter(p => p.test.name === 'node').map(p => ({ ...p, test: { ...p.test, setupFiles: [...(base.test.setupFiles ?? []), ...(p.test.setupFiles ?? []), ${JSON.stringify(join(out, "capture.mjs"))}] } }));
if (!projects.length) throw new Error('Node test project missing');
export default { ...base, test: { ...base.test, projects, fileParallelism: false, passWithNoTests: false, allowOnly: false, coverage: { ...base.test.coverage, enabled: false } } };
`
    );
    const log = openSync(join(out, "tests.log"), "w");
    try {
      const result = spawnSync(
        process.execPath,
        [
          join(product, "node_modules/vitest/vitest.mjs"),
          "run",
          "--config",
          join(out, "vitest.config.mjs"),
          "--reporter=json",
          `--outputFile=${join(out, "tests.json")}`,
        ],
        {
          cwd: product,
          env: { ...process.env, MP_CONTRACT_OBSERVATIONS: observations },
          stdio: ["ignore", log, log],
        }
      );
      testExit = result.status ?? 1;
    } finally {
      closeSync(log);
    }
  }
  const raw = readFileSync(observations, "utf8");
  const rows = raw.trim()
    ? raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
  const report = audit(documents, rows, { Ajv, formats });
  const candidateAfter = candidateIdentity(product);
  if (candidateBefore !== candidateAfter) throw Error("Product changed during the audit");
  const inputs = Object.fromEntries(
    paths.map((p) => [relative(product, p), hash(readFileSync(p))])
  );
  report.provenance = {
    product,
    source,
    candidate: candidateBefore,
    contracts: inputs,
    observationsSha256: hash(raw),
    testExit,
    toolSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
    captureSha256: hash(readFileSync(new URL("./capture.mjs", import.meta.url))),
    ajvVersion: dependencyRequire("ajv/package.json").version,
  };
  report.limits = [
    "Only synthetic transactions exercised by the selected HTTP tests are observed; no production or provider calls are made by this auditor.",
    "Schema uses are transitive references from observed bodies, not proof that every optional property or union branch was exercised.",
    "No query/path/header parameter validation, response-header validation, binary stream validation, or generation of missing negative cases.",
    "Unit route mounts and full-app tests are pooled. Findings require triage against the assembled app before changing behavior.",
    "An invalid body can implicate several referenced components; invalidUses does not prove each component is wrong.",
  ];
  report.summary = {
    observations: rows.length,
    findings: report.findings.length,
    previouslySkipped: report.schemas.filter((s) => s.previouslySkipped).length,
    skippedWithObservedUses: report.schemas.filter(
      (s) => s.previouslySkipped && s.observedUses.length
    ).length,
    unobservedBodies: report.unobservedBodies.length,
    unobservedOperations: report.unobservedOperations.length,
    testExit,
  };
  if (runTests && existsSync(join(out, "tests.json"))) {
    const tests = JSON.parse(readFileSync(join(out, "tests.json")));
    report.tests = {
      total: tests.numTotalTests,
      passed: tests.numPassedTests,
      failed: tests.numFailedTests,
      pending: tests.numPendingTests,
      success: tests.success,
      reportSha256: hash(readFileSync(join(out, "tests.json"))),
    };
  }
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report.summary, null, 2));
  process.exitCode =
    testExit || !rows.length || report.findings.length
      ? 1
      : report.unobservedBodies.length ||
          report.unobservedOperations.length ||
          report.schemas.some((s) => !s.observedUses.length)
        ? 2
        : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
