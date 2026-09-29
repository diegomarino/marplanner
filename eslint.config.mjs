import js from "@eslint/js";
import globals from "globals";
import tsEslint from "typescript-eslint";
import importX from "eslint-plugin-import-x";
import { PATTERNS, NAMED_COLOURS } from "./tools/dev/count-ui-debt.mjs";

// FR-014/FR-015/FR-017 — the enforcement ratchet for the migrated UI dialect.
//
// `tools/dev/count-ui-debt.mjs` is the MEASUREMENT oracle — it drives the four
// zero-target counters and is the only thing baselines are compared against. This ratchet is the
// separate ENFORCEMENT mechanism: it must reject the same three violation classes at lint time
// (FR-014 covers raw scale classes, inline style attributes and colour literals — NOT the fourth
// counter, translation-key casts, which is a different guarantee with no lint-time equivalent
// here). Reusing `PATTERNS.scaleClasses` keeps the scale-class detector byte-for-byte identical
// between measurement and enforcement; the colour detector's REGEX is still built here rather
// than imported, because the counter's colour regex is quote-delimited (it matches raw SOURCE
// TEXT, so a named colour must appear as `"red"`/`'red'`/`` `red` ``), while an ESLint `Literal`/
// `TemplateElement` node's `.value`/`.raw` is already unquoted — reusing the source verbatim would
// silently never match. The underlying NAMED COLOUR LIST, however, is imported (above) —
// see the comment near `COLOUR_NAMED_EXACT_SOURCE` below.
const SCALE_CLASS_SOURCE = PATTERNS.scaleClasses.source;

// This used to be its own 149-entry copy of `tools/dev/count-ui-debt.mjs`'s NAMED_COLOURS
// list, hand-duplicated and asserted nowhere to match. A single definition site prevents the copies from diverging —
// `NAMED_COLOURS` is now imported (above) directly from the counter module, which remains the
// SOURCE OF TRUTH for which names count. There is no separate regex OBJECT to reuse here (the
// counter's is baked into a quote-delimited alternation — `"(?:red|...)"` — that has no meaning
// against an already-unquoted AST literal value), but the underlying array is now one thing, not
// two: growing the list means editing exactly one file, and both the counter and this ratchet see
// the change immediately.

// Hex / functional colour forms — substring match anywhere in the literal, mirroring the
// counter's unanchored `#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(|oklab\(|hwb\(|lab\(|lch\(
// |color-mix\(|color\(`. This list covers modern CSS colour functions (color,
// hwb, lab, lch, oklab, color-mix), not just the original rgb/hsl/oklch trio — verified
// baseline-neutral (adding these alone leaves colourLiterals at 63; see count-ui-debt.mjs).
const COLOUR_HEX_FUNCTIONAL_SOURCE =
  "#[0-9a-fA-F]{3,8}\\b|rgba?\\(|hsla?\\(|oklch\\(|oklab\\(|hwb\\(|lab\\(|lch\\(|color-mix\\(|color\\(";
// Named colours — ANCHORED (whole literal must equal one name), mirroring the counter's
// quote-delimited exact match (`"red"`, not `"very red"`). `NAMED_COLOURS` is imported
// (top of file) from the counter module rather than duplicated here —
// This applies the same single-source-of-truth rule to the tooling itself.
// A previous update also proposed making this match case-insensitive (`color: "Red"` currently counts as
// zero). NOT shipped: doing so moves the counter's colourLiterals from 63 to 64, because
// src/client/i18n/messages.ts:662 contains `"weather.condition.snow": "Snow"` — a legitimate
// English translation string that collides with the CSS named colour "snow" once case is
// ignored. Per the rule ("if the count moves off 63... decide deliberately — do
// not silently rebaseline"), that part is left for a deliberate follow-up decision rather than
// shipped silently; see count-ui-debt.mjs's COLOUR_RE comment for the full evidence.
const COLOUR_NAMED_EXACT_SOURCE = `^(?:${NAMED_COLOURS.join("|")})$`;

