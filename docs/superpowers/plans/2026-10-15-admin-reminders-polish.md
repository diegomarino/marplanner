# Admin Reminders Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the Reminders add/edit dialog with the shared pills: kind and targeting as segmented choices, weekday pills, member-colour pills with a compact weekday row per member, and the same for calendar-gated rules.

**Architecture:** One new component `ReminderMemberDays` (per-member pill plus weekday row) replaces the checkbox table; `ReminderFormDialog` swaps its radios and checkboxes for `ChoicePills`, `PillToggle` and `MemberPills`. State shapes, request bodies and the server are unchanged.

**Tech Stack:** React, TypeScript, Vitest + Testing Library, Playwright, Tailwind.

**Spec:** `docs/superpowers/specs/2026-10-15-admin-reminders-polish-design.md`

## Setup

You work in your own worktree branched from main AFTER the shared-pills wave merged. First copy this plan and the spec into your branch (they are untracked in the planner's checkout): from `/Users/diego/Dev/marplanner-project/docs/superpowers/{specs,plans}/2026-10-15-admin-reminders-polish*.md` into the same relative paths in your worktree, and commit them. Then read `src/client/components/ChoicePills.tsx`, `MemberPills.tsx`, `PillToggle.tsx`, `WeekdayPicker.tsx` and `src/client/ui.ts`. **If a shared component API differs from what this plan uses, adapt to the real one.** Plan assumed APIs:

- `ChoicePills<T extends string>({ value: T | null, onChange(v), options: {value,label,disabled?,"data-testid"?}[], groupLabel, className? })`
- `MemberPills({ mode?: "multi", members, value: string[], onChange(next: string[]), groupLabel, testIdPrefix? })` (testid `${prefix}-${member.id}` on the native input)
- `PillToggle({ checked, onChange(checked), label, "data-testid"? })`
- `WeekdayPicker({ mode: "multi", value, onChange(next), labels, groupLabel, testIdPrefix })` (testid `${prefix}-${day}` on the native input)

## Global Constraints

- English for code, tests, commit messages. i18n only in `src/client/i18n/messages.ts`, one `// admin-reminders-polish` block per locale at the end of that locale's admin keys.
- No `window.confirm`; no new raw `<input>`/inline styles (`check:ui-debt` must not rise); no `*_CLASSES` constants outside `src/client/lib/recipes.ts`.
- Request payloads, testids `reminders-add-rule`, `reminder-form-dialog`, `reminder-save`, `reminder-*-<id>`, `reminders-weekday-form-<day>` stay.
- Page heading stays "Reminders".

## Review Focus

- A member selected then deselected must not leak their days into the POST/PATCH body (Task 2 test).
- Selected member with zero days: Save stays disabled and the hint shows (Task 1 and 2 tests).
- Editing a specific rule prefills selected members and their days; editing a calendar-gated rule prefills member pills (Task 2 tests).
- Sunday-first household: a member's day row starts with Sunday but the body keeps canonical order (Task 1 test).
- Zero active members: calendar-gated and specific show the empty message, no empty group (Task 1 and 2 tests).

## File Structure

- Create `src/client/admin/ReminderMemberDays.tsx`: per-member pill and weekday row.
- Create `tests/client/reminder-member-days.test.tsx`.
- Modify `src/client/admin/RemindersManagement.tsx`: dialog controls; delete `QueryFieldsPicker`, `MembershipChecklist`, `AssignmentMatrixGrid`, `toggleAssignmentDay`, `toggleCgMember`; update the header comment.
- Modify `src/client/i18n/messages.ts`, `tests/client/reminders.test.tsx`, `tests/e2e/reminders.spec.ts`, `tests/e2e/reminders-calendar-gated.spec.ts`, `docs/ui/household-contract.md`, `tests/fixtures/assembly-cohort.json`.

---

### Task 1: `ReminderMemberDays` component

**Files:** Create `src/client/admin/ReminderMemberDays.tsx`, `tests/client/reminder-member-days.test.tsx`; modify `src/client/i18n/messages.ts` (keys, used by Task 2 but defined here).

**Interfaces:**
- Produces: `ReminderMemberDays(props: ReminderMemberDaysProps)`; testids `reminders-member-<id>` (pill input), `reminders-weekday-<id>-<day>` (day input), `reminders-member-row-<id>` (block), `reminders-member-hint-<id>`.

- [ ] **Step 1: Add i18n keys.** In `messages.ts`, after the last key of the `en` admin block (after the last `// admin-*` block's entries, before the next non-admin section, keeping the file's existing ordering convention) add:

```ts
    // admin-reminders-polish
    "reminders.specific.membersLabel": "Members and weekdays",
    "reminders.specific.membersHint": "Pick at least one weekday.",
```
and in `es`:
```ts
    // admin-reminders-polish
    "reminders.specific.membersLabel": "Miembros y días de la semana",
    "reminders.specific.membersHint": "Elige al menos un día de la semana.",
```
Other pages add blocks at the same spot; keep yours contiguous.

- [ ] **Step 2: Write the failing test** `tests/client/reminder-member-days.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReminderMemberDays } from "@/admin/ReminderMemberDays";
import type { WeekdayLabels } from "@/components/WeekdayPicker";
import type { Member, Weekday } from "../../src/shared";

const LABELS: WeekdayLabels = {
  mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun",
};
const ARI = { id: "m1", displayName: "Ari", colorKey: "blue" } as Member;
const BEA = { id: "m2", displayName: "Bea", colorKey: "teal" } as Member;

afterEach(cleanup);

function setup(value: Record<string, Weekday[]>, members: Member[] = [ARI, BEA], weekStartDay?: 0 | 1) {
  const onChange = vi.fn();
  render(
    <ReminderMemberDays
      members={members}
      value={value}
      onChange={onChange}
      labels={LABELS}
      weekdaysLabel="Weekdays"
      emptyMessage="No active members."
      hint="Pick at least one weekday."
      weekStartDay={weekStartDay}
    />
  );
  return onChange;
}

describe("ReminderMemberDays", () => {
  it("shows a pill per member and day rows only for selected members", () => {
    setup({ m1: ["mon"] });
    expect(screen.getByTestId("reminders-member-m1")).toBeChecked();
    expect(screen.getByTestId("reminders-member-m2")).not.toBeChecked();
    expect(screen.getByTestId("reminders-weekday-m1-mon")).toBeChecked();
    expect(screen.queryByTestId("reminders-weekday-m2-mon")).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Ari — Weekdays" })).toBeInTheDocument();
  });

  it("selecting a member adds an empty entry and shows the hint", () => {
    const onChange = setup({});
    fireEvent.click(screen.getByTestId("reminders-member-m2"));
    expect(onChange).toHaveBeenCalledWith({ m2: [] });
  });

  it("deselecting a member removes their entry, days included", () => {
    const onChange = setup({ m1: ["mon"], m2: ["fri"] });
    fireEvent.click(screen.getByTestId("reminders-member-m1"));
    expect(onChange).toHaveBeenCalledWith({ m2: ["fri"] });
  });

  it("toggling a day emits canonical order for that member only", () => {
    const onChange = setup({ m1: ["wed"] });
    fireEvent.click(screen.getByTestId("reminders-weekday-m1-mon"));
    expect(onChange).toHaveBeenCalledWith({ m1: ["mon", "wed"] });
  });

  it("explains a selected member with no days", () => {
    setup({ m1: [] });
    expect(screen.getByTestId("reminders-member-hint-m1")).toHaveTextContent("Pick at least one weekday.");
    expect(screen.queryByTestId("reminders-member-hint-m2")).not.toBeInTheDocument();
  });

  it("puts Sunday first for a Sunday-first household without changing emitted order", () => {
    const onChange = setup({ m1: ["sun"] }, [ARI], 0);
    const group = screen.getByRole("group", { name: "Ari — Weekdays" });
    const labels = within(group).getAllByRole("checkbox").map((c) => c.closest("label")?.textContent?.trim());
    expect(labels[0]).toBe("Sun");
    fireEvent.click(screen.getByTestId("reminders-weekday-m1-mon"));
    expect(onChange).toHaveBeenCalledWith({ m1: ["mon", "sun"] });
  });

  it("renders the empty message when there are no members", () => {
    setup({}, []);
    expect(screen.getByText("No active members.")).toBeInTheDocument();
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
  });
});
```

(`weekStartDay` is the optional `WeekdayPicker` prop from the shared wave; `ReminderMemberDays` forwards an optional `weekStartDay?: 0 | 1` prop to it, for tests only.)

- [ ] **Step 3: Run, expect FAIL** (module missing): `npx vitest run tests/client/reminder-member-days.test.tsx`.

- [ ] **Step 4: Implement** `src/client/admin/ReminderMemberDays.tsx`:

```tsx
import { MemberPills, WeekdayPicker } from "@/ui";
import type { WeekdayLabels } from "@/components/WeekdayPicker";
import type { Member, Weekday } from "../../shared";

/** Per-member weekday selection for a "specific members" scheduled rule. Every active member gets a
 * pill in their own colour (selected = takes part) and, while selected, a compact weekday-pill row
 * beneath. The value is `Record<memberId, Weekday[]>`; a key's presence means the member takes part,
 * so deselecting drops their days. Members with no days are omitted by the caller on submit. */
export interface ReminderMemberDaysProps {
  members: readonly Member[];
  value: Record<string, Weekday[]>;
  onChange: (next: Record<string, Weekday[]>) => void;
  labels: WeekdayLabels;
  /** Localized "Weekdays"; each day row is named "<member> — <weekdaysLabel>". */
  weekdaysLabel: string;
  emptyMessage: string;
  /** Shown under a selected member that has no days yet. */
  hint: string;
  /** Overrides the household week start (tests only). */
  weekStartDay?: 0 | 1;
}

export function ReminderMemberDays({
  members,
  value,
  onChange,
  labels,
  weekdaysLabel,
  emptyMessage,
  hint,
  weekStartDay,
}: ReminderMemberDaysProps) {
  if (members.length === 0) {
    return <p className="text-muted-foreground text-control">{emptyMessage}</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {members.map((member) => {
        const included = member.id in value;
        const days = value[member.id] ?? [];
        return (
          <div
            key={member.id}
            data-testid={`reminders-member-row-${member.id}`}
            className="flex flex-col gap-2"
          >
            <MemberPills
              members={[member]}
              value={included ? [member.id] : []}
              groupLabel={member.displayName}
              testIdPrefix="reminders-member"
              onChange={(next) => {
                const draft = { ...value };
                if (next.includes(member.id)) draft[member.id] = days;
                else delete draft[member.id];
                onChange(draft);
              }}
            />
            {included && (
              <WeekdayPicker
                mode="multi"
                value={days}
                onChange={(next) => onChange({ ...value, [member.id]: [...next] })}
                labels={labels}
                groupLabel={`${member.displayName} — ${weekdaysLabel}`}
                testIdPrefix={`reminders-weekday-${member.id}`}
                weekStartDay={weekStartDay}
              />
            )}
            {included && days.length === 0 && (
              <p
                data-testid={`reminders-member-hint-${member.id}`}
                className="text-muted-foreground text-sm"
              >
                {hint}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
```
If `@/ui` does not export these names, import from their component files.

- [ ] **Step 5: Run, expect PASS**; run `npx tsc --noEmit -p .` (or `npm run typecheck`) and `npx eslint src/client/admin/ReminderMemberDays.tsx tests/client/reminder-member-days.test.tsx`.
- [ ] **Step 6: Commit** `feat(admin): add per-member weekday pill rows for reminders`.

---

### Task 2: Rework the dialog

**Files:** Modify `src/client/admin/RemindersManagement.tsx`, `tests/client/reminders.test.tsx`.

**Interfaces:** Consumes `ReminderMemberDays` (Task 1), `ChoicePills`, `MemberPills`, `PillToggle`, `WeekdayPicker`.

- [ ] **Step 1: Update fixtures in `tests/client/reminders.test.tsx`:** add `colorKey: "blue"` to `MEMBER` (so `MEMBER_B`, spread from it, set `colorKey: "teal"` explicitly).

- [ ] **Step 2: Rewrite/add tests (they fail first):**
  - "creates a specific scheduled rule": replace `getByRole("checkbox", { name: "Ari — Mon" })` with `fireEvent.click(within(dialog).getByTestId("reminders-member-m1")); fireEvent.click(within(dialog).getByTestId("reminders-weekday-m1-mon"));`.
  - "edits an all-members rule into a specific one": same replacement with `tue`.
  - Add: kind pills — create dialog `getByRole("radiogroup", { name: "Kind" })` contains radios "Scheduled" (checked) and "Calendar-gated"; clicking Calendar-gated shows the match-text input and, after choosing "Specific members", the `Assigned members` group of member pills; edit dialog shows no kind radiogroup.
  - Add: deselect drops days — choose Specific, select Ari, tick Mon, select Bea, tick Fri, deselect Ari, save: POST body `assignments` equals `[{ memberId: "m2", weekdays: ["fri"] }]`.
  - Add: edit `REMINDER_SPECIFIC` (members `[MEMBER, MEMBER_B]`): `reminders-member-m1` and `-m2` checked, `reminders-weekday-m1-mon`, `-wed` and `reminders-weekday-m2-fri` checked, `reminders-weekday-m1-tue` not.
  - Add: selected member without days: Save disabled and `reminders-member-hint-m1` visible until a day is ticked.
  - Add: calendar-gated create with specific: `reminders-cg-member-m1` click, query typed, save, POST `assignments: [{ memberId: "m1", weekdays: [] }]`; edit `REMINDER_CALENDAR_GATED` shows `reminders-cg-member-m1` checked.
  - Add: query field pill: `reminders-query-field-location` toggle adds `location` to `queryFields` in the POST.
  - Add: no active members (`members: () => json([])`), choose Specific: the text "No active members." shown (scheduled) and no member pills.
  - Existing assertions `getByLabelText("Mon")`, `getByLabelText("Specific members")`, `getByLabelText("All members")`, `queryByLabelText("Calendar-gated")` keep working with pills; leave them.

- [ ] **Step 3: Run `npx vitest run tests/client/reminders.test.tsx`**, confirm the new/changed tests FAIL.

- [ ] **Step 4: Implement in `RemindersManagement.tsx`:**
  - Imports: remove `CANONICAL_WEEKDAY_ORDER`, `CheckboxField`, `RadioField`, `BARE_CHECKBOX_INPUT_CLASSES`; add `import { ChoicePills, MemberPills, PillToggle } from "@/ui";` and `import { ReminderMemberDays } from "./ReminderMemberDays";` (`NATIVE_SELECT_CLASSES` stays for the dry-run select).
  - Header comment: replace the `AssignmentMatrixGrid ... deliberate exception` sentences with "The dialog's choices are shared pills (`ChoicePills`, `WeekdayPicker`, `ReminderMemberDays`, `MemberPills`, `PillToggle`)".
  - Kind block (create only):

```tsx
<div className="flex flex-wrap items-center gap-2">
  <span className="text-muted-foreground text-control">{t("reminders.management.kindLabel")}</span>
  {editing ? (
    <span className="text-control font-medium">
      {kind === "calendar_gated" ? t("reminders.kind.calendarGated") : t("reminders.kind.scheduled")}
    </span>
  ) : (
    <ChoicePills<ReminderKind>
      value={kind}
      onChange={setKind}
      groupLabel={t("reminders.management.kindLabel")}
      options={[
        { value: "scheduled", label: t("reminders.kind.scheduled"), "data-testid": "reminder-kind-scheduled" },
        { value: "calendar_gated", label: t("reminders.kind.calendarGated"), "data-testid": "reminder-kind-calendar_gated" },
      ]}
    />
  )}
</div>
```
  - Targeting block: same pattern, `ChoicePills<TargetingMode>`, `groupLabel={t("reminders.management.targetingLabel")}`, options apply_to_all (`targetingApplyToAll`) and specific (`targetingSpecific`) with testids `reminder-targeting-apply_to_all` / `reminder-targeting-specific`.
  - Scheduled + specific branch becomes:

```tsx
<div className="flex flex-col gap-2">
  <span className="text-muted-foreground text-control">{t("reminders.specific.membersLabel")}</span>
  <ReminderMemberDays
    members={activeMembers}
    value={assignmentDraft}
    onChange={setAssignmentDraft}
    labels={weekdayLabels(t)}
    weekdaysLabel={t("reminders.management.weekdaysLabel")}
    emptyMessage={t("reminders.matrix.noActiveMembers")}
    hint={t("reminders.specific.membersHint")}
  />
</div>
```
  - Calendar-gated: match text becomes `<label className="flex flex-col gap-1 text-sm">{label}<Input .../></label>` (drop `w-auto`); the query-fields row becomes `<div role="group" aria-label={t("reminders.calendarGated.queryFieldsLabel")} className="flex flex-wrap gap-2">` of `QUERY_FIELDS.map(field => <PillToggle key checked={queryFields.includes(field)} onChange={() => toggleQueryField(field)} label={t(QUERY_FIELD_LABEL_KEYS[field])} data-testid={`reminders-query-field-${field}`} />)`; specific members block becomes the caption span plus, when `activeMembers.length === 0`, the `reminders.calendarGated.noActiveMembers` paragraph, otherwise `<MemberPills members={activeMembers} value={cgMemberIds} onChange={setCgMemberIds} groupLabel={t("reminders.calendarGated.membershipTitle")} testIdPrefix="reminders-cg-member" />`.
  - Delete `toggleAssignmentDay`, `toggleCgMember`, `QueryFieldsPicker`, `MembershipChecklist`, `AssignmentMatrixGrid` and their prop interfaces. Keep `draftToAssignments` and `membershipToAssignments`.
  - `MemberPills` `onChange` yields ids in member order and keeps unknown ids (a hidden archived member stays selected), which preserves the old behaviour of cgMemberIds.

- [ ] **Step 5: Fix density tests** in `reminders.test.tsx`. Expected counts: the add-dialog phase stays 26 (radios become radio inputs, weekdays checkboxes). The edit-specific dialog is now: close 1, text 1, targeting radios 2, per member pill 2 + days 14, Cancel 1, Save 1 = 22, plus 4 on the page = 26 (was 24); update the number and the derivation comment. Any other count that drifts: derive it from the DOM and write the arithmetic in the comment, never guess.

- [ ] **Step 6: Run** `npx vitest run tests/client/reminders.test.tsx tests/client/reminder-member-days.test.tsx tests/client/reminders-i18n-parity.test.ts tests/client/reminders-calendar-gated-i18n-parity.test.ts`; then `npm run typecheck && npm run lint`. Fix until green.
- [ ] **Step 7: Commit** `feat(admin): use shared pills in the reminder dialog`.

---

### Task 3: e2e and docs

**Files:** Modify `tests/e2e/reminders.spec.ts`, `tests/e2e/reminders-calendar-gated.spec.ts`, `docs/ui/household-contract.md`.

- [ ] **Step 1: `reminders.spec.ts`.** In step 8 replace the `rowOf(...)` locators with:

```ts
await dialog.getByTestId(`reminders-member-${memberAId}`).check();
await dialog.getByTestId(`reminders-weekday-${memberAId}-${weekdayA}`).check();
await dialog.getByTestId(`reminders-member-${memberBId}`).check();
await dialog.getByTestId(`reminders-weekday-${memberBId}-${weekdayB}`).check();

// The seven weekday pills of one member share one line.
const ys = await Promise.all(
  WEEKDAY_ORDER.map(async (day) =>
    (await dialog.getByTestId(`reminders-weekday-${memberAId}-${day}`).boundingBox())!.y
  )
);
expect(new Set(ys).size).toBe(1);
```
  In step 10 replace the `rowOf(memberAName)... nth(...)` with member and weekday testids for `weekdayAll`. Remove the now-unused `rowOf`. Update the header comment ("assignment matrix" becomes "member pills with weekday rows"). `WEEKDAY_ORDER` stays (used for the type and the line check).
- [ ] **Step 2: `reminders-calendar-gated.spec.ts`** line 226: replace `createForm.getByLabel(memberName).check()` with the member's pill testid `reminders-cg-member-<memberId>` (use the id the spec already holds or reads from its member seed; if only the name is known, keep `getByLabel(memberName, { exact: true })`, which resolves to the pill's native checkbox). The kind/targeting `getByLabel(...).check()` calls work unchanged.
- [ ] **Step 3: docs.** In `docs/ui/household-contract.md`, extend the Reminders paragraph: "The dialog's choices are pills: kind and applies-to as segmented choices, weekdays in the household's week-start order, and for specific members a pill in each member's colour with a weekday-pill row beneath it while selected."
- [ ] **Step 4: Run e2e** (own ports): `PORT=43223 MP_E2E_WEATHER_FIXTURE_PORT=44423 MP_E2E_QUOTE_FIXTURE_PORT=44433 npx playwright test tests/e2e/reminders.spec.ts tests/e2e/reminders-calendar-gated.spec.ts --workers=3`. Fix until green.
- [ ] **Step 5: Commit** `test(admin): move reminder e2e to the pill controls`.

