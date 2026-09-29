// audit-accessible-names.test.mjs — fixture self-test for tools/dev/audit-accessible-names.mjs
// Follow-up coverage. Placed at the tools/ ROOT so `npm test`'s glob
// (`"./tools/*.test.mjs"`, non-recursive) actually runs it — same precedent as
// count-ui-debt.test.mjs.
//
// The point of this file: a gate never seen to reject is unproven (S1's own rule, the project guidance).
// Every "real offender" fixture below is a MINIMAL reproduction of an actual shape found in this
// codebase (cited per test), not a synthetic strawman — and every "false positive" fixture is a
// pattern the FIRST version of this script got wrong before being fixed against the real tree
// (`Select` root, `Label`-wrapped controls, a text prop passed through a variable). Both classes
// matter equally: a script that only proves it can reject would be exactly as unproven as one that
// only proves it can pass.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditSource,
  baselineRowsFromHits,
  diffRowMultisets,
  fileTierCounts,
  formatFileTierDeltas,
  parseBaselineFile,
} from "./dev/audit-accessible-names.mjs";

const BASELINE_PATH = fileURLToPath(
  new URL("./dev/accessible-names-baseline.txt", import.meta.url)
);
const SCRIPT_PATH = fileURLToPath(new URL("./dev/audit-accessible-names.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function fails(src) {
  return auditSource("x.tsx", src).hits.filter((h) => h.tier === "NONE");
}
function weak(src) {
  return auditSource("x.tsx", src).hits.filter((h) => h.tier === "WEAK");
}

// ── Known-positive: real offender shapes, each a fires-correctly proof ─────────────────────────

test("input: fires with no aria-label/label/placeholder (RoutinesManagement.tsx:401 shape)", () => {
  const hits = fails(`
    export const X = () => (
      <input type="text" value={v} onChange={onChange} className="border" />
    );
  `);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].tier, "NONE");
});

test("select: fires with no aria-label/label (RoutinesManagement.tsx:320 shape)", () => {
  const hits = fails(`
    export const X = () => (
      <select value={v} onChange={onChange}>
        <option value="">pick</option>
      </select>
    );
  `);
  assert.equal(hits.length, 1);
});

// This fixture fires twice, not once — the checkbox itself
// (unnamed input, as before) AND the `<li onClick>` wrapper it lives in (the shape-1 no-role-
// clickable gap, previously invisible to this script entirely — see the "shape-1" test group
// above). Both are real, independent offenders: naming the checkbox alone does not make the `<li>`
// operable, and vice versa.
test("checkbox: fires on a readOnly checkbox AND its non-focusable, no-role <li onClick> wrapper (CalendarView.tsx:628+644 shape)", () => {
  const hits = fails(`
    export const X = () => (
      <li onClick={toggle}>
        <input type="checkbox" checked={selected} readOnly />
      </li>
    );
  `);
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map((h) => h.tag).sort(), ["input", "li"]);
});

test("textarea: fires with no name (MealsManagement.tsx:716 shape)", () => {
  const hits = fails(`
    export const X = () => <textarea value={v} onChange={onChange} />;
  `);
  assert.equal(hits.length, 1);
});

test("role=button div: fires when unnamed", () => {
  const hits = fails(`
    export const X = () => <div role="button" tabIndex={0} onClick={go}>{}</div>;
  `);
  // an empty JsxExpression child ({}) has no expression at all -> no text found
  assert.equal(hits.length, 1);
});

// ── Shape-1 candidates: no ARIA role at all ────────────────────
// Four synthetic fixtures cover candidate elements without ARIA roles, including the
// `<li onClick>` shape described by FR-013.

test("shape-1: <li onClick> with no role/tabIndex/onKeyDown is now a candidate and fails (CalendarView.tsx:628 shape, the exact FR-013 wrapper)", () => {
  const hits = fails(`
    export const X = () => (
      <li onClick={toggle}>
        <span>Member</span>
      </li>
    );
  `);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].tag, "li");
});

test("shape-1: <div onClick> used as a button, no role, is a candidate and fails", () => {
  const hits = fails(`
    export const X = () => <div onClick={go}>Click me</div>;
  `);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].tag, "div");
});

test("shape-1: <div tabIndex={0} onClick> with no role and no name is a candidate and fails", () => {
  const hits = fails(`
    export const X = () => (
      <div tabIndex={0} onClick={go}>
        <span>Click me</span>
      </div>
    );
  `);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].tag, "div");
});

test("shape-1: an aria-label on the no-role clickable element itself is a legitimate fix", () => {
  const hits = fails(`export const X = () => <div onClick={go} aria-label="Toggle" />;`);
  assert.equal(hits.length, 0);
});

test("shape-1: adding aria-label to a NESTED control does not clear the outer no-role clickable wrapper (the exact false-green CalendarView shape: fixing the checkbox alone leaves the <li> unfixed)", () => {
  const hits = fails(`
    export const X = () => (
      <li onClick={toggle}>
        <input type="checkbox" aria-label="proof" readOnly />
      </li>
    );
  `);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].tag, "li");
});

test("shape-1: native <a>/<label>/<button> are exempt from the no-role-clickable check (they carry their own semantics/handling)", () => {
  assert.equal(fails(`export const X = () => <a onClick={go}>Link</a>;`).length, 0);
  assert.equal(fails(`export const X = () => <label onClick={go}>Text</label>;`).length, 0);
});

// ── Inverse activation gap: click-only, no keyboard handler ────

test("activation gap (inverse): role=button with onClick but NO onKeyDown/onKeyUp fires as 'no-keyboard' (the reviewer's fourth probe)", () => {
  const r = auditSource(
    "x.tsx",
    `export const X = () => (
      <div role="button" aria-label="Go" tabIndex={0} onClick={go}>go</div>
    );`
  );
  assert.equal(r.activationGaps.length, 1);
  assert.equal(r.activationGaps[0].kind, "no-keyboard");
});

test("activation gap (inverse): does NOT fire when onKeyDown is present alongside onClick", () => {
  const r = auditSource(
    "x.tsx",
    `export const X = () => (
      <div role="button" aria-label="Go" tabIndex={0} onClick={go} onKeyDown={onKeyDown}>go</div>
    );`
  );
  assert.equal(r.activationGaps.length, 0);
});