// CLIENT-LOGGING-TELEMETRY-INV-05 — the pre-existing logger
// `data`-must-be-structured selectors. Extracted to a constant so they can be appended to
// verbatim below WITHOUT ever being replaced: ESLint flat config does not merge array-valued
// rule options across matching blocks, it takes the LAST one — a third block re-declaring
// `no-restricted-syntax` for the same `files: ["src/client/**/*.{ts,tsx}"]` glob would silently
// DROP this array and disable INV-05 (proved in a dry-run before writing this). The fix is to
// keep exactly two client-scoped blocks below (no-console, and this expanded
// no-restricted-syntax array), and to scope the exception-list override to specific FILE PATHS
// rather than the shared wildcard glob, so it narrows rather than replaces.
const INV05_NO_RESTRICTED_SYNTAX = [
  {
    selector:
      "CallExpression[callee.name='log'] > TemplateLiteral:nth-child(4), CallExpression[callee.object][callee.property.name=/^(log|debug|info|warn|error)$/] > TemplateLiteral:last-child",
    message:
      "INV-05: logger `data` must be structured diagnostic values, not free-text — avoid a template literal as the data argument.",
  },
  {
    selector:
      "CallExpression[callee.name='log'] > BinaryExpression[operator='+']:nth-child(4), CallExpression[callee.object][callee.property.name=/^(log|debug|info|warn|error)$/] > BinaryExpression[operator='+']:last-child",
    message:
      "INV-05: logger `data` must be structured diagnostic values, not free-text — avoid string concatenation as the data argument.",
  },
  {
    selector:
      "CallExpression[callee.name='log'] > ObjectExpression:nth-child(4) Property > TemplateLiteral.value, CallExpression[callee.object][callee.property.name=/^(log|debug|info|warn|error)$/] > ObjectExpression:last-child Property > TemplateLiteral.value",
    message:
      "INV-05: logger `data` must be structured diagnostic values, not free-text — avoid a template literal as a data property value.",
  },
  {
    selector:
      "CallExpression[callee.name='log'] > ObjectExpression:nth-child(4) Property > BinaryExpression[operator='+'].value, CallExpression[callee.object][callee.property.name=/^(log|debug|info|warn|error)$/] > ObjectExpression:last-child Property > BinaryExpression[operator='+'].value",
    message:
      "INV-05: logger `data` must be structured diagnostic values, not free-text — avoid string concatenation as a data property value.",
  },
];

// FR-014 — the three enforced violation classes. AST-selector based (esquery), so they run
// through the same `no-restricted-syntax` rule as INV-05 above rather than a fourth eslint rule,
// keeping the client glob's rule set to one entry.
const UI_DEBT_SELECTORS = [
  {
    selector: `Literal[value=/${SCALE_CLASS_SOURCE}/]`,
    message:
      "FR-014: raw Tailwind scale class — use a semantic token from src/client/styles/globals.css instead (slice-020 research D1).",
  },
  {
    selector: `TemplateElement[value.raw=/${SCALE_CLASS_SOURCE}/]`,
    message:
      "FR-014: raw Tailwind scale class in a template literal — use a semantic token from src/client/styles/globals.css instead (slice-020 research D1).",
  },
  {
    // The selector must match the `style` attribute itself. Requiring an object literal as the
    // direct child of `JSXExpressionContainer` catches only `style={{...}}` and misses other
    // `style={...}` forms, including a hoisted style object (`style={HOISTED}`), a
    // conditional (`style={cond ? {...}: {...}}`), or a function call (`style={makeStyle}`).
    // Since SC-005's lexical counter (count-ui-debt.mjs) names this ESLint rule as its semantic
    // backstop, a selector that only catches the object-literal-direct-child form is not a
    // backstop at all — hoisting a file's style objects would zero its counter AND stay lint-clean.
    // Shortened to flag the JSX `style` ATTRIBUTE itself regardless of what expression is bound to
    // it, closing all three forms above. NOT closed by this change (still open, unrelated to this
    // fix's scope): `<div {...{ style: {...} }} />` (a `JSXSpreadAttribute`, not a `JSXAttribute`,
    // so this selector never sees it) and `React.createElement("div", { style: {...} })` (not JSX
    // at all — a `Property`, matched by no `JSXAttribute` selector). Verified (`npx eslint
    // --no-cache src/client`) this produces zero collateral: every existing `style={...}` site in
    // the client tree is already inside an exception-listed file, and no non-object `style={...}`
    // exists in unlisted client code today.
    selector: "JSXAttribute[name.name='style']",
    message:
      "FR-014: inline style attribute — use the token layer / shared component instead of any style={...} form, hoisted objects included (slice-020 research D1). To set a CSS CUSTOM PROPERTY inline (the token-correct way to pass a dynamic value into the token layer) or to forward a caller's style prop, use an eslint-disable-next-line with a one-line justification — see quickstart S4.",
  },
  {
    selector: `Literal[value=/${COLOUR_HEX_FUNCTIONAL_SOURCE}/]`,
    message:
      "FR-014: hardcoded colour literal (hex, or any CSS colour function: rgb/hsl/oklch/color/hwb/lab/lch/oklab/color-mix) — use a semantic colour token instead (slice-020 research D1).",
  },
  {
    selector: `TemplateElement[value.raw=/${COLOUR_HEX_FUNCTIONAL_SOURCE}/]`,
    message:
      "FR-014: hardcoded colour literal (hex, or any CSS colour function: rgb/hsl/oklch/color/hwb/lab/lch/oklab/color-mix) in a template literal — use a semantic colour token instead (slice-020 research D1).",
  },
  {
    selector: `Literal[value=/${COLOUR_NAMED_EXACT_SOURCE}/]`,
    message:
      "FR-014: hardcoded CSS named colour — use a semantic colour token instead (slice-020 research D1).",
  },
];

