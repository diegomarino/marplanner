#!/usr/bin/env node
// Compare the exact reviewed docs/api contract cohort with the installed app.
// The reviewed cohort lives in tests/fixtures/assembly-cohort.json and must grow
// with each accepted product batch before its API routes are enabled.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, relative } from "node:path";
import { load as yamlLoad } from "js-yaml";
import { generateApiRouteSet } from "./gen-openapi.mjs";

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];

// A missing root returns an empty discovery set; the executable gate rejects it.
export function discoverContracts(apiRoot) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(apiRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const contractPath = join(apiRoot, entry.name, "openapi.yaml");
    if (existsSync(contractPath)) out.push(contractPath);
  }
  return out.sort();
}

export function validateContractCohort(expected, actual) {
  if (!Array.isArray(expected) || !expected.length || !Array.isArray(actual)) {
    throw new Error("Reviewed OpenAPI contract cohort missing");
  }
  if (new Set(expected).size !== expected.length || new Set(actual).size !== actual.length) {
    throw new Error("Duplicate OpenAPI contract path");
  }
  const sortedExpected = [...expected].sort();
  const sortedActual = [...actual].sort();
  if (JSON.stringify(sortedExpected) !== JSON.stringify(sortedActual)) {
    throw new Error(
      `OpenAPI contract cohort differs: expected ${sortedExpected.join(", ")}; found ${sortedActual.join(", ")}`
    );
  }
}

// Parse one OpenAPI contract file into a Set of "<METHOD> <path>" strings. Throws (YAMLException or
// an fs error) on malformed/unreadable input — callers use `loadContract` below to turn that into
// a normal finding instead of letting it propagate as a crash.
export function parseContractRoutes(contractPath) {
  const doc = yamlLoad(readFileSync(contractPath, "utf8")) ?? {};
  const set = new Set();
  for (const [routePath, item] of Object.entries(doc.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      if (item && item[method]) set.add(`${method.toUpperCase()} ${routePath}`);
    }
  }
  return set;
}

// Load one contract, never throwing. On success: { path, routes }. On malformed YAML (or any other
// parseContractRoutes failure): { path, routes: <empty Set>, error: <message> } — the empty routes
// mean checkOpenApiDrift skips the normal per-contract comparison and instead surfaces the error
// as a plain, path-specific finding (see below), so a malformed contract fails the run cleanly
// instead of crashing with a raw stack trace.
export function loadContract(contractPath) {
  try {
    return { path: contractPath, routes: parseContractRoutes(contractPath) };
  } catch (err) {
    return { path: contractPath, routes: new Set(), error: err.message };
  }
}

// PURE core. `contracts`: Array<{ path: string, routes: Set<string>, error?: string }> (already
// loaded, one entry per discovered contract file — use `loadContract` to build these so malformed
// YAML arrives as `error`, never a throw). `implSet`: Set<string> of implemented "<METHOD> <path>"
// routes (app-wide — not per-slice). Returns { exitCode, findings, message }.
export function checkOpenApiDrift({ contracts, implSet }) {
  if (contracts.length === 0) {
    return {
      exitCode: 1,
      findings: [],
      message: "FAIL — 0 OpenAPI contracts discovered under docs/api/*/openapi.yaml.",
    };
  }

  const findings = [];
  const documented = new Set();
  for (const { path: contractPath, routes, error } of contracts) {
    if (error) {
      findings.push(`${contractPath}: malformed YAML: ${error}`);
      continue; // no routes to compare — the parse itself failed.
    }
    for (const r of routes) documented.add(r);
    const missingInImpl = [...routes].filter((r) => !implSet.has(r)).sort();
    if (missingInImpl.length) {
      findings.push(
        `${contractPath}: documented but NOT implemented:\n    ${missingInImpl.join("\n    ")}`
      );
    }
  }

  const undocumented = [...implSet].filter((r) => !documented.has(r)).sort();
  if (undocumented.length) {
    findings.push(
      `implemented but NOT documented in any contract:\n    ${undocumented.join("\n    ")}`
    );
  }

  if (findings.length) {
    return {
      exitCode: 1,
      findings,
      message: `OpenAPI drift detected across ${contracts.length} contract(s):`,
    };
  }
  return {
    exitCode: 0,
    findings: [],
    message: `OpenAPI drift check: OK — ${contracts.length} contract(s), ${documented.size} route(s) match the implementation.`,
  };
}

