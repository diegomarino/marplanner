import { readFileSync } from "node:fs";
import path from "node:path";

/** The generated, committed code-first contract (`npm run generate:openapi`). */
export const GENERATED_CONTRACT_PATH = path.resolve(process.cwd(), "docs/api/openapi.json");

export interface OpenApiDocument {
  paths: Record<string, Record<string, { tags?: string[] } & Record<string, unknown>>>;
  components: { schemas: Record<string, unknown> } & Record<string, unknown>;
}

export function loadGeneratedContract(): OpenApiDocument {
  return JSON.parse(readFileSync(GENERATED_CONTRACT_PATH, "utf8")) as OpenApiDocument;
}

function collectRefs(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const child of node) collectRefs(child, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "$ref" && typeof value === "string") {
      const match = /^#\/components\/schemas\/(.+)$/.exec(value);
      if (match) out.add(match[1]);
    } else collectRefs(value, out);
  }
}

/** One domain's slice of the generated contract, shaped like a stand-alone contract document:
 * the operations tagged `tag` (optionally only those whose `"<METHOD> <path>"` is listed in
 * `operations`) plus every component schema they reference, transitively. */
export function contractSlice(tag: string, operations?: readonly string[]): OpenApiDocument {
  const document = loadGeneratedContract();
  const paths: OpenApiDocument["paths"] = {};
  for (const [route, item] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!operation.tags?.includes(tag)) continue;
      if (operations && !operations.includes(`${method.toUpperCase()} ${route}`)) continue;
      paths[route] = { ...paths[route], [method]: operation };
    }
  }
  const names = new Set<string>();
  collectRefs(paths, names);
  const schemas: Record<string, unknown> = {};
  const pending = [...names];
  while (pending.length) {
    const name = pending.pop() as string;
    if (name in schemas) continue;
    schemas[name] = document.components.schemas[name];
    const nested = new Set<string>();
    collectRefs(schemas[name], nested);
    for (const child of nested) if (!(child in schemas)) pending.push(child);
  }
  return { paths, components: { schemas } };
}
