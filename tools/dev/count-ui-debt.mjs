#!/usr/bin/env node
// Measurement and ESLint enforcement share debtFindings below. Product client TS/TSX only;
// test files are excluded. AST nodes exclude comments and property names, understand hoisted
// style props, and permit semantic token-only colour composition. Translation copy is exempt
// only in src/client/i18n/messages.ts. All other named colours are case-insensitive.
// Counts include narrowly justified style forwarding: suppression is permission, not deletion.
// Translation casts retain their historical comment-stripped lexical counter.

// Baselines — DO NOT edit these to match a disagreeing run; a disagreement means this script regressed:
const BASELINES = {
  scaleClasses: 244,
  inlineStyles: 140,
  colourLiterals: 63,
  translationCasts: 98,
};

import ts from "typescript";
import tsEslint from "typescript-eslint";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const clientRoot = path.join(repoRoot, "src/client");

// --- File discovery -------------------------------------------------------------------------

const TEST_LIKE_RE = /(\.test\.[jt]sx?$)|(\.spec\.[jt]sx?$)|(\/__tests__\/)/;

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    const rel = path.relative(repoRoot, full).replace(/\\/g, "/");
    if (TEST_LIKE_RE.test(`/${rel}`)) continue; // excluded: test files (see header)
    out.push(full);
  }
  return out;
}

export function listFiles() {
  return walk(clientRoot, []).sort();
}

// --- Comment stripping ------------------------------------------------------------------------
// Uses the TypeScript compiler's own tokenizer instead of a hand-rolled string-state scanner.
// `ts.createSourceFile` parses the file for real, which resolves the regex-vs-division ambiguity
// (and template-literal / JSX-text tokenization) exactly the way the language actually works — a
// hand-rolled scanner that just walks characters treating every quote as a string delimiter gets
// this wrong inside a regex literal (e.g. `/"/g`), which then misreads a later real string as
// code and can strip a live colour literal as if it were a comment.
//
// Recipe: recursively walk `node.getChildren` down to leaf tokens (this requires
// `setParentNodes: true`). Every leaf token's `getFullStart` is the position right after the
// PREVIOUS token ends, so `ts.getLeadingCommentRanges`/`ts.getTrailingCommentRanges` at that
// position finds every comment in the file — because the token stream itself was produced by the
// real parser, regex and template literals are never misread as comment or string boundaries.
// JSX text needs one explicit exclusion (see `visit`): it is content rather than trivia, so a
// lexical comment-range lookup at its start would blank real rendered text.
function collectCommentRanges(sourceFile) {
  const fullText = sourceFile.getFullText();
  const ranges = [];
  const seen = new Set();

  function addRangesAt(pos) {
    for (const getRanges of [ts.getLeadingCommentRanges, ts.getTrailingCommentRanges]) {
      const found = getRanges(fullText, pos);
      if (!found) continue;
      for (const r of found) {
        const key = `${r.pos}:${r.end}`;
        if (seen.has(key)) continue;
        seen.add(key);
        ranges.push(r);
      }
    }
  }

  function visit(node) {
    const children = node.getChildren(sourceFile);
    if (children.length === 0) {
      // JSX text is CONTENT, not trivia, and has no leading trivia by definition. Asking for
      // comment ranges at its start is purely lexical: a text run beginning with `//` or `/*`
      // (a protocol-relative URL, a rendered code snippet) would be blanked as a comment, and a
      // colour inside it would vanish from the count — the false-green direction, same as H3 by a
      // a different mechanism.
      if (node.kind !== ts.SyntaxKind.JsxText) addRangesAt(node.getFullStart());
      return;
    }
    for (const child of children) visit(child);
  }

  visit(sourceFile);
  return ranges;
}

export function stripComments(src, fileName = "file.tsx") {
  const scriptKind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    fileName,
    src,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKind
  );
  const fullText = sourceFile.getFullText();
  const ranges = collectCommentRanges(sourceFile).sort((a, b) => a.pos - b.pos);

  if (ranges.length === 0) return fullText;

  let out = "";
  let cursor = 0;
  for (const { pos, end } of ranges) {
    if (pos < cursor) continue; // defensive: skip any overlapping/duplicate range
    out += fullText.slice(cursor, pos);
    // Blank the comment body (preserving newlines, for stable line counts) rather than deleting
    // it outright, so removing a comment can never accidentally splice two tokens together into
    // a new false match.
    for (let i = pos; i < end; i++) {
      out += fullText[i] === "\n" ? "\n" : " ";
    }
    cursor = end;
  }
  out += fullText.slice(cursor);
  return out;
}

// --- Counters ---------------------------------------------------------------------------------