// This is the mechanized half of the style-guide DoD (docs/development/style-guide.md,
// "Mechanization"). A recipe/component design gap left nowhere to put a recipe
// and declared three private constants — `LABEL_INLINE_CLASSES`, `NATIVE_SELECT_CLASSES`,
// `NATIVE_TEXTAREA_CLASSES` — all module-scope, all string literals, all name-suffixed the same
// way. This selector flags a `const` whose name ends in
// `Classes`/`_CLASSES` and whose initializer is ANY literal or `as`/`satisfies` cast, outside
// `src/client/lib/recipes.ts` — the one file allowed to declare them (narrowed back off below,
// same technique as the FR-015 exception list).
//
// The original selector was anchored `Program >
// VariableDeclaration > VariableDeclarator`, so it matched an unexported module-scope `const` only.
// An `export const` is wrapped in an `ExportNamedDeclaration`, which `Program >
// VariableDeclaration` never matches, so an `export const` evades the rule. The exemption for
// `src/client/lib/recipes.ts` did not need the selector because its declarations did not match it;
// its three real exports (`export const LABEL_INLINE_CLASSES = "..."`, etc.) never matched the
// anchored selector either way — the exemption existed to permit exactly what the rule could not
// flag. Fixed by dropping the `Program >` anchor entirely (an esquery selector with no ancestor
// constraint matches a `VariableDeclarator` regardless of what wraps its `VariableDeclaration` —
// `Program`, `ExportNamedDeclaration`, or anything else) and widening `init.type` from the bare
// `'Literal'` to `Literal|TemplateLiteral|TSAsExpression` (catches a template-literal class string
// and a trailing `as const`/`as SomeType`, both realistic recipe-shaped forms). Re-verified after
// the fix (`npx eslint --no-cache src/client`): deleting the `recipes.ts` exemption block now
// makes `recipes.ts` go red — the exemption is load-bearing again.
//
// It is still a NAMING-CONVENTION net, not a general "is this string a Tailwind class list"
// detector: a constant named or shaped differently (an object property, string concatenation, a
// `.join(" ")`/`cn(...)` call, or inlining the string at the call site with no constant at all)
// evades it — see the measured evasion matrix in docs/development/style-guide.md's
// "Mechanization" section for the full accounting, including the one documented false positive
// (a `*_CLASSES`/`*Classes`-suffixed constant whose value is a non-Tailwind string, e.g. SQL) and
// its escape hatch (an `eslint-disable-next-line` with a one-line justification, same convention
// as the inline-style selector above).
const RECIPE_CONSTANT_SELECTOR = [
  {
    selector:
      "VariableDeclarator[id.name=/(_CLASSES|Classes)$/][init.type=/^(Literal|TemplateLiteral|TSAsExpression|TSSatisfiesExpression)$/]",
    message:
      "#762: class-string constant outside src/client/lib/recipes.ts — this is a D3 " +
      "recipe. Add it as a named export in src/client/lib/recipes.ts and document it in " +
      "docs/development/style-guide.md, then import it here instead of declaring it locally. " +
      "If this is a false positive (the value isn't actually a Tailwind class list), use an " +
      "eslint-disable-next-line with a one-line justification.",
  },
];