// ---- Body-shape comparison (contract schemas vs src/shared DTOs) -----------------------------
//
// The route-drift check above proves the ROUTE surface stays in sync, but
// says nothing about request/response BODY shapes — a contract can document a field the
// implementation doesn't return (or vice versa) and check:openapi stays green. Fastify routes in
// this repo declare NO JSON schemas (validation is hand-rolled per src/server/modules/*), so
// there is no route-level schema object to introspect the way generateApiRouteSet reads the
// route table. The only machine-readable candidate source of truth for body shapes is the
// src/shared DTO TypeScript types (src/shared/index.ts) — so this compares each contract's
// `components/schemas/<Name>` against a same-named `export interface <Name>` / `export type
// <Name> = "a" | "b"` in src/shared/index.ts, NOT against the handlers.
//
// What IS compared (per matched schema/DTO name pair):
// - object schemas: every field in the schema's `required` list must exist in the DTO
// interface AND be non-optional there (a required contract field marked `?` in the DTO, or
// missing outright, is a finding).
// - string-enum schemas (`type: string, enum: [...]`) declared as a top-level named schema:
// the enum's value set must equal the DTO's string-literal union value set.
//
// What is DELIBERATELY NOT compared (documented gap, not silently claimed covered):
// - Extra DTO fields absent from the schema are never flagged — src/shared legitimately holds
// domain-only DTOs (e.g. MemberDTO duplicating Member) and reserved forward-compat fields
// (e.g. FeedItem.decoratedTitle/provider/sourceRef) that a strict two-way diff would falsely
// flag.
// - Optional (non-required) schema fields are not checked against the DTO at all — a weaker
// signal, high noise (many DTOs deliberately omit fields the schema lists as optional-only).
// - A schema name with no same-named DTO (or vice versa) is silently SKIPPED, not a finding —
// naming doesn't always line up 1:1 (`DayPeriod` schema vs `DayPeriodDTO` type).
// - Dictionary/map-shaped schemas (`type: object` with `additionalProperties` but no fixed
// `properties`, e.g. WeekMenu) are not structurally comparable to a TS interface field list —
// skipped.
// - Nested inline object types (e.g. BoardColumn.todayProgress's `{completed,total}`) are not
// separate `components/schemas` entries and are never visited.
// - Enums declared only INLINE on a property (`kind: { type: string, enum: [...] }` with no
// top-level `components/schemas/<Name>` entry — e.g. ReminderKind, TargetingMode) are not
// compared; only top-level named enum schemas are.
// - Request-body discriminated unions (e.g. ReminderInput's kind-driven apply_to_all/specific
// branching) are not modelled — the `required` list is the contract's unconditional minimum;
// conditional requirements stay a manual validation surface.
//
// So this NARROWS, not CLOSES, the `openapi-drift-gate-is-route-only` gap: it catches the common
// "field renamed/dropped on one side" drift class for the schemas it *can* structurally compare,
// nothing more. Run via `npm run check:openapi-shapes` (node tools/check-openapi-drift.mjs
// --shapes). The shape check is part of check:standard and therefore check:full as well; keep
// this scope description current when adding or changing comparable schema/DTO pairs.

// Parse one contract's `components/schemas` into structurally-comparable entries. Only two shapes
// are extracted (see the header comment above for what's skipped and why):
// - { name, kind: "object", required: Set<string>, properties: Set<string> }
// - { name, kind: "enum", values: Set<string> }
export function parseContractSchemas(contractPath) {
  const doc = yamlLoad(readFileSync(contractPath, "utf8")) ?? {};
  const schemas = doc.components?.schemas ?? {};
  const out = [];
  for (const [name, schema] of Object.entries(schemas)) {
    if (!schema || typeof schema !== "object") continue;
    if (schema.type === "object" && schema.properties) {
      out.push({
        name,
        kind: "object",
        required: new Set(schema.required ?? []),
        properties: new Set(Object.keys(schema.properties)),
      });
    } else if (schema.type === "string" && Array.isArray(schema.enum)) {
      out.push({ name, kind: "enum", values: new Set(schema.enum) });
    }
  }
  return out;
}