---

### Task 4: Resync the reviewed inventory

New/changed source: `src/client/admin/ReminderMemberDays.tsx` (new), `src/client/admin/RemindersManagement.tsx` (changed). New test file `tests/client/reminder-member-days.test.tsx`; changed cases in `tests/client/reminders.test.tsx`. Playwright titles/ids are unchanged, so `testCohorts.runners.playwright.files` needs no entry; `check:aggregate-only` in Task 5 verifies it, and if it reports a missing/extra id, list them with `npx playwright test --list --reporter=json` and key the spec's entries by its spec id as the existing entries are.

- [ ] **Step 1:** `mkdir -p .quality && npx vitest run tests/client tests/boundary tests/integration --coverage --reporter=json --outputFile=.quality/vitest-results.json`.
- [ ] **Step 2:** write `$SCRATCH/resync-cohort.mjs` (scratchpad outside the repo). If `docs/superpowers/plans/2026-10-15-admin-shared-pills.md` is in your tree, copy the script from its Task 7 Step 2 verbatim; otherwise write one that (a) rebuilds `fixture.testCohorts.runners.vitest.files` from `.quality/vitest-results.json` (`path.relative(root, suite.name)` keyed to `assertionResults[].fullName`), and (b) for each file passed on argv, recomputes from `coverage/coverage-final.json` `lines/statements/functions/branches` `{covered,total}` and writes `coveragePolicy.files[file] = { layer: "client", minimumTotals, minimumRates }` taking the minimum against any existing entry (rates floored to 2 decimals), deleting entries whose file no longer exists, then writes the fixture sorted by key.
- [ ] **Step 3:** `node "$SCRATCH/resync-cohort.mjs" src/client/admin/ReminderMemberDays.tsx src/client/admin/RemindersManagement.tsx`. The new file must be at 100% lines/statements/functions and at least 90% branches; if not, add cases to `reminder-member-days.test.tsx` and redo steps 1 to 3.
- [ ] **Step 4:** `npx prettier --write tests/fixtures/assembly-cohort.json`, review `git diff --stat` (only those two coverage entries and vitest cases change), commit `test: resync the reviewed inventory for the reminders polish`.

