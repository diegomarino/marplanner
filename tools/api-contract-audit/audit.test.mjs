import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { prepareRun, audit } from "./audit.mjs";

const require = createRequire(resolve(process.argv[2], "package.json"));
const nested = createRequire(require.resolve("ajv-formats"));
const Ajv = nested("ajv/dist/2020.js");
const formats = require("ajv-formats");
const doc = {
  openapi: "3.1.0",
  components: {
    schemas: {
      Value: {
        type: "object",
        required: ["items"],
        additionalProperties: false,
        properties: {
          items: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["kind"],
              properties: { kind: { enum: ["ok", null] } },
            },
          },
        },
      },
      Unused: { type: "string" },
    },
  },
  paths: {
    "/api/example/{id}": {
      post: {
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Value" },
            },
          },
        },
        responses: {
          200: {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Value" },
              },
            },
          },
          400: { description: "Rejected" },
        },
      },
    },
  },
};
const run = (rows, document = doc) =>
  audit([{ path: "test.yaml", doc: document }], rows, { Ajv, formats });
const row = {
  method: "POST",
  route: "/api/example/:id",
  status: 200,
  contentType: "application/json",
  requestContentType: "application/json",
  requestBody: { items: [{ kind: null }] },
  body: { items: [{ kind: "ok" }] },
};
assert.equal(run([row]).findings.length, 0);
for (const body of [{}, { items: [] }, { items: [{ kind: "wrong" }] }, { items: "wrong" }]) {
  assert.ok(run([{ ...row, body }]).findings.some((f) => f.kind === "invalid-response"));
}
assert.ok(
  run([{ ...row, requestBody: {} }]).findings.some((f) => f.kind === "accepted-invalid-request")
);
assert.equal(run([{ ...row, status: 400, body: "", requestBody: {} }]).findings.length, 0);
assert.ok(run([{ ...row, status: 418 }]).findings.some((f) => f.kind === "undocumented-status"));
assert.ok(
  run([{ ...row, contentType: "text/plain" }]).findings.some(
    (f) => f.kind === "undocumented-media-type"
  )
);
assert.ok(run([]).unobservedBodies.length > 0);
assert.equal(run([row]).schemas.find((s) => s.name === "Unused").uses.length, 0);
const broken = structuredClone(doc);
broken.components.schemas.Value.properties.items = {
  $ref: "#/components/schemas/Missing",
};
assert.ok(run([row], broken).findings.some((f) => f.kind === "schema-error"));
const forbidden = structuredClone(doc);
forbidden.components.schemas.Value = false;
assert.ok(run([row], forbidden).findings.some((f) => f.kind === "invalid-response"));
const before = JSON.stringify(row);
run([row]);
assert.equal(JSON.stringify(row), before);
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } =
  await import("node:fs");
const { tmpdir } = await import("node:os");
const root = mkdtempSync(resolve(tmpdir(), "api-audit-self-check-"));
let prepared;
try {
  mkdirSync(resolve(root, "tests/fixtures"), { recursive: true });
  mkdirSync(resolve(root, "node_modules"));
  writeFileSync(
    resolve(root, "tests/fixtures/assembly-cohort.json"),
    JSON.stringify({ productFiles: ["kept.txt", "tests/fixtures/assembly-cohort.json"] })
  );
  writeFileSync(resolve(root, "kept.txt"), "maintained");
  writeFileSync(resolve(root, ".env.local"), "private");
  writeFileSync(resolve(root, "marplanner.db"), "private");
  prepared = prepareRun({}, root);
  assert.equal(prepared.runTests, true);
  assert.equal(readFileSync(resolve(prepared.product, "kept.txt"), "utf8"), "maintained");
  assert.equal(existsSync(resolve(prepared.product, ".env.local")), false);
  assert.equal(existsSync(resolve(prepared.product, "marplanner.db")), false);
  assert.throws(() => prepareRun({ observations: "capture.jsonl", "run-tests": true }, root));
} finally {
  if (prepared) rmSync(prepared.out, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
console.log("Contract audit self-check: PASS");