test("activation gap (inverse): does NOT fire on a native <button role='button'> with onClick and no onKeyDown (the browser supplies Enter/Space)", () => {
  const r = auditSource(
    "x.tsx",
    `export const X = () => <button role="button" onClick={go}>Go</button>;`
  );
  assert.equal(r.activationGaps.length, 0);
});

test("activation gap: the original detector still fires (onKeyDown, no onClick) and is tagged 'no-click'", () => {
  const r = auditSource(
    "x.tsx",
    `export const X = () => (
      <div role="button" aria-label="Hold" tabIndex={0} onKeyDown={onKeyDown}>hold</div>
    );`
  );
  assert.equal(r.activationGaps.length, 1);
  assert.equal(r.activationGaps[0].kind, "no-click");
});

// ── Known-negative: real accessible-name mechanisms must NOT be flagged ────────────────────────

test("aria-label alone is sufficient", () => {
  assert.equal(fails(`export const X = () => <input aria-label="Search" />;`).length, 0);
});

test("label[for] association (id + htmlFor in the same file) is sufficient", () => {
  const hits = fails(`
    export const X = () => (
      <>
        <label htmlFor="name">Name</label>
        <input id="name" />
      </>
    );
  `);
  assert.equal(hits.length, 0);
});

test("native <label> wrap (implicit association) is sufficient", () => {
  const hits = fails(`
    export const X = () => (
      <label>
        Name
        <input />
      </label>
    );
  `);
  assert.equal(hits.length, 0);
});

test("button with visible text is sufficient", () => {
  assert.equal(fails(`export const X = () => <button onClick={go}>Save</button>;`).length, 0);
});

test("placeholder-only is WEAK, not a hard failure (the threshold this script deliberately does not silently resolve)", () => {
  const src = `export const X = () => <input placeholder="Search" />;`;
  assert.equal(fails(src).length, 0);
  assert.equal(weak(src).length, 1);
});

// ── False positives the FIRST version of this script actually produced against the real tree ──
// (fixed while building it for — kept here so a regression is caught, not just "seen once")

test("Select (Radix Root, non-rendering) must NOT itself be flagged — only SelectTrigger is, and only an explicit id/label pairing names it (MemberCreateForm.tsx:170-173 shape)", () => {
  const src = `
    export const X = () => (
      <>
        <label htmlFor="role">Role</label>
        <Select value={v} onValueChange={set}>
          <SelectTrigger id="role"><SelectValue placeholder="Pick" /></SelectTrigger>
          <SelectContent><SelectItem value="a">A</SelectItem></SelectContent>
        </Select>
      </>
    );
  `;
  const hits = auditSource("x.tsx", src).hits;
  assert.ok(!hits.some((h) => h.tag === "Select"), "Select root must not be a candidate at all");
  const trigger = hits.find((h) => h.tag === "SelectTrigger");
  assert.ok(trigger, "SelectTrigger must be scanned");
  assert.equal(trigger.tier, "STRONG");
  assert.equal(trigger.via, "label[for]");
});

// Real, corrected finding (caught by the e2e runtime companion, NOT by reading): `combobox` is not
// a "Name From: Contents" ARIA role, so a `SelectTrigger`'s visible placeholder/selected-value text
// does NOT make it named — verified against the real Chromium accessibility tree for
// `MemberCreateForm.tsx`'s birthdate month/day selects (`text: "Mes"` but `name` absent entirely).
// An earlier version of this script granted STRONG here on a "Radix always shows some text" theory
// that turned out to describe visible TEXT, not accessible NAME.
test("SelectTrigger with only a placeholder-bearing SelectValue and NO id/label/aria-label is a hard NONE, not STRONG (MemberCreateForm.tsx:188 shape)", () => {
  const hits = fails(`
    export const X = () => (
      <Select value={v} onValueChange={set}>
        <SelectTrigger><SelectValue placeholder="Month" /></SelectTrigger>
        <SelectContent><SelectItem value="1">January</SelectItem></SelectContent>
      </Select>
    );
  `);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].tag, "SelectTrigger");
});

test("<Label> (capitalized components/ui wrapper) wrap counts as implicit label association (DailyBriefingManagement.tsx:811-821 shape)", () => {
  const hits = fails(`
    export const X = () => (
      <Label>
        Generation time
        <Input type="time" value={v} onChange={onChange} />
      </Label>
    );
  `);
  assert.equal(hits.length, 0);
});

test("a name passed through a variable (not a string literal) is assumed present, not flagged (ConfirmDialog.tsx cancelLabel shape)", () => {
  const hits = fails(`
    export const X = ({ cancelLabel }) => (
      <Button onClick={close}>{cancelLabel}</Button>
    );
  `);
  assert.equal(hits.length, 0);
});

// ── L2 composed components ─────────────────────────────────
// The blind-drop this closes: a `CheckboxField`/`RadioField`/`StatusToggle`/`WeekdayPicker`/
// `ConfirmDialog` call site carried NO name signal any detector recognized (not a lowercase host
// tag, no `role`, not in `NATIVE_CANDIDATE_TAGS`) — so migrating a real offender OFF a bare
// `<input>` and ONTO one of these components could make the count drop by "disappearing" the
// control from the population entirely, not by actually naming it. Proven live against
// `CalendarView.tsx`: adding an unnamed `<CheckboxField label="".../>` left the real-tree audit's
// NONE count completely unchanged before this fix landed.

test("composed component: an imported CheckboxField call site with a non-empty label is STRONG via prop:label", () => {
  const src = `
    import { CheckboxField } from "@/components/CheckboxField";
    export const X = () => <CheckboxField checked={false} onChange={onChange} label="Ada" />;
  `;
  const hits = auditSource("x.tsx", src).hits;
  const hit = hits.find((h) => h.tag === "CheckboxField");
  assert.ok(hit, "CheckboxField call site must be a candidate");
  assert.equal(hit.tier, "STRONG");
  assert.equal(hit.via, "prop:label");
});

test("composed component: an imported CheckboxField call site with an EMPTY label is a hard NONE (the exact blind-drop probe from the T014 review)", () => {
  const src = `
    import { CheckboxField } from "@/components/CheckboxField";
    export const X = () => <CheckboxField checked={false} onChange={onChange} label="" />;
  `;
  const hits = fails(src);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].tag, "CheckboxField");
});

