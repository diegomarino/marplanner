import ts from "typescript";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PLUGIN_MANIFESTS } from "../src/server/plugins/manifest.ts";
import { EVENT_NAMESPACE_OWNERS } from "../src/shared/events.ts";

export const PLUGIN_ROUTE_OWNERS = Object.freeze({
  "src/server/routes/daily-briefing.ts": "daily-briefing",
  "src/server/routes/printing.ts": "printing",
  "src/server/routes/weather.ts": "weather",
  "src/server/routes/time-announcements.ts": "time-announcements",
  "src/server/routes/backups.ts": "backups",
  "src/server/routes/network-devices.ts": "network-devices",
  "src/server/routes/meals.ts": "meals-recipes",
  "src/server/routes/reminders.ts": "reminders",
  "src/server/routes/daily-messages.ts": "daily-messages",
});

export function loadEventProgram(root = process.cwd()) {
  const file = resolve(root, "tsconfig.server.json");
  const config = ts.readConfigFile(file, ts.sys.readFile);
  if (config.error)
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  if (parsed.errors.length)
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(parsed.errors, {
        getCurrentDirectory: () => root,
        getCanonicalFileName: (name) => name,
        getNewLine: () => "\n",
      })
    );
  return ts.createProgram(parsed.fileNames, parsed.options);
}

export function auditPluginEvents(program, manifests) {
  const errors = [];
  const root = program.getCurrentDirectory();
  const catalogFile = program.getSourceFile(resolve(root, "src/shared/events.ts"));
  const catalog = catalogFile?.statements.find(
    (node) => ts.isInterfaceDeclaration(node) && node.name.text === "CoreEventCatalog"
  );
  if (!catalog) return ["ADR-050: CoreEventCatalog is missing"];
  const names = new Set(catalog.members.map((member) => member.name?.text));
  for (const manifest of manifests) {
    for (const operation of ["emits", "subscribes"]) {
      const declared = manifest.events?.[operation];
      if (!Array.isArray(declared)) {
        errors.push(`ADR-050: ${manifest.id} must declare events.${operation}`);
        continue;
      }
      const seen = new Set();
      for (const name of declared) {
        if (!names.has(name)) errors.push(`ADR-050: ${manifest.id} declares unknown event ${name}`);
        if (seen.has(name))
          errors.push(`ADR-050: ${manifest.id} declares duplicate ${operation} event ${name}`);
        seen.add(name);
        if (
          operation === "emits" &&
          EVENT_NAMESPACE_OWNERS[String(name).split(".")[0]] !== manifest.id
        ) {
          errors.push(
            `ADR-050: ${manifest.id} cannot emit under another owner's namespace: ${name}`
          );
        }
      }
    }
  }
  const checker = program.getTypeChecker();
  function operationFor(expression, seen = new Set()) {
    if (!expression || seen.has(expression)) return null;
    seen.add(expression);
    if (
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isParenthesizedExpression(expression)
    ) {
      return operationFor(expression.expression, seen);
    }
    let symbol = checker.getSymbolAtLocation(expression);
    if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const declarations = [
      ...checker
        .getTypeAtLocation(expression)
        .getCallSignatures()
        .map((signature) => signature.declaration),
      ...(symbol?.declarations ?? []),
    ];
    for (const declaration of declarations) {
      if (!declaration) continue;
      const name = declaration.name?.getText();
      if (
        declaration
          .getSourceFile()
          .fileName.replaceAll("\\", "/")
          .endsWith("/src/server/lib/event-bus.ts") &&
        ["emit", "subscribe"].includes(name)
      )
        return name;
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        const operation = operationFor(declaration.initializer, seen);
        if (operation) return operation;
      }
    }
    return null;
  }
  for (const file of program.getSourceFiles()) {
    const path = relative(root, file.fileName).replaceAll("\\", "/");
    const directory = /^src\/server\/(?:modules\/)?([^/]+)\//.exec(path)?.[1];
    const id = PLUGIN_ROUTE_OWNERS[path] ?? (directory === "meals" ? "meals-recipes" : directory);
    const manifest = manifests.find((entry) => entry.id === id);
    if (!manifest || file.isDeclarationFile) continue;
    function visit(node) {
      if (ts.isCallExpression(node)) {
        const operation = operationFor(node.expression);
        if (operation) {
          const type = node.arguments[0] && checker.getTypeAtLocation(node.arguments[0]);
          const types = type?.isUnion() ? type.types : type ? [type] : [];
          const eventNames = types
            .filter((item) => item.flags & ts.TypeFlags.StringLiteral)
            .map((item) => item.value);
          const field = operation === "emit" ? "emits" : "subscribes";
          const location = `${path}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
          if (!types.length || eventNames.length !== types.length)
            errors.push(
              `ADR-050: ${location}: ${id} ${operation} requires a statically known event name`
            );
          for (const name of eventNames) {
            if (!manifest.events?.[field]?.includes(name))
              errors.push(`ADR-050: ${location}: ${id} ${operation} uses undeclared event ${name}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = auditPluginEvents(loadEventProgram(), PLUGIN_MANIFESTS);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else console.log("ADR-050: plugin event declarations and ownership passed");
}
