#!/usr/bin/env node
// audit-accessible-names.mjs — committed mechanical audit for SC-012's keyboard/AT criterion
// ("every control is reachable AND OPERABLE"), including the accessible-name requirement.
//
// WHY THIS EXISTS: An earlier census was a five-pass READ. All
// five passes made the same correlated mistake on the same defect class (a raw `<input>`/`<Input>`
// used for an inline edit affordance, with no `aria-label`, no associated `<label>`, no
// placeholder) — and found about 23 real offenders where the census reported 3. A
// human re-read is not the fix for a human-read miss; a machine that applies the SAME rule to
// EVERY candidate element, every time, is. This script is that machine. It is deliberately
// mechanical, not a re-creation of judgment: see "What this cannot see" below for the read it does
// NOT replace.
//
// SCOPE: every `src/client/* /*.tsx` file (product surfaces AND the shared `components/`
// primitives) — the earlier failure was partly trusting an unverified "the shared components already
// handle this" claim about files that don't even import the components in question. This script
// makes no such assumption: it inspects every candidate element wherever it appears.
//
// METHOD: parse each file with the TypeScript compiler (same tool as count-ui-debt.mjs — the
// real parser, not a regex heuristic, so JSX nesting/expressions are read correctly), walk every
// JSX element, and for each candidate INTERACTIVE control (native `<input>`/`<textarea>`/
// `<select>`/`<button>`, their common capitalized wrapper names, any element carrying an
// interactive ARIA `role`, or a call site of this repo's own `CheckboxField`/`RadioField`/
// `StatusToggle`/`WeekdayPicker`/`ConfirmDialog` L2 components — see `COMPOSED_COMPONENT_NAME_PROP`
// resolve whether it has an accessible name using a fixed precedence:
//
// 1. STRONG — `aria-label` (non-empty), `aria-labelledby`, the mapped name prop of a composed
// component call site (non-empty), an associated `<label htmlFor>` (same file,
// literal id match), an ancestor `<label>` wrapping the control, or — for
// button-like elements — non-empty visible text content.
// 2. WEAK — `placeholder` or `title` only. Per the HTML Accessible Name spec these DO
// contribute a computed name (browsers use them as a fallback), so a WEAK control
// is not reported as a hard offender by `--exact`/default exit code — but every WEAK
// control is listed separately, because whether "placeholder-only" clears this
// product's bar is a judgment call this script deliberately does NOT make silently
// (see the accessibility guidance's placeholder-threshold discussion). Pass `--strict-weak` to
// treat WEAK as a failure too.
// 3. NONE — no name signal found at all. Always a hard offender.
//
// Elements that are not exposed to assistive tech at all (`aria-hidden="true"`, `hidden`,
// `type="hidden"`, `disabled` is NOT this — a disabled control still needs a name for when it is
// re-enabled) are skipped entirely, not counted as passing or failing.
//
// WHAT THIS CANNOT SEE (be explicit, do not oversell a static pass):
// - Runtime-computed accessible names: an `aria-label={t("some.key")}` is treated as present
// (STRONG) without evaluating the translation catalogue — a key that resolves to an empty
// string at runtime would still read as accessible name FALSE HERE. Symmetric with count-ui-
// debt.mjs's own posture: this is a static, not a runtime, oracle.
// - Focus ORDER (DOM order vs. visual order) and focus TRAPS — a control can have a perfect name
// and still be unreachable in a sane order, or trap focus. Out of scope for this script by
// design; see the e2e companion spec for the runtime half.
// - AT ACTIVATION (PARTIALLY caught, structurally): a second, independent detector flags any
// interactive-role element that answers `onKeyDown`/`onKeyUp` but has NO `onClick` at all — a
// screen reader/switch-access tool activates via a synthetic click, so this is a silent no-op
// for every such tool even though the element is reachable and named. This IS how
// `AdminGate.tsx:126`'s hold-button was caught (`role="button"`, `onKeyDown`-only). What this
// canNOT see: an `onClick` that exists but is a no-op, wired to the wrong element, or an
// activation gap on a NATIVE element (`<button disabled onClick={...}>` guarded by a condition
// that never fires) — those need the runtime companion spec.
// - Spread props (`{...rest}`) that might carry an `aria-label` from a caller: if the JSX literal
// itself has no visible name attribute, this script reports the hit as `UNRESOLVED` (not a
// hard failure, not silently assumed clean either — S9's exact failure mode, inverted) rather
// than guessing either way.
// - Cross-file `id`/`htmlFor` pairing: label association is only resolved WITHIN the same file.
//
// Use `--json` for machine consumption, `--per-file` to group in text mode, `--strict-weak` to
// fail on WEAK too, `--exact <n>` for the CI-style hard-count assertion (mirrors
// count-ui-debt.mjs's own `--exact`), `--max <n>` for a growth-only baseline ceiling (still
// available, no longer the wired form — see below), and `--check-baseline <path>` /
// `--write-baseline <path>` for the per-row baseline LIST that IS actually WIRED into
// `check:standard` (`package.json`'s `check:accessible-names`; see the "Baseline list" section
// above `baselineRowsFromHits` and the accessibility guidance for the full rationale — a committed list of
// `file:line:tier` rows merges per-row across concurrent batches the way a single pinned integer
// cannot, and it also catches a fix-one/break-one swap a bare count is blind to).

import ts from "typescript";
import { readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const clientRoot = path.join(repoRoot, "src/client");

const TEST_LIKE_RE = /(\.test\.[jt]sx?$)|(\.spec\.[jt]sx?$)|(\/__tests__\/)/;

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (!/\.tsx$/.test(entry)) continue;
    const rel = path.relative(repoRoot, full).replace(/\\/g, "/");
    if (TEST_LIKE_RE.test(`/${rel}`)) continue;
    out.push(full);
  }
  return out;
}

export function listFiles() {
  return walk(clientRoot, []).sort();
}

// --- Candidate recognition --------------------------------------------------------------------

// Tag names treated as candidates regardless of role. Capitalized names are this repo's own
// `components/ui/*` pass-throughs (verified by reading: `Input`, `Button` render bare native
// elements with no name of their own — see this file header and
// the). `Textarea`/`Select` are included defensively even though this repo currently
// names its select wrapper `SelectTrigger` (below), in case a future file adds a differently named
// wrapper around a native element.
// NOTE: `Select` (the Radix `Root`) is deliberately EXCLUDED — it renders no DOM element of its
// own (`components/ui/select.tsx`: `<SelectPrimitive.Root>` is a non-visual context provider); the
// actual focusable, nameable widget is `SelectTrigger`. Scanning `Select` produced a false
// positive on every `<Select>` usage in this repo (verified: `MemberCreateForm.tsx`/
// `MembersManagement.tsx`) because the real name-bearing element (`SelectTrigger`, with its own
// `id`/children) was never inspected under that name.
const NATIVE_CANDIDATE_TAGS = new Set([
  "input",
  "Input",
  "textarea",
  "Textarea",
  "select",
  "SelectTrigger",
  "button",
  "Button",
]);

// role values that make ANY element (div, li, span, custom component) an interactive control
// requiring a computed accessible name, per WAI-ARIA.
const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "slider",
  "combobox",
  "textbox",
  "searchbox",
  "link",
]);

// input `type` values that are not focusable / not exposed as a nameable widget the same way —
// skip these entirely rather than mis-flag them.
const SKIP_INPUT_TYPES = new Set(["hidden"]);

