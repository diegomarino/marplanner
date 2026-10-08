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
  mkdirSync(resolve(root, "node_modules"));
  writeFileSync(resolve(root, "kept.txt"), "maintained");
  const { spawnSync } = await import("node:child_process");
  for (const args of [
    ["init", "-b", "main"],
    ["add", "kept.txt"],
  ]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
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

// Maintained contract regressions: positive variants and rejected trust-boundary shapes.
const yaml = require("js-yaml");
const contract = (name) =>
  yaml.load(readFileSync(resolve(process.argv[2], `docs/api/${name}/openapi.yaml`), "utf8"));
const accepts = (name, schema, value) => {
  const document = contract(name);
  const ajv = new Ajv({
    strict: true,
    strictTypes: false,
    strictRequired: false,
    allowUnionTypes: true,
  });
  formats(ajv);
  for (const keyword of ["components", "example", "xml", "externalDocs"]) ajv.addKeyword(keyword);
  return ajv.compile({ $ref: `#/components/schemas/${schema}`, components: document.components })(
    value
  );
};
const blocks = readFileSync(
  resolve(process.argv[2], "src/server/modules/daily-briefing/corpora/block-types.ts"),
  "utf8"
)
  .match(/ALL_BLOCK_TYPES = \[([\s\S]*?)\]/)[1]
  .match(/"([^"]+)"/g)
  .map((s) => JSON.parse(s));
for (const name of ["daily-briefing", "briefing-render"]) {
  for (const type of ["calendar", "chores", ...blocks])
    assert.ok(accepts(name, "BlockType", type), `${name}: ${type}`);
  assert.equal(accepts(name, "BlockType", "invented"), false);
  assert.ok(accepts(name, "BriefingStatus", "render-failed"));
  assert.equal(
    accepts(name, "BriefingPayload", {
      schemaVersion: 3,
      member: { id: "m", displayName: "M" },
      date: "2026-10-01",
      blocks: [],
    }),
    false
  );
}
for (const schema of ["ChoreInput", "ChoreEditInput"]) {
  for (const icon of [null, "🌅"]) assert.ok(accepts("chores", schema, { name: "Task", icon }));
  assert.equal(accepts("chores", schema, { name: "Task", icon: 42 }), false);
}
const scheduled = {
  kind: "scheduled",
  targetingMode: "apply_to_all",
  text: "Task",
  weekdays: ["mon"],
};
const gated = {
  kind: "calendar_gated",
  targetingMode: "specific",
  text: "Task",
  query: "school",
  assignments: [{ memberId: "m" }],
};
for (const body of [scheduled, gated, { ...gated, assignments: [{ memberId: "m", weekdays: [] }] }])
  assert.ok(accepts("reminders", "ReminderInput", body));
for (const body of [
  { ...scheduled, query: "school" },
  { ...scheduled, weekdays: [] },
  { ...scheduled, assignments: [] },
  { ...gated, weekdays: ["mon"] },
  { ...gated, query: " " },
  { ...gated, assignments: [{ memberId: "m", weekdays: ["mon"] }] },
  { ...gated, queryFields: [] },
])
  assert.equal(accepts("reminders", "ReminderInput", body), false);
assert.ok(accepts("calendar", "EventEditInput", { title: "Changed" }));
assert.equal(accepts("calendar", "EventEditInput", { allDay: "yes" }), false);
assert.equal(accepts("calendar", "EventInput", { title: "New", allDay: true }), false);
const source = { name: "Feed", provider: "ics_generic", feedUrl: "https://example.com/feed.ics" };
assert.ok(accepts("calendar", "ExternalSourceUpsert", source));
assert.equal(accepts("calendar", "ExternalSourceUpsert", { ...source, enabled: true }), false);
assert.ok(accepts("telemetry", "ClientLogBatch", { entries: [null, { level: "invalid" }] }));
assert.equal(accepts("telemetry", "ClientLogBatch", { entries: "invalid" }), false);
assert.equal(accepts("telemetry", "ClientLogEntryInput", { level: "invalid" }), false);
console.log("Maintained contract regression check: PASS");

const { captureRoute } = await import("./capture-route.mjs");
const gate = {
  method: "POST",
  route: "/api/auth/provision",
  url: "/%61pi/auth/provision",
  status: 200,
  contentType: "text/html; charset=utf-8",
  payload: '<main data-testid="access-gate-form">',
};
assert.equal(captureRoute(gate), "(access-gate-form)");
for (const changed of [
  { url: "/api/auth/provision" },
  { url: "/%61pi/other" },
  { url: "/%ZZpi/auth/provision" },
  { contentType: "application/json" },
  { payload: "Unexpected HTML" },
  { status: 500 },
  { method: "GET" },
])
  assert.equal(captureRoute({ ...gate, ...changed }), gate.route);
const binary = structuredClone(doc);
binary.paths["/api/example/{id}"].post.requestBody.content = {
  "application/octet-stream": { schema: { type: "string", format: "binary" } },
};
for (const requestBody of [undefined, { type: "Buffer", data: [1, 2] }]) {
  const result = run(
    [{ ...row, requestContentType: "application/octet-stream", requestBody }],
    binary
  );
  assert.equal(result.findings.length, 0);
  assert.ok(result.unobservedBodies.some((id) => id.includes("application/octet-stream")));
}
assert.ok(
  accepts("members", "Member", {
    id: "demo:member:lisa",
    displayName: "Lisa",
    role: "child",
    lifecycle: "active",
    colorKey: "blue",
    createdAt: 0,
    updatedAt: 0,
  })
);
assert.equal(
  accepts("members", "Member", {
    id: "arbitrary",
    displayName: "Lisa",
    role: "child",
    lifecycle: "active",
    colorKey: "blue",
    createdAt: 0,
    updatedAt: 0,
  }),
  false
);
console.log("Capture attribution and transport check: PASS");

for (const name of ["daily-briefing", "briefing-render"]) {
  const payload = (schemaVersion, type) => ({
    schemaVersion,
    member: { id: "m", displayName: "M" },
    date: "2026-10-01",
    blocks: [{ type, scope: "shared", status: "ok", data: {} }],
  });
  assert.ok(accepts(name, "BriefingPayload", payload(1, "calendar")));
  assert.ok(accepts(name, "BriefingPayload", payload(2, "today")));
  assert.equal(accepts(name, "BriefingPayload", payload(1, "today")), false);
  assert.equal(accepts(name, "BriefingPayload", payload(2, "calendar")), false);
}
const { discoverContracts } = await import("../check-openapi-drift.mjs");
assert.equal(
  audit(
    discoverContracts(resolve(process.argv[2], "docs/api")).map((path) => ({
      path,
      doc: yaml.load(readFileSync(path, "utf8")),
    })),
    [],
    { Ajv, formats }
  ).findings.length,
  0
);
console.log("Versioned envelopes and contract compilation check: PASS");

const settingsFailure = {
  method: "PUT",
  route: "/api/settings",
  status: 500,
  contentType: "application/json",
  body: { error: "Internal server error" },
};
for (const name of ["bootstrap", "weather"]) {
  const documents = [{ path: `${name}.yaml`, doc: contract(name) }];
  assert.equal(audit(documents, [settingsFailure], { Ajv, formats }).findings.length, 0);
  assert.ok(
    audit(documents, [{ ...settingsFailure, body: {} }], { Ajv, formats }).findings.some(
      (finding) => finding.kind === "invalid-response"
    )
  );
}
console.log("Overlapping settings failure contracts check: PASS");