const SCALE_CLASS_RE =
  /\b(bg|text|border|ring|from|to|via|fill|stroke|divide|outline|shadow|accent|caret|decoration|placeholder)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]{2,3}\b/g;

const TRANSLATION_CAST_RE = /as MessageKey/g;

// Full CSS Color Module named-colour set (147 basic keywords + "transparent" + "rebeccapurple" =
// 149) — M1/M2: the previous 17-name list evaded `"teal"`, `"navy"`, `"olive"`, `"coral"`,
// `"salmon"`, `"whitesmoke"`, etc. Matched inside double, single OR backtick delimiters, since a
// CSS-in-JS colour value is written with any of the three.
//
// Exported as the SINGLE definition site for this list: `eslint.config.mjs` imports it
// directly instead of keeping its own byte-identical copy. Before this export, the array grew
// once already (17 -> 149 names) with nothing asserting the two copies stayed in sync —
// a silent drift where the counter and the enforcement ratchet disagree on which names count,
// with nothing turning red. A single source makes that class of drift structurally impossible
// rather than merely documented.
export const NAMED_COLOURS = [
  "aliceblue",
  "antiquewhite",
  "aqua",
  "aquamarine",
  "azure",
  "beige",
  "bisque",
  "black",
  "blanchedalmond",
  "blue",
  "blueviolet",
  "brown",
  "burlywood",
  "cadetblue",
  "chartreuse",
  "chocolate",
  "coral",
  "cornflowerblue",
  "cornsilk",
  "crimson",
  "cyan",
  "darkblue",
  "darkcyan",
  "darkgoldenrod",
  "darkgray",
  "darkgreen",
  "darkgrey",
  "darkkhaki",
  "darkmagenta",
  "darkolivegreen",
  "darkorange",
  "darkorchid",
  "darkred",
  "darksalmon",
  "darkseagreen",
  "darkslateblue",
  "darkslategray",
  "darkslategrey",
  "darkturquoise",
  "darkviolet",
  "deeppink",
  "deepskyblue",
  "dimgray",
  "dimgrey",
  "dodgerblue",
  "firebrick",
  "floralwhite",
  "forestgreen",
  "fuchsia",
  "gainsboro",
  "ghostwhite",
  "gold",
  "goldenrod",
  "gray",
  "grey",
  "green",
  "greenyellow",
  "honeydew",
  "hotpink",
  "indianred",
  "indigo",
  "ivory",
  "khaki",
  "lavender",
  "lavenderblush",
  "lawngreen",
  "lemonchiffon",
  "lightblue",
  "lightcoral",
  "lightcyan",
  "lightgoldenrodyellow",
  "lightgray",
  "lightgreen",
  "lightgrey",
  "lightpink",
  "lightsalmon",
  "lightseagreen",
  "lightskyblue",
  "lightslategray",
  "lightslategrey",
  "lightsteelblue",
  "lightyellow",
  "lime",
  "limegreen",
  "linen",
  "magenta",
  "maroon",
  "mediumaquamarine",
  "mediumblue",
  "mediumorchid",
  "mediumpurple",
  "mediumseagreen",
  "mediumslateblue",
  "mediumspringgreen",
  "mediumturquoise",
  "mediumvioletred",
  "midnightblue",
  "mintcream",
  "mistyrose",
  "moccasin",
  "navajowhite",
  "navy",
  "oldlace",
  "olive",
  "olivedrab",
  "orange",
  "orangered",
  "orchid",
  "palegoldenrod",
  "palegreen",
  "paleturquoise",
  "palevioletred",
  "papayawhip",
  "peachpuff",
  "peru",
  "pink",
  "plum",
  "powderblue",
  "purple",
  "rebeccapurple",
  "red",
  "rosybrown",
  "royalblue",
  "saddlebrown",
  "salmon",
  "sandybrown",
  "seagreen",
  "seashell",
  "sienna",
  "silver",
  "skyblue",
  "slateblue",
  "slategray",
  "slategrey",
  "snow",
  "springgreen",
  "steelblue",
  "tan",
  "teal",
  "thistle",
  "tomato",
  "transparent",
  "turquoise",
  "violet",
  "wheat",
  "white",
  "whitesmoke",
  "yellow",
  "yellowgreen",
].sort((a, b) => b.length - a.length);

function countMatches(re, text) {
  re.lastIndex = 0;
  const matches = text.match(re);
  return matches ? matches.length : 0;
}

