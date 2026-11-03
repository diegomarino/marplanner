#!/usr/bin/env node
// Package the API reference as one downloadable zip, generated from the committed OpenAPI
// document (docs/api/openapi.json, kept current by `npm run check:openapi`).
//
//   npm run docs:api-bundle      write dist/marplanner-api-docs.zip
//
// The zip holds the raw openapi.json, a Markdown reference (index, one file per tag, schemas),
// docs/api/README.md as GUIDE.md, and the same Scalar viewer `/api/docs` serves, with the
// document embedded so it opens straight from disk. Nothing here is committed: dist/ is ignored.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";
import { renderOpenApiMarkdown } from "./openapi-markdown.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BUNDLE_NAME = "marplanner-api-docs";
const REPOSITORY_BLOB = "https://github.com/diegomarino/marplanner/blob/main/docs/";

function header(signature, size) {
  const bytes = Buffer.alloc(size);
  bytes.writeUInt32LE(signature, 0);
  return bytes;
}

/** A minimal zip writer (deflate, no zip64): enough for a few MB of generated docs. Every entry
 * gets the fixed DOS date 1980-01-01, so the same input always yields the same bytes. */
export function createZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const compressed = deflateRawSync(data);
    const checksum = crc32(data);
    const local = header(0x04034b50, 30);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, compressed);

    const central = header(0x02014b50, 46);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** The standalone Scalar bundle, read through the same plugin and version the server registers. */
async function scalarBundle() {
  const { default: Fastify } = await import("fastify");
  const { default: fastifyApiReference } = await import("@scalar/fastify-api-reference");
  const app = Fastify();
  await app.register(fastifyApiReference, {
    routePrefix: "/reference",
    configuration: { content: {} },
  });
  try {
    const response = await app.inject({ method: "GET", url: "/reference/js/scalar.js" });
    if (response.statusCode !== 200) throw new Error(`Scalar bundle: HTTP ${response.statusCode}`);
    return response.rawPayload;
  } finally {
    await app.close();
  }
}

/** Mirrors the `/api/docs` configuration in src/server/openapi/index.ts, with the document inline
 * and request sending hidden. */
export function viewerHtml(spec) {
  const configuration = {
    content: spec,
    withDefaultFonts: false,
    hideClientButton: true,
    // From file:// the browser cannot send the HttpOnly SameSite=Lax device cookie cross-origin,
    // and the server has no CORS, so request sending could never work: the offline copy is read-only.
    hideTestRequestButton: true,
    agent: { disabled: true },
    mcp: { disabled: true },
    showDeveloperTools: "never",
    telemetry: false,
  };
  // Escape "<" so no string in the document can close the inline script.
  const json = JSON.stringify(configuration).replace(/</g, "\\u003c");
  return `<!doctype html>
<html>
  <head>
    <title>Marplanner API reference</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <div id="app"></div>
    <script src="js/scalar.js"></script>
    <script>Scalar.createApiReference("#app", ${json});</script>
  </body>
</html>
`;
}

/** docs/api/README.md outside the repo: images travel with it, other relative links go to GitHub. */
export function portableGuide(markdown) {
  const images = [];
  const text = markdown.replace(/\]\(\.\.\/([^)\s]+)\)/g, (_match, target) => {
    if (target.startsWith("images/")) {
      images.push(target);
      return `](images/${target.split("/").pop()})`;
    }
    return `](${REPOSITORY_BLOB}${target})`;
  });
  return { text, images };
}

const CONTENTS = `## Contents

- \`README.md\`: this index, with every endpoint in one table.
- \`endpoints/<domain>.md\`: each operation with parameters, request body fields, responses and the success body's fields.
- \`schemas.md\`: the shared component schemas.
- \`GUIDE.md\`: authentication, a curl quickstart and conventions.
- \`html/index.html\`: the interactive reference (Scalar, the viewer \`/api/docs\` serves). Opens straight from disk and is read-only; to send requests, use \`/api/docs\` on your instance.
- \`openapi.json\`: the raw OpenAPI 3.1 document, the source of everything above.`;

export async function buildApiBundle({ root = ROOT, outDir = join(root, "dist") } = {}) {
  const specText = readFileSync(join(root, "docs/api/openapi.json"), "utf8");
  const spec = JSON.parse(specText);
  let commit = "";
  try {
    commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  } catch {
    // Not a git checkout: the bundle just omits the commit.
  }
  const files = renderOpenApiMarkdown(spec, { commit, preamble: CONTENTS });
  const guide = portableGuide(readFileSync(join(root, "docs/api/README.md"), "utf8"));

  const entries = [
    ...Object.entries(files).map(([name, text]) => ({ name, data: Buffer.from(text) })),
    { name: "GUIDE.md", data: Buffer.from(guide.text) },
    ...guide.images.map((image) => ({
      name: `images/${image.split("/").pop()}`,
      data: readFileSync(join(root, "docs", image)),
    })),
    { name: "openapi.json", data: Buffer.from(specText) },
    { name: "html/index.html", data: Buffer.from(viewerHtml(spec)) },
    { name: "html/js/scalar.js", data: await scalarBundle() },
  ].map((entry) => ({ ...entry, name: `${BUNDLE_NAME}/${entry.name}` }));

  mkdirSync(outDir, { recursive: true });
  const zipPath = join(outDir, `${BUNDLE_NAME}.zip`);
  // Also unpacked next to the zip, for a quick look without extracting.
  const unpacked = join(outDir, BUNDLE_NAME);
  rmSync(unpacked, { recursive: true, force: true });
  for (const { name, data } of entries) {
    const target = join(outDir, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
  writeFileSync(zipPath, createZip(entries));
  return { zipPath, entries: entries.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { zipPath, entries } = await buildApiBundle();
  console.log(`API docs bundle → ${relative(process.cwd(), zipPath)} (${entries} files)`);
}