test("composed component: StatusToggle is named via accessibleName, not label (label is the action text, deliberately state-shaped-only via the OTHER prop)", () => {
  const src = `
    import { StatusToggle } from "@/components/StatusToggle";
    export const X = () => (
      <StatusToggle pressed={false} label="Deactivate" accessibleName="Weeknights active" onPress={go} />
    );
  `;
  const hits = auditSource("x.tsx", src).hits;
  const hit = hits.find((h) => h.tag === "StatusToggle");
  assert.equal(hit.tier, "STRONG");
  assert.equal(hit.via, "prop:accessibleName");
});

test("composed component: WeekdayPicker is named via groupLabel", () => {
  const src = `
    import { WeekdayPicker } from "@/components/WeekdayPicker";
    export const X = () => (
      <WeekdayPicker mode="single" value={v} onChange={onChange} labels={labels} groupLabel="" />
    );
  `;
  const hits = fails(src);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].tag, "WeekdayPicker");
});

test("composed component: ConfirmDialog is named via title", () => {
  const src = `
    import { ConfirmDialog } from "@/components/ConfirmDialog";
    export const X = () => (
      <ConfirmDialog open={o} onOpenChange={f} title="Delete?" confirmLabel="Yes" cancelLabel="No" onConfirm={go} />
    );
  `;
  const hits = auditSource("x.tsx", src).hits;
  const hit = hits.find((h) => h.tag === "ConfirmDialog");
  assert.equal(hit.tier, "STRONG");
  assert.equal(hit.via, "prop:title");
});

// ── `Field` runtime-`useId` contract ────────────────────────────────────
// `components/Field.tsx` wires its `label` prop to its single direct child via `React.useId` —
// the id VALUE is only known at runtime, but the WIRING (child gets named by Field's own `label`
// prop) is a static, same-file, decidable fact, exactly like the composed-component contracts
// above. Measured live: adopting `Field` for eight inputs moved the audit 34 -> 42 before this fix
// (a real fix reads as six new NONE + two new WEAK); the fixtures below are the fires-correctly /
// does-not-false-positive pair for the fix, mirroring the `CheckboxField` pair above exactly.
test("Field: a direct child with a non-empty label is STRONG via field:label (adopting Field must not increase the count)", () => {
  const src = `
    import { Field } from "@/components/Field";
    import { Input } from "@/components/ui/input";
    export const X = () => (
      <Field label="Routine name">
        <Input value={v} onChange={onChange} />
      </Field>
    );
  `;
  const hits = auditSource("x.tsx", src).hits;
  const hit = hits.find((h) => h.tag === "Input");
  assert.ok(hit, "the wrapped control must still be a candidate");
  assert.equal(hit.tier, "STRONG");
  assert.equal(hit.via, "field:label");
});

test("Field: a direct child with an EMPTY label is a hard NONE, not falsely credited (the mirror failure)", () => {
  const src = `
    import { Field } from "@/components/Field";
    import { Input } from "@/components/ui/input";
    export const X = () => (
      <Field label="">
        <Input value={v} onChange={onChange} />
      </Field>
    );
  `;
  const hits = fails(src);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].tag, "Input");
});

test("Field: only the DIRECT child is credited — a control nested a level deeper than Field's own `cloneElement` reaches is NOT granted the wrap (Field cannot actually name it at runtime)", () => {
  const src = `
    import { Field } from "@/components/Field";
    export const X = () => (
      <Field label="Name">
        <div className="wrapper">
          <input value={v} onChange={onChange} />
        </div>
      </Field>
    );
  `;
  const hits = fails(src);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].tag, "input");
});

test("Field: a same-named LOCAL component NOT imported from the canonical module does NOT grant the wrap (guards against a worse false positive than the blind spot, same guard as the composed components)", () => {
  const src = `
    function Field({ label, children }) { return <div>{label}{children}</div>; }
    export const X = () => (
      <Field label="Name">
        <input value={v} onChange={onChange} />
      </Field>
    );
  `;
  const hits = fails(src);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].tag, "input");
});

test("Field: does not falsely flag an ALREADY-named child as unnamed — a mirror sanity check (a correctly-named L2/native call site is never falsely reported unnamed)", () => {
  const src = `
    import { Field } from "@/components/Field";
    export const X = () => (
      <Field label="Name">
        <input aria-label="explicit" value={v} onChange={onChange} />
      </Field>
    );
  `;
  const hits = auditSource("x.tsx", src).hits;
  const hit = hits.find((h) => h.tag === "input");
  assert.equal(hit.tier, "STRONG");
  assert.equal(hit.via, "aria-label"); // explicit aria-label still wins the normal precedence chain
});

// direction 1's residual fail-open fix (see `trailingTagIdentifier`'s header comment in the
// script): this fixture's expectation went out to UNRESOLVED and back. The intermediate version
// listed the local `WeekdayPicker` call site as UNRESOLVED on the grounds that it was
// indistinguishable from a real one reached through a fail-open import shape. Measured against the
// live tree, those two call sites were the ONLY `unresolved-import` hits in the repo — the tier was
// firing exclusively on the one case it was not built for. They are in fact distinguishable: a
// same-file declaration that DEFINES a component positively rules the imported canonical one out
// (the two bindings cannot coexist), so this is an ordinary unknown tag, invisible for the same
// reason every other unknown tag is. Emptying the tier of false members is what makes the
// zero-target `--check-baseline` rejection below possible at all.
test("composed component: a same-named LOCAL component DEFINED in-file is not a candidate at all (TimeAnnouncementsManagement.tsx's own unrelated in-file WeekdayPicker shape) — the local definition rules the canonical component out, so this is an ordinary unknown tag", () => {
  const src = `
    interface WeekdayPickerProps { selected: string[]; onToggle: (d: string) => void }
    function WeekdayPicker({ selected, onToggle }: WeekdayPickerProps) {
      return <div>{selected.map((d) => <input key={d} type="checkbox" onChange={() => onToggle(d)} />)}</div>;
    }
    export const X = () => <WeekdayPicker selected={["mon"]} onToggle={go} />;
  `;
  const hits = auditSource("x.tsx", src).hits;
  assert.equal(
    hits.filter((h) => h.tag === "WeekdayPicker").length,
    0,
    "a locally DEFINED same-named component is not the canonical one and must not be reported"
  );
  // NOTE: this fixture's INNER `<input type="checkbox">` (the local WeekdayPicker's own render) is
  // a separate, genuinely unnamed real offender — expected and unrelated to this test's subject,
  // the OUTER `<WeekdayPicker>` call site tag itself, which must never be counted as a failure.
  assert.ok(
    !fails(src).some((h) => h.tag === "WeekdayPicker"),
    "the WeekdayPicker call site itself must never be counted as a hard NONE failure"
  );
});