// A lowercase host element (`div`, `li`, `span`,...) carrying an
// `onClick` handler but NO `role` attribute at all is not a "candidate with a missing name" — it
// is not exposed to assistive tech as a CONTROL in the first place (no role means the accessible-
// name concept never even applies), which is a STRICTLY WORSE defect than an unnamed-but-findable
// control. The original version of this script could not see this shape at all: none of
// `NATIVE_CANDIDATE_TAGS` or `INTERACTIVE_ROLES` matches a bare `<li onClick={...}>`. Verified real
// example: `CalendarView.tsx:628` — the `<li onClick={toggleMember}>` wrapping the checkbox this
// script already flags at `:644`; giving the checkbox alone an `aria-label` does NOT fix this
// element, and previously this script would report `--exact 0` as if it had. Reported through the
// SAME NONE/WEAK/STRONG tier machinery as every other candidate (see `visit` below) — an
// `aria-label` on the element itself is still a legitimate, if unusual, fix.
//
// Exemptions, deliberately narrow (native tags that already carry inherent interactive semantics
// and so are not this shape's failure mode — each is handled by its own path elsewhere in this
// script, or has browser-native keyboard/AT support this shape's defect does not apply to):
// - `input`/`textarea`/`select`/`button` (+ capitalized wrappers): already in
// `NATIVE_CANDIDATE_TAGS`, scanned unconditionally regardless of `onClick`/`role`.
// - `a`: a native link has its own accessible-name-from-content and keyboard-activation rules;
// out of scope for this specific "no semantics at all" shape.
// - `label`: associates, is not itself a control.
const SEMANTIC_GAP_EXEMPT_TAGS = new Set([
  "input",
  "Input",
  "textarea",
  "Textarea",
  "select",
  "SelectTrigger",
  "button",
  "Button",
  "a",
  "label",
  "Label",
]);

function isLowercaseHostTag(tagName) {
  return typeof tagName === "string" && /^[a-z]/.test(tagName);
}

// this repo's own L2 composed components
// (`components/CheckboxField.tsx`, `RadioField.tsx`, `StatusToggle.tsx`, `WeekdayPicker.tsx`,
// `ConfirmDialog.tsx`) are invisible to every detector above at their CALL SITES — none of them is
// a lowercase host tag (so the shape-1 no-role-clickable check never matches), none carries an
// interactive ARIA `role` on the JSX element itself, and none is in `NATIVE_CANDIDATE_TAGS` (adding
// them there would be WORSE: `NATIVE_CANDIDATE_TAGS` assumes zero built-in naming, so every call
// site — even a correctly-labelled one — would be reported unnamed unless it also carried a raw
// `aria-label` the component doesn't itself forward from a differently-named prop).
//
// Proven live: `CalendarView.tsx`'s two `CheckboxField` call sites (the "assign to" per-member row
// and the create form's "all day" toggle) vanished from the candidate population entirely once
// migrated off a bare `<input type="checkbox">` onto `<CheckboxField>` — the population dropped
// 251→248 while NONE dropped only 23→21, i.e. one of the two rows the census marked "FIXED" merely
// stopped being visible to this script, not fixed. A synthetic `<CheckboxField label="".../>` probe
// (genuinely unnamed) was added to `CalendarView.tsx` and left the audit unchanged — proof of the
// blind spot, not just an argument for it.
//
// FIX: model each component's CONTRACT — which single prop supplies its accessible name — instead
// of the tag list. `label` (CheckboxField/RadioField), `accessibleName` (StatusToggle, REQUIRED and
// state-invariant by its own file's doc comment — see `components/StatusToggle.tsx`), `groupLabel`
// (WeekdayPicker, the `role="group"`/`"radiogroup"` wrapper's own name) and `title` (ConfirmDialog —
// the dialog's own accessible name, from `DialogTitle`). Verified by reading each component's
// render: none of them forwards an unrelated `aria-label` onto the wrong element, so the mapped prop
// really is the ONLY path to a name for a plain call site.
const COMPOSED_COMPONENT_NAME_PROP = new Map([
  ["CheckboxField", "label"],
  ["RadioField", "label"],
  ["StatusToggle", "accessibleName"],
  ["WeekdayPicker", "groupLabel"],
  ["ConfirmDialog", "title"],
]);

// direction 1 (the `Field`/`useId` half): `components/Field.tsx` — the L2 label↔input↔error
// wiring component, the own worked example — generates the id that links its `<Label
// htmlFor>` to its wrapped control with `React.useId` * at runtime* . The static resolver cannot
// follow that: from the CALLER file's own AST there is no literal `id`/`htmlFor` pair to match (that
// wiring lives inside `Field.tsx`, invisible here), so a control adopting `Field` was scored NONE —
// measured making the audit WORSE (34 -> 42) when tried adopting it for eight inputs, exactly
// backwards for the component whose entire purpose is fixing this defect.
//
// FIX (same shape as the composed-component contract above, direction 2's own precedent): model
// `Field`'s CONTRACT — its `label` prop is unconditionally the accessible name of its single direct
// child (`Field.tsx`'s `React.cloneElement(children, {...})` only ever clones the immediate child it
// is given, per its own JSDoc: "children is the control being wrapped"). The runtime id VALUE is
// unknown to this static pass, but the WIRING is not in question — cloneElement's target is always
// the literal JSX child, so "is this candidate the direct JSX child of a `<Field label="...">`" is a
// same-file, static, decidable question, exactly like the composed-component prop lookup above.
const FIELD_WRAPPER_NAME_PROP = new Map([["Field", "label"]]);

// Guards both maps above against a same-named LOCAL component that has nothing to do with the
// shared one — real example: `admin/TimeAnnouncementsManagement.tsx` declares its OWN, unrelated,
// in-file `function WeekdayPicker(...)` (pre-migration; see `components/WeekdayPicker.tsx`'s own
// header, which lists that file as one of the six NOT YET migrated call sites) with no `groupLabel`
// prop at all. Matching purely on tag name would misreport every one of ITS call sites as a hard
// NONE — a worse false positive than the blind spot this fix closes. This repo's own convention
// names every `components/*.tsx` file after its sole export (verified: `CheckboxField.tsx` exports
// `CheckboxField`, etc.), so trusting the CANDIDATE only when the file's own `import` statement
// binds that exact name from a module whose last path segment matches it is a cheap, correct guard
// — cross-file import resolution the rest of this script deliberately does not attempt (see the file
// header's "what this cannot see"), but a same-file import declaration is not cross-file at all.
//
// Generalized (was `collectComposedImports`, composed-components-only) so the SAME same-file import
// guard covers `Field` too, rather than duplicating it — pass the canonical-name set to resolve
// against.
function collectImportedComponents(sourceFile, canonicalNames) {
  const map = new Map(); // local JSX tag name -> canonical component name
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const moduleSpecifier = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(moduleSpecifier)) continue;
    const segments = moduleSpecifier.text.split("/");
    const lastSegment = segments[segments.length - 1].replace(/\.(tsx|ts|jsx|js|mjs)$/, "");
    const clause = stmt.importClause;
    if (!clause || !clause.namedBindings) continue;
    // `import * as Fields from "./CheckboxField"` binds a MODULE, so the JSX tag is the
    // property access `Fields.CheckboxField`. Resolve it under the same one-file-per-component
    // convention the named-import branch uses, keyed by the full tag text so the call site below
    // needs no namespace-specific branch.
    if (ts.isNamespaceImport(clause.namedBindings)) {
      if (canonicalNames.has(lastSegment)) {
        map.set(`${clause.namedBindings.name.getText()}.${lastSegment}`, lastSegment);
      }
      continue;
    }
    if (!ts.isNamedImports(clause.namedBindings)) continue;
    for (const element of clause.namedBindings.elements) {
      if (element.isTypeOnly) continue;
      const localName = element.name.getText();
      const importedName = (element.propertyName ?? element.name).getText();
      if (importedName === lastSegment && canonicalNames.has(importedName)) {
        map.set(localName, importedName);
      }
    }
  }
  return map;
}

