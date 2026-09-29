#!/usr/bin/env node
// The exception list may shrink, but additions require a reviewed policy change.
// A fresh root commit uses the reviewed bootstrap fixture; later commits compare
// against an explicitly recorded accepted predecessor commit.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CONFIG = "eslint.config.mjs";
export function extractExceptionListFromSource(source) {
  const match = source.match(/const\s+UI_DEBT_EXCEPTION_FILES\s*=\s*\[([\s\S]*?)\];/);
  if (!match) return null;
  return [...match[1].matchAll(/["']([^"']+)["']/g)].map((item) => item[1]);
}
function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function parseArgs(argv) {
  const args = { root: DEFAULT_ROOT };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") args.root = path.resolve(argv[++i]);
    else if (argv[i] === "--base") args.base = argv[++i];
    else if (argv[i] === "--bootstrap-fixture") args.fixture = argv[++i];
    else if (argv[i] === "--json") args.json = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const current = (
    await import(`${pathToFileURL(path.join(args.root, CONFIG)).href}?t=${Date.now()}`)
  ).UI_DEBT_EXCEPTION_FILES;
  if (
    !Array.isArray(current) ||
    current.some((item) => typeof item !== "string") ||
    new Set(current).size !== current.length
  )
    throw new Error("Current exception list invalid");
  let baseList, baseDescription;
  if (args.base || process.env.MP_ACCEPTED_PREDECESSOR) {
    const ref = args.base || process.env.MP_ACCEPTED_PREDECESSOR;
    git(args.root, ["rev-parse", "--verify", `${ref}^{commit}`]);
    baseList = extractExceptionListFromSource(git(args.root, ["show", `${ref}:${CONFIG}`]));
    if (!baseList) throw new Error("Accepted predecessor exception list missing");
    baseDescription = ref;
  } else {
    if (!args.fixture) throw new Error("Root commit requires --bootstrap-fixture");
    const fixture = JSON.parse(readFileSync(path.resolve(args.root, args.fixture), "utf8"));
    let commits = null;
    try {
      commits = Number(git(args.root, ["rev-list", "--count", "HEAD"]));
    } catch {
      // The B0 candidate is checked before its first product commit exists.
      // Bind that special case to the reviewed B0 fixture and run identity.
      if (
        fixture.batch !== "B0" ||
        !process.env.MP_CANDIDATE_ID ||
        fixture.candidate !== process.env.MP_CANDIDATE_ID
      )
        throw new Error("Uncommitted bootstrap requires the reviewed B0 candidate identity");
    }
    if (commits !== null && commits !== 1)
      throw new Error("Set MP_ACCEPTED_PREDECESSOR to the reviewed accepted commit");
    baseList = fixture.exceptionListBootstrap;
    if (
      !Array.isArray(baseList) ||
      baseList.some((item) => typeof item !== "string") ||
      new Set(baseList).size !== baseList.length
    )
      throw new Error("Reviewed bootstrap exception list missing or invalid");
    baseDescription = args.fixture;
  }
  const added = current.filter((item) => !baseList.includes(item));
  const removed = baseList.filter((item) => !current.includes(item));
  const result = {
    base: baseDescription,
    currentSize: current.length,
    baseSize: baseList.length,
    added,
    removed,
    pass: added.length === 0,
  };
  if (args.json) console.log(JSON.stringify(result));
  else
    console.log(
      `check-exception-list: ${result.pass ? "PASS" : "FAIL"}; base ${baseDescription}; added ${added.length}; removed ${removed.length}`
    );
  if (!result.pass) process.exitCode = 1;
}
main().catch((error) => {
  console.error(`check-exception-list: ${error.message}`);
  process.exitCode = 1;
});