// SC-011 requires error states to be announced to assistive technology. `ErrorNotice` provides
// the live-region behavior, and this selector catches non-interactive JSX elements with
// destructive text color that lack `role="alert"` or `aria-live`. Existing exceptions use
// per-line directives, while the selector remains active in every client file.

// This selector targets the DECIDABLE core of that gap: a non-interactive JSX element (no
// `onClick` — the same heuristic that separates every destructive-action button above from an
// error message, since none of today's error paragraphs are also click handlers) whose
// `className` carries `text-destructive`/`text-red-NNN` ANYWHERE in its expression tree (esquery's
// plain descendant combinator sees through a `cn(...)` call or a ternary, unlike a selector
// anchored to a bare string `Literal` attribute value — see the `PrintingManagement.tsx`/
// `PrintExecutor.tsx` status-indicator shape above, which is exactly the lesson this rule
// does NOT want to repeat: aim at the measured population, not just its most naive form) with no
// `role="alert"`/`aria-live` on that SAME element. Two selectors, not one: a `Literal` twin (a
// plain string `className`) and a `TemplateElement` twin (`` className={`text-destructive ${x}`} ``).
// Both node forms need coverage so template-literal classes are reported too.
//
// What this rule CANNOT catch (stated plainly, not discovered later):
// 1. A live region supplied by an ANCESTOR rather than the flagged element itself (e.g. a
// wrapping `<div role="alert">` around a plain `<p className="text-destructive">` child) —
// no occurrence of this shape exists in the client tree today, but the selector only looks
// at the element it flags, not its ancestors.
// 2. `border-*`/`bg-*`/`ring-*` destructive tokens — deliberately excluded (see the
// `aria-invalid` false-positive above); a colour used for a border/background/ring accent
// rather than the message TEXT itself is out of scope.
// 3. A colour class built through string concatenation, a `.join(" ")`, or any form other than
// a literal or template literal (however deeply nested inside `cn(...)`/a ternary) — the
// same "naming/shape convention, not a general string-content detector" limitation FR-014's
// own selectors and the recipe-constant selector already carry. (A template literal —
// unlike concatenation or `.join(" ")` — IS covered, see the `TemplateElement` twin above;
// only concatenation/`.join`/other non-AST-decidable forms remain out of reach.)
// 4. Whether an announced message is actually CORRECT (right politeness, not stale) — that is
// `ErrorNotice`'s own contract (its co-located spec asserts it), not this lint rule's job.
// 5. A dismissible error banner that also carries an `onClick` (e.g. a "dismiss" click handler
// on the error element itself) — the `:not(has(... onClick))` exclusion exists to spare
// destructive ACTION buttons, but it is indiscriminate: it also silently spares a real error
// message that happens to be clickable. This is the most PLAUSIBLE false negative of the
// five — exactly the shape a change "modernizing" an error banner into a dismissible one would
// write — and remains an accepted limitation of this selector.
// 6. `role="status"` DOES fire even though it is a live region with an implicit
// `aria-live="polite"` — FIXED: the exclusion list now accepts role alert/status/log/
// alertdialog, so `role="status"` is treated as announcing. A site that combines this role with a
// `text-destructive`/`text-red-NNN` class — a future site that combines the two would be a
// FALSE POSITIVE, not a false negative. Same gap for `role={"alert"}` written as a JSX
// expression container instead of a plain string attribute value (the selector's
// `value.value='alert'` match is string-literal-only), and for `<ErrorNotice
// className="text-destructive" />` — flagged on the very component this rule's own message
// tells the reader to adopt, because the selector cannot see that `ErrorNotice` itself
// renders the live-region wiring internally.
// 7. `aria-live="off"` is silent — the selector checks only for the PRESENCE of an `aria-live`
// attribute, not its value; `aria-live="off"` explicitly opts an element OUT of being
// announced, so a site written that way is indistinguishable here from a correctly-announced
// one.
// 8. FR-014 encourages shared class-string constants in `src/client/lib/recipes.ts`, but this
// selector sees only the `className` expression and not an imported identifier's definition. A
// shared constant can therefore meet FR-014 while remaining invisible to this SC-011 rule.
// Any of the above is a false negative, not a false positive: this is a lint NET tightened around
// the measured, decidable core, not an adversary-proof accessibility auditor.
const SC011_ERROR_TEXT_TOKEN_SOURCE = "\\btext-(?:destructive|red-[0-9]{2,3})\\b";
const SC011_SELECTOR = [
  {
    selector:
      `JSXOpeningElement:has(JSXAttribute[name.name='className'] Literal[value=/${SC011_ERROR_TEXT_TOKEN_SOURCE}/])` +
      ":not(:has(JSXAttribute[name.name='role'][value.value=/^(alert|status|log|alertdialog)$/]))" +
      ":not(:has(JSXAttribute[name.name='aria-live'][value.value=/^(polite|assertive)$/]))" +
      ":not(:has(JSXAttribute[name.name='onClick']))",
    message:
      'SC-011 (#758): error-coloured text (text-destructive/text-red-NNN) with no role="alert" ' +
      "or aria-live on the same element — assistive technology is never told this message " +
      "appeared. Route it through <ErrorNotice> (src/client/components/ErrorNotice.tsx), which " +
      'owns the live-region wiring, or add role="alert"/aria-live directly if ErrorNotice does ' +
      "not fit this call site.",
  },
  {
    selector:
      `JSXOpeningElement:has(JSXAttribute[name.name='className'] TemplateElement[value.raw=/${SC011_ERROR_TEXT_TOKEN_SOURCE}/])` +
      ":not(:has(JSXAttribute[name.name='role'][value.value=/^(alert|status|log|alertdialog)$/]))" +
      ":not(:has(JSXAttribute[name.name='aria-live'][value.value=/^(polite|assertive)$/]))" +
      ":not(:has(JSXAttribute[name.name='onClick']))",
    message:
      "SC-011 (#758): error-coloured text (text-destructive/text-red-NNN) in a template literal " +
      'with no role="alert" or aria-live on the same element — assistive technology is never ' +
      "told this message appeared. Route it through <ErrorNotice> " +
      "(src/client/components/ErrorNotice.tsx), which owns the live-region wiring, or add " +
      'role="alert"/aria-live directly if ErrorNotice does not fit this call site.',
  },
];

