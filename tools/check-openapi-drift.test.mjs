// Contract checks exercise route discovery, cohort integrity and DTO shape drift.
// Synthetic negative cases prove rejection; maintained YAML is checked for parse traps.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkOpenApiDrift,
  discoverContracts,
  validateContractCohort,
  parseContractRoutes,
  loadContract,
  checkOpenApiShapes,
  parseContractSchemas,
  loadContractSchemas,
  parseDtoInterfaces,
  parseDtoEnums,
} from "./check-openapi-drift.mjs";

function tmp(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ── discoverContracts: slice without a contract is skipped silently ────────────────────────────
test("discoverContracts: finds contracts under slices that have one, skips slices that don't", () => {
  const root = tmp("mpk-openapi-disc-");
  try {
    // bootstrap has a contract.
    mkdirSync(path.join(root, "bootstrap"), { recursive: true });
    writeFileSync(
      path.join(root, "bootstrap", "openapi.yaml"),
      "paths:\n  /health:\n    get: {}\n"
    );
    // A domain without an API contract is absent from discovery.
    mkdirSync(path.join(root, "members"), { recursive: true });
    // A stray non-directory entry at the API root must not blow up discovery.
    writeFileSync(path.join(root, "_build-order.md"), "# order\n");

    const found = discoverContracts(root);
    assert.equal(
      found.length,
      1,
      `expected exactly one discovered contract, got: ${found.join(", ")}`
    );
    assert.ok(found[0].endsWith(path.join("bootstrap", "openapi.yaml")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discoverContracts: missing API root returns empty, not a throw", () => {
  const root = path.join(os.tmpdir(), "mpk-openapi-does-not-exist-" + Date.now());
  assert.deepEqual(discoverContracts(root), []);
});

test("contract cohort rejects absent or duplicate reviewed paths", () => {
  const expected = ["docs/api/bootstrap/openapi.yaml", "docs/api/telemetry/openapi.yaml"];
  assert.doesNotThrow(() => validateContractCohort(expected, expected));
  assert.throws(() => validateContractCohort(expected, expected.slice(0, 1)));
  assert.throws(() => validateContractCohort(expected, [...expected, expected[0]]));
  assert.throws(() => validateContractCohort([expected[0], expected[0]], expected));
  assert.throws(() => validateContractCohort([], []));
});

// ── parseContractRoutes: extracts "<METHOD> <path>" per declared operation ─────────────────────
test("parseContractRoutes: extracts one entry per HTTP method declared under a path", () => {
  const root = tmp("mpk-openapi-parse-");
  try {
    const file = path.join(root, "openapi.yaml");
    writeFileSync(
      file,
      [
        "paths:",
        "  /api/members:",
        "    get: {}",
        "    post: {}",
        "  /api/members/{id}:",
        "    get: {}",
        "    delete: {}",
      ].join("\n")
    );
    const routes = parseContractRoutes(file);
    assert.deepEqual(
      [...routes].sort(),
      [
        "DELETE /api/members/{id}",
        "GET /api/members",
        "GET /api/members/{id}",
        "POST /api/members",
      ].sort()
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── malformed YAML: loadContract never throws; checkOpenApiDrift surfaces it as a normal,
// path-specific finding (exit 1, standard aggregation/output format) instead of an uncaught
// YAMLException stack trace.
test("negative: malformed contract YAML surfaces as a finding, not a crash", () => {
  const root = tmp("mpk-openapi-malformed-e2e-");
  try {
    const file = path.join(root, "openapi.yaml");
    writeFileSync(file, "paths:\n  /api/members: [get: {}\n");
    const contracts = [loadContract(file)];
    const implSet = new Set(["GET /health"]);
    const { exitCode, findings } = checkOpenApiDrift({ contracts, implSet });
    assert.equal(exitCode, 1);
    assert.ok(
      findings.some((f) => /malformed YAML/.test(f) && f.includes(file)),
      findings.join("; ")
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── checkOpenApiDrift: the pure core ────────────────────────────────────────────────────────────

// ACCEPT: every contract's routes are implemented, and every implemented route is documented
// somewhere — clean run across multiple contracts.
test("accept: multiple contracts, all routes match the implementation — zero findings", () => {
  const contracts = [
    {
      path: "specs/001-x/contracts/openapi.yaml",
      routes: new Set(["GET /health", "POST /api/members"]),
    },
    { path: "specs/002-y/contracts/openapi.yaml", routes: new Set(["GET /api/routines"]) },
  ];
  const implSet = new Set(["GET /health", "POST /api/members", "GET /api/routines"]);
  const { exitCode, findings } = checkOpenApiDrift({ contracts, implSet });
  assert.deepEqual(findings, []);
  assert.equal(exitCode, 0);
});

// NEGATIVE: drifted route — a contract documents a route the implementation doesn't have.
test("negative: documented but not implemented route is a path-specific finding", () => {
  const contracts = [
    {
      path: "specs/001-x/contracts/openapi.yaml",
      routes: new Set(["GET /health", "DELETE /api/members/{id}"]),
    },
  ];
  const implSet = new Set(["GET /health"]);
  const { exitCode, findings } = checkOpenApiDrift({ contracts, implSet });
  assert.equal(exitCode, 1);
  assert.ok(
    findings.some(
      (f) =>
        f.includes("specs/001-x/contracts/openapi.yaml") && f.includes("DELETE /api/members/{id}")
    ),
    findings.join("; ")
  );
});

// NEGATIVE: implemented but undocumented in any contract.
test("negative: implemented route absent from every contract is a finding", () => {
  const contracts = [
    { path: "specs/001-x/contracts/openapi.yaml", routes: new Set(["GET /health"]) },
  ];
  const implSet = new Set(["GET /health", "POST /api/secret-route"]);
  const { exitCode, findings } = checkOpenApiDrift({ contracts, implSet });
  assert.equal(exitCode, 1);
  assert.ok(
    findings.some((f) => f.includes("POST /api/secret-route")),
    findings.join("; ")
  );
});

// NEGATIVE: one bad contract fails the whole run, but findings stay path-specific (don't mask the
// clean contract's identity — a reader must be able to tell which file to fix).
test("negative: per-contract failures aggregate with path-specific messages", () => {
  const contracts = [
    { path: "specs/001-x/contracts/openapi.yaml", routes: new Set(["GET /health"]) },
    {
      path: "specs/002-y/contracts/openapi.yaml",
      routes: new Set(["GET /api/routines", "GET /api/ghost"]),
    },
  ];
  const implSet = new Set(["GET /health", "GET /api/routines"]);
  const { exitCode, findings } = checkOpenApiDrift({ contracts, implSet });
  assert.equal(exitCode, 1);
  assert.equal(findings.length, 1, "only the 002 contract has a violation");
  assert.ok(findings[0].includes("specs/002-y/contracts/openapi.yaml"));
  assert.ok(findings[0].includes("GET /api/ghost"));
});

// NEGATIVE / zero-contract semantics: zero discovered contracts is an honest FAIL, never a
// vacuous-green pass — mirrors check-issues.mjs's honest-zero pattern.
test("negative: zero discovered contracts FAILS (not a vacuous green)", () => {
  const { exitCode, findings } = checkOpenApiDrift({
    contracts: [],
    implSet: new Set(["GET /health"]),
  });
  assert.equal(exitCode, 1);
  assert.deepEqual(findings, []);
});

test("negative: zero discovered contracts even with an empty impl set still FAILS", () => {
  const { exitCode } = checkOpenApiDrift({ contracts: [], implSet: new Set() });
  assert.equal(exitCode, 1);
});

// ── Body-shape comparison ──────────────────────────────────────────────────────────────
// checkOpenApiShapes compares each contract's components/schemas against same-named src/shared
// DTOs (see the header comment above it in check-openapi-drift.mjs for exactly what is and isn't
// covered). parseDtoInterfaces/parseDtoEnums are the only new fs-adjacent-but-pure text
// parsers; parseContractSchemas/loadContractSchemas are the YAML-side counterparts to
// parseContractRoutes/loadContract above, so they get the same tmp-dir fixture treatment.

// ── parseDtoInterfaces: extracts field name + optional flag from `export interface` blocks ────
test("parseDtoInterfaces: extracts required and optional fields, ignores non-interface content", () => {
  const source = [
    "export enum Role {",
    "  parent = 'parent',",
    "}",
    "",
    "export interface Member {",
    "  id: string;",
    "  displayName: string;",
    "  birthDate?: { month: number; day: number; year: number | null } | null;",
    "}",
    "",
    "export * from './events.js';",
    "",
    "export interface Empty {",
    "}",
  ].join("\n");
  const interfaces = parseDtoInterfaces(source);
  assert.deepEqual([...interfaces.keys()], ["Member", "Empty"]);
  const member = interfaces.get("Member");
  assert.deepEqual([...member.keys()], ["id", "displayName", "birthDate"]);
  assert.equal(member.get("id").optional, false);
  assert.equal(member.get("displayName").optional, false);
  assert.equal(member.get("birthDate").optional, true);
  assert.equal(interfaces.get("Empty").size, 0);
});

// ── parseDtoEnums: extracts string-literal union value sets ────────────────────────────────────
test("parseDtoEnums: extracts values from single-line string-literal unions only", () => {
  const source = [
    'export type PeriodId = "morning" | "afternoon" | "evening" | "night";',
    'export type Slot = "breakfast" | "lunch" | "snack" | "dinner";',
    "export interface NotAnEnum { id: string; }",
  ].join("\n");
  const enums = parseDtoEnums(source);
  assert.deepEqual([...enums.get("PeriodId")].sort(), ["afternoon", "evening", "morning", "night"]);
  assert.deepEqual([...enums.get("Slot")].sort(), ["breakfast", "dinner", "lunch", "snack"]);
  assert.equal(enums.has("NotAnEnum"), false);
});

// ── parseContractSchemas: extracts object + enum schema entries, skips non-comparable shapes ───
test("parseContractSchemas: extracts object required/properties and string-enum values", () => {
  const root = tmp("mpk-shapes-parse-");
  try {
    const file = path.join(root, "openapi.yaml");
    writeFileSync(
      file,
      [
        "components:",
        "  schemas:",
        "    Weekday:",
        "      type: string",
        "      enum: [mon, tue, wed]",
        "    Member:",
        "      type: object",
        "      required: [id, displayName]",
        "      properties:",
        "        id: { type: string }",
        "        displayName: { type: string }",
        "        birthDate: { type: object }",
        "    WeekMenu:",
        "      type: object",
        "      additionalProperties: { type: string }",
      ].join("\n")
    );
    const schemas = parseContractSchemas(file);
    assert.equal(schemas.length, 2, "WeekMenu (no `properties`) must be skipped, not crash");

    const weekday = schemas.find((s) => s.name === "Weekday");
    assert.equal(weekday.kind, "enum");
    assert.deepEqual([...weekday.values].sort(), ["mon", "tue", "wed"]);

    const member = schemas.find((s) => s.name === "Member");
    assert.equal(member.kind, "object");
    assert.deepEqual([...member.required].sort(), ["displayName", "id"]);
    assert.deepEqual([...member.properties].sort(), ["birthDate", "displayName", "id"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("negative: loadContractSchemas surfaces malformed YAML as an error, not a throw", () => {
  const root = tmp("mpk-shapes-malformed-");
  try {
    const file = path.join(root, "openapi.yaml");
    writeFileSync(file, "components:\n  schemas: [broken\n");
    const result = loadContractSchemas(file);
    assert.deepEqual(result.schemas, []);
    assert.ok(result.error, "expected a parse error message");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── checkOpenApiShapes: the pure core ───────────────────────────────────────────────────────────

// ACCEPT: every required field is present and non-optional on the matching DTO; enum value sets
// match exactly — zero findings.
test("accept: matched object + enum schemas fully covered by src/shared DTOs — zero findings", () => {
  const contracts = [
    {
      path: "specs/002-x/contracts/openapi.yaml",
      schemas: [
        {
          name: "Member",
          kind: "object",
          required: new Set(["id", "displayName"]),
          properties: new Set(["id", "displayName", "birthDate"]),
        },
        { name: "Weekday", kind: "enum", values: new Set(["mon", "tue"]) },
      ],
    },
  ];
  const dtoInterfaces = new Map([
    [
      "Member",
      new Map([
        ["id", { optional: false }],
        ["displayName", { optional: false }],
        ["birthDate", { optional: true }],
      ]),
    ],
  ]);
  const dtoEnums = new Map([["Weekday", new Set(["mon", "tue"])]]);
  const { exitCode, findings } = checkOpenApiShapes({ contracts, dtoInterfaces, dtoEnums });
  assert.deepEqual(findings, []);
  assert.equal(exitCode, 0);
});

// ACCEPT: a schema name with no same-named DTO is SKIPPED, not a finding — proves the naming-gap
// case (e.g. `DayPeriod` schema vs `DayPeriodDTO` type) doesn't manufacture a false positive.
// Paired with a second, matching schema so the run has ≥1 real comparison — an all-unmatched run
// is exactly the vacuous-pass case covered separately below, and must FAIL, not pass.
test("accept: one unmatched schema name is skipped (not a finding) alongside a matched one", () => {
  const contracts = [
    {
      path: "specs/003-x/contracts/openapi.yaml",
      schemas: [
        {
          name: "DayPeriod",
          kind: "object",
          required: new Set(["id"]),
          properties: new Set(["id"]),
        },
        {
          name: "Member",
          kind: "object",
          required: new Set(["id"]),
          properties: new Set(["id"]),
        },
      ],
    },
  ];
  const { exitCode, findings } = checkOpenApiShapes({
    contracts,
    dtoInterfaces: new Map([
      ["DayPeriodDTO", new Map([["id", { optional: false }]])],
      ["Member", new Map([["id", { optional: false }]])],
    ]),
    dtoEnums: new Map(),
  });
  assert.deepEqual(findings, []);
  assert.equal(exitCode, 0);
});

// NEGATIVE (vacuous-pass guard): the existing "0 DTO types parsed" honest-zero
// check only catches a TOTAL parser failure. It misses the narrower case where the parser still
// recognizes SOME unrelated type (dtoInterfaces/dtoEnums are non-empty) but every contract schema
// fails to match by name — e.g. src/shared/index.ts's declarations were renamed, or the parser
// regressed for just interfaces (or just enums). Without this guard, checkOpenApiShapes would
// silently report OK with zero actual comparisons performed — a vacuous pass that defeats the
// whole check. This proves it FAILS instead.
test("negative: contracts declare schemas but ZERO were matched+compared — vacuous-pass guard", () => {
  const contracts = [
    {
      path: "specs/002-x/contracts/openapi.yaml",
      schemas: [
        {
          name: "Member",
          kind: "object",
          required: new Set(["id"]),
          properties: new Set(["id"]),
        },
        { name: "Weekday", kind: "enum", values: new Set(["mon"]) },
      ],
    },
  ];
  // Simulates a DTO-parser/renaming regression: some unrelated type parsed fine (so the
  // dtoInterfaces/dtoEnums size-0 guard doesn't fire), but neither `Member` nor `Weekday` is
  // recognized under that name.
  const dtoInterfaces = new Map([["SomeUnrelatedType", new Map([["x", { optional: false }]])]]);
  const dtoEnums = new Map([["SomeOtherEnum", new Set(["a"])]]);
  const { exitCode, findings } = checkOpenApiShapes({ contracts, dtoInterfaces, dtoEnums });
  assert.equal(exitCode, 1, "zero schemas actually compared must FAIL, not report a vacuous OK");
  assert.ok(
    findings.some((f) => /0 of 2 contract schema\(s\) were matched/.test(f)),
    findings.join("; ")
  );
});

// NEGATIVE (real RED fixture, not a tautology): a schema requires a field the DTO doesn't declare
// at all.
test("negative: required field entirely missing from the DTO is a finding", () => {
  const contracts = [
    {
      path: "specs/002-x/contracts/openapi.yaml",
      schemas: [
        {
          name: "Member",
          kind: "object",
          required: new Set(["id", "updatedAt"]),
          properties: new Set(["id", "updatedAt"]),
        },
      ],
    },
  ];
  const dtoInterfaces = new Map([["Member", new Map([["id", { optional: false }]])]]);
  const { exitCode, findings } = checkOpenApiShapes({
    contracts,
    dtoInterfaces,
    dtoEnums: new Map(),
  });
  assert.equal(exitCode, 1);
  assert.ok(
    findings.some(
      (f) => f.includes("Member") && f.includes("updatedAt") && f.includes("does not declare")
    ),
    findings.join("; ")
  );
});

// NEGATIVE (real RED fixture): a schema requires a field the DTO declares but marks optional —
// this is the exact shape of the one true finding on the current tree (Error.message).
test("negative: required field present but optional on the DTO is a finding", () => {
  const contracts = [
    {
      path: "specs/008-x/contracts/openapi.yaml",
      schemas: [
        {
          name: "Error",
          kind: "object",
          required: new Set(["error", "message"]),
          properties: new Set(["error", "message"]),
        },
      ],
    },
  ];
  const dtoInterfaces = new Map([
    [
      "Error",
      new Map([
        ["error", { optional: false }],
        ["message", { optional: true }],
      ]),
    ],
  ]);
  const { exitCode, findings } = checkOpenApiShapes({
    contracts,
    dtoInterfaces,
    dtoEnums: new Map(),
  });
  assert.equal(exitCode, 1);
  assert.ok(
    findings.some((f) => f.includes("Error") && f.includes("message") && f.includes("optional")),
    findings.join("; ")
  );
});

// NEGATIVE: enum value sets diverge in both directions (missing + extra), both surfaced.
test("negative: enum value-set mismatch surfaces both missing-in-DTO and extra-in-DTO", () => {
  const contracts = [
    {
      path: "specs/007-x/contracts/openapi.yaml",
      schemas: [{ name: "Slot", kind: "enum", values: new Set(["breakfast", "lunch"]) }],
    },
  ];
  const dtoEnums = new Map([["Slot", new Set(["lunch", "dinner"])]]);
  const { exitCode, findings } = checkOpenApiShapes({
    contracts,
    dtoInterfaces: new Map(),
    dtoEnums,
  });
  assert.equal(exitCode, 1);
  assert.ok(
    findings.some((f) => f.includes("breakfast") && f.includes("not present in src/shared")),
    findings.join("; ")
  );
  assert.ok(
    findings.some((f) => f.includes("dinner") && f.includes("not declared by the contract enum")),
    findings.join("; ")
  );
});

// NEGATIVE: malformed contract YAML surfaces as a finding, not a crash (mirrors the route-drift
// pattern above).
test("negative: malformed contract YAML surfaces as a shape finding, not a crash", () => {
  const contracts = [
    { path: "specs/002-x/contracts/openapi.yaml", schemas: [], error: "bad YAML" },
  ];
  const { exitCode, findings } = checkOpenApiShapes({
    contracts,
    dtoInterfaces: new Map([["X", new Map()]]),
    dtoEnums: new Map(),
  });
  assert.equal(exitCode, 1);
  assert.ok(findings.some((f) => f.includes("malformed YAML: bad YAML")));
});

// NEGATIVE / honest-zero: zero discovered contracts FAILS, never a vacuous green (mirrors
// checkOpenApiDrift's zero-contract semantics above).
test("negative: zero discovered contracts FAILS the shape check too", () => {
  const { exitCode, findings } = checkOpenApiShapes({
    contracts: [],
    dtoInterfaces: new Map([["X", new Map()]]),
    dtoEnums: new Map(),
  });
  assert.equal(exitCode, 1);
  assert.deepEqual(findings, []);
});

// NEGATIVE / honest-zero: zero parsed src/shared types FAILS — a silently-broken TS parser must
// not read as "nothing to compare, all clean".
test("negative: zero parsed src/shared types FAILS (parser breakage isn't a vacuous green)", () => {
  const contracts = [
    {
      path: "specs/002-x/contracts/openapi.yaml",
      schemas: [{ name: "Member", kind: "object", required: new Set(), properties: new Set() }],
    },
  ];
  const { exitCode, findings } = checkOpenApiShapes({
    contracts,
    dtoInterfaces: new Map(),
    dtoEnums: new Map(),
  });
  assert.equal(exitCode, 1);
  assert.deepEqual(findings, []);
});

test("maintained YAML descriptions do not become accidental null-valued fields", async () => {
  const { readFileSync } = await import("node:fs");
  const { load } = await import("js-yaml");
  function inspect(value, location) {
    if (!value || typeof value !== "object") return;
    if (typeof value.description === "string") {
      for (const [key, child] of Object.entries(value)) {
        assert.ok(
          child !== null || ["default", "example", "const"].includes(key),
          `${location}: accidental description field ${key}`
        );
      }
    }
    for (const [key, child] of Object.entries(value)) inspect(child, `${location}/${key}`);
  }
  for (const file of discoverContracts("docs/api")) inspect(load(readFileSync(file, "utf8")), file);
});
