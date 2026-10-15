# Admin Shared Pills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship three shared selection controls for the admin pages: `ChoicePills` (the segmented choice), `MemberPills` (one or several members, in member colours) and a pill-styled, week-start-aware `WeekdayPicker`. All three are built on one internal `PillControl`, and the cheap call sites that already use the same pattern are migrated.

**Architecture:**
- `PillControl` (internal) draws a pill and lays a native checkbox or radio invisibly over it, using the technique `PillToggle` uses today.
- `PillToggle`, `ChoicePills` and `MemberPills` are thin wrappers around it.
- `WeekdayPicker` keeps its API. It renders `PillToggle`s (multi mode) and `ChoicePills` (radio mode), and orders days by the household week start.
- Settings and `BriefingMemberPills` switch to the shared components.

**Tech Stack:** React 19, TypeScript, Tailwind 4 tokens, Vitest (jsdom) + Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-15-admin-shared-pills-design.md`. Read it first; its Decisions D1–D10 and its Public API are binding. Page workers depend on the exact names and props.

## Global Constraints

- Work in your own git worktree on branch `feat/admin-shared-pills`, created from `main` after PR #38 (`feat/admin-parity`) has merged. Verify that `src/client/daily-briefing/admin/BriefingMemberPills.tsx` and `src/client/admin/SettingsManagement.tsx` exist on your base; if they don't, PR #38 is not in, so stop and report. Copy the spec and this plan from the main checkout `/Users/diego/Dev/marplanner-project` (they are untracked there) into the same relative paths in your worktree and commit them with the work.
- If every git command is refused in your environment, do not work around it. Do the work, skip the commit steps, and in the final report list every changed, added and deleted file.
- The public API must match the spec's "Public API" section exactly (names, prop names, optionality, the `mode` default). `PillToggle`'s props must not change.
- `PillControl` is not exported from `src/client/ui.ts`. `ChoicePills` and `MemberPills` are.
- Shared components take every visible string from the caller. Don't call `useT()` in them and don't add i18n keys.
- No `*_CLASSES` / `*Classes` constants outside `src/client/lib/recipes.ts` (lint). Raw `<input>` only in `PillControl.tsx`, with the exact per-line `ui-policy/raw-controls` disable. Inline `style` only in `PillControl.tsx`, with the exact `ui-policy/debt` disable moved from `PillToggle`.
- Don't change `CANONICAL_WEEKDAY_ORDER` or the canonical emit order of multi-mode `onChange`.
- Technical text (code, comments, commits) in English. Conventional commits, e.g. `feat(ui): ...`.
- Run `npx prettier --write <files>` on every file you touch before committing.
- e2e: `PORT=43211 MP_E2E_WEATHER_FIXTURE_PORT=44411 MP_E2E_QUOTE_FIXTURE_PORT=44421`, always `--workers=3`.
- `npm run check:standard` must pass from a clean, committed tree before you report.

## Review Focus

1. A multi `MemberPills` whose `value` contains a member that the caller didn't pass in `members` (for example a filtered-out archived member) must keep that id when another pill is toggled. Test: Task 3, "keeps selected ids that are not shown".
2. With a Sunday-first household, the weekday row must show Sunday first but still save in mon..sun order. Test: Task 4, "still emits the canonical order when shown Sunday first".
3. Two `ChoicePills` or single `MemberPills` on one page must not share a native radio group, otherwise picking in one clears the other. Tests: Task 2 "gives two groups different native names" and Task 3 "single mode isolates groups".
4. An inactive member must be distinguishable without colour, and screen readers must hear it. Test: Task 3, "names an inactive member with its marker".
5. The seven weekday pills must stay on one line in the Routines "Assign routine" dialog. Test: Task 6, the e2e same-line assertion.

---

### Task 0: Worktree and baseline

**Files:** none changed.

- [ ] **Step 1:** Create the worktree and branch `feat/admin-shared-pills` from `main` with the `superpowers:using-git-worktrees` skill. Run `npm ci` if `node_modules` is missing.
- [ ] **Step 2:** Copy the two docs and commit them:

```bash
mkdir -p docs/superpowers/specs docs/superpowers/plans
cp /Users/diego/Dev/marplanner-project/docs/superpowers/specs/2026-10-15-admin-shared-pills-design.md docs/superpowers/specs/
cp /Users/diego/Dev/marplanner-project/docs/superpowers/plans/2026-10-15-admin-shared-pills.md docs/superpowers/plans/
git add docs/superpowers && git commit -m "docs: add the shared admin pills spec and plan"
```

- [ ] **Step 3: Baseline.** Run `npx vitest run tests/client/pill-toggle.test.tsx tests/client/weekday-picker.test.tsx tests/client/settings-management.test.tsx tests/client/daily-briefing-management.test.tsx`. Expected: all PASS.

---

### Task 1: `PillControl` and `PillToggle` on top of it

**Files:**
- Create: `src/client/components/PillControl.tsx`
- Modify: `src/client/components/PillToggle.tsx` (whole file)
- Test: `tests/client/pill-toggle.test.tsx` (unchanged; it must still pass)

**Interfaces:**
- Produces: `PillControl(props: PillControlProps)` with `type: "checkbox" | "radio"`, `checked: boolean`, `onChange: (checked: boolean) => void`, `label: string`, `note?: string`, `adornment?: ReactNode`, `selectedStyle?: CSSProperties`, `name?: string`, `value?: string`, `disabled?: boolean`, `className?: string`, `"data-testid"?: string`. The `data-testid` goes on the native input.

- [ ] **Step 1: Create `src/client/components/PillControl.tsx`:**

```tsx
import type { CSSProperties, ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Internal drawing primitive behind `PillToggle`, `ChoicePills` and `MemberPills`. It is NOT
 * exported from `@/ui`: page code uses one of those three instead.
 * The `<label>` draws the pill; a native checkbox or radio is laid invisibly over the whole pill,
 * so the touch target is the full control (density minimum), keyboard and assistive tech get the
 * native semantics, and the label text is the accessible name.
 */
export interface PillControlProps {
  type: "checkbox" | "radio";
  checked: boolean;
  /** The input's new checked state. A radio only fires when it becomes checked. */
  onChange: (checked: boolean) => void;
  /** Localized label text (call-site-owned). */
  label: string;
  /** Visible muted text after the label, e.g. "inactive". Part of the accessible name. */
  note?: string;
  /** Decorative node before the label (hidden from assistive tech), e.g. a colour dot. */
  adornment?: ReactNode;
  /** Replaces the accent fill while selected. Pass only semantic colour tokens. */
  selectedStyle?: CSSProperties;
  /** Native radio group name. */
  name?: string;
  value?: string;
  disabled?: boolean;
  className?: string;
  /** Placed on the native input. */
  "data-testid"?: string;
}

export function PillControl({
  type,
  checked,
  onChange,
  label,
  note,
  adornment,
  selectedStyle,
  name,
  value,
  disabled,
  className,
  "data-testid": testId,
}: PillControlProps) {
  return (
    <label
      // eslint-disable-next-line ui-policy/debt -- Forwards the caller's semantic colour tokens for the selected state.
      style={checked ? selectedStyle : undefined}
      className={cn(
        "border-input bg-background text-muted-foreground text-control relative inline-flex h-[var(--control-height)] cursor-pointer items-center rounded-lg border px-4 font-medium",
        "not-has-[:checked]:hover:bg-primary/10 not-has-[:checked]:hover:text-foreground",
        "has-[:checked]:bg-accent has-[:checked]:text-accent-foreground",
        "has-[:focus-visible]:ring-ring/50 has-[:focus-visible]:ring-[3px]",
        disabled && "cursor-not-allowed opacity-50",
        className
      )}
    >
      {/* eslint-disable-next-line ui-policy/raw-controls -- Invisible native checkbox or radio stretched over the token-sized label, which draws its state. */}
      <input
        type={type}
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        data-testid={testId}
        onChange={(event) => onChange(event.target.checked)}
        className="absolute inset-0 h-[var(--control-height)] w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
      />
      {adornment ? (
        <span aria-hidden="true" className="mr-2 inline-flex shrink-0">
          {adornment}
        </span>
      ) : null}
      {label}
      {note ? <span className="text-muted-foreground font-normal">{` (${note})`}</span> : null}
    </label>
  );
}
```

- [ ] **Step 2: Replace the body of `src/client/components/PillToggle.tsx`** with the version below. Keep the existing doc comment above `PillToggleProps` word for word; the props interface is unchanged.

```tsx
import type { CSSProperties } from "react";

import { PillControl } from "./PillControl";

/** L2 composed component (wiring and accessibility).
 * An on/off choice drawn as a pill: plain when off, filled when on. Use it where several
 * independent choices sit side by side (filters, the people on an event, the meals a recipe
 * suits) and a column of checkboxes would spend more room than the choice deserves.
 * It stays a native checkbox for keyboard and assistive tech. The input is laid invisibly over
 * the whole pill, so the touch target is the full control and meets the density minimum.
 */
export interface PillToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Localized label text (call-site-owned). */
  label: string;
  /** Replaces the accent fill while selected — a member's own colour, for instance. Pass only
   * semantic colour tokens.
   */
  selectedStyle?: CSSProperties;
  disabled?: boolean;
  className?: string;
  "data-testid"?: string;
}

