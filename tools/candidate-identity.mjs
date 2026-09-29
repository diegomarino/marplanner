import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

// Only generated root outputs are outside the maintained product inventory.
const GENERATED = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  ".quality",
  "test-results",
  "playwright-report",
]);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sorted = (value) =>
  Array.isArray(value)
    ? value.map(sorted)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, sorted(value[key])])
        )
      : value;

export function candidateIdentity(root = process.cwd(), expected) {
  expected ??= JSON.parse(
    fs.readFileSync(path.join(root, "tests/fixtures/assembly-cohort.json"))
  ).productFiles;
  if (!Array.isArray(expected) || !expected.length || new Set(expected).size !== expected.length)
    throw new Error("Candidate inventory missing or duplicated");
  const files = {},
    directories = [];
  function walk(relative = "") {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      if (!relative && (GENERATED.has(entry.name) || entry.name.endsWith(".tsbuildinfo"))) continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const full = path.join(root, name);
      if (entry.isDirectory()) {
        directories.push(name);
        walk(name);
      } else if (entry.isFile()) {
        files[name] = {
          sha256: digest(fs.readFileSync(full)),
          mode: fs.statSync(full).mode & 0o111 ? "100755" : "100644",
        };
      } else throw new Error(`Candidate non-regular path: ${name}`);
    }
  }
  walk();
  if (JSON.stringify(Object.keys(files).sort()) !== JSON.stringify([...expected].sort()))
    throw new Error("Candidate inventory differs from reviewed product files");
  return digest(
    JSON.stringify(sorted({ schema: 1, files, directories: directories.sort() })) + "\n"
  );
}

export function requireCandidate(expected, root = process.cwd(), files) {
  const actual = candidateIdentity(root, files);
  if (expected && expected !== actual)
    throw new Error("Candidate identity differs from current bytes");
  return actual;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const candidate = requireCandidate(process.env.MP_CANDIDATE_ID);
  if (process.argv[2] === "--stamp") {
    fs.rmSync(".quality", { recursive: true, force: true });
    fs.mkdirSync(".quality");
    fs.writeFileSync(
      ".quality/candidate.json",
      JSON.stringify({ candidate, startedAt: Date.now() })
    );
  }
  console.log(candidate);
}
