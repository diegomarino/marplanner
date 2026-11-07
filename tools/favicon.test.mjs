import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url));
const indexHtml = read("index.html").toString("utf8");

/** Width and height from a PNG's IHDR chunk. */
function pngSize(bytes) {
  assert.equal(bytes.subarray(1, 4).toString("latin1"), "PNG");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

test("index.html links the SVG favicon, its PNG fallback and the apple touch icon", () => {
  // Root-absolute public paths: the build rewrites them to ./favicon.svg etc., which resolve
  // against the <base href> the server injects, so they also work under a BASE_PATH mount.
  for (const tag of [
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml" />',
    '<link rel="icon" href="/favicon-32.png" type="image/png" sizes="32x32" />',
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png" />',
  ])
    assert.ok(indexHtml.includes(tag), `index.html is missing ${tag}`);
});

test("the favicon files ship in public/ at their declared sizes", () => {
  const svg = read("public/favicon.svg").toString("utf8");
  assert.match(svg, /^<svg [^>]*viewBox="0 0 32 32"/);
  assert.match(svg, /@media \(prefers-color-scheme: dark\)/);
  assert.deepEqual(pngSize(read("public/favicon-32.png")), [32, 32]);
  assert.deepEqual(pngSize(read("public/apple-touch-icon.png")), [180, 180]);
});

test("the container build copies public/ so the image serves the favicons", () => {
  assert.match(read("infra/docker/Dockerfile").toString("utf8"), /^COPY public\/ public\/$/m);
});
