#!/usr/bin/env node
// Generate docs/api/openapi.json from the code-first route schemas (src/server/openapi/*).
//
//   npm run generate:openapi            write docs/api/openapi.json
//   node tools/generate-openapi.mjs --check   exit 1 when the committed file is stale
//
// The app is booted in-process in an isolated subprocess (fresh DATA_DIR, no `listen`, no
// BASE_PATH) exactly like tools/gen-openapi.mjs, then `app.swagger()` is serialized with sorted
// paths/components and formatted with the repository's Prettier config, so the output is
// byte-for-byte deterministic.

import { register } from "tsx/esm/api";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

export const OPENAPI_DOCUMENT = fileURLToPath(new URL("../docs/api/openapi.json", import.meta.url));

async function buildIsolatedDocument() {
  register();
  const { buildApp } = await import("../src/server/app.ts");
  const app = await buildApp();
  const { resetDb } = await import("../src/server/db/client.ts");
  try {
    await app.ready();
    return app.swagger();
  } finally {
    await app.close();
    resetDb();
  }
}

/** Generate the formatted OpenAPI document text (subprocess-isolated). */
export async function generateOpenApiDocument() {
  const directory = await mkdtemp(join(tmpdir(), "marplanner-openapi-doc-"));
  try {
    const env = { ...process.env, DATA_DIR: directory, DATABASE_PATH: join(directory, "doc.db") };
    delete env.BASE_PATH;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [fileURLToPath(import.meta.url), "--isolated-worker"],
      { env, maxBuffer: 64 * 1024 * 1024 }
    );
    const prettier = await import("prettier");
    const options = (await prettier.resolveConfig(OPENAPI_DOCUMENT)) ?? {};
    return prettier.format(stdout, { ...options, filepath: OPENAPI_DOCUMENT });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Compare the committed document with a fresh generation. */
export async function checkOpenApiDocument() {
  const [expected, actual] = await Promise.all([
    generateOpenApiDocument(),
    readFile(OPENAPI_DOCUMENT, "utf8").catch(() => null),
  ]);
  return { fresh: expected === actual, expected, actual };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (process.argv[2] === "--isolated-worker") {
    process.stdout.write(JSON.stringify(await buildIsolatedDocument()));
  } else if (process.argv.includes("--check")) {
    const { fresh, actual } = await checkOpenApiDocument();
    if (!fresh) {
      console.error(
        actual === null
          ? "docs/api/openapi.json is missing — run `npm run generate:openapi`."
          : "docs/api/openapi.json is stale — run `npm run generate:openapi` and commit the result."
      );
      process.exit(1);
    }
    console.log("docs/api/openapi.json is up to date.");
  } else {
    await writeFile(OPENAPI_DOCUMENT, await generateOpenApiDocument());
    console.log("wrote docs/api/openapi.json");
  }
}