const COMPONENT_WRAPPER_CALLEES = new Set(["memo", "forwardRef", "observer"]);

// A BARE tag whose name is DECLARED in this file is not the imported canonical component — those
// two bindings cannot coexist. The restriction to bare tags is load-bearing and the reason the call
// site (`isAmbiguousComposedName`) gates on `tagName.includes(".")`: a PROPERTY-ACCESS tag names a
// property of a namespace, which a same-file declaration neither shadows nor conflicts with, so
// there the premise is simply false. This is the `TimeAnnouncementsManagement.tsx` shape the import guard
// above exists to protect: its own `function WeekdayPicker(...)` is an unrelated local component,
// and the script can no more see inside it than inside any other unknown tag. Knowing that lets
// the ambiguity tier below stay reserved for the case it was actually built for — "this MIGHT be
// the real component reached through an import shape I cannot follow" — instead of firing on every
// same-named local, which is the one case we can positively rule out.
function collectLocallyDeclaredNames(sourceFile) {
  const names = new Set();
  function walk(node) {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      names.add(node.name.getText());
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      // Only a declaration that DEFINES a component rules the canonical one out. A variable whose
      // initializer is a bare identifier or property access (`const CheckboxField = Thing;`) is an
      // ALIAS — the third fail-open shape — and the thing it aliases may well BE the canonical
      // component, so it must stay ambiguous rather than be ruled out by its own indirection.
      const init = node.initializer;
      // A call-expression initializer counts as a DEFINITION only for the wrappers that take a
      // component body and hand back the same component. `lazy( => import("../components/X"))`
      // is the opposite: it REACHES the canonical component through a module path, so treating it
      // as a local definition would make a real call site invisible instead of unresolvable
      // Anything not on this list stays an alias.
      const isWrapperCall =
        init &&
        ts.isCallExpression(init) &&
        COMPONENT_WRAPPER_CALLEES.has(trailingTagIdentifier(init.expression.getText()));
      const isDefinition =
        init &&
        (ts.isArrowFunction(init) ||
          ts.isFunctionExpression(init) ||
          ts.isClassExpression(init) ||
          isWrapperCall);
      if (isDefinition) names.add(node.name.getText());
    }
    node.forEachChild(walk);
  }
  walk(sourceFile);
  return names;
}

// direction 1's "known latent residual": three import shapes fail OPEN today — an
// extension-bearing specifier (`"./CheckboxField.tsx"`, whose last path segment is
// `"CheckboxField.tsx"` and so never string-equals the imported name), a namespace import
// (`import * as Fields from "..."`, which has no `NamedImports` clause at all), and a local const
// indirection (`const X = CheckboxField;`, not an import declaration `collectImportedComponents`
// looks at in the first place). None of these resolves via the guard above, so today the element is
// simply invisible — not reported NONE, not reported at all, the exact "control vanishes and that
// reads as progress" failure mode direction 2 already fixed for the tag-list gap. None of the three
// occurs in this repo's tree today (verified: every real `CheckboxField`/`RadioField`/`StatusToggle`/
// `WeekdayPicker`/`ConfirmDialog` call site uses a plain same-file named import), but a future batch
// could introduce any of them without this script ever noticing the regression.
//
// FIX: when a JSX tag's own trailing identifier segment (after any `Namespace.` prefix a
// `Fields.CheckboxField`-style property-access tag would carry) textually matches one of the
// canonical composed-component names but `collectImportedComponents` did NOT resolve it to that
// canonical name via a normal same-file named import, this script can no longer tell whether it is
// (a) the real component reached through one of the three fail-open shapes above, or (b) a genuinely
// unrelated local component that merely happens to share the name (the exact
// `TimeAnnouncementsManagement.tsx` `WeekdayPicker` shape the guard above exists to protect).
// Reporting it as a hard NONE would risk a false positive on (b); silently skipping it (the status
// quo) risks a false negative on (a). `UNRESOLVED` is the tier built for exactly this "this script
// cannot tell" honesty (see the `spread-props` case), so this ambiguous shape is folded into it: the
// element becomes a LISTED, visible candidate — not counted as a failure, but never an invisible
// skip either.
function trailingTagIdentifier(tagName) {
  if (!tagName) return null;
  const segments = tagName.split(".");
  return segments[segments.length - 1];
}

function getTagName(node) {
  const tagNameNode = ts.isJsxElement(node)
    ? node.openingElement.tagName
    : ts.isJsxSelfClosingElement(node)
      ? node.tagName
      : null;
  if (!tagNameNode) return null;
  return tagNameNode.getText();
}

function getOpeningElement(node) {
  return ts.isJsxElement(node) ? node.openingElement : node;
}

function getAttr(openingElement, name) {
  for (const attr of openingElement.attributes.properties) {
    if (ts.isJsxAttribute(attr) && attr.name.getText() === name) return attr;
  }
  return null;
}

function attrIsNonEmpty(attr) {
  if (!attr) return false;
  if (!attr.initializer) return true; // bare boolean attribute, e.g. `disabled`
  if (ts.isStringLiteral(attr.initializer)) return attr.initializer.text.trim().length > 0;
  if (ts.isJsxExpression(attr.initializer)) {
    const expr = attr.initializer.expression;
    if (!expr) return false;
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
      return expr.text.trim().length > 0;
    }
    // Any other expression (a translation call, a variable, a ternary): assume present. This is
    // the documented static-oracle limitation (see file header) — conservative in the
    // "name exists" direction so the audit does not need a translation catalogue to run, but
    // recorded, not silently assumed clean, via the header note.
    return true;
  }
  return false;
}

function attrLiteralString(attr) {
  if (!attr || !attr.initializer) return null;
  if (ts.isStringLiteral(attr.initializer)) return attr.initializer.text;
  if (ts.isJsxExpression(attr.initializer) && attr.initializer.expression) {
    const expr = attr.initializer.expression;
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  }
  return null;
}

function hasSpreadProps(openingElement) {
  return openingElement.attributes.properties.some((p) => ts.isJsxSpreadAttribute(p));
}