---

### Task 5: Gate, commit, report

- [ ] **Step 1:** `git status --porcelain` must be empty (the gate hashes tracked files and rejects untracked ones). If the worktree complains, use a detached clean copy: `git worktree add --detach "$SCRATCH/verify" HEAD`, symlink `node_modules`, run there.
- [ ] **Step 2:**

```bash
export MP_CANDIDATE_ID=$(node tools/candidate-identity.mjs)
npm run check:standard
```
Expected exit 0. On `check:coverage`/`check:test-cohorts:standard` failure, redo Task 4 in your worktree, commit, and rerun on the new HEAD. If `check:ui-debt` rises you added an inline style; remove it. If `check:accessible-names` or `check:ui-catalog` fails, fix the cause (do not edit the audit).
- [ ] **Step 3:**

```bash
PORT=43223 MP_E2E_WEATHER_FIXTURE_PORT=44423 MP_E2E_QUOTE_FIXTURE_PORT=44433 npm run check:aggregate-only
```
It also verifies the Playwright inventory; on mismatch fix the cohort fixture (Task 4 note), recommit, and rerun both gates.
- [ ] **Step 4:** Ensure everything is committed on the worktree branch. Write `REPORT-reminders-polish.md` (outside tracked files is fine; at the worktree root, do not commit it if it would dirty a gated tree) with: what changed, gate outputs, final coverage rates, any shared-API adaptations. Reply `DONE`.

## Self-review

Spec coverage: D1 Task 2; D2 untouched; D3 Task 1+2; D4 Task 2; D5 Task 2 (deletion); D6 no change; D7 Task 1 Step 1; D8 Task 3. Names consistent: `ReminderMemberDays`, testids `reminders-member-`, `reminders-weekday-<id>-`, `reminders-cg-member-`, `reminders-query-field-`.
