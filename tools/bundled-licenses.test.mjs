import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  bundledLicensesPlugin,
  bundledPackages,
  renderLicenses,
} from "../scripts/bundled-licenses.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "mp-licenses-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = (dir, manifest, files = {}) => {
    mkdirSync(join(root, dir, "lib"), { recursive: true });
    writeFileSync(join(root, dir, "package.json"), JSON.stringify(manifest));
    writeFileSync(join(root, dir, "lib", "index.js"), "");
    for (const [name, text] of Object.entries(files)) writeFileSync(join(root, dir, name), text);
    return join(root, dir, "lib", "index.js");
  };
  return {
    root,
    mit: pkg(
      "node_modules/alpha",
      { name: "alpha", version: "1.0.0", license: "MIT" },
      {
        LICENSE: "MIT License\nCopyright (c) Alpha",
      }
    ),
    scoped: pkg(
      "node_modules/@scope/beta",
      { name: "@scope/beta", version: "2.0.0", license: { type: "Apache-2.0" } },
      { "LICENSE.txt": "Apache License", NOTICE: "Beta notice" }
    ),
    nested: pkg(
      "node_modules/alpha/node_modules/gamma",
      {
        name: "gamma",
        version: "0.1.0",
        license: "ISC",
        repository: { url: "https://example.test/gamma" },
      },
      {}
    ),
  };
}

test("bundled licences list each package once with its shipped licence and notice files", (t) => {
  const f = fixture(t);
  const packages = bundledPackages([f.mit, f.mit, f.scoped, f.nested, join(f.root, "src/app.ts")]);
  assert.deepEqual(
    packages.map((p) => [p.name, p.version, p.license, p.texts.map((x) => x.name)]),
    [
      ["@scope/beta", "2.0.0", "Apache-2.0", ["LICENSE.txt", "NOTICE"]],
      ["alpha", "1.0.0", "MIT", ["LICENSE"]],
      ["gamma", "0.1.0", "ISC", []],
    ]
  );
  const text = renderLicenses("Title", packages);
  assert.match(text, /alpha 1\.0\.0 — MIT[\s\S]*Copyright \(c\) Alpha/);
  assert.match(text, /--- NOTICE ---\nBeta notice/);
  assert.match(text, /Source: https:\/\/example\.test\/gamma\n\(The package ships no licence file/);
});

test("the client plugin emits licences only for modules rendered into the bundle", (t) => {
  const f = fixture(t);
  const emitted = [];
  bundledLicensesPlugin().generateBundle.call(
    { emitFile: (file) => emitted.push(file) },
    {},
    {
      "index.js": {
        type: "chunk",
        modules: { [f.mit]: { renderedLength: 10 }, [f.scoped]: { renderedLength: 0 } },
      },
      "style.css": { type: "asset" },
    }
  );
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].fileName, "THIRD_PARTY_LICENSES.txt");
  assert.match(emitted[0].source, /alpha 1\.0\.0 — MIT/);
  assert.doesNotMatch(emitted[0].source, /@scope\/beta/);
});
