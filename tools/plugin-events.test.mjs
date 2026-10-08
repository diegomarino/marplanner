import assert from "node:assert/strict";
import { test } from "node:test";
import ts from "typescript";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { auditPluginEvents, PLUGIN_ROUTE_OWNERS } from "./check-plugin-events.mjs";
import { PLUGIN_MANIFESTS } from "../src/server/plugins/manifest.ts";

function programFor(code, module = "printing", sourcePath) {
  const file = resolve(sourcePath ?? `src/server/modules/${module}/adr050-probe.ts`);
  const host = ts.createCompilerHost({});
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, ...args) =>
    name === file
      ? ts.createSourceFile(name, code, ts.ScriptTarget.Latest, true)
      : original(name, ...args);
  return ts.createProgram(
    [file, resolve("src/shared/events.ts")],
    {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      skipLibCheck: true,
    },
    host
  );
}

const payload =
  '{ memberId: "m", choreId: "c", routineId: "r", date: "2026-10-08", completed: true, timestamp: 0 }';

test("plugin route ownership matches the application registrar inventory", () => {
  const app = ts.createSourceFile(
    "app.ts",
    readFileSync("src/server/app.ts", "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  const imports = new Map();
  let registrars;
  function visit(node) {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier.text.startsWith("./routes/")) {
      for (const binding of node.importClause.namedBindings.elements) {
        imports.set(binding.name.text, `src/server/${node.moduleSpecifier.text.slice(2)}.ts`);
      }
    }
    if (ts.isVariableDeclaration(node) && node.name.getText(app) === "pluginRouteRegistrars")
      registrars = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(app);
  assert.ok(registrars && ts.isObjectLiteralExpression(registrars));
  const actual = {};
  for (const property of registrars.properties) {
    if (ts.isSpreadAssignment(property)) continue;
    assert.ok(ts.isPropertyAssignment(property));
    const initializer = property.initializer;
    const registrar = ts.isArrowFunction(initializer) ? initializer.body.expression : initializer;
    assert.ok(ts.isIdentifier(registrar));
    const path = imports.get(registrar.text);
    assert.ok(path, `unmapped registrar: ${registrar.text}`);
    actual[path] = property.name.text;
  }
  assert.deepEqual(PLUGIN_ROUTE_OWNERS, actual);
  assert.equal(Object.keys(actual).length, PLUGIN_MANIFESTS.length);
  for (const [path, id] of Object.entries(actual)) {
    const errors = auditPluginEvents(
      programFor(
        `import { emit } from "../host-api";
      emit("routines.completion_changed", ${payload});`,
        id,
        path
      ),
      PLUGIN_MANIFESTS
    );
    assert.ok(
      errors.some((error) => error.includes(`${id} emit uses undeclared event`)),
      path
    );
  }
});

test("plugin event gate checks registered route emits and subscriptions", () => {
  const errors = auditPluginEvents(
    programFor(
      `import { emit, subscribe } from "../host-api";
      emit("routines.completion_changed", ${payload});
      subscribe("daily_briefing.generated", () => undefined);`,
      "printing",
      "src/server/routes/printing.ts"
    ),
    PLUGIN_MANIFESTS
  );
  assert.equal(
    errors.filter((error) => error.includes("printing emit uses undeclared event")).length,
    1
  );
  assert.equal(
    errors.filter((error) => error.includes("printing subscribe uses undeclared event")).length,
    1
  );
  assert.deepEqual(
    auditPluginEvents(
      programFor(
        `import { emit } from "../host-api";
      emit("printing.completed", { jobId: "j", outputRef: "x", printedAt: 0 });`,
        "printing",
        "src/server/routes/printing.ts"
      ),
      PLUGIN_MANIFESTS
    ),
    []
  );
});

test("plugin event gate rejects a typed foreign-owner emit and an undeclared subscription", () => {
  const program = programFor(`import { emit, subscribe } from "../../host-api";
    emit("routines.completion_changed", ${payload});
    subscribe("daily_briefing.generated", () => undefined);`);
  const errors = auditPluginEvents(program, PLUGIN_MANIFESTS);
  assert.ok(
    errors.some(
      (error) => error.includes("printing") && error.includes("routines.completion_changed")
    ),
    errors.join("\n")
  );
  assert.ok(
    errors.some(
      (error) => error.includes("printing") && error.includes("daily_briefing.generated")
    ),
    errors.join("\n")
  );
});

test("plugin event gate accepts owned emits without subscribers and declared cross-owner subscriptions", () => {
  const printing = PLUGIN_MANIFESTS.filter((manifest) => manifest.id === "printing");
  assert.deepEqual(
    auditPluginEvents(
      programFor(`import { emit } from "../../host-api";
    emit("printing.completed", { jobId: "j", outputRef: "x", printedAt: 0 });`),
      printing
    ),
    []
  );
  assert.deepEqual(
    auditPluginEvents(
      programFor(
        `import { subscribe } from "../../host-api";
    subscribe("routines.completion_changed", () => undefined);`,
        "daily-briefing"
      ),
      PLUGIN_MANIFESTS
    ),
    []
  );
});

test("plugin event gate follows imported, local and namespace aliases through type assertions", () => {
  const program = programFor(`import { emit as publish } from "../../host-api";
    import * as host from "../../host-api";
    const send: any = publish;
    send("routines.completion_changed", ${payload});
    (host.emit as any)("routines.completion_changed", ${payload});`);
  const errors = auditPluginEvents(program, PLUGIN_MANIFESTS);
  assert.equal(
    errors.filter((error) => error.includes("uses undeclared event routines.completion_changed"))
      .length,
    2,
    errors.join("\n")
  );
});

test("plugin event gate checks every conditional event name and rejects opaque names", () => {
  const program = programFor(`import { emit } from "../../host-api";
    declare const blocked: boolean;
    emit(blocked ? "printing.completed" : "routines.completion_changed", {} as any);
    let name: string = "printing.completed";
    emit(name as any, {} as any);`);
  const errors = auditPluginEvents(program, PLUGIN_MANIFESTS);
  assert.ok(
    errors.some((error) => error.includes("undeclared event routines.completion_changed")),
    errors.join("\n")
  );
  assert.ok(
    errors.some((error) => error.includes("statically known event name")),
    errors.join("\n")
  );
});

test("plugin event gate rejects missing, duplicate, unknown and foreign-owner manifest declarations", () => {
  const program = programFor("export {};");
  const changed = (events) =>
    PLUGIN_MANIFESTS.map((manifest) =>
      manifest.id === "printing" ? { ...manifest, events } : manifest
    );
  for (const [events, expected] of [
    [undefined, "must declare events.emits"],
    [{ emits: [], subscribes: ["printing.failed", "printing.failed"] }, "duplicate subscribes"],
    [{ emits: ["core.fabricated"], subscribes: [] }, "unknown event core.fabricated"],
    [{ emits: ["routines.completion_changed"], subscribes: [] }, "another owner's namespace"],
    [{ emits: ["network.device_blocked"], subscribes: [] }, "another owner's namespace"],
  ]) {
    assert.ok(
      auditPluginEvents(program, changed(events)).some((error) => error.includes(expected)),
      expected
    );
  }
});

test("plugin event gate ignores unrelated methods and rejects a missing typed catalog", () => {
  assert.deepEqual(
    auditPluginEvents(
      programFor(
        `const local = { emit(name: string) { return name; } }; local.emit("other.event");`
      ),
      PLUGIN_MANIFESTS
    ),
    []
  );
  const empty = ts.createProgram([], {});
  assert.deepEqual(auditPluginEvents(empty, PLUGIN_MANIFESTS), [
    "ADR-050: CoreEventCatalog is missing",
  ]);
});
