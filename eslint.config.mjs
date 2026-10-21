import { dirname, resolve } from "node:path";
import js from "@eslint/js";
import globals from "globals";
import tsEslint from "typescript-eslint";
import importX from "eslint-plugin-import-x";
import { debtFindings } from "./tools/dev/count-ui-debt.mjs";

function clientImport(context, source) {
  if (source.startsWith("@/")) return resolve(context.cwd, "src/client", source.slice(2));
  return source.startsWith(".") ? resolve(dirname(context.filename), source) : null;
}

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

// FR-014: measurement and lint share the AST oracle, including token-only colour mixes.
const uiPolicy = {
  rules: {
    debt: {
      meta: { type: "problem", schema: [] },
      create(context) {
        return {
          Program(node) {
            const labels = {
              scaleClasses: "raw Tailwind scale class",
              inlineStyles: "inline style attribute",
              colourLiterals: "hardcoded colour literal",
            };
            for (const finding of debtFindings(node, context.filename))
              context.report({
                node: finding.node,
                message: `FR-014: ${labels[finding.kind]} — use semantic tokens/shared components; narrowly justified token forwarding may use a per-line disable.`,
              });
          },
        };
      },
    },
    layers: {
      meta: { type: "problem", schema: [] },
      create(context) {
        const client = resolve(context.cwd, "src/client");
        const primitives = resolve(client, "components/ui");
        const inPrimitive = context.filename.startsWith(`${primitives}/`);
        function check(node) {
          const source = node.source?.value;
          if (typeof source !== "string") return;
          if (!inPrimitive && /^(?:@radix-ui\/|radix-ui(?:\/|$))/.test(source))
            context.report({
              node,
              message: "G2: Radix belongs in components/ui; use the shared primitive.",
            });
          if (!inPrimitive || !(source.startsWith(".") || source.startsWith("@/"))) return;
          const target = source.startsWith("@/")
            ? resolve(client, source.slice(2))
            : resolve(dirname(context.filename), source);
          if (
            !target.startsWith(`${primitives}/`) &&
            ![
              resolve(client, "lib/utils"),
              resolve(client, "lib/utils.ts"),
              resolve(client, "lib/recipes"),
              resolve(client, "lib/recipes.ts"),
            ].includes(target)
          )
            context.report({
              node,
              message:
                "G5: primitives are a leaf; import only lib utilities and sibling primitives.",
            });
        }
        return {
          ImportDeclaration: check,
          ExportNamedDeclaration: check,
          ExportAllDeclaration: check,
          ImportExpression: check,
        };
      },
    },
    "raw-controls": {
      meta: { type: "problem", schema: [] },
      create(context) {
        if (
          context.filename.includes("/components/ui/") ||
          /components\/(CheckboxField|RadioField)\.tsx$/.test(context.filename)
        )
          return {};
        function imported(node, name, module) {
          if (node?.type !== "Identifier") return false;
          let scope = context.sourceCode.getScope(node);
          while (scope) {
            const variable = scope.variables.find((v) => v.name === node.name);
            if (variable)
              return variable.defs.some(
                (def) =>
                  def.type === "ImportBinding" &&
                  def.node.imported?.name === name &&
                  clientImport(context, def.parent.source.value) ===
                    resolve(context.cwd, "src/client", module)
              );
            scope = scope.upper;
          }
          return false;
        }
        function usesRecipe(node, name) {
          if (!node) return false;
          if (imported(node, name, "lib/recipes")) return true;
          if (node.type === "CallExpression" && imported(node.callee, "cn", "lib/utils"))
            return node.arguments.some((arg) => usesRecipe(arg, name));
          if (node.type === "ConditionalExpression")
            return usesRecipe(node.consequent, name) && usesRecipe(node.alternate, name);
          if (node.type === "TemplateLiteral")
            return node.expressions.some((expression) => usesRecipe(expression, name));
          if (node.type === "BinaryExpression" && node.operator === "+")
            return usesRecipe(node.left, name) || usesRecipe(node.right, name);
          return false;
        }
        return {
          JSXOpeningElement(node) {
            const name = node.name.name;
            if (!["button", "input", "textarea", "select"].includes(name)) return;
            const type = node.attributes.find(
              (a) => a.type === "JSXAttribute" && a.name.name === "type"
            )?.value?.value;
            const classes = node.attributes.find(
              (a) => a.type === "JSXAttribute" && a.name.name === "className"
            );
            const recipe = classes?.value?.expression;
            if (name === "select" && usesRecipe(recipe, "NATIVE_SELECT_CLASSES")) return;
            if (
              name === "input" &&
              type === "checkbox" &&
              usesRecipe(recipe, "BARE_CHECKBOX_INPUT_CLASSES")
            )
              return;
            context.report({
              node,
              message:
                "G1: reuse Button/Input/Textarea or CheckboxField/RadioField. Native selects use NATIVE_SELECT_CLASSES; domain-only controls need an exact, justified per-line exception.",
            });
          },
        };
      },
    },
    sizing: {
      meta: { type: "problem", schema: [] },
      create(context) {
        if (context.filename.includes("/components/ui/")) return {};
        const controls = new Set();
        const namespaces = new Set();
        return {
          ImportDeclaration(node) {
            const target = clientImport(context, node.source.value);
            const client = resolve(context.cwd, "src/client");
            if (
              target &&
              (target.startsWith(`${client}/components/ui/`) ||
                [resolve(client, "ui"), resolve(client, "ui.ts")].includes(target))
            )
              for (const s of node.specifiers) {
                if (s.type === "ImportNamespaceSpecifier") namespaces.add(s.local.name);
                if (
                  ["Button", "Input", "Textarea", "SelectTrigger", "SelectItem"].includes(
                    s.imported?.name
                  )
                )
                  controls.add(s.local.name);
              }
          },
          JSXOpeningElement(node) {
            const member =
              node.name.type === "JSXMemberExpression" &&
              namespaces.has(node.name.object.name) &&
              ["Button", "Input", "Textarea", "SelectTrigger", "SelectItem"].includes(
                node.name.property.name
              );
            if (
              !controls.has(node.name.name) &&
              !member &&
              !["button", "input", "select", "textarea"].includes(node.name.name)
            )
              return;
            const attribute = node.attributes.find(
              (a) => a.type === "JSXAttribute" && a.name.name === "className"
            );
            if (!attribute) return;
            const text = context.sourceCode.getText(attribute);
            // Width/minimum growth and icon descendants are layout concerns; control height and
            // font overrides must be token-driven or explicitly reviewed at the exact call site.
            const candidates = text.match(/[^\s"'`]+/g) ?? [];
            const invalid = candidates.some((c) => {
              if (/\[&[_>+~]/.test(c)) return false;
              const property = c.match(
                /(?:^|:)!?\[(height|min-height|max-height|font-size):([^\]]+)\]!?$/
              );
              if (property) {
                const [, name, value] = property;
                const token = name === "font-size" ? "--control-font-size" : "--control-height";
                if (value === `var(${token})`) return false;
                const pixels = value.match(/^(\d+(?:\.\d+)?)px$/);
                return !(name === "min-height" && pixels && Number(pixels[1]) >= 48);
              }
              const minimum = c.match(/(?:^|:)!?min-h-(.*)/)?.[1];
              if (minimum && !/^\[var\(--control-height\)\](?:$|[}])/.test(minimum)) {
                const scale = minimum.match(/^(\d+(?:\.\d+)?)(?:$|[}])/);
                const pixels = minimum.match(/^\[(\d+(?:\.\d+)?)px\]/);
                if (!(scale && Number(scale[1]) >= 12) && !(pixels && Number(pixels[1]) >= 48))
                  return true;
              }
              return (
                /(?:^|:)!?(?:(?:h|max-h|size)-|text-(?:xs|sm|base|lg|xl|[2-9]xl|\[(?!color:|var\(--)))/.test(
                  c
                ) &&
                !/(?:^|:)(?:(?:h|size)-\[var\(--control-height\)\]|text-\[length:var\(--control-font-size\)\])(?:$|[}])/.test(
                  c
                )
              );
            });
            if (invalid)
              context.report({
                node: attribute,
                message:
                  "G3: primitive height/font override bypasses document density. Use a size/wrap variant or a justified per-line exception for a larger intentional layout.",
              });
          },
        };
      },
    },
  },
};

// Naming-convention recipe net: initializer shape cannot evade it. Renamed/inline class
// strings still require review; this is deliberately not a Tailwind expression evaluator.
const RECIPE_CONSTANT_SELECTOR = [
  {
    selector:
      "VariableDeclarator[id.name=/(_CLASSES|Classes)$/], Property[key.name=/(_CLASSES|Classes)$/], Property[key.value=/(_CLASSES|Classes)$/]",
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
  {
    plugins: {
      quality: {
        rules: {
          "justified-disable": {
            meta: { type: "problem", schema: [] },
            create(context) {
              return {
                Program() {
                  for (const comment of context.sourceCode.getAllComments()) {
                    const directive = comment.value
                      .trim()
                      .match(/^eslint-disable(?:-next-line|-line)?\b(.*)/s);
                    if (!directive) continue;
                    const [rules, reason] = directive[1].split(/\s+--\s+/);
                    if (!rules.trim() || !reason?.trim())
                      context.report({
                        loc: comment.loc,
                        message:
                          "Lint exceptions must name specific rules and explain why after --.",
                      });
                  }
                },
              };
            },
          },
        },
      },
    },
    rules: { "quality/justified-disable": "error" },
  },
  {
    files: ["src/client/**/*.{ts,tsx}"],
    plugins: { "ui-policy": uiPolicy },
    rules: {
      "ui-policy/debt": "error",
      "ui-policy/sizing": "error",
      "ui-policy/raw-controls": "error",
      "ui-policy/layers": "error",
    },
  },
  // Stale suppressions are errors, including when ESLint is invoked directly.
  {
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },
  {
    ignores: [
      "node_modules/",
      "dist/",
      "build/",
      ".specify/",
      ".opencode/",
      ".data/",
      ".data-fresh/",
      ".worktrees/",
      ".claude/",
      "coverage/",
      "playwright-report/",
      "test-results/",
      ".quality/",
      ".playwright-mcp/",
      ".e2e-data/",
    ],
  },

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

  // TypeScript rules own unused bindings; the core rule misreads type declarations.
  {
    files: ["**/*.ts", "**/*.tsx"],
    plugins: { "@typescript-eslint": tsEslint.plugin },
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
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["error", { args: "none" }],
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-ignore": true,
          "ts-nocheck": true,
          "ts-expect-error": "allow-with-description",
          minimumDescriptionLength: 10,
        },
      ],
    },
  },
  {
    files: [
      "src/**/*.{ts,tsx}",
      "tests/client/**/*.{ts,tsx}",
      "tests/boundary/**/*.ts",
      "tests/integration/**/*.ts",
      "tests/helpers/**/*.ts",
      "vitest.setup.ts",
    ],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.client.json", "./tsconfig.server.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
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
  // Keep logging, recipe and live-region selectors together: flat config replaces arrays.
  {
    files: ["src/client/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...INV05_NO_RESTRICTED_SYNTAX,
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
      "no-restricted-syntax": ["error", ...INV05_NO_RESTRICTED_SYNTAX, ...SC011_SELECTOR],
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
            "ui-policy/debt": "off",
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