// ── direction 1's "known latent residual": the three fail-open import shapes ─────────────
// None occurs in this repo's tree today (verified by grep — every real composed-component call
// site uses a plain same-file named import). Two of the three are now RESOLVED outright, which is
// strictly better than being listed as unresolvable: the component's real naming contract gets
// evaluated, so an empty naming prop fails instead of parking in a tier the gate never reads. Only
// the alias indirection stays UNRESOLVED, and the zero-target gate rejects it.

test("resolved shape: an extension-bearing specifier (`./CheckboxField.tsx`) resolves, so a real name passes", () => {
  const src = `
    import { CheckboxField } from "./CheckboxField.tsx";
    export const X = () => <CheckboxField checked={false} onChange={onChange} label="Ada" />;
  `;
  const hit = auditSource("x.tsx", src).hits.find((h) => h.tag === "CheckboxField");
  assert.equal(hit?.tier, "STRONG");
  assert.equal(hit?.via, "prop:label");
});

test("resolved shape: a namespace import used via property access (`import * as Fields`, `<Fields.CheckboxField>`) resolves, so a real name passes", () => {
  const src = `
    import * as Fields from "@/components/CheckboxField";
    export const X = () => <Fields.CheckboxField checked={false} onChange={onChange} label="Ada" />;
  `;
  const hit = auditSource("x.tsx", src).hits.find((h) => h.tag === "Fields.CheckboxField");
  assert.equal(hit?.tier, "STRONG");
  assert.equal(hit?.via, "prop:label");
});

test("residual fail-open shape: a local const indirection (`const CheckboxField = <re-export or wrapper, not a plain same-file named import>`) is UNRESOLVED, not invisible", () => {
  const src = `
    const CheckboxField = require("./CheckboxField").CheckboxField;
    export const X = () => <CheckboxField checked={false} onChange={onChange} label="Ada" />;
  `;
  const hits = auditSource("x.tsx", src).hits;
  const hit = hits.find((h) => h.tag === "CheckboxField");
  assert.ok(hit, "must be a listed candidate, not an invisible skip");
  assert.equal(hit.tier, "UNRESOLVED");
  assert.equal(hit.via, "unresolved-import");
});

test("composed component: a renamed import (`import { CheckboxField as CF }`) still resolves to the canonical contract", () => {
  const src = `
    import { CheckboxField as CF } from "@/components/CheckboxField";
    export const X = () => <CF checked={false} onChange={onChange} label="" />;
  `;
  const hits = fails(src);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].tag, "CF");
});

// ── Skips: elements correctly excluded from the population ─────────────────────────────────────

test("aria-hidden='true' is skipped entirely (not counted pass or fail)", () => {
  const r = auditSource("x.tsx", `export const X = () => <input aria-hidden="true" />;`);
  assert.equal(r.hits.length, 0);
});

test("type='hidden' input is skipped entirely", () => {
  const r = auditSource("x.tsx", `export const X = () => <input type="hidden" value={v} />;`);
  assert.equal(r.hits.length, 0);
});

test("a spread-props definition site (components/ui primitive) is UNRESOLVED, not a hard NONE", () => {
  const r = auditSource(
    "x.tsx",
    `function Input({ ...props }) { return <input type="text" {...props} />; }`
  );
  const hit = r.hits.find((h) => h.tag === "input");
  assert.equal(hit.tier, "UNRESOLVED");
  assert.equal(
    fails(`function Input({ ...props }) { return <input type="text" {...props} />; }`).length,
    0
  );
});

// ── Activation-gap detector (SC-012's "operable" half, distinct from naming) ───────────────────

test("activation gap: role=button with onKeyDown but no onClick fires (AdminGate.tsx:126 shape)", () => {
  const r = auditSource(
    "x.tsx",
    `export const X = () => (
      <div role="button" aria-label="Hold" tabIndex={0} onKeyDown={onKeyDown}>hold</div>
    );`
  );
  assert.equal(r.activationGaps.length, 1);
});

test("activation gap: does NOT fire when onClick is present alongside onKeyDown", () => {
  const r = auditSource(
    "x.tsx",
    `export const X = () => (
      <div role="button" aria-label="Hold" tabIndex={0} onClick={go} onKeyDown={onKeyDown}>hold</div>
    );`
  );
  assert.equal(r.activationGaps.length, 0);
});

// ── Regression guard on the population itself (this repo's real tree) — ──────────────────
// SUPERSEDES the two pinned-integer assertions this test used to carry (`none.length === 21`,
// `failing.length === 34`). a single hardcoded integer is a HIGHER-CONTENTION shared path
// than `eslint.config.mjs`'s own per-file exception list — every component that fixes ANY offender, in
// ANY file, has to edit this SAME line of this SAME file, so two changes fixing different files
// both touch it and whichever merges second conflicts, every time.
//
// FIX (the proposal, adopted here): compare against `tools/dev/accessible-names-baseline.txt`, a
// committed, per-row `file:line:tier` list — a change that fixes an offender removes ITS OWN row
// (a different line of the baseline file than any other change's row), so two changes fixing
// different files merge cleanly, the same way two edits to `eslint.config.mjs`'s exception list do.
// This is a SET comparison, not a length comparison, so it is STRICTLY STRONGER than the integer it
// replaces: it still catches drift in EITHER direction (a row appears that the baseline doesn't
// list, or a baselined row silently stops appearing), and it additionally catches the fix-one/
// break-one swap a bare count cannot see at all (see the dedicated test below) — fixing one real
// offender while a NEW one appears elsewhere nets the same TOTAL, so `none.length`/`failing.length`
// would not move, but the SET of rows changes and this comparison rejects it.
test("real tree: NONE/WEAK offender rows match the committed baseline exactly (tools/dev/accessible-names-baseline.txt, #778) — set comparison, not a count, so it also catches a fix-one/break-one swap", async () => {
  const { listFiles, auditFile } = await import("./dev/audit-accessible-names.mjs");
  const files = listFiles();
  const allHits = files.flatMap((f) => auditFile(f).hits);
  const currentRows = new Set(baselineRowsFromHits(allHits));
  const baselineRows = new Set(parseBaselineFile(readFileSync(BASELINE_PATH, "utf8")));

  const added = [...currentRows].filter((r) => !baselineRows.has(r)).sort();
  const stale = [...baselineRows].filter((r) => !currentRows.has(r)).sort();

  assert.deepEqual(
    added,
    [],
    "NEW NONE/WEAK offender row(s) not in tools/dev/accessible-names-baseline.txt — either a real " +
      "fix elsewhere shifted line numbers (regenerate the baseline) or a script regression " +
      `(do not silently rebaseline): ${JSON.stringify(added)}`
  );
  assert.deepEqual(
    stale,
    [],
    "STALE row(s) in tools/dev/accessible-names-baseline.txt the live audit no longer produces — " +
      "remove them if this is a real fix, or this is a script regression that silently stopped " +
      `seeing them (do not silently rebaseline): ${JSON.stringify(stale)}`
  );
});