// Ancestor <label> check: walk up `.parent` (requires setParentNodes) looking for a JsxElement
// whose opening tag is literally `label` OR this repo's `Label` wrapper (`components/ui/label.tsx`
// renders `<LabelPrimitive.Root>`, which IS a real `<label>` — verified by reading the file). A
// control nested inside either provides IMPLICIT label association per the HTML spec (no
// `htmlFor`/`id` pair required) — missing this recognition was a real false-positive source: e.g.
// `DailyBriefingManagement.tsx`'s `<Label>{t(...)}<Input.../></Label>` pattern.
const LABEL_TAGS = new Set(["label", "Label"]);
function isInsideLabel(node) {
  let current = node.parent;
  while (current) {
    if (ts.isJsxElement(current) && LABEL_TAGS.has(current.openingElement.tagName.getText())) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

// `Field` ancestor-wrap check — the runtime-`useId` counterpart of
// `isInsideLabel` above. Deliberately checks ONLY the DIRECT parent, not the full ancestor chain
// `isInsideLabel` walks: `Field.tsx`'s `React.cloneElement(children, {...})` clones exactly the one
// JSX element it is given as `children` — a control nested a level deeper than that would not
// actually receive `Field`'s `id`/`aria-describedby` wiring at runtime, so granting it credit here
// would assert a link `Field` itself does not create. Returns the `label` attribute of the
// immediately-enclosing `<Field>` opening element (import-guarded via `fieldImports`, same guard as
// `collectImportedComponents`), or `null` if this node is not `Field`'s direct child.
function getFieldWrapLabelAttr(node, fieldImports) {
  const parent = node.parent;
  if (!parent || !ts.isJsxElement(parent)) return null;
  const parentTagName = parent.openingElement.tagName.getText();
  if (fieldImports.get(parentTagName) !== "Field") return null;
  return getAttr(parent.openingElement, "label");
}

// Visible-text-content check for button-like elements. Deliberately walks ONLY the element's own
// `.children` (JsxText / JsxExpression / nested JsxElement's own children) — NOT attributes of
// nested elements, so an icon-only child (`<XIcon className="..."/>`) is correctly seen as
// contributing no text even though its `className` is itself a JsxExpression. A direct JsxText
// with non-whitespace, or a JsxExpression that is not a provably-empty string/template literal
// (an identifier, a call like `t("save")`, a ternary, member access), counts as a name source —
// conservative "assume present" posture, deliberately, so a real name passed through a variable
// (e.g. `ConfirmDialog`'s `{cancelLabel}` prop) is not misread as absent.
function childrenHaveText(children) {
  for (const child of children) {
    if (ts.isJsxText(child)) {
      if (child.getText().trim().length > 0) return true;
      continue;
    }
    if (ts.isJsxExpression(child)) {
      const expr = child.expression;
      if (!expr) continue;
      if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
        if (expr.text.trim().length > 0) return true;
        continue;
      }
      return true; // any other expression: assume it renders text (documented limitation)
    }
    if (ts.isJsxElement(child) && childrenHaveText(child.children)) return true;
    if (ts.isJsxFragment(child) && childrenHaveText(child.children)) return true;
  }
  return false;
}

// CORRECTED BY THE RUNTIME ORACLE (tests/e2e/accessible-names-audit.spec.ts): an earlier version
// of this function granted `SelectTrigger` a STRONG name whenever it wrapped a `SelectValue`, on
// the theory that Radix always renders SOME visible text (the placeholder or the selected item's
// label) inside it. That theory is TRUE about visible text but FALSE about accessible NAME —
// verified by dumping the real Chromium accessibility tree against `MemberCreateForm.tsx`'s
// birthdate month/day selects: both show visible placeholder text ("Mes"/"Día") captured under
// the node's `text` property, but their computed `name` is EMPTY. This is correct per the ARIA
// "Name From: Contents" table — `combobox` is NOT a name-from-content role (unlike `button`,
// which IS, and legitimately keeps the content-text credit below) — so a `SelectTrigger` needs
// the SAME explicit mechanism as a native `<select>`: `aria-label`, `aria-labelledby`, or a
// `<label htmlFor>`/ancestor-`<label>` association. Content text is never sufficient. This false
// STRONG verdict is exactly why both the static script and the e2e companion exist — a heuristic
// that LOOKS reasonable from reading JSX can still be wrong, and only the browser's own
// accessibility tree settles it.
function hasVisibleTextContent(node) {
  if (!ts.isJsxElement(node)) return false; // self-closing has no children
  return childrenHaveText(node.children);
}

function findLabelForInFile(sourceText, id) {
  if (!id) return false;
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`htmlFor=(["'\`])${escaped}\\1`);
  return re.test(sourceText);
}

// --- Core audit --------------------------------------------------------------------------------

