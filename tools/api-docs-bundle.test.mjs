import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { crc32, inflateRawSync } from "node:zlib";

import { createZip, portableGuide, viewerHtml } from "./docs/api-bundle.mjs";
import { headingAnchor, renderOpenApiMarkdown } from "./docs/openapi-markdown.mjs";

const spec = JSON.parse(readFileSync("docs/api/openapi.json", "utf8"));

/** Reads entries back through the central directory, the way unzip tools do. */
function readZip(zip) {
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const entries = {};
  for (let i = 0; i < count; i++) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const checksum = zip.readUInt32LE(at + 16);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength);
    const local = zip.readUInt32LE(at + 42);
    const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = inflateRawSync(zip.subarray(dataStart, dataStart + size));
    assert.equal(crc32(data), checksum, `${name} checksum`);
    entries[name] = data.toString("utf8");
    at += 46 + nameLength;
  }
  return entries;
}

test("api docs zip round-trips names and contents and is byte-for-byte reproducible", () => {
  const input = [
    { name: "bundle/README.md", data: Buffer.from("# Índice\n") },
    { name: "bundle/empty.txt", data: Buffer.alloc(0) },
    { name: "bundle/big.json", data: Buffer.from(JSON.stringify(spec)) },
  ];
  const zip = createZip(input);
  assert.deepEqual(
    readZip(zip),
    Object.fromEntries(input.map(({ name, data }) => [name, data.toString("utf8")]))
  );
  assert.deepEqual(createZip(input), zip);
});

test("api docs markdown lists every documented operation once, in its tag's file", () => {
  const files = renderOpenApiMarkdown(spec);
  const methods = ["get", "post", "put", "patch", "delete"];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of methods.filter((m) => item[m])) {
      const heading = `### \`${method.toUpperCase()} ${path}\``;
      const file = files[`endpoints/${item[method].tags[0]}.md`];
      assert.equal(file.split(heading).length - 1, 1, heading);
      assert.ok(files["README.md"].includes(`| ${method.toUpperCase()} | \`${path}\` |`), heading);
    }
  }
  for (const name of Object.keys(spec.components.schemas))
    assert.ok(files["schemas.md"].includes(`\n## ${name}\n`), name);
});

test("api docs markdown expands referenced request bodies and links to real anchors", () => {
  const files = renderOpenApiMarkdown(spec, { commit: "abc1234", preamble: "## Contents" });
  const members = files["endpoints/members.md"];
  assert.match(members, /Schema: \[CreateMemberRequest\]\(\.\.\/schemas\.md#creatememberrequest\)/);
  assert.match(members, /\| `displayName` \| string \| yes \|/);
  assert.match(members, /\[`\/api\/members\/\{id\}`\]\(#patch-apimembersid\)/);
  assert.equal(headingAnchor("`PATCH /api/members/{id}`"), "patch-apimembersid");
  assert.match(
    files["README.md"],
    /^Generated from `docs\/api\/openapi.json` at commit `abc1234`/m
  );
  assert.match(files["README.md"], /\n## Contents\n/);
  assert.doesNotMatch(files["schemas.md"], /\]\(\.\.\/schemas\.md/);
});

test("api docs viewer embeds the document without letting it close the inline script", () => {
  const html = viewerHtml({ ...spec, info: { ...spec.info, description: "</script><b>x</b>" } });
  assert.equal(html.match(/<\/script>/g).length, 2);
  assert.match(html, /\\u003c\/script>\\u003cb>x/);
  assert.match(html, /"telemetry":false/);
  // Read-only offline: the device cookie can never reach the API from file://.
  assert.match(html, /"hideTestRequestButton":true/);
  const configuration = JSON.parse(html.match(/createApiReference\("#app", (.*)\);<\/script>/)[1]);
  assert.equal(configuration.servers, undefined);
});

test("api docs guide keeps images local and sends other relative links to GitHub", () => {
  const { text, images } = portableGuide(
    "![shot](../images/features/api-reference.png) see [ops](../operations.md) and [here](openapi.json)"
  );
  assert.deepEqual(images, ["images/features/api-reference.png"]);
  assert.equal(
    text,
    "![shot](images/api-reference.png) see [ops](https://github.com/diegomarino/marplanner/blob/main/docs/operations.md) and [here](openapi.json)"
  );
});

test("api docs markdown keeps pattern alternations inside their table cell", () => {
  const dayPeriods = renderOpenApiMarkdown(spec)["endpoints/day-periods.md"];
  const row = dayPeriods.split("\n").find((line) => line.startsWith("| `start` |"));
  assert.ok(row.includes("[01][0-9]\\|2[0-3]"), row);
  // Only the four column separators remain unescaped.
  assert.equal(row.replace(/\\\|/g, "").split("|").length - 1, 5, row);
});

test("api docs markdown documents the item fields of list responses", () => {
  const members = renderOpenApiMarkdown(spec)["endpoints/members.md"];
  const list = members.slice(
    members.indexOf("### `GET /api/members`"),
    members.indexOf("### `POST")
  );
  assert.match(list, /\*\*200 body items\*\*\n\nSchema: \[Member\]/);
  assert.match(list, /\| `displayName` \| string \| yes \|/);
});
