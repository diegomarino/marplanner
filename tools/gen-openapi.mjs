import { register } from "tsx/esm/api";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/** Normalize a Fastify path parameter (`:id`) to the OpenAPI form (`{id}`) so the
 * implemented route set is comparable to the contract, which is authored in
 * OpenAPI syntax. e.g. `/api/members/:id` -> `/api/members/{id}`.
 */
export function toOpenApiPath(path) {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function appendRouteSegment(parent, segment) {
  if (!parent || parent === "/") {
    return segment.startsWith("/") ? segment : `/${segment}`;
  }
  return `${parent}${segment}`;
}

/** Parse the output of Fastify's `app.printRoutes({ commonPrefix: false })` into a
 * Set of "<METHOD> <path>" strings.
 * The tree renders each route as a node whose depth is encoded by indentation and
 * whose label is a PATH SEGMENT RELATIVE to its parent — nested routes appear as
 * child segments (e.g. `/:id` under `/api/members`), NOT as absolute paths. A
 * child without a leading slash is a radix suffix (e.g. `-all` under `generate`),
 * so we accumulate full paths by tree depth and concatenate labels verbatim.
 * HEAD (auto-added by Fastify for GET) is dropped. Param syntax is normalized to
 * OpenAPI form.
 */
export function parseRouteTree(tree) {
  const set = new Set();
  const stack = []; // stack[depth] = full path for that tree depth
  for (const line of tree.split("\n")) {
    const markerIdx = line.search(/[├└]── /);
    if (markerIdx === -1) continue;
    const depth = markerIdx / 4;
    const rest = line.slice(markerIdx + 4); // text after "├── "
    const m = rest.match(/^(.*?)\s+\(([^)]+)\)\s*$/);
    const rawSegment = (m ? m[1] : rest).replace(/\/+$/g, "");
    if (!rawSegment) continue;
    stack.length = depth; // drop any deeper ancestors from a previous branch
    const parent = stack[depth - 1] ?? "";
    const path = appendRouteSegment(parent, rawSegment);
    stack[depth] = path;
    if (!m) continue;
    if (path !== "/health" && !path.startsWith("/api/")) continue; // API surface only
    for (const raw of m[2].split(",")) {
      const method = raw.trim().toUpperCase();
      // Skip methods Fastify auto-registers, not authored routes: HEAD (for every
      // GET) and OPTIONS (added by a CORS plugin) — they are not in the contract
      // and would otherwise report spurious drift.
      if (method === "HEAD" || method === "OPTIONS") continue;
      set.add(`${method} ${toOpenApiPath(path)}`);
    }
  }
  return set;
}

/** Boot the app in-process (no `listen`), introspect its route table, and return
 * the API surface (`/health` + `/api/*`) as a Set of "<METHOD> <path>" strings in
 * OpenAPI path syntax. Frontend/static routes (`/gate`, `/`, `/assets/*`,
 * `/index.html`) are excluded — they are not part of the OpenAPI contract
 * (ADR-031/059). This is the raw route table (path+method only), independent of the
 * OpenAPI collector; the full document is generated from the route schemas by
 * tools/generate-openapi.mjs, and check-openapi-drift.mjs compares the two.
 */
async function discoverIsolatedRoutes() {
  register();
  const { buildApp } = await import("../src/server/app.ts");
  const app = await buildApp();
  const { resetDb } = await import("../src/server/db/client.ts");
  let tree;
  try {
    await app.ready();
    tree = app.printRoutes({ commonPrefix: false });
  } finally {
    await app.close();
    resetDb();
  }
  const routes = parseRouteTree(tree);
  if (!routes.size || !routes.has("GET /health")) {
    throw new Error("Installed API route discovery is empty or disconnected from the health route");
  }
  return routes;
}

// A subprocess isolates module singletons and environment from library callers.
export async function generateApiRouteSet() {
  const directory = await mkdtemp(join(tmpdir(), "marplanner-openapi-"));
  try {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [fileURLToPath(import.meta.url), "--isolated-worker"],
      { env: { ...process.env, DATA_DIR: directory, DATABASE_PATH: join(directory, "routes.db") } }
    );
    return new Set(JSON.parse(stdout));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const set =
    process.argv[2] === "--isolated-worker"
      ? await discoverIsolatedRoutes()
      : await generateApiRouteSet();
  console.log(JSON.stringify([...set].sort(), null, 2));
}