// Pure core: takes source text directly (no fs), so it is unit-testable with synthetic fixtures
// (same split as count-ui-debt.mjs's countSource/countFile).
export function auditSource(rel, src) {
  const sourceFile = ts.createSourceFile(
    rel,
    src,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX
  );

  const hits = [];
  const activationGaps = [];
  const composedImports = collectImportedComponents(
    sourceFile,
    new Set(COMPOSED_COMPONENT_NAME_PROP.keys())
  );
  const fieldImports = collectImportedComponents(
    sourceFile,
    new Set(FIELD_WRAPPER_NAME_PROP.keys())
  );
  const locallyDeclared = collectLocallyDeclaredNames(sourceFile);

  function visit(node) {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tagName = getTagName(node);
      const opening = getOpeningElement(node);
      const roleAttr = getAttr(opening, "role");
      const role = attrLiteralString(roleAttr);

      // SECOND, INDEPENDENT check: SC-012 requires "reachable AND OPERABLE", not just named.
      // `role="button"` (or any interactive ARIA widget role) tells assistive tech "activate me
      // with a synthetic click" — that is the contract every screen reader/switch-access tool
      // relies on. An element that answers keyboard input only via `onKeyDown`/`onKeyUp` and
      // ships NO `onClick` at all is invisible to that activation path even though it is reachable
      // and named (real example: `AdminGate.tsx:126`, verified by reading). This is orthogonal to
      // the name check above, so it is collected separately, not mixed into NONE/WEAK/STRONG.
      //
      // The inverse gap: the original detector only caught
      // "keyboard-only, no click" — it said nothing about "click-only, no keyboard", which is the
      // more classic WCAG 2.1.1 operability defect (a custom `role="button"` widget a mouse user
      // can activate but a keyboard-only user cannot Tab-and-Enter through). Native interactive
      // tags are exempt (`button`/`input`/`select`/`option`/`textarea`/`a`, mirroring
      // `SEMANTIC_GAP_EXEMPT_TAGS` minus `label`) because the BROWSER supplies Enter/Space
      // activation for those regardless of whether an `onKeyDown` handler is present — flagging
      // them here would be a false positive, not a real gap.
      if (role && INTERACTIVE_ROLES.has(role)) {
        const hasOnClick = Boolean(getAttr(opening, "onClick"));
        const hasOnKeyDown = Boolean(getAttr(opening, "onKeyDown") || getAttr(opening, "onKeyUp"));
        const isNativeInteractiveTag =
          tagName &&
          SEMANTIC_GAP_EXEMPT_TAGS.has(tagName) &&
          tagName !== "label" &&
          tagName !== "Label";
        if (hasOnKeyDown && !hasOnClick) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          activationGaps.push({
            file: rel,
            line: line + 1,
            tag: tagName ?? `[role=${role}]`,
            role,
            kind: "no-click", // reachable via a real click/AT-activation cannot fire (no onClick)
            snippet: opening.getText(sourceFile).replace(/\s+/g, " ").slice(0, 160),
          });
        } else if (hasOnClick && !hasOnKeyDown && !isNativeInteractiveTag) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          activationGaps.push({
            file: rel,
            line: line + 1,
            tag: tagName ?? `[role=${role}]`,
            role,
            kind: "no-keyboard", // reachable by mouse only — Tab+Enter/Space cannot activate it
            snippet: opening.getText(sourceFile).replace(/\s+/g, " ").slice(0, 160),
          });
        }
      }

      // THIRD, INDEPENDENT check: (the shape-1 gap). A lowercase
      // host element (`div`, `li`, `span`,...) wired to `onClick` but carrying NO `role` at all is
      // not exposed to assistive tech as a control in the first place — worse than an unnamed
      // candidate, and invisible to both checks above (no native tag match, no role to match
      // `INTERACTIVE_ROLES`). Real example: `CalendarView.tsx:628`, the `<li onClick={...}>`
      // wrapping the checkbox this script already flagged at `:644` — an `aria-label` added to the
      // checkbox ALONE does not fix this element. Folded into the SAME candidate population below
      // (not a separate bucket) so it gets the same NONE/WEAK/STRONG tiering as everything else.
      const isSemanticGapCandidate =
        isLowercaseHostTag(tagName) &&
        !SEMANTIC_GAP_EXEMPT_TAGS.has(tagName) &&
        !role &&
        Boolean(getAttr(opening, "onClick"));

      const isNativeCandidate = tagName && NATIVE_CANDIDATE_TAGS.has(tagName);
      const isRoleCandidate = role && INTERACTIVE_ROLES.has(role);

      // FOURTH, INDEPENDENT check: a call site of one of this repo's
      // own L2 composed components — see `COMPOSED_COMPONENT_NAME_PROP`/`collectImportedComponents`
      // above for the full rationale and the real blind-drop this closes.
      const composedCanonicalName = tagName ? composedImports.get(tagName) : undefined;
      const composedNameProp = composedCanonicalName
        ? COMPOSED_COMPONENT_NAME_PROP.get(composedCanonicalName)
        : null;
      const isComposedCandidate = Boolean(composedNameProp);

      // direction 1's residual fail-open fix — see `trailingTagIdentifier`'s header comment.
      // Only relevant when the normal (resolved) composed-candidate path above did NOT already
      // classify this tag.
      const isAmbiguousComposedName =
        !isComposedCandidate &&
        Boolean(
          trailingTagIdentifier(tagName) &&
          COMPOSED_COMPONENT_NAME_PROP.has(trailingTagIdentifier(tagName)) &&
          //...and, for a BARE tag only, this file does not declare that name itself. See
          // `collectLocallyDeclaredNames`: a local declaration positively rules the canonical
          // component OUT, so `<WeekdayPicker>` beside a local `function WeekdayPicker` is an
          // ordinary unknown tag, not an unresolvable one.
          //
          // The exclusion must NOT extend to a property-access tag, because its premise — the two
          // bindings cannot coexist — is false there: `<UI.ConfirmDialog>` names a property of the
          // `UI` namespace, which a module-scope `function ConfirmDialog` in the same file
          // neither shadows nor conflicts with. Applying it anyway let an unrelated local silence
          // a barrel-reached canonical call site, turning the gate green over exactly the offender
          // this rule is designed to catch.
          (tagName.includes(".") || !locallyDeclared.has(trailingTagIdentifier(tagName)))
        );

      if (
        isNativeCandidate ||
        isRoleCandidate ||
        isSemanticGapCandidate ||
        isComposedCandidate ||
        isAmbiguousComposedName
      ) {
        const hiddenAttr = getAttr(opening, "hidden");
        const ariaHiddenAttr = getAttr(opening, "aria-hidden");
        const typeAttr = getAttr(opening, "type");
        const typeValue = attrLiteralString(typeAttr);

        const isHidden =
          attrIsNonEmpty(hiddenAttr) ||
          attrLiteralString(ariaHiddenAttr) === "true" ||
          (typeValue && SKIP_INPUT_TYPES.has(typeValue));

        if (!isHidden) {
          const ariaLabelAttr = getAttr(opening, "aria-label");
          const ariaLabelledByAttr = getAttr(opening, "aria-labelledby");
          const placeholderAttr = getAttr(opening, "placeholder");
          const titleAttr = getAttr(opening, "title");
          const idAttr = getAttr(opening, "id");
          const idLiteral = attrLiteralString(idAttr);

          const hasAriaLabel = attrIsNonEmpty(ariaLabelAttr);
          const hasAriaLabelledBy = attrIsNonEmpty(ariaLabelledByAttr);
          const composedNameAttr = composedNameProp ? getAttr(opening, composedNameProp) : null;
          const hasComposedName = composedNameProp ? attrIsNonEmpty(composedNameAttr) : false;
          const fieldLabelAttr = getFieldWrapLabelAttr(node, fieldImports);
          const hasFieldWrap = attrIsNonEmpty(fieldLabelAttr);
          const hasLabelFor = idLiteral ? findLabelForInFile(src, idLiteral) : false;
          const hasLabelWrap = isInsideLabel(node);
          const hasPlaceholder = attrIsNonEmpty(placeholderAttr);
          const hasTitle = attrIsNonEmpty(titleAttr);
          // Name-from-content is granted ONLY for roles the ARIA "Name From: Contents" table
          // actually lists as such (`button` — native and `role="button"`). `SelectTrigger`/
          // `combobox` are deliberately EXCLUDED — see the header comment on
          // `hasVisibleTextContent` for the real-browser evidence that disproved the earlier,
          // broader version of this condition.
          const hasVisibleText =
            (tagName === "button" || tagName === "Button" || role === "button") &&
            hasVisibleTextContent(node);

          let tier;
          let via;
          if (hasAriaLabel) {
            tier = "STRONG";
            via = "aria-label";
          } else if (hasAriaLabelledBy) {
            tier = "STRONG";
            via = "aria-labelledby";
          } else if (hasComposedName) {
            tier = "STRONG";
            via = `prop:${composedNameProp}`;
          } else if (hasFieldWrap) {
            tier = "STRONG";
            via = "field:label";
          } else if (hasLabelFor) {
            tier = "STRONG";
            via = "label[for]";
          } else if (hasLabelWrap) {
            tier = "STRONG";
            via = "label-wrap";
          } else if (hasVisibleText) {
            tier = "STRONG";
            via = "visible-text";
          } else if (hasPlaceholder) {
            tier = "WEAK";
            via = "placeholder";
          } else if (hasTitle) {
            tier = "WEAK";
            via = "title";
          } else if (hasSpreadProps(opening)) {
            // No literal name signal found on THIS element, but it forwards a spread of props it
            // did not declare — the caller of this element (or, for a `components/ui/*` primitive
            // definition, the caller of the wrapping component) could supply `aria-label` etc. at
            // that call site. Reporting this as a hard NONE would double-count a primitive
            // definition (e.g. `components/ui/input.tsx`'s own `<input {...props}/>`) alongside
            // every real call site that already gets its own, independently-resolved hit. Kept
            // OUT of the failing count by default; listed separately so it is never silently
            // assumed clean either (S9's exact failure mode, inverted).
            tier = "UNRESOLVED";
            via = "spread-props";
          } else if (isAmbiguousComposedName) {
            // See `trailingTagIdentifier`'s header comment: this tag's name matches a canonical
            // composed component but the same-file import guard could not confirm it (one of the
            // three fail-open shapes, or a genuinely unrelated same-named local component) — honest
            // "cannot tell," not a silent skip and not a confident NONE.
            tier = "UNRESOLVED";
            via = "unresolved-import";
          } else {
            tier = "NONE";
            via = null;
          }

          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          hits.push({
            file: rel,
            line: line + 1,
            tag: tagName ?? `[role=${role}]`,
            role: role ?? null,
            tier,
            via,
            snippet: opening.getText(sourceFile).replace(/\s+/g, " ").slice(0, 160),
          });
        }
      }
    }
    node.forEachChild(visit);
  }

  visit(sourceFile);
  return { hits, activationGaps };
}

export function auditFile(file) {
  const rel = path.relative(repoRoot, file).replace(/\\/g, "/");
  const src = readFileSync(file, "utf8");
  return auditSource(rel, src);
}