// FR-015 — files not yet migrated MAY be listed here; the list MUST only ever shrink
// (tools/dev/check-exception-list.mjs). Measured against `node tools/dev/count-ui-debt.mjs
// --per-file` on the tip this list was authored against (2026-09-09): every file below has
// nonzero scaleClasses, inlineStyles or colourLiterals count. Files whose ONLY debt is
// translation-key casts (colourLiterals=inlineStyles=scaleClasses=0) are deliberately NOT listed
// — FR-014 does not cover that counter, and listing a file with zero enforced debt would make the
// list unshrinkable in a way nobody could diagnose (the task list DoD note). As of this
// baseline that excludes: src/client/daily-briefing/DailyBriefingView.tsx,
// src/client/daily-briefing/blockRenderers.tsx, src/client/home/WeatherPill.tsx.
const UI_DEBT_EXCEPTION_FILES = [];

// Named export (in addition to the default flat-config export) so
// `tools/dev/check-exception-list.mjs` can be pointed at this file's *declared* source of
// truth. The checker still parses committed revisions of this file as TEXT (via `git show`) rather
// than importing them, since importing an arbitrary historical revision would execute that
// revision's code and could break on relative-import drift — but the current working-tree side
// uses this export directly, so the two extraction paths never silently diverge.
export { UI_DEBT_EXCEPTION_FILES };

// `SC011_SELECTOR` remains active for every client file, including paths listed in
// `UI_DEBT_EXCEPTION_FILES`. Per-line directives mark only the existing exceptions, so the
// selector continues to catch new violations in those files.
// to keep SC-011 enforced regardless of a file's FR-014 migration status.

