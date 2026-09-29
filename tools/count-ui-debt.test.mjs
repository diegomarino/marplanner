// count-ui-debt.test.mjs — fixture self-test for tools/dev/count-ui-debt.mjs. Placed at the tools/ ROOT, not tools/dev/, so `npm test`'s glob
// (`"./tools/*.test.mjs"`, non-recursive) actually runs it — a test at tools/dev/*.test.mjs would
// silently never execute. Widening the glob to tools/* /*.test.mjs was the other option; this repo
// already has a working top-level tools/*.test.mjs convention for exactly this kind of
// negative/fixture test (see check-openapi-drift.test.mjs), so co-locating here follows that
// precedent instead of changing shared test-discovery config for one tool.
//
// The whole point of this file: a pattern that silently stops matching (the
// escaped-pipe alternation-collapse bug — an edit that broke the regex made counts DROP, and the
// old baseline-ceiling-only gate read that as progress) must fail a test, not read as green.

import { test } from "node:test";
import assert from "node:assert/strict";
import { countSource, stripComments, PATTERNS } from "./dev/count-ui-debt.mjs";

// ── Known-positive: each detector still fires on an unambiguous real violation ─────────────────
test("scaleClasses: fires on a raw Tailwind scale class", () => {
  const counts = countSource("x.tsx", `export const X = <div className="bg-slate-500" />;`);
  assert.equal(counts.scaleClasses, 1);
});

test("inlineStyles: fires on style={{ ", () => {
  const counts = countSource("x.tsx", `export const X = <div style={{ color: "red" }} />;`);
  assert.equal(counts.inlineStyles, 1);
});

test("translationCasts: fires on 'as MessageKey'", () => {
  const counts = countSource("x.ts", `export const k = "home.title" as MessageKey;`);
  assert.equal(counts.translationCasts, 1);
});

test("colourLiterals: fires on a hex literal", () => {
  const counts = countSource("x.ts", `export const c = "#ff00aa";`);
  assert.equal(counts.colourLiterals, 1);
});

test("colourLiterals: fires on rgb()/hsl()/oklch() calls", () => {
  const counts = countSource(
    "x.ts",
    `export const a = "rgb(1,2,3)"; export const b = "hsl(1,2%,3%)"; export const c = "oklch(1 0 0)";`
  );
  assert.equal(counts.colourLiterals, 3);
});

// ── M1/M2: full CSS named-colour set, all three quote delimiters ───────────────────────────────
test("colourLiterals: fires on CSS named colours beyond the old 17-name list", () => {
  const counts = countSource(
    "x.ts",
    `export const a = "teal"; export const b = 'navy'; export const c = \`olive\`; export const d = "whitesmoke";`
  );
  assert.equal(counts.colourLiterals, 4);
});

// ──: every modern CSS colour function, not just the original rgb/hsl/oklch trio ───────────
// Fixtures per new form, so a future narrowing of COLOUR_RE (e.g. an edit that only re-derives
// the hex/rgb/hsl/oklch alternatives and drops the rest) goes red instead of reading as progress
// — the same H5 rule the PATTERNS regression guard below already applies to the pre-existing four.
test("colourLiterals: fires on color()", () => {
  const counts = countSource("x.ts", `export const c = "color(display-p3 1 0 0)";`);
  assert.equal(counts.colourLiterals, 1);
});

test("colourLiterals: fires on hwb()", () => {
  const counts = countSource("x.ts", `export const c = "hwb(0 0% 0%)";`);
  assert.equal(counts.colourLiterals, 1);
});

// SINGLE-quoted deliberately. Every fixture using the same delimiter is how a narrowing survives:
// requiring a `"` prefix on the alternatives kept all six green while silently losing backtick and
// single-quote detection — exactly the evasion class the old 17-name list already fell to.
test("colourLiterals: fires on lab() in a SINGLE-quoted literal", () => {
  const counts = countSource("x.ts", "export const c = 'lab(50% 40 30)';");
  assert.equal(counts.colourLiterals, 1);
});

test("colourLiterals: fires on lch()", () => {
  const counts = countSource("x.ts", `export const c = "lch(50% 40 30)";`);
  assert.equal(counts.colourLiterals, 1);
});

test("colourLiterals: fires on oklab()", () => {
  const counts = countSource("x.ts", `export const c = "oklab(0.5 0.1 0.1)";`);
  assert.equal(counts.colourLiterals, 1);
});

// The short function names are word-boundary anchored. Unanchored, `lab(`/`lch(`/`color(` matched
// ordinary identifiers — `collab(`, `mulch(`, `theme.color("fg")` — and that is worse than a false
// positive: the RATCHET only applies its patterns to Literal and TemplateElement nodes, so such a
// call is lint-clean while the counter counts it. The final `--exact 0,0,0,0` would then be
// UNSATISFIABLE, with nothing to fix.
test("colourLiterals: does NOT fire on an identifier that merely ends in a colour-function name", () => {
  const counts = countSource("x.ts", "export const a = collab(1) + mulch(2) + theme.color('fg');");
  assert.equal(counts.colourLiterals, 0);
});

test("colourLiterals: still fires on a real lab() alongside such an identifier", () => {
  const counts = countSource(
    "x.ts",
    'export const a = collab(1); export const b = "lab(50% 40 30)";'
  );
  assert.equal(counts.colourLiterals, 1);
});