// --- Baseline list --------------------------------------------------------------------
//
// REPLACES the single pinned integer this script used to be gated on (a `--max <n>` ceiling
// mirrored by a hardcoded real-tree assertion in `tools/audit-accessible-names.test.mjs` and
// `the project guidance` S9's prose). with ten migration steps remaining and MOST of them
// touching one of these files, a single shared integer is a HIGHER-CONTENTION conflict point than
// `eslint.config.mjs`'s own per-file exception list — two changes fixing offenders in DIFFERENT
// files both have to edit the SAME line of the SAME number, so whichever merges second conflicts,
// every time. A per-row list does not have this problem: two changes removing rows for two
// different files touch different lines of this file, so git merges them like any other
// non-overlapping edit — same shape as the exception list already points to as the
// better-behaved precedent.
//
// It also closes a hole the integer literally cannot see (demonstrated in the fixture test below):
// fixing one real offender while a DIFFERENT new one is introduced elsewhere leaves the TOTAL
// unchanged, so `--exact`/`--max` — both count-only — see nothing to reject. A row-level SET
// comparison catches it immediately: the new offender's row is not in the baseline, regardless of
// what happened to the total.
//
// Format: one `file:line:tier` row per line (TIER is always `NONE` or `WEAK` — the same population
// `--strict-weak` already treats as failing; `UNRESOLVED`/`STRONG` are never baselined), sorted,
// blank lines and `#`-comment lines ignored on read. Deliberately flat, not JSON — one row per
// physical line is what makes this mergeable in the first place; a pretty-printed JSON array with
// trailing commas would still create a spurious conflict on the line adjacent to two unrelated
// row removals.
export function baselineRowsFromHits(hits) {
  return hits
    .filter((h) => h.tier === "NONE" || h.tier === "WEAK")
    .map((h) => `${h.file}:${h.line}:${h.tier}`)
    .sort();
}

export function formatBaselineFile(rows) {
  const header =
    "# audit-accessible-names baseline (#778) — one `file:line:tier` row per currently-known NONE\n" +
    "# or WEAK offender, machine-generated and hand-editable. Regenerate with:\n" +
    "#   node tools/dev/audit-accessible-names.mjs --write-baseline tools/dev/accessible-names-baseline.txt\n" +
    "# A batch that fixes an offender removes its row here, in the SAME PR as the fix — do this\n" +
    "# instead of hand-deleting the line so the row text always matches what the script itself\n" +
    "# produces. A row appearing here that the live audit no longer produces (STALE) or a live-audit\n" +
    "# row missing from here (a NEW, unbaselined offender) both fail `--check-baseline` — see #778,\n" +
    "# #774, and quickstart.md S9 for the full rationale. Do not silently re-sort or hand-format this\n" +
    "# file; regenerate it.\n";
  return header + rows.map((r) => `${r}\n`).join("");
}