export default [
  // Unused `eslint-disable-next-line` directives must fail lint. ESLint 10 defaults these to
  // warnings, and `npm run lint` does not set `--max-warnings`; without this option, stale
  // directives would exit successfully.
  {
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },
  { ignores: ["node_modules/", "dist/", "build/", ".specify/", ".opencode/"] },

  // Base rules for all JS/CJS/MJS
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.cjs", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.commonjs,
        ...globals.es2024,
      },
    },
    rules: {
      "no-unused-vars": ["error", { args: "none" }],
    },
  },

  // TypeScript / TSX support (no project / no projectService)
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      parser: tsEslint.parser,
      parserOptions: {
        ecmaVersion: 2024,
        sourceType: "module",
      },
      globals: {
        ...globals.node,
        ...globals.es2024,
        ...globals.browser,
        React: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["error", { args: "none" }],
    },
  },

  // Import-boundary rule (ADR-039 §2b′/Rule B): a PLUGIN module
  // (reminders, daily-messages, meals, daily-briefing) may import only its own subtree + the
  // host-API barrel (src/server/host-api) — everything else under
  // src/server (core modules, db/client, lib/*) is forbidden. Path-aware
  // (resolves import targets, so it catches `../../lib/*`, `../../db/client`, and
  // path-normalization bypasses a specifier regex would miss). eslint-plugin-
  // import-x's moduleVisitor defaults `esmodule: true`, so no-restricted-paths
  // already visits dynamic `import` (ImportExpression) the same path-aware
  // way as static imports — no separate dynamic-import guard is needed (a
  // syntax-only regex guard would be depth/subtree-unaware and wrongly red a
  // nested file's valid own-subtree or depth-correct barrel dynamic import;
  // Dynamic imports are covered by the same path-aware visitor. Add a
  // zone here when a future plugin module lands (printing).
  {
    files: ["**/*.{js,ts,tsx}"],
    plugins: { "import-x": importX },
    settings: {
      "import-x/resolver": { node: { extensions: [".ts", ".tsx", ".js"] } },
    },
    rules: {
      "import-x/no-restricted-paths": [
        "error",
        {
          zones: [
            {
              target: "src/server/modules/reminders",
              from: "src/server",
              except: ["modules/reminders", "host-api"],
              message:
                "Plugin modules must reach core/host only through ../../host-api (ADR-039 §2b′).",
            },
            {
              target: "src/server/modules/daily-messages",
              from: "src/server",
              except: ["modules/daily-messages", "host-api"],
              message:
                "Plugin modules must reach core/host only through ../../host-api (ADR-039 §2b′).",
            },
            {
              target: "src/server/modules/meals",
              from: "src/server",
              except: ["modules/meals", "host-api"],
              message:
                "Plugin modules must reach core/host only through ../../host-api (ADR-039 §2b′).",
            },
            {
              target: "src/server/modules/daily-briefing",
              from: "src/server",
              except: ["modules/daily-briefing", "host-api"],
              message:
                "Plugin modules must reach core/host only through ../../host-api (ADR-039 §2b′).",
            },
            // The time-announcements module uses rule CRUD only
            // and has no cross-domain reads, so it needs only `getDb` from the host-api barrel.
            {
              target: "src/server/modules/time-announcements",
              from: "src/server",
              except: ["modules/time-announcements", "host-api"],
              message:
                "Plugin modules must reach core/host only through ../../host-api (ADR-039 §2b′).",
            },
            // The weather module is the first ADR-039 host-API
            // plugin consumer that also needs operator config. Location reads and writes
            // go through App Settings via the host-api barrel like every other plugin; the
            // `getOperatorConfig` accessor added to host-api/index.ts is the ONLY seam this
            // module may use for deploy-time knobs — paired with the `process.env` ban below.
            {
              target: "src/server/modules/weather",
              from: "src/server",
              except: ["modules/weather", "host-api"],
              message:
                "Plugin modules must reach core/host only through ../../host-api (ADR-039 §2b′).",
            },
            // Seventh plugin-module zone — network-devices.
            // The sensitive-domain gate (`requireManagementKey`) and this module fence are the initial
            // checkpoint for the registry, controller client, and poller. The module uses the same
            // host-api-only seam as every zone above and consumes
            // `getOperatorConfig` (`unifi.*` keys) through
            // the SAME barrel + the SAME process.env ban below, never a direct read.
            {
              target: "src/server/modules/network-devices",
              from: "src/server",
              except: ["modules/network-devices", "host-api"],
              message:
                "Plugin modules must reach core/host only through ../../host-api (ADR-039 §2b′).",
            },
            // Eighth plugin-module zone — printing.
            // Atomic-claim, lease, and artifact-conversion behavior is implemented separately. This
            // config fences the namespace and allows the current printing skeleton. Printing has
            // no operator-config keys, so it remains subject to the `process.env` ban without an
            // accessor exception.
            {
              target: "src/server/modules/printing",
              from: "src/server",
              except: ["modules/printing", "host-api"],
              message:
                "Plugin modules must reach core/host only through ../../host-api (ADR-039 §2b′).",
            },
            // src/shared contains shared household time-zone calculations
            // used by both server and client. It must stay pure (no I/O, no
            // clock, no dependencies) so both sides can safely import it. A shared → server or
            // shared → client import would either drag server-only code (getDb, node
            // built-ins) into the client bundle, or create an import cycle back into
            // whichever side is compiling src/shared. RED-verified: temporarily adding
            // `import { getDb } from "../server/db/client"` to householdTime.ts violates this
            // boundary.
            {
              target: "src/shared",
              from: "src/server",
              message:
                "src/shared must stay pure — no imports from src/server (Constitution VIII, D1).",
            },
            {
              target: "src/shared",
              from: "src/client",
              message:
                "src/shared must stay pure — no imports from src/client (Constitution VIII, D1).",
            },
          ],
        },
      ],
    },
  },

  // PLUGIN-SYSTEM-INV-09 — no file under a plugin module
  // namespace may read `process.env` directly; deploy-time configuration MUST go through
  // the host-API barrel's `getOperatorConfig` accessor instead (host-api/index.ts is
  // OUTSIDE `src/server/modules/**`, so it is exempt — it's the one legitimate reader).
  // The namespace was clean before this module (zero `process.env` reads under modules/**);
  // weather is the first module that would otherwise introduce a violation. RED-proved in
  // A scratch file under src/server/modules/weather/ with a direct `process.env`
  // read fails this rule) and guarded going
  // forward by tests/boundary/weather-rule-b.test.ts (config-drift tripwire).
  //
  // The first (non-computed `process.env`) selector alone left two evasion
  // forms unflagged — `process["env"]` (computed access, whose property node is a Literal
  // with `.value`, not `.name`) and `const { env } = process` (destructuring, which reads
  // `.env` at declaration time without ever writing a `process.env` MemberExpression). Both
  // are added below as separate selectors. NOT closed by any selector here — and not
  // realistically closable by one — is full aliasing (`const p = process; p.env.X`): this
  // is a lint NET, not an adversary-proof sandbox; it stops the obvious/accidental reads a
  // plugin author would actually write, not a deliberately obfuscated bypass.
  {
    files: ["src/server/modules/**/*.{js,ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message:
            "PLUGIN-SYSTEM-INV-09: plugin modules may not read process.env directly — use " +
            "getOperatorConfig() from ../../host-api (research D2).",
        },
        {
          selector: "MemberExpression[computed=true][object.name='process'][property.value='env']",
          message:
            "PLUGIN-SYSTEM-INV-09: plugin modules may not read process['env'] (computed " +
            "access) directly — use getOperatorConfig() from ../../host-api (research D2).",
        },
        {
          selector:
            "VariableDeclarator[init.name='process'] > ObjectPattern > Property[key.name='env']",
          message:
            "PLUGIN-SYSTEM-INV-09: plugin modules may not destructure env from process — " +
            "use getOperatorConfig() from ../../host-api (research D2).",
        },
      ],
    },
  },

  // Two distinct client-side telemetry lint rules trace
  // different invariants and are not interchangeable.
  //
  // (a) INV-06: raw `console.*` is banned across the client surface — the client console mirror
  // guarantee belongs to `src/client/lib/logger.ts` alone (its DEV-only mirror); everywhere else
  // on the client, an error/warning must go through the shared logger so it becomes a redacted,
  // queryable telemetry row instead of vanishing into a device's local console. Server code is
  // NOT in scope here (its console usage is a legitimate operator log, unrelated to this domain).
  {
    files: ["src/client/**/*.{ts,tsx}"],
    rules: {
      "no-console": "error",
    },
  },
  {
    files: ["src/client/lib/logger.ts"],
    rules: {
      "no-console": "off",
    },
  },

  // (b) INV-05: DB-sink minimization — the logger's `data` argument must carry structured
  // diagnostic values, never free-text. `no-console` does NOT substitute for this: a call could
  // be perfectly logger-routed and still smuggle interpolated user/product text into `data`. This
  // selector set flags the OBVIOUS cases — a template literal or `+` string-concatenation used
  // either as the `data` argument itself, or as a property value inside an object literal passed
  // as `data` — for calls to `log(...)` or any `logger.<method>(...)` call
  // This is a convention and a lint net,
  // not a taint-analysis hard gate (residual risk accepted per the contract).
  // FR-014/FR-015/FR-017 require this two-block shape (see the comment above
  // `INV05_NO_RESTRICTED_SYNTAX`) — this is the SAME block INV-05 has always lived in, with
  // `UI_DEBT_SELECTORS` appended to the same `no-restricted-syntax` array rather than declared in
  // a new block for the same glob. Do not split this into a third `files:
  // ["src/client/**/*.{ts,tsx}"]` block: the last matching block for a given rule REPLACES the
  // array entirely under ESLint flat config, so a second `no-restricted-syntax` entry for this
  // exact glob would silently disable INV-05.
  //
  // `SC011_SELECTOR` is appended here too (in its own array, kept separate from
  // `UI_DEBT_SELECTORS` — a different guarantee, FR-014 debt vs SC-011 announcement, independently
  // narrowable). SUPERSEDED: files on `UI_DEBT_EXCEPTION_FILES` used
  // to get a free pass from THIS selector too, because that block (below) dropped the entire
  // FR-014 debt path for them without re-adding `SC011_SELECTOR` — which meant SC-011 was
  // completely inert on exactly the files carrying every one of the 12 measured misses (100% of
  // them). Fixed: the `UI_DEBT_EXCEPTION_FILES` narrowing block below now re-adds
  // `SC011_SELECTOR`, so it is enforced on every client file without exception; the 12 pre-existing
  // sites are grandfathered per-line instead (see `SC011_SELECTOR`'s own comment for the map).
  {
    files: ["src/client/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...INV05_NO_RESTRICTED_SYNTAX,
        ...UI_DEBT_SELECTORS,
        ...RECIPE_CONSTANT_SELECTOR,
        ...SC011_SELECTOR,
      ],
    },
  },

  // The recipes module is the one file allowed to declare a module-scope class-string
  // constant (that IS its job). Narrows the block above for exactly this path by re-declaring the
  // array WITHOUT `RECIPE_CONSTANT_SELECTOR` — the same narrowing technique the FR-015
  // exception-list block below uses for migration debt, and for the same reason: a DIFFERENT
  // (narrower) `files` value narrows the previous block instead of replacing it repo-wide.
  {
    files: ["src/client/lib/recipes.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...INV05_NO_RESTRICTED_SYNTAX, ...UI_DEBT_SELECTORS],
    },
  },
  // FR-015 exception paths re-declare the INV-05 selectors while omitting the three FR-014
  // migration selectors. Keep `RECIPE_CONSTANT_SELECTOR` in this block so an exception path
  // cannot add private class-string constants. Re-declare `SC011_SELECTOR` as well: FR-014
  // migration exceptions do not disable the separate announcement rule. Individual existing
  // violations use `eslint-disable-next-line` directives.
  //
  // Conditional spread: ESLint 10 requires a non-empty `files` array. Include this block only
  // while `UI_DEBT_EXCEPTION_FILES` has entries, so an empty list does not make config loading fail.
  ...(UI_DEBT_EXCEPTION_FILES.length > 0
    ? [
        {
          files: UI_DEBT_EXCEPTION_FILES,
          rules: {
            "no-restricted-syntax": [
              "error",
              ...INV05_NO_RESTRICTED_SYNTAX,
              ...RECIPE_CONSTANT_SELECTOR,
              ...SC011_SELECTOR,
            ],
          },
        },
      ]
    : []),
];