// BACKTICK-delimited deliberately — see the note on the lab fixture above.
test("colourLiterals: fires on color-mix() in a BACKTICK literal", () => {
  const counts = countSource("x.ts", "export const c = `color-mix(in oklch, red, blue)`;");
  assert.equal(counts.colourLiterals, 1);
});

// ──: case-variant named colours — a DOCUMENTED, DELIBERATE gap, not an oversight ───────────
// also proposed an `i` flag on the whole colour regex so `"Red"`/`"CRIMSON"` would count.
// That was measured and rejected for this change: it moves colourLiterals from 63 to 64, because
// src/client/i18n/messages.ts:662 has `"weather.condition.snow": "Snow"` — a legitimate English
// translation string, not a hardcoded colour, that collides with the CSS keyword "snow" once case
// is ignored (see the comment above COLOUR_RE). This test locks the CURRENT behaviour so that
// decision, whichever way it eventually lands, changes visibly here rather than silently drifting
// counts up or down as a side effect of an unrelated regex edit.
test("colourLiterals: does NOT fire on a case-variant named colour (documented gap, see COLOUR_RE)", () => {
  const counts = countSource("x.ts", `export const c = "Red";`);
  assert.equal(counts.colourLiterals, 0);
});

// ── H2: a provenance comment documenting removed debt is not itself counted as debt ────────────
test("H2: box-comment describing removed debt yields zero across all four counters", () => {
  const src = [
    "/*  Batch T013 (Codex review #718): the following raw scale classes were  */",
    "/*  removed — bg-slate-100, bg-slate-200, text-slate-700, border-slate-300 */",
    "/*  and the inline style={{ ... }} became <Stack>. Key casts as MessageKey */",
    "export const x = 1;",
    "",
  ].join("\n");
  assert.deepEqual(countSource("x.tsx", src), {
    scaleClasses: 0,
    inlineStyles: 0,
    colourLiterals: 0,
    translationCasts: 0,
  });
});

test("line comments describing removed debt yield zero, not just block comments", () => {
  const src = [
    '// removed bg-slate-100, style={{ color: "red" }}, "#ff00aa" and `as MessageKey`',
    "export const x = 1;",
    "",
  ].join("\n");
  assert.deepEqual(countSource("x.ts", src), {
    scaleClasses: 0,
    inlineStyles: 0,
    colourLiterals: 0,
    translationCasts: 0,
  });
});

// ── H3: the comment stripper must never eat real code ───────────────────────────────────────────
test("H3: a regex literal containing a quote does not desync string/comment parsing", () => {
  const src = [
    'export function f(s: string) { return s.replace(/"/g, "&quot;"); }',
    'export const u = "https://ex.com/#ff0000";',
    "",
  ].join("\n");
  const counts = countSource("x.ts", src);
  assert.equal(counts.colourLiterals, 1, "the hex colour after the regex literal must be counted");
});

test("H3: a // inside a string literal is not treated as a line-comment start", () => {
  const src = 'export const url = "https://example.com/#ff0000-not-a-comment";\n';
  const counts = countSource("x.ts", src);
  assert.equal(counts.colourLiterals, 1);
});

test("H3: a template literal with an interpolated expression containing a comment-like token is handled", () => {
  const src = "export const t = `prefix-${/* inline */ 1}-suffix-#ff00aa`;\n";
  const counts = countSource("x.ts", src);
  // The backtick-delimited literal text itself is not a quoted-colour match (colour literal
  // detection only looks for colours as a WHOLE quoted string), but stripping must not crash or
  // desync on the nested comment inside the interpolation.
  assert.equal(typeof counts.colourLiterals, "number");
});

// This fixture must START the JSX text run with `//`. The earlier version put the `//` MID-text
// ("see https://example.com for more"), where a leading-comment lookup can never fire — so it
// passed no matter what the stripper did. A test that cannot fail is the green theatre this whole
// script exists to prevent.
test("stripComments leaves JSX text that BEGINS with '//' untouched (it is content, not trivia)", () => {
  const src = "export const X = (\n  <span>\n  //cdn.example.com/#ff0000\n  </span>\n);\n";
  const stripped = stripComments(src, "x.tsx");
  assert.ok(stripped.includes("//cdn.example.com/#ff0000"));
  // And the colour inside that text must still be counted — the under-count direction is the one
  // that lets the slice close green with debt still in the tree.
  assert.equal(countSource("x.tsx", src).colourLiterals, 1);
});

test("stripComments leaves JSX text that begins with '/*' untouched", () => {
  const src = "export const X = (\n  <span>\n  /* not a comment, rendered text */\n  </span>\n);\n";
  const stripped = stripComments(src, "x.tsx");
  assert.ok(stripped.includes("not a comment, rendered text"));
});

// ── Regression guard against a silently-broken pattern (the escaped-pipe bug class) ──
test("PATTERNS regex objects are non-empty and match their known-positive fixtures", () => {
  assert.equal(countSourceWithPattern(PATTERNS.scaleClasses, "bg-slate-500"), 1);
  assert.equal(countSourceWithPattern(PATTERNS.inlineStyles, "style={{"), 1);
  assert.equal(countSourceWithPattern(PATTERNS.translationCasts, "as MessageKey"), 1);
  assert.equal(countSourceWithPattern(PATTERNS.colourLiterals, '"#ff00aa"'), 1);
});

function countSourceWithPattern(re, text) {
  re.lastIndex = 0;
  const m = text.match(re);
  return m ? m.length : 0;
}