export function parseBaselineFile(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

// Row identity is `file:line:tier`, which is NOT unique: two candidates can begin on the same
// source line at the same tier (`<Field><input/><input/></Field>` on one line). Comparing the two
// sides as SETS would silently collapse those to one row, so adding a second offender to a line
// that already holds a baselined one would leave the compared value unchanged and PASS — losing
// exactly the growth-detection property the old count ceiling had. Comparing MULTISETS keeps it:
// a row present twice must be listed twice. This needs no baseline-format change, because
// `baselineRowsFromHits` already emits one row per candidate rather than deduplicating.
export function diffRowMultisets(currentRows, baselineRows) {
  const tally = (rows) => {
    const counts = new Map();
    for (const r of rows) counts.set(r, (counts.get(r) ?? 0) + 1);
    return counts;
  };
  const current = tally(currentRows);
  const baseline = tally(baselineRows);
  const excess = (a, b) => {
    const out = [];
    for (const [row, count] of a) {
      for (let i = 0; i < count - (b.get(row) ?? 0); i += 1) out.push(row);
    }
    return out.sort();
  };
  return { added: excess(current, baseline), stale: excess(baseline, current) };
}

// --- Per-file NET tier delta (fix on) ----------------------------------------
//
// WHY THIS EXISTS: `--check-baseline`'s row identity is `file:line:tier` (see the header comment
// above `baselineRowsFromHits`), so ANY edit above an open row in the same file — even one totally
// unrelated to accessible names, e.g. a single blank line added at the top of the file — shifts
// every later row's line number. That reads as "N stale rows gone, N new rows appeared," which is
// 100% noise: measured, a single leading blank line in `MealsManagement.tsx` produces 26 diff rows
// with ZERO real regressions, and a REALISTIC one-line fix (adding an `aria-label` partway through
// the file) produces 21 diff rows for ONE meaningful change — the other 20 are the same file's
// later rows shifting down by one line. At the change cadence this repo runs (ten migration
// batches, most touching these same nine files), that noise-to-signal ratio makes the failure
// output unreadable exactly when it matters most.
//
// FIX: alongside the row-level added/stale diff (unchanged — it is still the actual pass/fail
// oracle), compute a per-file NET tier count comparison. A pure line-shift leaves a file's NONE/WEAK
// COUNTS unchanged (the same offenders, just renumbered) — a `0` delta. A real regression or fix
// changes the count. This does not replace the row diff (a fix-one/break-one swap WITHIN the same
// file, same tier, would still net a zero per-file delta and needs the row-level view to catch),
// it is a second, coarser signal that lets a human's eye find the one file that matters among many
// that only shifted.
export function fileTierCounts(rows) {
  const counts = new Map(); // file -> { NONE: number, WEAK: number }
  for (const row of rows) {
    const tierSep = row.lastIndexOf(":");
    const tier = row.slice(tierSep + 1);
    const lineSep = row.lastIndexOf(":", tierSep - 1);
    const file = row.slice(0, lineSep);
    if (!counts.has(file)) counts.set(file, { NONE: 0, WEAK: 0 });
    const entry = counts.get(file);
    if (tier === "NONE" || tier === "WEAK") entry[tier] += 1;
  }
  return counts;
}

function formatCountDelta(before, after) {
  const delta = after - before;
  if (delta === 0) return `${before}→${after}`;
  const sign = delta > 0 ? `+${delta}` : `${delta}`;
  return `${before}→${after} (${sign})`;
}

// Returns one formatted line per affected file (files that own at least one added or stale row),
// sorted, plus whether any file's NET delta is positive in either tier (a real, not line-shift-
// only, regression) — the caller uses that to decide whether the "just regenerate" advice is safe
// to print (see `main` below).
export function formatFileTierDeltas(currentRows, baselineRows, added, stale) {
  const affectedFiles = new Set();
  for (const row of [...added, ...stale]) {
    const tierSep = row.lastIndexOf(":");
    const lineSep = row.lastIndexOf(":", tierSep - 1);
    affectedFiles.add(row.slice(0, lineSep));
  }
  const currentCounts = fileTierCounts(currentRows);
  const baselineCounts = fileTierCounts(baselineRows);
  const emptyCounts = { NONE: 0, WEAK: 0 };
  // A file with BOTH an added and a stale row at the SAME tier nets a zero delta, so it is
  // indistinguishable from a pure line shift — see the churn branch in the CLI for why that
  // matters more than it looks.
  const tierOf = (row) => row.slice(row.lastIndexOf(":") + 1);
  const fileOf = (row) => {
    const tierSep = row.lastIndexOf(":");
    return row.slice(0, row.lastIndexOf(":", tierSep - 1));
  };
  const addedKeys = new Set(added.map((r) => `${fileOf(r)}\u0000${tierOf(r)}`));
  const hasSameTierChurn = stale.some((r) => addedKeys.has(`${fileOf(r)}\u0000${tierOf(r)}`));

  let hasNetIncrease = false;
  const lines = [...affectedFiles].sort().map((file) => {
    const before = baselineCounts.get(file) ?? emptyCounts;
    const after = currentCounts.get(file) ?? emptyCounts;
    if (after.NONE > before.NONE || after.WEAK > before.WEAK) hasNetIncrease = true;
    return `  ${file}: NONE ${formatCountDelta(before.NONE, after.NONE)}, WEAK ${formatCountDelta(before.WEAK, after.WEAK)}`;
  });
  return { lines, hasNetIncrease, hasSameTierChurn };
}

// --- CLI -----------------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const perFile = args.includes("--per-file");
  const strictWeak = args.includes("--strict-weak");
  const exactIdx = args.indexOf("--exact");
  const exact = exactIdx !== -1 ? Number(args[exactIdx + 1]) : null;
  // The bare invocation (no flags) fails on any `failing > 0`,
  // which cannot simply be appended to `check:standard` while 23 known, owned offenders (36 under
  // `--strict-weak`, see below) are still open across in-flight migration steps
  // — every change would fail on day one.
  // `--exact <n>` (above) already exists but requires bumping the exact number on every legitimate
  // per-change fix, which is friction this ratchet doesn't need while offenders can only DECREASE.
  // `--max <n>` mirrors `tools/dev/count-ui-debt.mjs`'s own baseline posture (BASELINES there: fail
  // only if a count EXCEEDS the recorded ceiling, not on any deviation) — a count-only ceiling, so
  // it reds only on a NEW offender (a regression), never on an already-known one still awaiting its
  // change that owns it. SUPERSEDED as the form wired into `check:standard` by `--check-baseline`,
  // below) — a bare count cannot see a fix-one/break-one swap (fixing offender A while introducing
  // a different offender B nets the same total), and a single shared integer conflicts on every
  // concurrent updates the way a per-row list does not. `--max` stays available, unchanged, for anyone
  // who wants a quick manual ceiling check. `--exact` stays available for exact-count checks.
  // final "must be exactly zero" close-out assertion (the accessibility guidance).
  const maxIdx = args.indexOf("--max");
  const max = maxIdx !== -1 ? Number(args[maxIdx + 1]) : null;
  // `--check-baseline <path>` / `--write-baseline <path>`: the row-list ratchet that
  // REPLACES `--max` as the form wired into `check:standard` (see package.json). See the
  // "Baseline list" section above `baselineRowsFromHits` for the full rationale.
  const checkBaselineIdx = args.indexOf("--check-baseline");
  const checkBaselinePath = checkBaselineIdx !== -1 ? args[checkBaselineIdx + 1] : null;
  const writeBaselineIdx = args.indexOf("--write-baseline");
  const writeBaselinePath = writeBaselineIdx !== -1 ? args[writeBaselineIdx + 1] : null;

  // Baseline writing is handled after validation; `main` runs the write block
  // BEFORE the check block, so `--check-baseline X --write-baseline Y` silently wrote Y and exited
  // 0 without ever running the comparison X asked for — a stray `--write-baseline` anywhere in a
  // `package.json` script line would neuter the gate while still printing success. Both flags
  // together are never a legitimate invocation (one asks "tell me if this matches," the other says
  // "make it match unconditionally") — refuse instead of silently picking one.
  if (writeBaselinePath && checkBaselinePath) {
    console.error(
      "audit-accessible-names: FAIL — both --write-baseline and --check-baseline were passed. " +
        "This is never a valid combination (write-baseline would win silently and the check would " +
        "never run). Pass exactly one."
    );
    process.exit(1);
  }

  // `--files <path...>` scopes the audit to an explicit list instead of the whole client tree.
  // Two uses: a migration step auditing only the files it touches, and this script's own fixture
  // test proving the `unresolved-import` rejection below end to end — a gate never seen to reject
  // is unproven, and the alternative (writing a fixture into `src/client` so the tree walk finds
  // it) leaves a real source file behind if the test crashes.
  // Take-while, not filter: `--files a.tsx --exact 3` must stop at `--exact` and leave `3` to it.
  // Filtering out only the `--`-prefixed tokens kept their VALUES, so the next flag's argument was
  // silently audited as a source path.
  const filesIdx = args.indexOf("--files");
  let explicitFiles = null;
  if (filesIdx !== -1) {
    explicitFiles = [];
    for (const a of args.slice(filesIdx + 1)) {
      if (a.startsWith("--")) break;
      explicitFiles.push(a);
    }
  }
  if (explicitFiles && explicitFiles.length === 0) {
    console.error("audit-accessible-names: FAIL — --files was passed with no paths.");
    process.exit(1);
  }
  // `--write-baseline <canonical> --files <subset>` would regenerate the committed baseline from a
  // SUBSET of the tree, silently deleting every row belonging to an unlisted file — a green gate
  // over a tree full of unrecorded offenders, and indistinguishable in the diff from a change that
  // legitimately fixed them. Scoping a write to a scratch path is fine; truncating the canonical
  // one never is.
  const canonicalBaseline = path.join(repoRoot, "tools/dev/accessible-names-baseline.txt");
  if (explicitFiles && writeBaselinePath && path.resolve(writeBaselinePath) === canonicalBaseline) {
    console.error(
      "audit-accessible-names: FAIL — --write-baseline on the canonical baseline cannot be combined " +
        "with --files: it would drop every row from the files not listed. Regenerate it from the " +
        "full tree."
    );
    process.exit(1);
  }

  const files = explicitFiles ? explicitFiles.map((f) => path.resolve(f)) : listFiles();
  for (const f of files) {
    let st;
    try {
      st = statSync(f);
    } catch {
      console.error(
        `audit-accessible-names: FAIL — ${explicitFiles ? "--files path" : "scanned path"} does not exist: ${f}`
      );
      process.exit(1);
    }
    if (!st.isFile() || !/\.tsx$/.test(f)) {
      console.error(
        `audit-accessible-names: FAIL — ${explicitFiles ? "--files expects" : "this script scans"} .tsx source files, got: ${f}`
      );
      process.exit(1);
    }
  }
  const perFileResults = files.map(auditFile);
  const allHits = perFileResults.flatMap((r) => r.hits);
  const allActivationGaps = perFileResults.flatMap((r) => r.activationGaps);

  const none = allHits.filter((h) => h.tier === "NONE");
  const weak = allHits.filter((h) => h.tier === "WEAK");
  const unresolved = allHits.filter((h) => h.tier === "UNRESOLVED");
  const strong = allHits.filter((h) => h.tier === "STRONG");
  const failing = strictWeak ? [...none, ...weak] : none;

  const result = {
    filesScanned: files.length,
    totalCandidates: allHits.length,
    none: none.length,
    weak: weak.length,
    unresolved: unresolved.length,
    strong: strong.length,
    failing: failing.length,
    activationGaps: allActivationGaps.length,
    strictWeak,
  };

  if (writeBaselinePath) {
    const rows = baselineRowsFromHits(allHits);
    writeFileSync(path.resolve(writeBaselinePath), formatBaselineFile(rows));
    console.log(
      `audit-accessible-names: wrote ${rows.length} baseline row(s) (NONE+WEAK) to ${writeBaselinePath}`
    );
    process.exit(0);
  }

  if (checkBaselinePath) {
    const currentRows = baselineRowsFromHits(allHits);
    let baselineText;
    try {
      baselineText = readFileSync(path.resolve(checkBaselinePath), "utf8");
    } catch (err) {
      console.error(
        `audit-accessible-names: FAIL (--check-baseline) — could not read ${checkBaselinePath}: ${err.message}`
      );
      process.exit(1);
    }
    const baselineRows = parseBaselineFile(baselineText);
    const { added, stale } = diffRowMultisets(currentRows, baselineRows);

    // An `unresolved-import` hit is a candidate this script positively identified as one of the
    // repo's own composed components by name but could NOT resolve to an import it understands.
    // It is never baselined (only NONE/WEAK are), so it would otherwise grow unwatched behind a
    // green gate — the exact "the control vanished and that reads as progress" failure this whole
    // audit exists to prevent. Every real call site in this repo reaches its component through a
    // plain named import, so the honest target is ZERO: if this fires, name the import rather than
    // teaching the script another indirection to guess at.
    const unresolvedImports = allHits.filter((h) => h.via === "unresolved-import");
    if (unresolvedImports.length > 0) {
      console.error(
        `audit-accessible-names: FAIL (--check-baseline) — ${unresolvedImports.length} tag(s) name a ` +
          `composed component through an import this script cannot resolve, so their accessible ` +
          `name was never evaluated. Import the component with a plain named import:`
      );
      for (const h of unresolvedImports) console.error(`    ? ${h.file}:${h.line} <${h.tag}>`);
      process.exit(1);
    }

    if (added.length === 0 && stale.length === 0) {
      console.log(
        `audit-accessible-names: PASS (--check-baseline) — ${currentRows.length} NONE/WEAK row(s) ` +
          `match ${checkBaselinePath} exactly.`
      );
      process.exit(0);
    }

    console.error(
      `audit-accessible-names: FAIL (--check-baseline) — the live audit and ${checkBaselinePath} disagree.`
    );
    if (added.length > 0) {
      console.error(
        `  NEW row(s) the baseline does not list yet (a regression, OR a real fix you forgot to ` +
          `remove the OLD row for while adding this new one — check which):`
      );
      for (const r of added) console.error(`    + ${r}`);
    }
    if (stale.length > 0) {
      console.error(
        `  STALE row(s) the baseline lists but the live audit no longer produces (a real fix — ` +
          `remove the row — or the script silently stopped seeing them, which is its own bug):`
      );
      for (const r of stale) console.error(`    - ${r}`);
    }

    // Row identity is `file:line:tier`, so an edit above an open row in the
    // same file — even one totally unrelated to accessible names — shifts every later row's line
    // number, which prints as N stale rows gone / N new rows appeared even though nothing about
    // those controls' names changed. Print the per-file NET tier count alongside the row diff so a
    // real regression (a file's NONE/WEAK count actually went UP) is visually distinguishable from
    // pure line-shift noise (every affected file's counts unchanged).
    const {
      lines: deltaLines,
      hasNetIncrease,
      hasSameTierChurn,
    } = formatFileTierDeltas(currentRows, baselineRows, added, stale);
    if (deltaLines.length > 0) {
      console.error(`  Per-file NET tier delta (0 delta = pure line-shift, not a new offender):`);
      for (const line of deltaLines) console.error(line);
    }

    if (hasNetIncrease) {
      console.error(
        `  At least one file's NONE/WEAK count went UP — this is a real regression, not just a ` +
          `line shift. Do NOT regenerate the baseline to make this pass; fix the new offender first.`
      );
    } else if (hasSameTierChurn) {
      // A file has BOTH added and stale rows at the SAME tier, so the per-file net delta is zero.
      // That is byte-identical whether it is a pure line shift or a fix-one/break-one swap inside
      // one file — and this script cannot tell them apart, because row identity is `file:line:tier`
      // (only content-based identity could). This is the realistic shape: MealsManagement
      // alone holds 11 of the rows, so a change migrating it may fix several and leave one.
      //
      // The gate still FAILS here, so nothing lands silently. What must not happen is the tool
      // recommending the one action that would hide it.
      console.error(
        `  One or more files above have rows that both APPEARED and DISAPPEARED at the same tier.\n` +
          `  That is EITHER a line shift OR a fix-one/break-one swap, and this script cannot tell\n` +
          `  them apart. Check that each new row is the same control as the removed one BEFORE\n` +
          `  regenerating — otherwise regenerating absorbs a real regression.`
      );
    } else {
      console.error(
        `  If every change above is a confirmed real fix (not a script regression), regenerate with:\n` +
          `    node tools/dev/audit-accessible-names.mjs --write-baseline ${checkBaselinePath}`
      );
    }
    process.exit(1);
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          ...result,
          hits: perFile ? allHits : none.concat(weak).concat(unresolved),
          activationGapHits: allActivationGaps,
        },
        null,
        2
      )
    );
  } else {
    const toList = strictWeak ? none.concat(weak) : none.concat(weak, unresolved);
    if (perFile || toList.length > 0) {
      const rows = perFile ? allHits : toList;
      const grouped = new Map();
      for (const h of rows) {
        if (!grouped.has(h.file)) grouped.set(h.file, []);
        grouped.get(h.file).push(h);
      }
      for (const [file, hits] of [...grouped.entries()].sort()) {
        console.log(`\n${file}`);
        for (const h of hits.sort((a, b) => a.line - b.line)) {
          console.log(
            `  L${h.line} [${h.tier}] <${h.tag}${h.role ? ` role=${h.role}` : ""}>${h.via ? ` (via ${h.via})` : ""} — ${h.snippet}`
          );
        }
      }
    }
    console.log(
      `\naudit-accessible-names: ${result.filesScanned} files, ${result.totalCandidates} candidate controls`
    );
    console.log(`  STRONG name      : ${result.strong}`);
    console.log(`  WEAK name        : ${result.weak}  (placeholder/title only — see file header)`);
    console.log(
      `  UNRESOLVED       : ${result.unresolved}  (spread props — not counted, see file header)`
    );
    console.log(`  NONE (fail)      : ${result.none}`);
    if (strictWeak) console.log(`  --strict-weak: WEAK also counted as failing`);
    if (allActivationGaps.length > 0) {
      console.log(
        `\nActivation gaps (interactive role, but only ONE of click/keyboard activation is wired):`
      );
      for (const g of allActivationGaps) {
        const desc =
          g.kind === "no-keyboard"
            ? "onClick but NO onKeyDown/onKeyUp — keyboard-only users cannot activate it"
            : "onKeyDown/onKeyUp but NO onClick — a real click/AT-activation cannot fire";
        console.log(`  ${g.file}:${g.line} <${g.tag} role=${g.role}> (${desc}) — ${g.snippet}`);
      }
    }
    console.log(
      `  ACTIVATION GAPS  : ${result.activationGaps}  (not counted in --exact; see list above)`
    );
    console.log(`${result.failing}`);
  }

  if (exact !== null) {
    if (result.failing !== exact) {
      console.error(
        `audit-accessible-names: FAIL (--exact) — expected ${exact}, got ${result.failing}`
      );
      process.exit(1);
    }
    process.exit(0);
  }

  if (max !== null) {
    if (result.failing > max) {
      console.error(
        `audit-accessible-names: FAIL (--max) — ${result.failing} failing exceeds the baseline ceiling of ${max}. ` +
          `A new offender was introduced (--max only catches GROWTH; it does not require the count to be exactly ` +
          `${max} — a decrease is fine and does not need this number bumped down).`
      );
      process.exit(1);
    }
    process.exit(0);
  }

  process.exit(result.failing > 0 ? 1 : 0);
}

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