export function PillToggle({
  checked,
  onChange,
  label,
  selectedStyle,
  disabled,
  className,
  "data-testid": testId,
}: PillToggleProps) {
  return (
    <PillControl
      type="checkbox"
      checked={checked}
      onChange={onChange}
      label={label}
      selectedStyle={selectedStyle}
      disabled={disabled}
      className={className}
      data-testid={testId}
    />
  );
}
```

- [ ] **Step 3: Verify.** Run `npx vitest run tests/client/pill-toggle.test.tsx tests/client/calendar-management.test.tsx && npx eslint src/client/components/PillControl.tsx src/client/components/PillToggle.tsx && npm run check:ui-debt`. Expected: PASS, no lint errors, and `inline style attrs` unchanged from the baseline (13 at the time of writing; it must not go up).
- [ ] **Step 4: Commit.** `npx prettier --write src/client/components/PillControl.tsx src/client/components/PillToggle.tsx && git add -A src/client/components && git commit -m "refactor(ui): draw PillToggle through an internal PillControl"`

---

### Task 2: `ChoicePills` (the segmented choice)

**Files:**
- Create: `src/client/components/ChoicePills.tsx`
- Create: `tests/client/choice-pills.test.tsx`

**Interfaces:**
- Consumes: `PillControl` (Task 1).
- Produces: `ChoicePills<T extends string>(props: ChoicePillsProps<T>)`, `ChoicePillsOption<T>`, `ChoicePillsProps<T>`, exactly as in the spec.

- [ ] **Step 1: Write the failing test `tests/client/choice-pills.test.tsx`:**

```tsx
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChoicePills, type ChoicePillsOption } from "@/components/ChoicePills";
import { assertKioskDensityCompliant } from "./helpers/density";
import { injectDensityStyles } from "./helpers/densityStyles";

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-density");
});

type Kind = "scheduled" | "calendar_gated";
const OPTIONS: ChoicePillsOption<Kind>[] = [
  { value: "scheduled", label: "Scheduled", "data-testid": "kind-scheduled" },
  { value: "calendar_gated", label: "Calendar-gated", "data-testid": "kind-gated" },
];