// Documentation-only sanity check (NOT the enforcement mechanism above — that is the set
// comparison): derives the current NONE/failing counts FROM the baseline file itself, so this
// never needs editing on an ordinary per-change fix either. Mirrors the accessibility guidance's own numbers
// so a reader of either can cross-check them, without reintroducing a magic literal here.
test("real tree: NONE/strict-weak counts match the baseline file's own row tiers (documentation cross-check, quickstart.md S9)", async () => {
  const { listFiles, auditFile } = await import("./dev/audit-accessible-names.mjs");
  const files = listFiles();
  const allHits = files.flatMap((f) => auditFile(f).hits);
  const none = allHits.filter((h) => h.tier === "NONE").length;
  const failing = allHits.filter((h) => h.tier === "NONE" || h.tier === "WEAK").length;

  const baselineRows = parseBaselineFile(readFileSync(BASELINE_PATH, "utf8"));
  const baselineNone = baselineRows.filter((r) => r.endsWith(":NONE")).length;

  assert.equal(none, baselineNone);
  assert.equal(failing, baselineRows.length);
});

// ── DoD: "if you implement the list, demonstrate the fix-one/break-one swap now fails" ────
// Permanent regression fixture (not just a one-time demonstration): proves the SET comparison
// catches what a bare count literally cannot. `--exact`/`--max` (and the two pinned integers this
// test file used to carry) only ever look at `hits.length` — fixing offender A while introducing a
// brand-new offender B leaves that number UNCHANGED, so a count-only gate passes. This test builds
// that exact scenario with the exported building blocks the real CLI's `--check-baseline` uses
// (`baselineRowsFromHits`) and asserts the row-diff surfaces it.
test("#778: a fix-one/break-one swap (fixing offender A while introducing a NEW offender B elsewhere) is INVISIBLE to a bare count but CAUGHT by the baseline row-diff", () => {
  const before = auditSource(
    "fileA.tsx",
    `export const X = () => <input type="text" value={v} onChange={onChange} />;`
  ).hits; // one NONE offender: fileA.tsx:1

  const after = auditSource(
    "fileB.tsx", // a DIFFERENT file — this IS the swap, not just an edit in place
    `export const Y = () => <input type="text" value={v} onChange={onChange} />;`
  ).hits; // fileA's offender is gone (fixed); fileB's is new (a regression)

  const beforeCount = before.filter((h) => h.tier === "NONE").length;
  const afterCount = after.filter((h) => h.tier === "NONE").length;
  assert.equal(
    beforeCount,
    afterCount,
    "the swap must net the SAME total — this is the exact blind spot a count-only gate has"
  );

  const baseline = new Set(baselineRowsFromHits(before));
  const current = new Set(baselineRowsFromHits(after));
  const added = [...current].filter((r) => !baseline.has(r));
  const stale = [...baseline].filter((r) => !current.has(r));

  assert.deepEqual(added, ["fileB.tsx:1:NONE"], "the new, unbaselined offender must be surfaced");
  assert.deepEqual(
    stale,
    ["fileA.tsx:1:NONE"],
    "the fixed offender's now-stale row must be surfaced"
  );
  // A caller (the real CLI's --check-baseline) treats EITHER list being non-empty as FAIL — proven
  // here directly: the swap is not silently accepted just because `beforeCount === afterCount`.
  assert.ok(added.length > 0 || stale.length > 0, "the row-diff must reject the swap");
});