// Non-throwing wrapper around parseContractSchemas — mirrors loadContract above.
export function loadContractSchemas(contractPath) {
  try {
    return { path: contractPath, schemas: parseContractSchemas(contractPath) };
  } catch (err) {
    return { path: contractPath, schemas: [], error: err.message };
  }
}

// Parse `export interface Name { field: type; field2?: type; }` blocks from src/shared/index.ts
// source text. One field per line, closing `}` alone on its line — matches this file's actual
// style; anything else on a line inside a body (blank lines, stray syntax) is skipped, not an
// error. Returns Map<interfaceName, Map<fieldName, { optional: boolean }>>.
export function parseDtoInterfaces(source) {
  const interfaces = new Map();
  let current = null;
  for (const rawLine of source.split("\n")) {
    if (current === null) {
      const open = rawLine.match(/^export interface (\w+)\s*\{\s*$/);
      if (open) {
        current = new Map();
        interfaces.set(open[1], current);
      }
      continue;
    }
    const line = rawLine.trim();
    if (line === "}") {
      current = null;
      continue;
    }
    const field = line.match(/^(\w+)(\?)?:\s*(.+);\s*$/);
    if (field) current.set(field[1], { optional: Boolean(field[2]) });
  }
  return interfaces;
}

// Parse `export type Name = "a" | "b" | "c";` string-literal unions (single line — this file's
// actual style for every such alias today). Returns Map<typeName, Set<string>>.
export function parseDtoEnums(source) {
  const enums = new Map();
  const re = /^export type (\w+) = ((?:"[^"]*"\s*\|\s*)*"[^"]*")\s*;\s*$/gm;
  let m;
  while ((m = re.exec(source))) {
    const values = new Set([...m[2].matchAll(/"([^"]*)"/g)].map((v) => v[1]));
    enums.set(m[1], values);
  }
  return enums;
}

// PURE core, same output shape as checkOpenApiDrift above: { exitCode, findings, message }.
// `contracts`: Array<{ path, schemas: <parseContractSchemas output>, error? }>. `dtoInterfaces`
// / `dtoEnums`: parseDtoInterfaces/parseDtoEnums output.
export function checkOpenApiShapes({ contracts, dtoInterfaces, dtoEnums }) {
  if (contracts.length === 0) {
    return {
      exitCode: 1,
      findings: [],
      message:
        "FAIL — 0 OpenAPI contracts discovered under docs/api/*/openapi.yaml. Either the " +
        "discovery path is broken or every contract vanished — this is not a vacuous pass.",
    };
  }
  if (dtoInterfaces.size === 0 && dtoEnums.size === 0) {
    return {
      exitCode: 1,
      findings: [],
      message:
        "FAIL — 0 types parsed from src/shared/index.ts. Either the parser broke or the file is " +
        "empty — this is not a vacuous pass.",
    };
  }

  const findings = [];
  let totalSchemas = 0;
  let comparedObjects = 0;
  let comparedEnums = 0;
  let skipped = 0;

  for (const { path: contractPath, schemas, error } of contracts) {
    if (error) {
      findings.push(`${contractPath}: malformed YAML: ${error}`);
      continue;
    }
    for (const schema of schemas) {
      totalSchemas++;
      if (schema.kind === "object") {
        const dto = dtoInterfaces.get(schema.name);
        if (!dto) {
          skipped++;
          continue;
        }
        comparedObjects++;
        for (const fieldName of [...schema.required].sort()) {
          const dtoField = dto.get(fieldName);
          if (!dtoField) {
            findings.push(
              `${contractPath}: schema '${schema.name}' requires field '${fieldName}' — src/shared ` +
                `DTO '${schema.name}' does not declare it`
            );
          } else if (dtoField.optional) {
            findings.push(
              `${contractPath}: schema '${schema.name}' requires field '${fieldName}' — src/shared ` +
                `DTO '${schema.name}' marks it optional ('${fieldName}?')`
            );
          }
        }
      } else if (schema.kind === "enum") {
        const dtoValues = dtoEnums.get(schema.name);
        if (!dtoValues) {
          skipped++;
          continue;
        }
        comparedEnums++;
        const missingInDto = [...schema.values].filter((v) => !dtoValues.has(v)).sort();
        const extraInDto = [...dtoValues].filter((v) => !schema.values.has(v)).sort();
        if (missingInDto.length) {
          findings.push(
            `${contractPath}: enum '${schema.name}' has value(s) [${missingInDto.join(", ")}] not ` +
              `present in src/shared type '${schema.name}'`
          );
        }
        if (extraInDto.length) {
          findings.push(
            `${contractPath}: src/shared type '${schema.name}' has value(s) [${extraInDto.join(", ")}] ` +
              `not declared by the contract enum`
          );
        }
      }
    }
  }

  // Vacuous-pass guard: the dtoInterfaces/dtoEnums-size check above only
  // catches a TOTAL parser failure (nothing parsed from src/shared/index.ts at all). It misses the
  // narrower case where the parser still recognizes SOME unrelated type (so that check passes)
  // but every contract schema fails to match — e.g. a DTO was renamed, or the parser regressed for
  // just interfaces (or just enums) while the other kind kept parsing fine elsewhere in the file.
  // In that case comparedObjects/comparedEnums are both 0 and `findings` is empty (a comparison
  // that never ran can't produce a finding) — the loop above would silently report OK with zero
  // actual comparisons performed. Only fires when the contracts under check DO declare schemas
  // (totalSchemas > 0); a contract set with genuinely zero schemas is a different, legitimate case.
  if (totalSchemas > 0 && comparedObjects === 0 && comparedEnums === 0) {
    findings.push(
      `0 of ${totalSchemas} contract schema(s) were matched to a src/shared type by name (all ` +
        "skipped) — src/shared/index.ts's declarations may have been renamed, or the parser " +
        "regressed and stopped recognizing them; this is not a vacuous pass."
    );
  }

  if (findings.length) {
    return {
      exitCode: 1,
      findings,
      message:
        `OpenAPI body-shape drift detected (${comparedObjects} object schema(s), ${comparedEnums} ` +
        `enum(s) compared, ${skipped} skipped — no matching src/shared type by name):`,
    };
  }
  return {
    exitCode: 0,
    findings: [],
    message:
      `OpenAPI body-shape check: OK — ${comparedObjects} object schema(s), ${comparedEnums} enum(s) ` +
      `matched src/shared, ${skipped} skipped (no matching src/shared type by name).`,
  };
}

// ---- CLI -------------------------------------------------------------------
function report(exitCode, findings, message) {
  if (exitCode === 0) {
    console.log(message);
  } else {
    console.error(message);
    for (const f of findings) console.error("  " + f);
  }
}

async function main() {
  const apiRoot = fileURLToPath(new URL("../docs/api/", import.meta.url));
  const contractPaths = discoverContracts(apiRoot);
  const cohortPath = fileURLToPath(
    new URL("../tests/fixtures/assembly-cohort.json", import.meta.url)
  );
  const expected = JSON.parse(readFileSync(cohortPath, "utf8")).apiContracts;
  validateContractCohort(
    expected,
    contractPaths.map((p) => relative(process.cwd(), p))
  );

  if (process.argv.includes("--shapes")) {
    const contracts = contractPaths.map((p) => ({
      ...loadContractSchemas(p),
      path: relative(process.cwd(), p),
    }));
    const dtoPath = fileURLToPath(new URL("../src/shared/index.ts", import.meta.url));
    const dtoSource = readFileSync(dtoPath, "utf8");
    const dtoInterfaces = parseDtoInterfaces(dtoSource);
    const dtoEnums = parseDtoEnums(dtoSource);

    const { exitCode, findings, message } = checkOpenApiShapes({
      contracts,
      dtoInterfaces,
      dtoEnums,
    });
    report(exitCode, findings, message);
    process.exit(exitCode);
  }

  const contracts = contractPaths.map((p) => ({
    ...loadContract(p),
    path: relative(process.cwd(), p),
  }));
  const implSet = await generateApiRouteSet();
  const { exitCode, findings, message } = checkOpenApiDrift({ contracts, implSet });
  report(exitCode, findings, message);
  process.exit(exitCode);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) await main();