describe("ChoicePills", () => {
  it("is a radiogroup named by groupLabel, options in order, only the value checked", () => {
    render(
      <ChoicePills value="scheduled" onChange={() => {}} options={OPTIONS} groupLabel="Kind" />
    );
    const group = screen.getByRole("radiogroup", { name: "Kind" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((r) => r.closest("label")?.textContent)).toEqual([
      "Scheduled",
      "Calendar-gated",
    ]);
    expect(screen.getByRole("radio", { name: "Scheduled" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Calendar-gated" })).not.toBeChecked();
  });

  it("checks nothing when value is null", () => {
    render(<ChoicePills value={null} onChange={() => {}} options={OPTIONS} groupLabel="Kind" />);
    for (const radio of screen.getAllByRole("radio")) expect(radio).not.toBeChecked();
  });

  it("emits the clicked option's value and puts testids on the inputs", () => {
    const onChange = vi.fn();
    render(
      <ChoicePills value="scheduled" onChange={onChange} options={OPTIONS} groupLabel="Kind" />
    );
    fireEvent.click(screen.getByTestId("kind-gated"));
    expect(onChange).toHaveBeenCalledWith("calendar_gated");
  });

  it("disables the whole group or a single option", () => {
    const { rerender } = render(
      <ChoicePills
        value="scheduled"
        onChange={() => {}}
        options={[OPTIONS[0], { ...OPTIONS[1], disabled: true }]}
        groupLabel="Kind"
      />
    );
    expect(screen.getByTestId("kind-scheduled")).toBeEnabled();
    expect(screen.getByTestId("kind-gated")).toBeDisabled();
    rerender(
      <ChoicePills
        value="scheduled"
        onChange={() => {}}
        options={OPTIONS}
        groupLabel="Kind"
        disabled
      />
    );
    expect(screen.getByTestId("kind-scheduled")).toBeDisabled();
  });

  it("gives two groups different native names", () => {
    render(
      <>
        <ChoicePills value="scheduled" onChange={() => {}} options={OPTIONS} groupLabel="A" />
        <ChoicePills value="scheduled" onChange={() => {}} options={OPTIONS} groupLabel="B" />
      </>
    );
    const names = within(screen.getByRole("radiogroup", { name: "A" }))
      .getAllByRole("radio")
      .map((r) => (r as HTMLInputElement).name);
    const other = within(screen.getByRole("radiogroup", { name: "B" }))
      .getAllByRole("radio")
      .map((r) => (r as HTMLInputElement).name);
    expect(new Set(names).size).toBe(1);
    expect(names[0]).not.toBe(other[0]);
  });

  it("meets kiosk density", async () => {
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");
    try {
      const { container } = render(
        <ChoicePills value="scheduled" onChange={() => {}} options={OPTIONS} groupLabel="Kind" />
      );
      expect(() => assertKioskDensityCompliant(container)).not.toThrow();
    } finally {
      uninject();
    }
  });
});
```

- [ ] **Step 2:** Run `npx vitest run tests/client/choice-pills.test.tsx`. Expected: FAIL (cannot resolve `@/components/ChoicePills`).
- [ ] **Step 3: Create `src/client/components/ChoicePills.tsx`:**

```tsx
import { useId } from "react";

import { cn } from "@/lib/utils";
import { PillControl } from "./PillControl";

/** L2 composed component (wiring and accessibility).
 * Exactly one of a few options (2–4), drawn as the same pills as `PillToggle` — the admin's
 * segmented choice (Settings language and week start, a reminder's kind). It is a native radio
 * group: one tab stop, arrow keys move the choice, and the group name is instance-unique so two
 * groups on one page never share a native radio group.
 */
export interface ChoicePillsOption<T extends string> {
  value: T;
  /** Localized, call-site-owned. */
  label: string;
  disabled?: boolean;
  /** Placed on the option's native radio input. */
  "data-testid"?: string;
}

export interface ChoicePillsProps<T extends string> {
  /** null = nothing chosen yet. */
  value: T | null;
  onChange: (value: T) => void;
  /** 2–4 options in display order. */
  options: readonly ChoicePillsOption<T>[];
  /** Accessible name of the radiogroup (required, localized). */
  groupLabel: string;
  disabled?: boolean;
  className?: string;
}

export function ChoicePills<T extends string>({
  value,
  onChange,
  options,
  groupLabel,
  disabled,
  className,
}: ChoicePillsProps<T>) {
  const name = useId();
  return (
    <div
      role="radiogroup"
      aria-label={groupLabel}
      className={cn("flex flex-wrap gap-2", className)}
    >
      {options.map((option) => (
        <PillControl
          key={option.value}
          type="radio"
          name={name}
          value={option.value}
          checked={option.value === value}
          onChange={() => onChange(option.value)}
          label={option.label}
          disabled={disabled || option.disabled}
          data-testid={option["data-testid"]}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 4:** Run `npx vitest run tests/client/choice-pills.test.tsx`. Expected: PASS (6 tests).
- [ ] **Step 5: Commit.** Prettier both files, then `git add src/client/components/ChoicePills.tsx tests/client/choice-pills.test.tsx && git commit -m "feat(ui): add ChoicePills for one-of-few choices"`

---

### Task 3: `MemberPills`

**Files:**
- Create: `src/client/components/MemberPills.tsx`
- Create: `tests/client/member-pills.test.tsx`

**Interfaces:**
- Consumes: `PillControl` (Task 1) and `memberFilterStyle(key: MemberColorKey): CSSProperties` from `src/client/calendar/member-event-style.ts`.
- Produces: `MemberPills`, `MemberPillsMember`, `MemberPillsSingleProps`, `MemberPillsMultiProps`, `MemberPillsProps`, exactly as in the spec. Each input's testid is `${testIdPrefix}-${member.id}`.

- [ ] **Step 1: Write the failing test `tests/client/member-pills.test.tsx`:**

```tsx
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MemberPills, type MemberPillsMember } from "@/components/MemberPills";
import { assertKioskDensityCompliant } from "./helpers/density";
import { injectDensityStyles } from "./helpers/densityStyles";

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-density");
});

const MEMBERS: MemberPillsMember[] = [
  { id: "ada", displayName: "Ada", colorKey: "blue" },
  { id: "ben", displayName: "Ben", colorKey: "green" },
  { id: "cleo", displayName: "Cleo", colorKey: "pink" },
];

describe("MemberPills — multi (default)", () => {
  it("is a named group of checkboxes, one per member, in order", () => {
    render(<MemberPills members={MEMBERS} value={["ben"]} onChange={() => {}} groupLabel="Who" />);
    const boxes = within(screen.getByRole("group", { name: "Who" })).getAllByRole("checkbox");
    expect(boxes.map((b) => b.closest("label")?.textContent)).toEqual(["Ada", "Ben", "Cleo"]);
    expect(screen.getByRole("checkbox", { name: "Ben" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Ada" })).not.toBeChecked();
  });

  it("emits the selection in members order, not click order", () => {
    const onChange = vi.fn();
    render(
      <MemberPills
        members={MEMBERS}
        value={["cleo"]}
        onChange={onChange}
        groupLabel="Who"
        testIdPrefix="who"
      />
    );
    fireEvent.click(screen.getByTestId("who-ada"));
    expect(onChange).toHaveBeenCalledWith(["ada", "cleo"]);
  });

  it("removes a member that is already selected", () => {
    const onChange = vi.fn();
    render(
      <MemberPills members={MEMBERS} value={["ada", "ben"]} onChange={onChange} groupLabel="Who" />
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Ada" }));
    expect(onChange).toHaveBeenCalledWith(["ben"]);
  });

  it("keeps selected ids that are not shown", () => {
    const onChange = vi.fn();
    render(
      <MemberPills
        members={MEMBERS}
        value={["gone", "ben"]}
        onChange={onChange}
        groupLabel="Who"
      />
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Ada" }));
    expect(onChange).toHaveBeenCalledWith(["ada", "ben", "gone"]);
  });

  it("disables one member or the whole group", () => {
    const { rerender } = render(
      <MemberPills
        members={[MEMBERS[0], { ...MEMBERS[1], disabled: true }]}
        value={[]}
        onChange={() => {}}
        groupLabel="Who"
      />
    );
    expect(screen.getByRole("checkbox", { name: "Ada" })).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: "Ben" })).toBeDisabled();
    rerender(
      <MemberPills members={MEMBERS} value={[]} onChange={() => {}} groupLabel="Who" disabled />
    );
    expect(screen.getByRole("checkbox", { name: "Ada" })).toBeDisabled();
  });

  it("names an inactive member with its marker and draws it dashed", () => {
    render(
      <MemberPills
        members={[{ ...MEMBERS[0], inactiveLabel: "inactive" }]}
        value={[]}
        onChange={() => {}}
        groupLabel="Who"
      />
    );
    const box = screen.getByRole("checkbox", { name: "Ada (inactive)" });
    expect(box.closest("label")).toHaveClass("border-dashed");
  });

  it("wears the member's colour only while selected", () => {
    const { rerender } = render(
      <MemberPills members={MEMBERS} value={[]} onChange={() => {}} groupLabel="Who" />
    );
    const pill = () => screen.getByRole("checkbox", { name: "Ada" }).closest("label");
    expect(pill()).not.toHaveAttribute("style");
    rerender(<MemberPills members={MEMBERS} value={["ada"]} onChange={() => {}} groupLabel="Who" />);
    expect(pill()?.getAttribute("style")).toContain("--color-member-blue-500");
  });
});

describe("MemberPills — single", () => {
  it("is a named radiogroup and emits the chosen member id", () => {
    const onChange = vi.fn();
    render(
      <MemberPills
        mode="single"
        members={MEMBERS}
        value="ada"
        onChange={onChange}
        groupLabel="Preview"
        testIdPrefix="preview"
      />
    );
    const group = screen.getByRole("radiogroup", { name: "Preview" });
    expect(within(group).getAllByRole("radio")).toHaveLength(3);
    expect(screen.getByTestId("preview-ada")).toBeChecked();
    fireEvent.click(screen.getByTestId("preview-cleo"));
    expect(onChange).toHaveBeenCalledWith("cleo");
  });

  it("checks nothing when value is null", () => {
    render(
      <MemberPills
        mode="single"
        members={MEMBERS}
        value={null}
        onChange={() => {}}
        groupLabel="Preview"
      />
    );
    for (const radio of screen.getAllByRole("radio")) expect(radio).not.toBeChecked();
  });

  it("single mode isolates groups", () => {
    render(
      <>
        <MemberPills mode="single" members={MEMBERS} value="ada" onChange={() => {}} groupLabel="A" />
        <MemberPills mode="single" members={MEMBERS} value="ben" onChange={() => {}} groupLabel="B" />
      </>
    );
    const nameOf = (label: string) =>
      (within(screen.getByRole("radiogroup", { name: label })).getAllByRole("radio")[0] as HTMLInputElement)
        .name;
    expect(nameOf("A")).not.toBe(nameOf("B"));
  });
});

describe("MemberPills — density", () => {
  it.each(["multi", "single"] as const)("meets kiosk density in %s mode", async (mode) => {
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");
    try {
      const { container } = render(
        mode === "single" ? (
          <MemberPills mode="single" members={MEMBERS} value="ada" onChange={() => {}} groupLabel="Who" />
        ) : (
          <MemberPills members={MEMBERS} value={["ada"]} onChange={() => {}} groupLabel="Who" />
        )
      );
      expect(() => assertKioskDensityCompliant(container)).not.toThrow();
    } finally {
      uninject();
    }
  });
});
```

- [ ] **Step 2:** Run `npx vitest run tests/client/member-pills.test.tsx`. Expected: FAIL (cannot resolve the module).
- [ ] **Step 3: Create `src/client/components/MemberPills.tsx`:**

```tsx
import { useId } from "react";

import { memberFilterStyle } from "@/calendar/member-event-style";
import { cn } from "@/lib/utils";
import type { MemberColorKey } from "../../shared";
import { PillControl } from "./PillControl";

/** L2 composed component (wiring and accessibility).
 * Pick one member (`mode="single"`, a native radio group) or several (multi, the default, native
 * checkboxes). Each pill carries the member's colour dot and, once selected, the member's tint —
 * the same `memberFilterStyle` the calendar member filters use. A disabled member stays visible;
 * an inactive one is drawn dashed with its caller-supplied marker after the name, so colour is
 * never the only signal and screen readers hear the marker.
 */

/** Static class map so Tailwind sees every class (the `TodayAgenda.tsx` precedent). */
const MEMBER_DOT_CLASS: Record<MemberColorKey, string> = {
  blue: "bg-member-blue-500",
  sky: "bg-member-sky-500",
  teal: "bg-member-teal-500",
  green: "bg-member-green-500",
  lime: "bg-member-lime-500",
  amber: "bg-member-amber-500",
  orange: "bg-member-orange-500",
  red: "bg-member-red-500",
  pink: "bg-member-pink-500",
  violet: "bg-member-violet-500",
};

export interface MemberPillsMember {
  id: string;
  displayName: string;
  colorKey: MemberColorKey;
  disabled?: boolean;
  /** Localized marker such as "inactive"; when set the pill is drawn inactive and the marker
   * follows the name (and is part of its accessible name). */
  inactiveLabel?: string;
}

interface MemberPillsCommonProps {
  /** Display order. A MemberDTO/Member satisfies this structurally. */
  members: readonly MemberPillsMember[];
  /** Accessible name of the group (required, localized). */
  groupLabel: string;
  /** `${testIdPrefix}-${member.id}` on each native input. */
  testIdPrefix?: string;
  disabled?: boolean;
  className?: string;
}

export interface MemberPillsSingleProps extends MemberPillsCommonProps {
  mode: "single";
  value: string | null;
  onChange: (memberId: string) => void;
}

export interface MemberPillsMultiProps extends MemberPillsCommonProps {
  mode?: "multi";
  value: readonly string[];
  /** Selected ids in `members` order, followed by any selected ids not in `members`. */
  onChange: (next: string[]) => void;
}

export type MemberPillsProps = MemberPillsSingleProps | MemberPillsMultiProps;

export function MemberPills(props: MemberPillsProps) {
  const { members, groupLabel, testIdPrefix, disabled, className } = props;
  // Called before the mode branch: hooks cannot sit inside a conditional.
  const name = useId();

  const renderPill = (
    member: MemberPillsMember,
    type: "checkbox" | "radio",
    checked: boolean,
    onPillChange: () => void
  ) => (
    <PillControl
      key={member.id}
      type={type}
      name={type === "radio" ? name : undefined}
      value={member.id}
      checked={checked}
      onChange={onPillChange}
      label={member.displayName}
      note={member.inactiveLabel}
      adornment={
        <span
          className={cn(
            "block size-3 rounded-full border border-background",
            MEMBER_DOT_CLASS[member.colorKey]
          )}
        />
      }
      selectedStyle={memberFilterStyle(member.colorKey)}
      disabled={disabled || member.disabled}
      className={member.inactiveLabel ? "border-dashed" : undefined}
      data-testid={testIdPrefix ? `${testIdPrefix}-${member.id}` : undefined}
    />
  );

  if (props.mode === "single") {
    const { value, onChange } = props;
    return (
      <div
        role="radiogroup"
        aria-label={groupLabel}
        className={cn("flex flex-wrap gap-2", className)}
      >
        {members.map((member) =>
          renderPill(member, "radio", member.id === value, () => onChange(member.id))
        )}
      </div>
    );
  }

  const { value, onChange } = props;
  const toggle = (memberId: string) => {
    const next = new Set(value);
    if (next.has(memberId)) {
      next.delete(memberId);
    } else {
      next.add(memberId);
    }
    const shown = new Set(members.map((member) => member.id));
    onChange([
      ...members.filter((member) => next.has(member.id)).map((member) => member.id),
      // Never drop a selected member the caller chose not to show (e.g. an archived one).
      ...[...next].filter((id) => !shown.has(id)),
    ]);
  };

  return (
    <div role="group" aria-label={groupLabel} className={cn("flex flex-wrap gap-2", className)}>
      {members.map((member) =>
        renderPill(member, "checkbox", value.includes(member.id), () => toggle(member.id))
      )}
    </div>
  );
}
```

- [ ] **Step 4:** Run `npx vitest run tests/client/member-pills.test.tsx`. Expected: PASS (12 tests). If jsdom drops the `color-mix(...)` background from the style attribute, the `border-color: var(--color-member-blue-500)` declaration still satisfies the colour assertion. Do not weaken the assertion.
- [ ] **Step 5: Commit.** Prettier both files, then `git add src/client/components/MemberPills.tsx tests/client/member-pills.test.tsx && git commit -m "feat(ui): add MemberPills for picking members in their own colours"`

---

### Task 4: `WeekdayPicker` as pills, following the household week start

**Files:**
- Modify: `src/client/components/WeekdayPicker.tsx` (imports, the last paragraph of the header doc, `WeekdayPickerCommonProps`, a new `weekdayDisplayOrder`, and the `WeekdayPicker` body)
- Modify: `src/client/admin/DailyBriefingManagement.tsx` (one import line, one hook line and the `<thead>` weekday map at about line 1192)
- Test: `tests/client/weekday-picker.test.tsx`

**Interfaces:**
- Consumes: `PillToggle` (Task 1), `ChoicePills` (Task 2), and `useHouseholdSettings()` from `@/lib/householdSettings` (returns `{ weekStartDay: number | null, ... }`).
- Produces: `weekdayDisplayOrder(weekStartDay: number | null | undefined): readonly WeekdayCode[]` and the new optional prop `weekStartDay?: 0 | 1` on every `WeekdayPicker` mode.

- [ ] **Step 1: Add the failing tests to `tests/client/weekday-picker.test.tsx`.**

Make these edits:
- Change the import from `@/components/WeekdayPicker` to also import `weekdayDisplayOrder`.
- Add the household mock right after the imports.
- Reset the mocked value in the existing `afterEach`.
- Append the two `describe` blocks at the end of the file.

```tsx
// after the imports:
const household = vi.hoisted(() => ({ weekStartDay: null as number | null }));
vi.mock("@/lib/householdSettings", () => ({ useHouseholdSettings: () => household }));

// inside the existing afterEach, add:
household.weekStartDay = null;

// appended at the end of the file:
const SUNDAY_FIRST_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

describe("weekdayDisplayOrder", () => {
  it("puts Sunday first only for a Sunday week start", () => {
    expect(weekdayDisplayOrder(0)).toEqual(["sun", "mon", "tue", "wed", "thu", "fri", "sat"]);
    for (const start of [1, null, undefined, 7]) {
      expect(weekdayDisplayOrder(start)).toEqual(EXPECTED_CODE_ORDER);
    }
  });
});

describe("WeekdayPicker — household week start", () => {
  const shownLabels = () =>
    within(screen.getByRole("group"))
      .getAllByRole("checkbox")
      .map((c) => c.closest("label")?.textContent);

  it("shows Sunday first when the household week starts on Sunday", () => {
    household.weekStartDay = 0;
    render(<WeekdayPicker labels={LABELS} groupLabel="Weekdays" value={[]} onChange={() => {}} />);
    expect(shownLabels()).toEqual(SUNDAY_FIRST_LABELS);
  });

  it("lets the weekStartDay prop override the household setting", () => {
    household.weekStartDay = 0;
    render(
      <WeekdayPicker
        labels={LABELS}
        groupLabel="Weekdays"
        value={[]}
        onChange={() => {}}
        weekStartDay={1}
      />
    );
    expect(shownLabels()).toEqual(EXPECTED_LABEL_ORDER);
  });

  it("still emits the canonical order when shown Sunday first", () => {
    household.weekStartDay = 0;
    const onChange = vi.fn();
    render(
      <WeekdayPicker labels={LABELS} groupLabel="Weekdays" value={["sat"]} onChange={onChange} />
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Sun" }));
    expect(onChange).toHaveBeenCalledWith(["sat", "sun"]);
  });

  it("orders the single-day select and the radio pills by the week start", () => {
    household.weekStartDay = 0;
    render(
      <>
        <WeekdayPicker mode="single" labels={LABELS} groupLabel="Day" value="mon" onChange={() => {}} />
        <WeekdayPicker
          mode="single"
          renderAs="radio"
          labels={LABELS}
          groupLabel="Radio day"
          value="mon"
          onChange={() => {}}
        />
      </>
    );
    expect(
      within(screen.getByRole("combobox", { name: "Day" }))
        .getAllByRole("option")
        .map((o) => o.textContent)
    ).toEqual(SUNDAY_FIRST_LABELS);
    expect(
      within(screen.getByRole("radiogroup", { name: "Radio day" }))
        .getAllByRole("radio")
        .map((r) => r.closest("label")?.textContent)
    ).toEqual(SUNDAY_FIRST_LABELS);
  });
});
```

- [ ] **Step 2:** Run `npx vitest run tests/client/weekday-picker.test.tsx`. Expected: FAIL. `weekdayDisplayOrder` is not exported, and the order tests fail.
- [ ] **Step 3: Edit `src/client/components/WeekdayPicker.tsx`.**

(a) Replace the import block at the top with:

```tsx
import { NATIVE_SELECT_CLASSES } from "@/lib/recipes";
import { useHouseholdSettings } from "@/lib/householdSettings";
import { ChoicePills } from "./ChoicePills";
import { PillToggle } from "./PillToggle";
import { cn } from "@/lib/utils";
```

(b) In the header doc comment, replace its last paragraph (the one beginning "Internally built on `CheckboxField`/`RadioField`") with:

```
 * Rendering: multi mode is a row of compact `PillToggle`s sized to fit one line in a dialog; single
 * mode is a native `<select>` or, with `renderAs="radio"`, `ChoicePills`. Days are SHOWN in the
 * household week-start order (`weekdayDisplayOrder`, from `useHouseholdSettings().weekStartDay`,
 * overridable with the `weekStartDay` prop); values are always EMITTED in
 * `CANONICAL_WEEKDAY_ORDER`, so storage never depends on the display order.
```

(c) Directly after the `CANONICAL_WEEKDAY_ORDER` declaration, add:

```tsx
const SUNDAY_FIRST_ORDER: readonly WeekdayCode[] = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
];

/** The order weekdays are SHOWN in for a household week start (`locale.weekStartDay`: 0 = Sunday,
 * 1 = Monday). Anything but 0 — including null while settings load — is Monday-first. Use it for
 * display-only weekday loops (grids, table headers); store and sort with `CANONICAL_WEEKDAY_ORDER`. */
export function weekdayDisplayOrder(
  weekStartDay: number | null | undefined
): readonly WeekdayCode[] {
  return weekStartDay === 0 ? SUNDAY_FIRST_ORDER : CANONICAL_WEEKDAY_ORDER;
}
```

(d) In `WeekdayPickerCommonProps`, add after `testIdPrefix`:

```tsx
  /** Overrides the household week start (tests, previews). Normally omitted: the picker reads
   * `useHouseholdSettings().weekStartDay`. */
  weekStartDay?: 0 | 1;
```

(e) Replace the whole `export function WeekdayPicker(...) { ... }` with:

```tsx
export function WeekdayPicker(props: WeekdayPickerProps) {
  const { labels, disabled, className, groupLabel, testIdPrefix } = props;
  // Called unconditionally, before the mode branch — hooks cannot sit inside a conditional.
  const household = useHouseholdSettings();
  const order = weekdayDisplayOrder(props.weekStartDay ?? household.weekStartDay);

  if (props.mode === "single") {
    const { value, onChange, renderAs = "select" } = props;

    if (renderAs === "select") {
      return (
        <select
          aria-label={groupLabel}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value as WeekdayCode)}
          className={cn(NATIVE_SELECT_CLASSES, className)}
          data-testid={testIdPrefix ? `${testIdPrefix}-select` : undefined}
        >
          {order.map((day) => (
            <option key={day} value={day}>
              {labels[day]}
            </option>
          ))}
        </select>
      );
    }

    // ChoicePills scopes the native radio group name per instance (useId), so two radio-mode
    // pickers on one page never share a group, with or without a testIdPrefix.
    return (
      <ChoicePills
        value={value}
        onChange={onChange}
        groupLabel={groupLabel}
        disabled={disabled}
        className={className}
        options={order.map((day) => ({
          value: day,
          label: labels[day],
          "data-testid": testIdPrefix ? `${testIdPrefix}-${day}` : undefined,
        }))}
      />
    );
  }

  const { value, onChange, disabledDays } = props;
  /** Always emits in `CANONICAL_WEEKDAY_ORDER`, regardless of click or display order, so callers
   * can save weekdays without sorting them again. */
  const toggle = (day: WeekdayCode) => {
    const next = new Set(value);
    if (next.has(day)) {
      next.delete(day);
    } else {
      next.add(day);
    }
    onChange(CANONICAL_WEEKDAY_ORDER.filter((d) => next.has(d)));
  };

  return (
    <div
      role="group"
      aria-label={groupLabel}
      className={cn("flex flex-wrap gap-1.5", className)}
    >
      {order.map((day) => (
        <PillToggle
          key={day}
          checked={value.includes(day)}
          onChange={() => toggle(day)}
          label={labels[day]}
          disabled={disabled || disabledDays?.includes(day)}
          // Compact padding so seven pills fit one line in a dialog at kiosk density.
          className="px-3"
          data-testid={testIdPrefix ? `${testIdPrefix}-${day}` : undefined}
        />
      ))}
    </div>
  );
}
```

(f) If `CheckboxField`, `RadioField` or `useId` are now unused imports anywhere in the file, they are already gone because of (a). Run `npx tsc --noEmit -p .` (or `npm run typecheck`) to confirm.

- [ ] **Step 4: Keep the Daily briefing matrix header aligned with its pills** (spec D7). In `src/client/admin/DailyBriefingManagement.tsx`:
  - Add `weekdayDisplayOrder,` to the `@/components/WeekdayPicker` import (lines 8–13).
  - Add `import { useHouseholdSettings } from "@/lib/householdSettings";` with the other `@/lib` imports.
  - Directly after `const t = useT();` in `export function DailyBriefingManagement()` (about line 273), add `const { weekStartDay } = useHouseholdSettings();`.
  - In the `<thead>` of `data-testid="daily-briefing-block-matrix"` (about line 1192), change `{CANONICAL_WEEKDAY_ORDER.map((day) => (` to `{weekdayDisplayOrder(weekStartDay).map((day) => (`.
  - Leave every other `CANONICAL_WEEKDAY_ORDER` use (data and storage) untouched.
- [ ] **Step 5: Run the affected unit tests:**

```bash
npx vitest run tests/client/weekday-picker.test.tsx tests/client/time-announcements-management.test.tsx tests/client/announcements-briefing-admin.test.tsx tests/client/daily-briefing-management.test.tsx tests/client/reminders.test.tsx tests/client/routines.test.tsx tests/client/foundation-primitives.test.tsx
```

Expected: PASS. The `daily-briefing-management` failure on `aria-selected` is fixed in Task 5. If it fails only there, continue.
  - If some other test fails with "useHouseholdSettings is not a function", that test file has a `vi.mock("@/lib/householdSettings")` without a `useHouseholdSettings` export. Add `useHouseholdSettings: () => <the same object its useHouseholdSettingsContext returns>` to that mock. Do not change product code to dodge it.
  - If a test asserted a specific weekday markup detail of `CheckboxField` (for example its classes), update it to the pill markup and record the change in your report.

- [ ] **Step 6: Commit.** Prettier the changed files, then `git add -A src/client/components/WeekdayPicker.tsx src/client/admin/DailyBriefingManagement.tsx tests/client && git commit -m "feat(ui): draw weekday pickers as pills in the household week-start order"`

---

### Task 5: Migrate Settings and Briefing member pills; publish the API

**Files:**
- Modify: `src/client/admin/SettingsManagement.tsx` (the local `ChoicePills`, lines ~52–96, and its two uses)
- Modify: `src/client/daily-briefing/admin/BriefingMemberPills.tsx` (whole file; keep `pillMembers` and the props)
- Modify: `src/client/ui.ts`, `COMPONENTS.md` (generated), `docs/ui/component-contract.md`
- Test: `tests/client/settings-management.test.tsx:122-124,218,234`, `tests/client/daily-briefing-management.test.tsx:100-103`, `tests/e2e/admin-settings.spec.ts:54-57`

**Interfaces:**
- Consumes: `ChoicePills` (Task 2), `MemberPills` (Task 3).
- Produces: the `@/ui` exports `ChoicePills`, `ChoicePillsOption`, `ChoicePillsProps`, `MemberPills`, `MemberPillsMember`, `MemberPillsMultiProps`, `MemberPillsProps`, `MemberPillsSingleProps` and `weekdayDisplayOrder`.

- [ ] **Step 1: Update the tests first (failing).**

In `tests/client/settings-management.test.tsx`, lines 122–124 become:

```tsx
    expect(screen.getByRole("radio", { name: "English" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Español" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "Monday" })).toBeChecked();
```

Lines 218 and 234 each become `expect(screen.getByTestId("settings-week-start-0")).toBeChecked();`.

In `tests/client/daily-briefing-management.test.tsx`, replace lines 100–103:

```tsx
    expect(screen.getByTestId("daily-briefing-block-member-member-ada")).toBeChecked();
```

In `tests/e2e/admin-settings.spec.ts`, replace the `toHaveAttribute("aria-checked", "true")` assertion at lines 54–57 with:

```ts
    await expect(page.getByTestId(`settings-week-start-${target}`)).toBeChecked();
```

Run `npx vitest run tests/client/settings-management.test.tsx tests/client/daily-briefing-management.test.tsx`. Expected: FAIL. The current buttons are not checkable, and the tab is not a radio.

- [ ] **Step 2: Settings.** In `src/client/admin/SettingsManagement.tsx`:
  - Delete the local `function ChoicePills<T extends string>(...) {...}` and its doc comment.
  - Add `import { ChoicePills } from "@/components/ChoicePills";`.
  - Add this local wrapper in its place:

```tsx
/** A setting drawn as a caption, a description and a one-of-few choice. */
function ChoiceRow<T extends string>({
  label,
  description,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  description: string;
  value: T;
  options: { value: T; label: string; testId: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-control font-semibold">{label}</span>
      <p className="text-muted-foreground text-control">{description}</p>
      <ChoicePills
        value={value}
        onChange={onChange}
        groupLabel={label}
        disabled={disabled}
        options={options.map((option) => ({
          value: option.value,
          label: option.label,
          "data-testid": option.testId,
        }))}
      />
    </div>
  );
}
```

  Then rename the two `<ChoicePills` uses in `SettingsManagement()` to `<ChoiceRow` and delete their `labelId=...` props. Keep all other props as they are. If `Button` is still used elsewhere in the file (it is, for Retry and Save), keep its import.

- [ ] **Step 3: Briefing.** Replace `src/client/daily-briefing/admin/BriefingMemberPills.tsx` with:

```tsx
import { MemberPills } from "@/components/MemberPills";
import type { MemberDTO } from "../../../shared";

/** Briefing members: active children, plus any adult who has the briefing turned on (spec D8). */
export function pillMembers(members: MemberDTO[], optIns: Record<string, boolean>): MemberDTO[] {
  return members.filter((member) => member.role === "child" || optIns[member.id] === true);
}

interface BriefingMemberPillsProps {
  members: MemberDTO[];
  selectedId: string;
  onSelect: (memberId: string) => void;
  /** `${testIdPrefix}-${member.id}` on each pill. */
  testIdPrefix: string;
  /** Accessible name of the pill group. */
  label: string;
}

/** The briefing's member choice, drawn with the shared single-select `MemberPills`. */
export function BriefingMemberPills({
  members,
  selectedId,
  onSelect,
  testIdPrefix,
  label,
}: BriefingMemberPillsProps) {
  return (
    <MemberPills
      mode="single"
      members={members}
      value={selectedId}
      onChange={onSelect}
      testIdPrefix={testIdPrefix}
      groupLabel={label}
    />
  );
}
```

- [ ] **Step 4: Publish.**
  - In `src/client/ui.ts`, add `export * from "./components/ChoicePills";` after the `CheckboxField` line and `export * from "./components/MemberPills";` after the `Field` line, keeping the list alphabetical. Do not export `PillControl`.
  - Run `npm run generate:ui-catalog` to regenerate `COMPONENTS.md`.
  - In `docs/ui/component-contract.md`, add these rows to the table in section 3, after the "Weekday picker" row:

```markdown
| Choice pills           | the radiogroup, shared native name and pill look of a one-of-few choice |
| Member pills           | member colours, the inactive marker and single/multi member selection   |
```

  Change the "Weekday picker" row's text to `five separate implementations of the same selection, and the household week-start order`. Then run `npx prettier --write docs/ui/component-contract.md` so the table realigns.

- [ ] **Step 5: Verify:**

```bash
npx vitest run tests/client/settings-management.test.tsx tests/client/daily-briefing-management.test.tsx tests/client/daily-briefing-workspace.test.tsx tests/client/announcements-briefing-admin.test.tsx
npm run check:ui-catalog && node --test tools/ui-catalog.test.mjs
npm run typecheck && npm run lint
npm run check:accessible-names
```

Expected: all PASS. If the accessible-names audit reports new NONE/WEAK rows in the new files, fix the markup. Do not add them to the baseline.

- [ ] **Step 6: Commit.** Prettier the changed files, then `git add -A src/client tests COMPONENTS.md docs/ui/component-contract.md && git commit -m "feat(ui): publish ChoicePills and MemberPills and adopt them in Settings and the briefing"`

---

### Task 6: e2e — one-line weekday row in the Assign routine dialog

**Files:**
- Modify: `tests/e2e/admin-routines.spec.ts` (around line 82, inside the existing test; do not rename the test)

- [ ] **Step 1:** Directly after `const row = assign.getByTestId(\`routine-assignment-${memberId}\`);` and before the `.check()` line, add:

```ts
  // The seven weekday pills fit one line inside the dialog.
  const dayTops = await row
    .locator(`input[data-testid^="routines-weekday-${memberId}-"]`)
    .evaluateAll((inputs) => inputs.map((input) => Math.round(input.getBoundingClientRect().top)));
  expect(dayTops).toHaveLength(7);
  expect(new Set(dayTops).size).toBe(1);
```

- [ ] **Step 2:** Run `PORT=43211 MP_E2E_WEATHER_FIXTURE_PORT=44411 MP_E2E_QUOTE_FIXTURE_PORT=44421 npx playwright test tests/e2e/admin-routines.spec.ts tests/e2e/admin-settings.spec.ts --workers=3`. Expected: PASS. If the pills wrap, reduce the weekday gap in `WeekdayPicker` from `gap-1.5` to `gap-1`. Do not shrink the text or the control height, because density rules forbid it. Record what you changed.
- [ ] **Step 3: Commit.** `npx prettier --write tests/e2e/admin-routines.spec.ts && git add tests/e2e/admin-routines.spec.ts && git commit -m "test(e2e): keep the routine weekday pills on one line"`

---

### Task 7: Resync the reviewed inventory (coverage policy and test cohorts)

`tests/fixtures/assembly-cohort.json` does two jobs:
- `coveragePolicy.files` lists every production file under `src/` with its minimum coverage totals and rates.
- `testCohorts.runners.{node,vitest,playwright}.files` lists every test case per runner.

This branch adds three production files (`PillControl.tsx`, `ChoicePills.tsx`, `MemberPills.tsx`), changes five (`PillToggle.tsx`, `WeekdayPicker.tsx`, `SettingsManagement.tsx`, `BriefingMemberPills.tsx`, `DailyBriefingManagement.tsx`), adds two test files and adds test cases. Playwright test titles and ids are unchanged.

**Files:** Modify `tests/fixtures/assembly-cohort.json`. Helper scripts go in your scratchpad directory (`$SCRATCH`), NOT in the repo.

- [ ] **Step 1: Full Vitest run with coverage and JSON results** (from the worktree root):

```bash
mkdir -p .quality
npx vitest run tests/client tests/boundary tests/integration --coverage --reporter=json --outputFile=.quality/vitest-results.json
```

Expected: success.

- [ ] **Step 2: Write `$SCRATCH/resync-cohort.mjs`:**

```js
// Usage: node $SCRATCH/resync-cohort.mjs <production files whose policy to (re)measure...>
// Rebuilds the vitest cohort from .quality/vitest-results.json and updates coveragePolicy
// entries from coverage/coverage-final.json (same aggregation as tools/verify-coverage.mjs).
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const fixturePath = "tests/fixtures/assembly-cohort.json";
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

const report = JSON.parse(fs.readFileSync(".quality/vitest-results.json", "utf8"));
if (report.success !== true) throw new Error("vitest run was not green");
const cases = {};
for (const suite of report.testResults) {
  const file = path.relative(root, suite.name).replaceAll(path.sep, "/");
  cases[file] = (suite.assertionResults ?? []).map((a) => a.fullName);
}
fixture.testCohorts.runners.vitest.files = Object.fromEntries(
  Object.keys(cases).sort().map((file) => [file, cases[file]])
);

const raw = JSON.parse(fs.readFileSync("coverage/coverage-final.json", "utf8"));
const policy = fixture.coveragePolicy.files;
for (const file of Object.keys(policy)) {
  if (!fs.existsSync(file)) delete policy[file];
}
const floor2 = (covered, total) => (total === 0 ? 100 : Math.floor((10000 * covered) / total) / 100);
for (const file of process.argv.slice(2)) {
  const item = raw[path.resolve(root, file)];
  if (!item) throw new Error(`${file} absent from coverage`);
  const lineHits = new Map();
  for (const [id, loc] of Object.entries(item.statementMap)) {
    lineHits.set(loc.start.line, Math.max(lineHits.get(loc.start.line) ?? 0, item.s[id]));
  }
  const agg = (counts) => ({ covered: counts.filter((v) => v > 0).length, total: counts.length });
  const measured = {
    lines: agg([...lineHits.values()]),
    statements: agg(Object.values(item.s)),
    functions: agg(Object.values(item.f)),
    branches: agg(Object.values(item.b).flat()),
  };
  const layer = file.startsWith("src/client/")
    ? "client"
    : file.startsWith("src/server/")
      ? "server"
      : "shared";
  const old = policy[file];
  const entry = { layer, minimumTotals: {}, minimumRates: {} };
  for (const metric of ["lines", "statements", "functions", "branches"]) {
    const { covered, total } = measured[metric];
    entry.minimumTotals[metric] = old ? Math.min(old.minimumTotals[metric], total) : total;
    entry.minimumRates[metric] = old
      ? Math.min(old.minimumRates[metric], floor2(covered, total))
      : floor2(covered, total);
  }
  policy[file] = entry;
  console.log(file, JSON.stringify(measured));
}
fixture.coveragePolicy.files = Object.fromEntries(
  Object.keys(policy).sort().map((file) => [file, policy[file]])
);
fs.writeFileSync(fixturePath, JSON.stringify(fixture, null, 2) + "\n");
```

- [ ] **Step 3: Run it:**

```bash
node "$SCRATCH/resync-cohort.mjs" \
  src/client/components/PillControl.tsx \
  src/client/components/ChoicePills.tsx \
  src/client/components/MemberPills.tsx \
  src/client/components/PillToggle.tsx \
  src/client/components/WeekdayPicker.tsx \
  src/client/admin/SettingsManagement.tsx \
  src/client/daily-briefing/admin/BriefingMemberPills.tsx \
  src/client/admin/DailyBriefingManagement.tsx
```

Read the printed rates. The three new files must be at 100% lines, statements and functions, and at least 90% branches. If a branch is uncovered, add the missing case to `choice-pills.test.tsx` or `member-pills.test.tsx` (not to the product code) and redo Steps 1–3.

- [ ] **Step 4:** Run `npx prettier --write tests/fixtures/assembly-cohort.json` and review `git diff --stat tests/fixtures/assembly-cohort.json`. Only the entries for the files above and the vitest cases should change. Then commit: `git add tests/fixtures/assembly-cohort.json && git commit -m "test: resync the reviewed inventory for the shared admin pills"`

---

### Task 8: Verification gate, commit and report

- [ ] **Step 1: Clean tree.** `git status --porcelain` must print nothing. The gate hashes git-tracked files and rejects untracked ones, and the scratch scripts live outside the repo.
- [ ] **Step 2: Standard gate.** If the worktree is clean, run it there. Otherwise, or if `check:preflight` complains about the checkout, use a detached clean copy:

```bash
git worktree add --detach "$SCRATCH/verify" HEAD
cd "$SCRATCH/verify" && ln -s "<your worktree>/node_modules" node_modules
export MP_CANDIDATE_ID=$(node tools/candidate-identity.mjs)
npm run check:standard
```

Expected: exit 0. If `check:coverage` or `check:test-cohorts:standard` fails:
  1. Fix the fixture in your worktree with Task 7 (rerun its Steps 1–4 there) and commit.
  2. Recreate the verify worktree (`git worktree remove --force "$SCRATCH/verify"`) and rerun the gate on the new HEAD.

If `check:ui-debt` reports more inline styles than before Task 1, you added a `style` outside `PillControl`. Remove it.

- [ ] **Step 3: Affected e2e, final run** (from your worktree):

```bash
PORT=43211 MP_E2E_WEATHER_FIXTURE_PORT=44411 MP_E2E_QUOTE_FIXTURE_PORT=44421 npx playwright test \
  tests/e2e/admin-settings.spec.ts tests/e2e/admin-routines.spec.ts \
  tests/e2e/time-announcements-admin.spec.ts tests/e2e/reminders.spec.ts \
  tests/e2e/reminders-calendar-gated.spec.ts tests/e2e/daily-briefing.spec.ts \
  tests/e2e/calendar.spec.ts tests/e2e/meals.spec.ts tests/e2e/accessible-names-audit.spec.ts \
  --workers=3
```

Expected: all PASS. A failure that clicks a weekday or member testid and then waits for an `aria-*` attribute means that assertion still expects the old markup. Switch it to `toBeChecked()`/`not.toBeChecked()`, commit, and rerun.

- [ ] **Step 4: Commit and report.** Commit anything left (`git add -A && git commit -m "chore(ui): final verification fixes"`, only if there are changes). Do not merge or push.

Write `REPORT-shared-pills.md` in the worktree root. It is the report file the owner asked for; commit it with `git add REPORT-shared-pills.md && git commit -m "docs: report the shared admin pills wave"`. It must contain:
- the branch name and worktree path
- `git log --oneline main..HEAD`
- the last lines of `check:standard`
- the e2e result
- the coverage rates printed in Task 7 Step 3
- the final exported API (copied from the spec, with any deviation flagged)
- anything you skipped or decided differently from the spec, with the reason

Then reply exactly `DONE` followed by the branch name. The spec and plan are committed in the branch; the copies in the main checkout stay untracked.

## Orchestrator addendum (2026-10-15)

- Open question resolved: every weekday control and display follows the household week start. In this wave, also switch the display-only weekday loops listed in spec D9 to `weekdayDisplayOrder(...)`: `RoutineWeekGrid.tsx`, `RemindersManagement.tsx` and `TimeAnnouncementsManagement.tsx` (storage order stays `CANONICAL_WEEKDAY_ORDER`). Update their tests.
- Gate addition: after `check:standard`, also run `npm run check:aggregate-only` (with `PORT=43211 MP_E2E_WEATHER_FIXTURE_PORT=44411 MP_E2E_QUOTE_FIXTURE_PORT=44421`). It verifies the Playwright inventory in `tests/fixtures/assembly-cohort.json` (`testCohorts.runners.playwright.files`, keyed by spec id), which `check:standard` does not; add any new e2e spec there.