// ── `--check-baseline` CLI-path coverage ────────────────────────────────
//
// WHY THIS EXISTS: every test above the fold in this file exercises the EXPORTED helpers directly
// (`auditSource`/`baselineRowsFromHits`) — never the actual `main` code path in
// `tools/dev/audit-accessible-names.mjs:807-852` that `check:accessible-names` (and therefore
// `check:standard`) actually runs. That left the CLI's argument parsing, exit codes, and
// read/compare logic completely unproven: an found FOUR mutations to that block
// (compare `Set.size` instead of set membership, an unconditional `if (true)` pass, silently
// rewriting the baseline before comparing, and stripping the `:tier` suffix so a WEAK→NONE
// regression reads as unchanged) that ALL survived both the CI gate and the full 47-fixture `npm
// test` run. A gate never seen to reject through the path CI actually invokes is unproven — the
// same rule S1/S9 already apply to the script's own logic, now applied to its entrypoint.
//
// Each mutation was manually applied, confirmed to turn ONE of the three cases below red (i.e. the
// the unmutated test suite would have passed on the mutant), then reverted.
// description for the transcript. This file only carries the PERMANENT regression tests.
function runCli(baselineText) {
  const dir = mkdtempSync(path.join(tmpdir(), "audit-accessible-names-cli-test-"));
  const baselinePath = path.join(dir, "baseline.txt");
  writeFileSync(baselinePath, baselineText);
  try {
    return spawnSync(
      process.execPath,
      [SCRIPT_PATH, "--strict-weak", "--check-baseline", baselinePath],
      { encoding: "utf8" }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The real, live baseline file IS the "exact match" fixture — using it (rather than a synthetic
// stand-in) means this test also re-proves, through the actual CLI entrypoint, the same "matches
// exactly" fact the real-tree `--check-baseline` test above proves through the exported helpers
// only. If the live tree and the committed baseline ever drift, THIS test fails for the same
// reason `check:accessible-names` would in CI.
const LIVE_BASELINE_TEXT = readFileSync(BASELINE_PATH, "utf8");

test("CLI: --check-baseline exits 0 and prints PASS when the live audit matches the baseline exactly", () => {
  const result = runCli(LIVE_BASELINE_TEXT);
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  assert.match(result.stdout, /PASS \(--check-baseline\)/);
});

// This rejects an always-pass implementation and an implementation that rewrites the baseline before comparing:
// deleting a row from the baseline means the LIVE audit still produces it, so it must be reported
// as a NEW, unbaselined row.
// Uses an EXTRA FABRICATED row rather than deleting a real one, and that choice is deliberate.
// Deleting `lines[0]` couples this test to the baseline being non-empty — at the baseline
// reaches ZERO rows, both sides become empty, the CLI correctly exits 0, and this test goes red in
// the very file meant to prove the close-out. A fabricated ghost row is empty-baseline-safe and
// works at any row count, including zero.
test("CLI: --check-baseline exits 1 and reports a STALE row when the baseline holds a row the live audit does not produce", () => {
  const lines = parseBaselineFile(LIVE_BASELINE_TEXT);
  const ghost = "src/client/ghost/Nope.tsx:1:NONE";
  const mutated = [...lines, ghost].join("\n") + "\n";
  const result = runCli(mutated);
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}: ${result.stdout}`);
  assert.match(result.stderr, /FAIL \(--check-baseline\)/);
  assert.match(result.stderr, /STALE row\(s\)/);
  assert.ok(
    result.stderr.includes(`- ${ghost}`),
    `expected the fabricated row to be reported as STALE: ${result.stderr}`
  );
});

// This rejects a size-only comparison: the row COUNT is IDENTICAL before/after — only the tier
// suffix on one existing row changes — so a size check would wrongly PASS — and a tier-strip mutation
// (stripping `:tier` before comparing: with the suffix gone, `file:line` alone is unchanged, so a
// WEAK->NONE flip would also wrongly read as no change). Flipping the baseline's recorded tier for
// one row (leaving the live tree untouched) makes the two sides disagree on tier for the SAME
// file:line: the live `…:WEAK` row is no longer in the (mutated) baseline (reported NEW), and the
// baseline's now-wrong `…:NONE` row is no longer in the live set (reported STALE). Both mutations
// pass every fixture test in this file but must fail THIS one.
// This test also covers an empty live baseline. The previous version
// flipped a tier on a LIVE baseline row, with a fallback that half-anticipated the close-out but
// still required "at least one NONE or WEAK row" — unsatisfiable the day the baseline empties,
// exactly the defect class covered by ui-debt-ratchet.test.ts. This version
// builds its own fixture through the CLI's --files flag (same technique as the DupLine test
// below), so the tier-disagreement shape is provable at ANY live row count, including zero.
test("CLI: --check-baseline exits 1 when one row's recorded tier disagrees with the live tier for the same file:line (same row COUNT, only the tier text differs — the exact shape mutations #1 and #4 both let through)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "audit-accessible-names-tierflip-"));
  try {
    // A bare <input /> is a NONE offender; write ITS baseline via the tool itself so the row
    // text is exactly what the script produces, then flip the recorded tier.
    const fixture = path.join(dir, "TierFlip.tsx");
    writeFileSync(fixture, `export const X = () => <input />;\n`);
    const baselinePath = path.join(dir, "baseline.txt");
    const write = spawnSync(
      process.execPath,
      [SCRIPT_PATH, "--strict-weak", "--write-baseline", baselinePath, "--files", fixture],
      { encoding: "utf8" }
    );
    assert.equal(write.status, 0, `fixture setup failed: ${write.stderr}`);
    const rows = parseBaselineFile(readFileSync(baselinePath, "utf8"));
    assert.equal(rows.length, 1, "fixture precondition: exactly one offender row");
    const original = rows[0];
    assert.ok(original.endsWith(":NONE"), "fixture precondition: a bare input is a NONE offender");
    const flipped = original.replace(/:NONE$/, ":WEAK");
    // Tier DISAGREEMENT at a constant row count — the only shape that separates a size check
    // from a set check.
    writeFileSync(baselinePath, `${flipped}\n`);
    const result = spawnSync(
      process.execPath,
      [SCRIPT_PATH, "--strict-weak", "--check-baseline", baselinePath, "--files", fixture],
      { encoding: "utf8" }
    );
    assert.equal(result.status, 1, `expected exit 1, got ${result.status}: ${result.stdout}`);
    assert.match(result.stderr, /FAIL \(--check-baseline\)/);
    assert.ok(
      result.stderr.includes(`+ ${original}`),
      `expected the real row reported as NEW: ${result.stderr}`
    );
    assert.ok(
      result.stderr.includes(`- ${flipped}`),
      `expected the tier-flipped row reported as STALE: ${result.stderr}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The always-pass mutation and the mutation that silently rewrites the baseline before
// comparing, then compare against what was just written) are both killed by ANY of the three cases
// above already: either would exit 0 on cases where the tool must exit 1;
// the self-heal step makes the file match by construction before
// the comparison ever runs. No separate fixture is needed for either — recorded here so the mapping
// from each mutation to the tests that detect it is explicit and auditable.

test("CLI: --write-baseline and --check-baseline together is a hard error (P7 — write-baseline used to silently win, writing and exiting 0 without ever checking)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "audit-accessible-names-cli-test-"));
  const checkPath = path.join(dir, "baseline.txt");
  const writePath = path.join(dir, "written.txt");
  writeFileSync(checkPath, "src/client/nonexistent/File.tsx:1:NONE\n");
  try {
    const result = spawnSync(
      process.execPath,
      [SCRIPT_PATH, "--check-baseline", checkPath, "--write-baseline", writePath],
      { encoding: "utf8" }
    );
    assert.equal(result.status, 1, `expected exit 1, got ${result.status}: ${result.stdout}`);
    assert.match(result.stderr, /both --write-baseline and --check-baseline/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Per-file NET tier delta (fix on) ────────────────────────────────────────────

test("fileTierCounts: tallies NONE/WEAK rows per file, ignoring any other tier", () => {
  const counts = fileTierCounts(["a.tsx:1:NONE", "a.tsx:2:WEAK", "a.tsx:3:NONE", "b.tsx:1:WEAK"]);
  assert.deepEqual(counts.get("a.tsx"), { NONE: 2, WEAK: 1 });
  assert.deepEqual(counts.get("b.tsx"), { NONE: 0, WEAK: 1 });
});

test("formatFileTierDeltas: a pure line-shift (same file, same tiers, different line numbers) reports a zero delta for every affected file, and hasNetIncrease is false", () => {
  const baseline = new Set(["a.tsx:10:NONE", "a.tsx:20:WEAK"]);
  const current = new Set(["a.tsx:11:NONE", "a.tsx:21:WEAK"]); // both rows shifted down one line
  const added = [...current].filter((r) => !baseline.has(r));
  const stale = [...baseline].filter((r) => !current.has(r));
  const { lines, hasNetIncrease } = formatFileTierDeltas(current, baseline, added, stale);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /a\.tsx: NONE 1→1, WEAK 1→1/);
  assert.equal(hasNetIncrease, false);
});

test("formatFileTierDeltas: a real regression (a file's NONE count actually goes up) reports a non-zero delta and hasNetIncrease is true", () => {
  const baseline = new Set(["a.tsx:10:NONE"]);
  const current = new Set(["a.tsx:10:NONE", "a.tsx:20:NONE"]); // a NEW offender, nothing removed
  const added = [...current].filter((r) => !baseline.has(r));
  const stale = [...baseline].filter((r) => !current.has(r));
  const { lines, hasNetIncrease } = formatFileTierDeltas(current, baseline, added, stale);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /a\.tsx: NONE 1→2 \(\+1\), WEAK 0→0/);
  assert.equal(hasNetIncrease, true);
});

// ---: resolving the canonical import forms, and per-occurrence row identity ------
//
// Both of these close a hole where the gate stays GREEN while a real offender exists. The first
// was measured against the live tree: before this fix the two `TimeAnnouncementsManagement.tsx`
// call sites of its OWN local `WeekdayPicker` were the only `unresolved-import` hits in the repo,
// which is precisely the case the tier was NOT built for.

test("namespace import: <Fields.CheckboxField> with an EMPTY label is evaluated (NONE), not parked as unresolvable", () => {
  const r = auditSource(
    "x.tsx",
    `import * as Fields from "../components/CheckboxField";
     export function F() { return <Fields.CheckboxField label="" checked={a} onChange={b} />; }`
  );
  const hit = r.hits.find((h) => h.tag === "Fields.CheckboxField");
  assert.equal(hit?.tier, "NONE", "an empty naming prop must fail, not hide behind UNRESOLVED");
});

test("namespace import: <Fields.CheckboxField> with a real label passes as STRONG via its prop", () => {
  const r = auditSource(
    "x.tsx",
    `import * as Fields from "../components/CheckboxField";
     export function F() { return <Fields.CheckboxField label="Done" checked={a} onChange={b} />; }`
  );
  const hit = r.hits.find((h) => h.tag === "Fields.CheckboxField");
  assert.equal(hit?.tier, "STRONG");
  assert.equal(hit?.via, "prop:label");
});

test("extension-bearing specifier: `from './CheckboxField.tsx'` resolves like the bare form", () => {
  const r = auditSource(
    "x.tsx",
    `import { CheckboxField } from "../components/CheckboxField.tsx";
     export function F() { return <CheckboxField label="" checked={a} onChange={b} />; }`
  );
  const hit = r.hits.find((h) => h.tag === "CheckboxField");
  assert.equal(hit?.tier, "NONE", "the extension must not make a real offender invisible");
});

test("a same-file LOCAL declaration of a canonical name is not a candidate at all (the real TimeAnnouncementsManagement.tsx shape)", () => {
  const r = auditSource(
    "x.tsx",
    `function WeekdayPicker({ selected, onToggle }) { return <div>{selected}</div>; }
     export function F() { return <WeekdayPicker selected={d} onToggle={t} />; }`
  );
  assert.equal(
    r.hits.filter((h) => h.tag === "WeekdayPicker").length,
    0,
    "an unrelated local component this script cannot see inside must not be reported as unresolvable"
  );
});

test("row identity is per-occurrence: a SECOND offender on an already-baselined line is caught", () => {
  const baseline = ["src/a.tsx:40:NONE"];
  const current = ["src/a.tsx:40:NONE", "src/a.tsx:40:NONE"];
  const { added, stale } = diffRowMultisets(current, baseline);
  assert.deepEqual(added, ["src/a.tsx:40:NONE"], "the added occurrence must be reported");
  assert.deepEqual(stale, []);
  //...and the set-based comparison this replaced could not see it at all:
  assert.equal(new Set(current).size, new Set(baseline).size);
});

test("diffRowMultisets: identical multisets are clean regardless of order", () => {
  const { added, stale } = diffRowMultisets(
    ["b:2:WEAK", "a:1:NONE", "a:1:NONE"],
    ["a:1:NONE", "a:1:NONE", "b:2:WEAK"]
  );
  assert.deepEqual(added, []);
  assert.deepEqual(stale, []);
});

test("--check-baseline REJECTS a SECOND offender added to an already-baselined line (per-occurrence identity, end to end)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "audit-dupline-"));
  try {
    // Two unnamed controls beginning on ONE source line at the SAME tier. Their rows are
    // byte-identical, so a set-based comparison sees one row on each side and passes; only a
    // per-occurrence comparison notices the second. This is the CLI-level twin of the
    // `diffRowMultisets` unit test above — that one proves the helper, this one proves the CLI
    // actually calls it, which a mutation of the call site otherwise survives untouched.
    const fixture = path.join(dir, "DupLine.tsx");
    writeFileSync(fixture, `export const X = () => <div><input /><input /></div>;\n`);
    const baselinePath = path.join(dir, "baseline.txt");
    const write = spawnSync(
      process.execPath,
      [SCRIPT_PATH, "--strict-weak", "--write-baseline", baselinePath, "--files", fixture],
      { encoding: "utf8" }
    );
    assert.equal(write.status, 0, `fixture setup failed: ${write.stderr}`);
    const rows = parseBaselineFile(readFileSync(baselinePath, "utf8"));
    assert.equal(rows.length, 2, "fixture precondition: both controls share one line and tier");
    assert.equal(rows[0], rows[1], "fixture precondition: the two rows must be identical");

    // Drop ONE of the two identical rows — the exact shape of "an offender was added to a line
    // that already had one" once the baseline is regenerated from the pre-regression tree.
    writeFileSync(baselinePath, `${rows[0]}\n`);
    const result = spawnSync(
      process.execPath,
      [SCRIPT_PATH, "--strict-weak", "--check-baseline", baselinePath, "--files", fixture],
      { encoding: "utf8" }
    );
    assert.equal(
      result.status,
      1,
      `expected the extra occurrence to be rejected, got:\n${result.stdout}${result.stderr}`
    );
    assert.match(result.stderr, /NEW row/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--write-baseline on the CANONICAL baseline refuses to be scoped by --files (it would drop unlisted files' rows)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "audit-scoped-write-"));
  let before = null;
  try {
    const fixture = path.join(dir, "One.tsx");
    writeFileSync(fixture, `export const X = () => <input />;\n`);
    before = readFileSync(BASELINE_PATH, "utf8");
    const result = spawnSync(
      process.execPath,
      [
        SCRIPT_PATH,
        "--strict-weak",
        // RELATIVE on purpose: the guard normalizes before comparing, and a raw string compare
        // would let exactly this spelling through.
        "--write-baseline",
        "tools/dev/accessible-names-baseline.txt",
        "--files",
        fixture,
      ],
      { encoding: "utf8", cwd: REPO_ROOT }
    );
    assert.equal(result.status, 1, `expected refusal, got:\n${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /cannot be combined with --files/);
    assert.equal(readFileSync(BASELINE_PATH, "utf8"), before, "the baseline must be untouched");
  } finally {
    // This test aims a real `--write-baseline` at the REAL committed baseline: if the guard it
    // proves is ever removed, the write goes through and truncates a tracked file. Restoring it
    // here keeps a failing run from also leaving the tree dirty (observed exactly once, while
    // mutation-testing this guard).
    if (before !== null && readFileSync(BASELINE_PATH, "utf8") !== before) {
      writeFileSync(BASELINE_PATH, before);
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--check-baseline REJECTS an unresolvable composed-component import (zero-target gate)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "audit-unresolved-"));
  try {
    // A local-const indirection: the one fail-open shape that remains genuinely unresolvable.
    // It must fail the gate rather than pass unevaluated.
    const fixture = path.join(dir, "Ghost.tsx");
    writeFileSync(
      fixture,
      `import { Thing } from "../components/Thing";
       const CheckboxField = Thing;
       export function F() { return <CheckboxField checked={a} onChange={b} />; }
      `
    );
    const result = spawnSync(
      process.execPath,
      [SCRIPT_PATH, "--strict-weak", "--check-baseline", BASELINE_PATH, "--files", fixture],
      { encoding: "utf8" }
    );
    assert.equal(result.status, 1, `expected rejection, got:\n${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /cannot resolve/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---: the three holes its mutation run found ---------------------------

test("a module-scope local declaration must NOT silence a same-named PROPERTY-ACCESS tag (they coexist legally)", () => {
  const src = `
    import * as UI from "../components";
    function ConfirmDialog() { return null; }
    export const X = () => <UI.ConfirmDialog onConfirm={a} onCancel={b} />;
  `;
  const hit = auditSource("x.tsx", src).hits.find((h) => h.tag === "UI.ConfirmDialog");
  assert.ok(
    hit,
    "an unrelated local must not hide a barrel-reached canonical call site — the two bindings do not conflict"
  );
  assert.equal(hit.tier, "UNRESOLVED");
  assert.equal(hit.via, "unresolved-import");
});

test("a local `lazy(() => import(...))` REACHES the canonical component, so it stays unresolvable rather than invisible", () => {
  const src = `
    const ConfirmDialog = lazy(() => import("../components/ConfirmDialog"));
    export const X = () => <ConfirmDialog onConfirm={a} onCancel={b} />;
  `;
  const hit = auditSource("x.tsx", src).hits.find((h) => h.tag === "ConfirmDialog");
  assert.equal(hit?.via, "unresolved-import", "lazy() is an indirection, not a local definition");
});

test("a local `memo(...)`/`forwardRef(...)` wrapper IS a definition and rules the canonical one out", () => {
  for (const wrapper of ["memo", "forwardRef"]) {
    const src = `
      const ConfirmDialog = ${wrapper}(function Inner() { return null; });
      export const X = () => <ConfirmDialog onConfirm={a} onCancel={b} />;
    `;
    assert.equal(
      auditSource("x.tsx", src).hits.filter((h) => h.tag === "ConfirmDialog").length,
      0,
      `${wrapper}() wraps a local body — that is a local component, not the canonical one`
    );
  }
});

test("the unresolvable-import gate fires even when the ROW DIFF IS CLEAN (ordering is load-bearing)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "audit-gate-order-"));
  try {
    // A file whose ONLY finding is an unresolvable import: no NONE/WEAK rows at all, so an empty
    // baseline matches the row diff exactly. If the gate ever moves below the clean-diff `exit(0)`,
    // this passes with an unevaluated control present — which is what the gate exists to prevent.
    const fixture = path.join(dir, "OnlyUnresolvable.tsx");
    writeFileSync(
      fixture,
      `const ConfirmDialog = Thing;
       export const X = () => <ConfirmDialog onConfirm={a} onCancel={b} />;
      `
    );
    const emptyBaseline = path.join(dir, "empty.txt");
    writeFileSync(emptyBaseline, "# no rows\n");
    const result = spawnSync(
      process.execPath,
      [SCRIPT_PATH, "--strict-weak", "--check-baseline", emptyBaseline, "--files", fixture],
      { encoding: "utf8" }
    );
    assert.equal(
      result.status,
      1,
      `a clean row diff must not mask an unresolvable import, got:\n${result.stdout}${result.stderr}`
    );
    assert.match(result.stderr, /cannot resolve/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--files consumes paths only up to the next flag, leaving that flag's own value alone", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "audit-files-parse-"));
  try {
    const fixture = path.join(dir, "One.tsx");
    writeFileSync(fixture, `export const X = () => <input aria-label="Named" />;\n`);
    // `3` belongs to --exact. A filter-based parser treated it as a path and died on ENOENT.
    const result = spawnSync(process.execPath, [SCRIPT_PATH, "--files", fixture, "--exact", "3"], {
      encoding: "utf8",
    });
    assert.doesNotMatch(
      result.stderr,
      /ENOENT|--files path does not exist/,
      `--exact's value must not be absorbed as a path: ${result.stderr}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--files rejects a directory and a non-.tsx path in this script's own error style, not a raw stack trace", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "audit-files-bad-"));
  try {
    for (const bad of [dir, path.join(dir, "nope.txt")]) {
      if (bad.endsWith(".txt")) writeFileSync(bad, "x");
      const result = spawnSync(process.execPath, [SCRIPT_PATH, "--files", bad], {
        encoding: "utf8",
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /audit-accessible-names: FAIL/);
      assert.doesNotMatch(result.stderr, /at \w+ \(node:/, "must not surface a raw Node stack");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
