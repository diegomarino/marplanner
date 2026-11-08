import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  TAG_CARDS,
  apiDomains,
  buildSite,
  publishedSpec,
  referencedImages,
  renderIndex,
} from "./docs/site.mjs";

const spec = JSON.parse(readFileSync("docs/api/openapi.json", "utf8"));
const source = readFileSync("site/index.html", "utf8");

test("landing page has a card for every OpenAPI tag and no stale ones", () => {
  const tags = spec.tags.map(({ name }) => name);
  assert.deepEqual(Object.keys(TAG_CARDS).sort(), [...tags].sort());
  const total = apiDomains(spec).reduce((sum, domain) => sum + domain.operations, 0);
  const documented = Object.values(spec.paths).flatMap((item) => Object.values(item)).length;
  assert.equal(total, documented);
});

test("landing page build rejects a tag without display copy", () => {
  const extra = { ...spec, tags: [...spec.tags, { name: "brand-new" }] };
  assert.throws(() => apiDomains(extra), /"brand-new" has no entry in TAG_CARDS/);
});

test("landing page replaces its API markers and links each card into the reference", () => {
  const html = renderIndex(source, spec);
  assert.doesNotMatch(html, /<!-- @api-/);
  for (const { name } of spec.tags) assert.match(html, new RegExp(`href="api/#tag/${name}"`));
  assert.throws(() => renderIndex("<html></html>", spec), /lost its <!-- @api-tags --> marker/);
});

test("landing page references only screenshots that exist, through relative paths", () => {
  const images = referencedImages(source);
  assert.ok(images.length > 0);
  for (const image of images) assert.ok(existsSync(join("docs/images/features", image)), image);
  // Pages serves the site under /<repo>/, so a root-relative link would escape it.
  assert.doesNotMatch(source, /\b(?:href|src)="\/(?!\/)/);
});

test("landing page deploy buttons use the same links as the README", () => {
  const readme = readFileSync("README.md", "utf8");
  const decode = (url) => url.replaceAll("&amp;", "&");
  const links = [
    ...source.matchAll(
      /href="(https:\/\/(?:render\.com|app\.koyeb\.com|cloud\.digitalocean\.com)\/[^"]+)"/g
    ),
  ].map((match) => decode(match[1]));
  assert.equal(links.length, 6, "three hosts, each in the hero and in the one-click tab");
  for (const link of links) assert.ok(readme.includes(link), link);
});

test("landing page reference points its examples at a local instance, not the Pages host", () => {
  const published = publishedSpec(spec);
  assert.equal(published.servers[0].variables.base.default, "http://localhost:3000");
  assert.deepEqual(spec.servers, [{ url: "/" }], "the committed document is left untouched");
});

test("landing page build writes the page, reference, spec, screenshots and offline bundle", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "marplanner-site-test-"));
  try {
    const { images } = await buildSite({ outDir });
    for (const file of [
      "index.html",
      "styles.css",
      "main.js",
      "favicon.svg",
      "openapi.json",
      ".nojekyll",
      "api/index.html",
      "api/js/scalar.js",
      "downloads/marplanner-api-docs.zip",
      ...images.map((image) => `images/${image}`),
    ]) {
      assert.ok(existsSync(join(outDir, file)), file);
    }
    assert.match(readFileSync(join(outDir, "api/index.html"), "utf8"), /localhost:3000/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