/** Walk the same ESTree nodes ESLint sees. No comments, property names or regex bodies. */
export function debtFindings(ast, fileName = "file.tsx") {
  const findings = [];
  const named = new RegExp(`^(?:${NAMED_COLOURS.join("|")})$`, "i");
  const namedInMix = new RegExp(
    `(?:[:,_(\\s])(?:${NAMED_COLOURS.join("|")})(?=[,_)\\]\\s]|$)`,
    "i"
  );
  const translations = /(?:^|\/)src\/client\/i18n\/messages\.ts$/.test(
    fileName.replace(/\\/g, "/")
  );
  function report(node, kind) {
    findings.push({ node, kind });
  }
  function visit(node, parent, ancestors = []) {
    if (!node || typeof node.type !== "string") return;
    const value =
      (node.type === "Literal" || node.type === "JSXText") && typeof node.value === "string"
        ? node.value
        : node.type === "TemplateLiteral"
          ? node.quasis.map((q) => q.value.raw).join("var(--dynamic)")
          : null;
    if (
      value !== null &&
      !(parent?.type === "Property" && parent.key === node) &&
      !(parent?.type === "ImportDeclaration")
    ) {
      const withoutTokens = value.replace(/var\(--[\w-]+\)/g, "");
      if (countMatches(SCALE_CLASS_RE, withoutTokens)) report(node, "scaleClasses");
      const functions = /(?<![\w.-])(?:rgba?|hsla?|oklch|oklab|hwb|lab|lch|color)\(/i.test(
        withoutTokens
      );
      const mix =
        /color-mix\(/i.test(value) && (namedInMix.test(withoutTokens) || !/var\(--/.test(value));
      const translationValue =
        translations &&
        parent?.type === "Property" &&
        parent.value === node &&
        ancestors.some((a) => a.type === "VariableDeclarator" && a.id.name === "messages");
      if (
        !translationValue &&
        (/#[0-9a-f]{3,8}\b/i.test(value) ||
          functions ||
          mix ||
          (/var\([^)]*,/.test(value) && namedInMix.test(value)) ||
          (/\[[^\]]*:/.test(value) && namedInMix.test(withoutTokens)) ||
          named.test(value) ||
          /(?:^|[:\s])(bg|text|border|ring|fill|stroke|outline|shadow|accent|caret|decoration|placeholder|from|to|via|divide)-(white|black)(?=[/\s]|$)/i.test(
            value
          ))
      )
        report(node, "colourLiterals");
    }
    if (node.type === "JSXAttribute" && node.name.name === "style") report(node, "inlineStyles");
    // A style-bearing props object is forbidden even when hoisted or spread. This also covers
    // createElement aliases. Non-props objects named style remain a documented conservative net.
    if (node.type === "Property" && (node.key.name ?? node.key.value) === "style")
      report(node, "inlineStyles");
    for (const [key, child] of Object.entries(node)) {
      if (["parent", "loc", "range", "tokens", "comments"].includes(key)) continue;
      if (Array.isArray(child)) child.forEach((n) => visit(n, node, [...ancestors, node]));
      else if (child && typeof child === "object") visit(child, node, [...ancestors, node]);
    }
  }
  visit(ast);
  return findings;
}

// Pure core: lint and measurement deliberately use the same semantic AST oracle.
export function countSource(fileName, src) {
  const { ast } = tsEslint.parser.parseForESLint(src, {
    filePath: fileName,
    jsx: true,
    loc: true,
    range: true,
  });
  const counts = {
    scaleClasses: 0,
    inlineStyles: 0,
    colourLiterals: 0,
    translationCasts: countMatches(TRANSLATION_CAST_RE, stripComments(src, fileName)),
  };
  for (const { kind } of debtFindings(ast, fileName)) counts[kind]++;
  return counts;
}

export function countFile(file) {
  const src = readFileSync(file, "utf8");
  return countSource(file, src);
}

const COUNTER_ORDER = ["scaleClasses", "inlineStyles", "colourLiterals", "translationCasts"];

function parseExact(raw) {
  if (!raw) {
    throw new Error("--exact requires a value, e.g. --exact 0,0,0,0");
  }
  const parts = raw.split(",").map((s) => s.trim());
  if (parts.length !== COUNTER_ORDER.length) {
    throw new Error(
      `--exact expects ${COUNTER_ORDER.length} comma-separated integers (${COUNTER_ORDER.join(",")}), got "${raw}"`
    );
  }
  const values = parts.map(Number);
  if (values.some((v) => !Number.isInteger(v) || v < 0)) {
    throw new Error(`--exact values must be non-negative integers, got "${raw}"`);
  }
  return Object.fromEntries(COUNTER_ORDER.map((key, i) => [key, values[i]]));
}

function main() {
  const args = process.argv.slice(2);
  const perFile = args.includes("--per-file");
  const json = args.includes("--json");
  const exactIdx = args.indexOf("--exact");

  let exact = null;
  if (exactIdx !== -1) {
    try {
      exact = parseExact(args[exactIdx + 1]);
    } catch (err) {
      console.error(`count-ui-debt: ${err.message}`);
      process.exit(2);
    }
  }

  const files = listFiles();
  const perFileCounts = files.map((file) => {
    const counts = countFile(file);
    const debt =
      counts.scaleClasses + counts.inlineStyles + counts.colourLiterals + counts.translationCasts;
    return { file: path.relative(repoRoot, file).replace(/\\/g, "/"), ...counts, debt };
  });

  const totals = perFileCounts.reduce(
    (acc, f) => ({
      scaleClasses: acc.scaleClasses + f.scaleClasses,
      inlineStyles: acc.inlineStyles + f.inlineStyles,
      colourLiterals: acc.colourLiterals + f.colourLiterals,
      translationCasts: acc.translationCasts + f.translationCasts,
    }),
    { scaleClasses: 0, inlineStyles: 0, colourLiterals: 0, translationCasts: 0 }
  );

  const overBaseline = Object.keys(BASELINES).filter((key) => totals[key] > BASELINES[key]);

  const exactMismatches = exact
    ? COUNTER_ORDER.filter((key) => totals[key] !== exact[key]).map(
        (key) => `${key}: expected ${exact[key]}, got ${totals[key]}`
      )
    : [];

  // Single result object — L1: `--per-file --json` used to emit two concatenated JSON documents
  // (the per-file array, then the summary), which is not parseable as one value. `perFile` is now
  // just a key on the one object.
  const result = { files: files.length, totals, baselines: BASELINES, overBaseline };
  if (perFile) {
    result.perFile = [...perFileCounts].filter((f) => f.debt > 0).sort((a, b) => b.debt - a.debt);
  }
  if (exact) {
    result.exact = exact;
    result.exactMismatches = exactMismatches;
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (perFile) {
      console.log("File | scale | inline | colour | casts | Debt");
      console.log("--- | --- | --- | --- | --- | ---");
      for (const f of result.perFile) {
        console.log(
          `${f.file} | ${f.scaleClasses} | ${f.inlineStyles} | ${f.colourLiterals} | ${f.translationCasts} | ${f.debt}`
        );
      }
    }
    console.log(`count-ui-debt: ${files.length} files scanned under src/client/**/*.{ts,tsx}`);
    console.log(
      `  raw scale classes    : ${totals.scaleClasses}  (baseline ${BASELINES.scaleClasses})`
    );
    console.log(
      `  inline style attrs   : ${totals.inlineStyles}  (baseline ${BASELINES.inlineStyles})`
    );
    console.log(
      `  colour literals      : ${totals.colourLiterals}  (baseline ${BASELINES.colourLiterals})`
    );
    console.log(
      `  translation-key casts: ${totals.translationCasts}  (baseline ${BASELINES.translationCasts})`
    );
    if (exact) {
      console.log(
        exactMismatches.length === 0
          ? `  --exact ${COUNTER_ORDER.map((k) => exact[k]).join(",")}: MATCH`
          : `  --exact ${COUNTER_ORDER.map((k) => exact[k]).join(",")}: MISMATCH — ${exactMismatches.join("; ")}`
      );
    }
    console.log(
      `${totals.scaleClasses} ${totals.inlineStyles} ${totals.colourLiterals} ${totals.translationCasts}`
    );
  }

  // H5 — this gate used to fail only when a count EXCEEDED its baseline, so it could never verify
  // its own close condition (`0 0 0 0`) or detect a pattern silently regressing to zero matches;
  // both `244 140 63 98` and `0 0 0 0` exited 0. `--exact` makes the close condition a hard,
  // machine-checked equality instead of something a human reads off stdout.
  if (exact) {
    if (exactMismatches.length > 0) {
      console.error(`count-ui-debt: FAIL (--exact) — ${exactMismatches.join("; ")}`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (overBaseline.length > 0) {
    console.error(
      `count-ui-debt: FAIL — ${overBaseline.join(", ")} exceed${overBaseline.length === 1 ? "s" : ""} the recorded baseline`
    );
    process.exit(1);
  }

  process.exit(0);
}

// ESM entry-point guard: run the CLI only when this file is executed directly, not when imported
// (the fixture self-test at tools/count-ui-debt.test.mjs imports stripComments/countSource/PATTERNS).
// Both sides MUST be realpath'd. Node resolves the main module to its realpath but
// `path.resolve` does not, so any symlink in the invocation path (e.g. macOS `/tmp` ->
// `/private/tmp`, which is where agents' scratch worktrees live) made these differ: main never
// ran, the process printed NOTHING and exited 0. `--exact 0,0,0,0` then "passed" on a tree with
// 545 debt items — a gate that silently reports success is the exact failure class this file
// exists to eliminate.
function isMainModule() {
  try {
    return (
      Boolean(process.argv[1]) &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main();
}
