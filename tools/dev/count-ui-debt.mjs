#!/usr/bin/env node
// count-ui-debt.mjs — committed counting method for the four zero-target criteria
// (SC-004..SC-007). This is the ONLY authority for these numbers: if a count
// disagrees with the recorded baseline on an unchanged tree, the METHOD moved — that is a defect
// in this script, never progress, and the baseline is not to be edited to match a new output

//
// Scope: `src/client/* /*.{ts,tsx}` — PRODUCT CLIENT CODE ONLY. Test files (`*.test.*`,
// `*.spec.*`, anything under a `__tests__/` directory), tooling scripts and any generated output
// are excluded, because the same literal (a colour, a raw scale class, an inline style, a
// `MessageKey` cast) can be legitimate there — this mirrors the client audit file set.
//
// Four counters, ALL measured against COMMENT-STRIPPED source:
// A change that documents removed debt in a provenance comment (e.g. "the following raw
// scale classes were removed — bg-slate-100,...") must not have that documentation counted as
// live debt. Comments are stripped with the TypeScript compiler's own tokenizer (see "Comment
// stripping" below), not a hand-rolled string-state scanner — a hand-rolled scanner that treats
// every `"`/`'`/backtick as a string delimiter mis-parses regex literals (e.g. `/"/g`), which
// flips string/code parity for the rest of the file and can silently DELETE real code from the
// counted text — the false-green direction: the counter reads
// lower than the truth).
//
// 1. Raw Tailwind scale classes (SC-004) — e.g. `bg-slate-500`.
// 2. Inline `style={{` attributes (SC-005).
// 3. Colour literals (SC-006) — hex/rgb/hsl/oklch/oklab/hwb/lab/lch/color/color-mix
// (every modern CSS colour function, not just the original four) AND the full set of
// CSS named colours, matched inside double-quoted, single-quoted OR backtick-delimited
// strings (M1/M2 — the previous 17-name, double-quote-only list evaded `'teal'`,
// `` `crimson` ``, etc.). Named-colour matching is deliberately still case-SENSITIVE — see
// the note above `COLOUR_RE` for why case-insensitive matching was held back.
// The naive `#[0-9a-fA-F]{3,8}` pattern also counted numbered references
// in comments as colors. It also missed 19 real colours expressed as CSS named colours
// (`color: "crimson"` x14, plus "white"/"green"/"transparent").
// 4. `as MessageKey` casts (SC-007).
//
// Baselines — DO NOT edit these to match a disagreeing run; a disagreement means this script regressed:
const BASELINES = {
  scaleClasses: 244,
  inlineStyles: 140,
  colourLiterals: 63,
  translationCasts: 98,
};

import ts from "typescript";
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

const INLINE_STYLE_RE = /style=\{\{/g;

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

const NAMED_COLOURS_ALTERNATION = NAMED_COLOURS.join("|");

// This implementation includes the baseline-impact check because the case-insensitive option
// would not be baseline-neutral:
//
// 1. Every modern CSS colour function beyond rgb/hsl/oklch — `color`, `hwb`, `lab`,
// `lch`, `oklab` and `color-mix` are all valid, all currently unused anywhere in
// src/client (verified: adding them alone leaves colourLiterals at 63), and all equally
// capable of expressing the exact hardcoded colour the ratchet exists to catch. SHIPPED below.
//
// 2. Case-variant named keywords (`"Red"`, `"CRIMSON"`) via an `i` flag — NOT shipped.
// The assumption that no current occurrence exists is false. Adding `i` to this regex
// moves colourLiterals from 63 to 64, because `src/client/i18n/messages.ts:662` contains
// `"weather.condition.snow": "Snow"` — a legitimate English translation string that is also
// the CSS named colour "snow" once case is ignored. This is a structural hazard, not a
// one-off: ordinary English words this list also claims as colour keywords include "Coral",
// "Ivory", "Gold", "Silver", "Tan", "Plum", "Olive", "Wheat", "Salmon", "Turquoise" —
// ANY of which can legitimately appear Titlecased inside a message catalogue.
// This is left out deliberately: a count change requires inspecting and reporting the affected
// file and line instead of silently rebaselining;
// report the file and line evidence rather than shipping a moved baseline.
const COLOUR_RE = new RegExp(
  `#[0-9a-fA-F]{3,8}\\b|rgba?\\(|hsla?\\(|oklch\\(|oklab\\(|hwb\\(|(?<![\\w.-])lab\\(|(?<![\\w.-])lch\\(|(?<![\\w.-])color-mix\\(|(?<![\\w.-])color\\(|"(?:${NAMED_COLOURS_ALTERNATION})"|'(?:${NAMED_COLOURS_ALTERNATION})'|\`(?:${NAMED_COLOURS_ALTERNATION})\``,
  "g"
);

// The four regexes above are the actual detectors. Exported so the fixture self-test
// (tools/count-ui-debt.test.mjs) can assert directly that each one still matches its
// known-positive case — H5: a pattern that silently stops matching (e.g. the escaped-pipe
// alternation-collapse bug must fail loudly, not read as progress.
export const PATTERNS = {
  scaleClasses: SCALE_CLASS_RE,
  inlineStyles: INLINE_STYLE_RE,
  colourLiterals: COLOUR_RE,
  translationCasts: TRANSLATION_CAST_RE,
};

function countMatches(re, text) {
  re.lastIndex = 0;
  const matches = text.match(re);
  return matches ? matches.length : 0;
}

// Pure core: takes source text directly (no fs), so it is unit-testable with synthetic fixtures.
export function countSource(fileName, src) {
  const stripped = stripComments(src, fileName);
  return {
    scaleClasses: countMatches(SCALE_CLASS_RE, stripped),
    inlineStyles: countMatches(INLINE_STYLE_RE, stripped),
    colourLiterals: countMatches(COLOUR_RE, stripped),
    translationCasts: countMatches(TRANSLATION_CAST_RE, stripped),
  };
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
