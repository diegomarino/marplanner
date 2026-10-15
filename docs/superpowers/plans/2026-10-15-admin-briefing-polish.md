# Admin Briefing Polish (round 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **For the executing agent:**
>
> - Work in your own git worktree on its own branch (slug `briefing-polish`), branched from `main` **after the shared-pills wave has merged**. Never work in the main checkout.
> - The spec and this plan are untracked in the main checkout (`/Users/diego/Dev/marplanner-project`). Task 0 copies them into your branch.
> - Use TDD: write the failing test, watch it fail, implement, watch it pass.
> - The reference app `/Users/diego/Dev/marplanner` is READ-ONLY. Look at it, never edit it, never use its DB.
> - Do not ask the owner questions. The decisions are in the spec (§4).
> - If this plan contradicts the code you find, trust the code, make the smallest change that meets the spec, and list the deviation in your report.
> - **If a shared component API (`MemberPills`, `ChoicePills`, `WeekdayPicker`/`weekdayDisplayOrder`) differs from this plan when you start, adapt to the real one** and note it in the report.

**Goal:** Make `/admin/daily-briefing` coherent. It gets three scoped tabs (Schedule · Blocks · Briefings) and one compact per-member blocks × weekdays matrix that replaces the "Block order" card and the per-row Enabled + weekday pills. Opt-in gates every member-scoped tab. "Generate briefings" takes a date, and the member selectors use the shared member pills. An independent review loop runs before the gate.

**Architecture:** This is a UI-only change; the server, OpenAPI and FRs stay as they are.

- Pure helpers move out of the 1406-line page into `src/client/daily-briefing/admin/briefingBlocks.ts`.
- The page keeps all data loading and writes, and renders three new presentational units (`BriefingScheduleTab`, `BlockMatrix`, `BriefingMemberBar`) plus the reworked `BriefingWorkspace`.
- The selected member and the selected date are page state shared across tabs.

**Tech Stack:** React 19, TypeScript, Tailwind v4, @dnd-kit (core 6.3.1 / sortable 10.0.0 / utilities 3.2.2, already installed), vitest + @testing-library/react, Playwright. Node 24.21.0, npm.

**Spec:** `docs/superpowers/specs/2026-10-15-admin-briefing-polish-design.md`. Read it first: decisions D1–D17, assumptions A1–A4, and the §8 review loop.

## Global Constraints

- **Language:**
  - Code, identifiers, comments and commit messages are in English.
  - UI strings live in `src/client/i18n/messages.ts`, in en AND es.
  - New keys go in ONE contiguous block per locale, headed `// admin-briefing-polish`, inserted right after `"dailyBriefing.admin.imageError"` (en ≈ line 407, es ≈ line 1886).
  - All new keys use the `dailyBriefing.admin.` prefix, so `tests/client/daily-briefing-i18n-parity.test.ts` covers them.
- **No server, route, schema, OpenAPI, FR or seed change.** Keep the round-1 server behaviour exactly: weekday pause, history, manual print, 202 while rendering, and the paused recheck at write time.
- **Files you must not touch:** `src/client/admin/AdminRoutes.tsx`, `src/client/shell/routes.ts`, `src/shared/**` and `src/server/**`. Add no URL sub-routes.
- **No new shared primitive.** The only shared-component change is the additive `labelHidden?: boolean` prop on `src/client/components/CheckboxField.tsx` (spec D14). Use `MemberPills` and `weekdayDisplayOrder` from the shared-pills wave; never hand-roll pills.
- **Styling:**
  - No raw palette classes such as `bg-amber-50`; use semantic tokens.
  - The only inline style allowed is the dnd-kit transform forward in `BlockMatrix`. It copies `SortableChoreRow.tsx` exactly: CSS custom properties plus the single `// eslint-disable-next-line ui-policy/debt -- …` line.
- **Testids to keep** (other specs pin them):
  - `daily-briefing-management`
  - `daily-briefing-tab-blocks` (the `admin-unlock-resilience.spec.ts` primary action)
  - `daily-briefing-tab-preview` (now labelled "Briefings")
  - `daily-briefing-opt-in-<id>`, with the accessible name `<Name>: Enabled`
  - `daily-briefing-generate`, `daily-briefing-generate-all`, `daily-briefing-generate-all-info`
  - `daily-briefing-admin-generation-time`, `daily-briefing-admin-trigger-binding`, `daily-briefing-admin-settings-save`, `daily-briefing-admin-settings-error`
  - `daily-briefing-schedule-day-<day>`, `daily-briefing-block-matrix`, `daily-briefing-block-weekday-heading-<day>`
  - `daily-briefing-admin-block-settings-row-<type>`, `daily-briefing-admin-block-drag-<type>`
  - `daily-briefing-admin-block-level|difficulty|language-<type>`, `daily-briefing-admin-block-default-disabled-<type>`
  - `daily-briefing-settings-changed`, `daily-briefing-retry`, `daily-briefing-settings-retry`
  - every round-1 workspace testid except `daily-briefing-admin-preview-show`, `daily-briefing-member-select` and `daily-briefing-needs-opt-in`
- **Request bodies for today** stay `{}` (generate-all) and `{memberId}` (generate). Any other date is sent explicitly (spec D7).
- **Shared hot files** that other workers edit in parallel: `messages.ts`, `tests/fixtures/assembly-cohort.json`, `docs/ui/household-contract.md`. Keep your edits minimal and localized.
- **Ports for this work:** `PORT=43224 MP_E2E_WEATHER_FIXTURE_PORT=44424 MP_E2E_QUOTE_FIXTURE_PORT=44434`.

## Review Focus

1. **A legacy row with `enabled:false` and stored weekdays shows as all off.** The first cell switched on must write `{enabled:true, weekdays:[thatDay]}` and must not resurrect the old days. Test: Task 1, `cellToggleInput`.
2. **Unchecking the last on-cell writes `{enabled:false, weekdays:[]}`.** Rechecking all seven writes `weekdays:null`. Test: Task 1.
3. **A Sunday-first household:** matrix headers, pause checkboxes and cells must line up column by column, and the days summary must list Sunday first. Test: Task 3 (matrix with `weekStartDay={0}`) and Task 4 (summary).
4. **Generate for all members on a past date when a member is paused that weekday:** that member's row says "Paused", not "Not generated" and not blank. Test: Task 4.
5. **Opting a member out while they are selected on the Blocks tab:** the matrix must disappear and the opted-out notice must appear without a reload. Turning them back on restores the matrix with their stored settings and does not refetch from defaults. Test: Task 6.

---

## File map

| File                                                         | Change                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/client/daily-briefing/admin/briefingBlocks.ts`          | create: pure helpers, registry mirror, label maps, types                                                                                                                                                                                                         |
| `src/client/components/CheckboxField.tsx`                    | add `labelHidden`                                                                                                                                                                                                                                                |
| `src/client/daily-briefing/admin/BlockMatrix.tsx`            | create                                                                                                                                                                                                                                                           |
| `src/client/daily-briefing/admin/BriefingAutomationCard.tsx` | create                                                                                                                                                                                                                                                           |
| `src/client/daily-briefing/admin/BriefingScheduleTab.tsx`    | create                                                                                                                                                                                                                                                           |
| `src/client/daily-briefing/admin/BriefingMemberBar.tsx`      | create                                                                                                                                                                                                                                                           |
| `src/client/daily-briefing/admin/BriefingWorkspace.tsx`      | rework props (member/date from the page)                                                                                                                                                                                                                         |
| `src/client/daily-briefing/admin/BriefingMemberPills.tsx`    | delete                                                                                                                                                                                                                                                           |
| `src/client/admin/DailyBriefingManagement.tsx`               | rewrite as the page shell (state, loading, writes, tabs)                                                                                                                                                                                                         |
| `src/client/i18n/messages.ts`                                | `// admin-briefing-polish` blocks; delete keys that become unused                                                                                                                                                                                                |
| `docs/ui/household-contract.md`                              | rewrite item 7                                                                                                                                                                                                                                                   |
| Tests (new)                                                  | `tests/client/daily-briefing-blocks.test.ts`, `tests/client/daily-briefing-block-matrix.test.tsx`, `tests/client/daily-briefing-schedule-tab.test.tsx`                                                                                                           |
| Tests (changed)                                              | `checkbox-field.test.tsx`, `daily-briefing-management.test.tsx`, `daily-briefing-workspace.test.tsx`, `daily-briefing-admin.test.tsx`, `announcements-briefing-admin.test.tsx`, `daily-briefing-admin-mirror-fence.test.tsx`, `tests/e2e/daily-briefing.spec.ts` |
| `tests/fixtures/assembly-cohort.json`                        | vitest cases, Playwright ids, coverage                                                                                                                                                                                                                           |

---

## Task 0: Worktree setup

- [ ] **Step 1: Copy the spec and plan into your branch**

```bash
mkdir -p docs/superpowers/specs docs/superpowers/plans
cp /Users/diego/Dev/marplanner-project/docs/superpowers/specs/2026-10-15-admin-briefing-polish-design.md docs/superpowers/specs/
cp /Users/diego/Dev/marplanner-project/docs/superpowers/plans/2026-10-15-admin-briefing-polish.md docs/superpowers/plans/
git add docs/superpowers/specs/2026-10-15-admin-briefing-polish-design.md docs/superpowers/plans/2026-10-15-admin-briefing-polish.md
git commit -m "docs: add the daily briefing coherence pass spec and plan"
```

- [ ] **Step 2: Install and run a baseline**

```bash
cp /Users/diego/Dev/marplanner-project/.env.local . 2>/dev/null || true
fnm exec --using=24.21.0 npm ci
npx vitest run tests/client/daily-briefing-management.test.tsx tests/client/daily-briefing-workspace.test.tsx tests/client/member-pills.test.tsx
```

Expected: PASS.

- `member-pills.test.tsx` exists only once the shared-pills wave has merged. If it is missing, stop and report that the base is wrong.
- Open `src/client/components/MemberPills.tsx` and `src/client/components/WeekdayPicker.tsx` and confirm `MemberPills` (props `mode`, `members`, `value`, `onChange`, `groupLabel`, `testIdPrefix`, per-member `inactiveLabel`) and `weekdayDisplayOrder(weekStartDay)`. Adapt later tasks if they differ.

- [ ] **Step 3: If git is refused in your worktree**

This is known for isolated agent worktrees. Keep working, skip each "Commit" step, and follow Task 11's fallback.

---

## Task 1: Pure helpers module

**Files:**

- Create: `src/client/daily-briefing/admin/briefingBlocks.ts`
- Test: `tests/client/daily-briefing-blocks.test.ts`

**Interfaces:**

- Produces:
  - types `Weekday`, `AutoPrintTrigger`, `BlockParams`, `BlockOrderInstance`, `MemberBlockSettings`, `DailyBriefingSettingsView`, `BlockRegistryType`, `MemberResult`
  - constants `WEEKDAY_LABEL_KEYS`, `ALL_BLOCK_TYPES`, `BLOCK_LABEL_KEYS`, `DEFAULT_DISABLED_BLOCK_TYPES`, `LEVEL_BLOCK_TYPES`, `LEVELS`, `DIFFICULTY_BLOCK_TYPES`, `DIFFICULTIES`, `DIFFICULTY_LABEL_KEYS`, `CORPUS_LANGUAGE_AVAILABILITY`
  - functions:
    - `weekdayLabels(t)`
    - `defaultMemberBlockSettings(memberId, type)`
    - `resolveMemberBlockSettings(list, memberId, type)`
    - `effectiveMatrixBlockTypes(order)`
    - `reorderBlockOrderByType(order, activeType, overType)`
    - `effectiveBlockDays(settings): WeekdayCode[]`
    - `cellToggleInput(settings, day): { enabled: boolean; weekdays: WeekdayCode[] | null }`
    - `weekdayOfDate(date: string): WeekdayCode | null`

- [ ] **Step 1: Write the failing test** `tests/client/daily-briefing-blocks.test.ts`

```ts
import { describe, expect, it } from "vitest";
import {
  ALL_BLOCK_TYPES,
  WEEKDAY_LABEL_KEYS,
  cellToggleInput,
  defaultMemberBlockSettings,
  effectiveBlockDays,
  effectiveMatrixBlockTypes,
  reorderBlockOrderByType,
  resolveMemberBlockSettings,
  weekdayOfDate,
  type MemberBlockSettings,
} from "@/daily-briefing/admin/briefingBlocks";

const ALL = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

function row(partial: Partial<MemberBlockSettings>): MemberBlockSettings {
  return { ...defaultMemberBlockSettings("m1", "weather"), ...partial };
}

describe("briefingBlocks — effective days and cell writes", () => {
  it("treats enabled + null weekdays as every day and disabled as no day", () => {
    expect(effectiveBlockDays(row({ enabled: true, weekdays: null }))).toEqual(ALL);
    expect(effectiveBlockDays(row({ enabled: false, weekdays: ["mon"] }))).toEqual([]);
    expect(effectiveBlockDays(row({ enabled: true, weekdays: ["sun", "mon"] }))).toEqual([
      "mon",
      "sun",
    ]);
  });

  it("switching one cell on in a legacy disabled row writes only that day", () => {
    expect(cellToggleInput(row({ enabled: false, weekdays: ["mon", "tue"] }), "fri")).toEqual({
      enabled: true,
      weekdays: ["fri"],
    });
  });

  it("switching the last cell off disables the block with an empty list", () => {
    expect(cellToggleInput(row({ enabled: true, weekdays: ["wed"] }), "wed")).toEqual({
      enabled: false,
      weekdays: [],
    });
  });

  it("completing all seven days writes null (every day) in canonical order otherwise", () => {
    expect(
      cellToggleInput(
        row({ enabled: true, weekdays: ["mon", "tue", "wed", "thu", "fri", "sat"] }),
        "sun"
      )
    ).toEqual({ enabled: true, weekdays: null });
    expect(cellToggleInput(row({ enabled: true, weekdays: null }), "mon")).toEqual({
      enabled: true,
      weekdays: ["tue", "wed", "thu", "fri", "sat", "sun"],
    });
  });

  it("resolves a missing row to the FR-013 default (onThisDay off)", () => {
    expect(resolveMemberBlockSettings([], "m1", "onThisDay").enabled).toBe(false);
    expect(resolveMemberBlockSettings([], "m1", "dadJoke").enabled).toBe(true);
  });
});

describe("briefingBlocks — order", () => {
  it("lists configured types first, then the rest of the registry once", () => {
    const types = effectiveMatrixBlockTypes([{ type: "weather" }, { type: "weather" }]);
    expect(types[0]).toBe("weather");
    expect(types).toHaveLength(ALL_BLOCK_TYPES.length);
  });

  it("moves a type and keeps repeated instances with their params", () => {
    const order = [
      { type: "dadJoke" },
      { type: "wordOfDay", params: { level: "L1" as const } },
      { type: "wordOfDay", params: { level: "L3" as const } },
    ];
    const next = reorderBlockOrderByType(order, "wordOfDay", "dadJoke");
    expect(next.slice(0, 3)).toEqual([order[1], order[2], order[0]]);
    expect(next).toHaveLength(ALL_BLOCK_TYPES.length + 1);
  });

  it("returns the same array when nothing moves", () => {
    const order = [{ type: "dadJoke" }];
    expect(reorderBlockOrderByType(order, "dadJoke", "dadJoke")).toBe(order);
  });
});

describe("briefingBlocks — dates and labels", () => {
  it("reads a calendar date's weekday without a timezone", () => {
    expect(weekdayOfDate("2026-10-15")).toBe("thu");
    expect(weekdayOfDate("2026-10-18")).toBe("sun");
    expect(weekdayOfDate("not-a-date")).toBeNull();
  });

  it("maps every weekday to its own key", () => {
    for (const day of ALL) {
      expect(WEEKDAY_LABEL_KEYS[day as keyof typeof WEEKDAY_LABEL_KEYS]).toBe(
        `dailyBriefing.admin.weekday.${day}`
      );
    }
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/client/daily-briefing-blocks.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `src/client/daily-briefing/admin/briefingBlocks.ts`

Move these definitions verbatim from `src/client/admin/DailyBriefingManagement.tsx` (lines 70–270) and export each one:

- `WEEKDAY_LABEL_KEYS`, `weekdayLabels`
- the `AutoPrintTrigger`, `BlockParams`, `BlockOrderInstance` and `MemberBlockSettings` types, and `DailyBriefingSettingsView` (with `memberSchedules?: BriefingSchedule[]`)
- `ALL_BLOCK_TYPES`, `BlockRegistryType`, `BLOCK_LABEL_KEYS`
- `effectiveMatrixBlockTypes`, `reorderBlockOrderByType`
- `DEFAULT_DISABLED_BLOCK_TYPES`, `LEVEL_BLOCK_TYPES`, `LEVELS`, `DIFFICULTY_BLOCK_TYPES`, `DIFFICULTIES`, `DIFFICULTY_LABEL_KEYS`
- `CORPUS_LANGUAGE_AVAILABILITY`, `defaultMemberBlockSettings`

Keep the comments that say these mirror `src/server/modules/daily-briefing/corpora/block-types.ts`. Import `CANONICAL_WEEKDAY_ORDER`, `WeekdayCode` and `WeekdayLabels` from `@/components/WeekdayPicker`, `MessageKey` from `@/i18n/messages`, and `BriefingSchedule` and `BriefingStatus` from `../../../shared`. Then append:

```ts
export type Weekday = WeekdayCode;

/** A Schedule-tab result cell: a stored status, or why a generate-all produced nothing. */
export type MemberResult = BriefingStatus | "paused" | "notGenerated";

export function resolveMemberBlockSettings(
  list: readonly MemberBlockSettings[],
  memberId: string,
  blockType: BlockRegistryType
): MemberBlockSettings {
  return (
    list.find((row) => row.memberId === memberId && row.blockType === blockType) ??
    defaultMemberBlockSettings(memberId, blockType)
  );
}

/** The days a block prints (spec D4): `enabled` and `weekdays` collapsed into one set. */
export function effectiveBlockDays(settings: MemberBlockSettings): WeekdayCode[] {
  if (!settings.enabled) return [];
  if (settings.weekdays === null) return [...CANONICAL_WEEKDAY_ORDER];
  const days = new Set(settings.weekdays);
  return CANONICAL_WEEKDAY_ORDER.filter((day) => days.has(day));
}

/** The block-settings PUT body for toggling one matrix cell (spec D4). */
export function cellToggleInput(
  settings: MemberBlockSettings,
  day: WeekdayCode
): { enabled: boolean; weekdays: WeekdayCode[] | null } {
  const days = new Set(effectiveBlockDays(settings));
  if (days.has(day)) days.delete(day);
  else days.add(day);
  const next = CANONICAL_WEEKDAY_ORDER.filter((d) => days.has(d));
  return {
    enabled: next.length > 0,
    weekdays: next.length === CANONICAL_WEEKDAY_ORDER.length ? null : next,
  };
}

const JS_DAY_TO_CODE: readonly WeekdayCode[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** The weekday of a plain `YYYY-MM-DD` date — a calendar date has no timezone (spec A3). */
export function weekdayOfDate(date: string): WeekdayCode | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(day.getTime()) ? null : (JS_DAY_TO_CODE[day.getUTCDay()] ?? null);
}
```

`resolveMemberBlockSettings` here is the client mirror. It shares its name with a server function, but the client cannot import server code.

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run tests/client/daily-briefing-blocks.test.ts`. Expected: PASS.

The page still has its own copies until Task 6. That is fine; `tsc` passes because both compile.

- [ ] **Step 5: Commit**

```bash
git add src/client/daily-briefing/admin/briefingBlocks.ts tests/client/daily-briefing-blocks.test.ts
git commit -m "refactor(briefing): extract the admin block helpers and add cell-write rules"
```

---

## Task 2: `CheckboxField` `labelHidden`

**Files:**

- Modify: `src/client/components/CheckboxField.tsx`
- Test: `tests/client/checkbox-field.test.tsx`

**Interfaces:**

- Produces: `CheckboxFieldProps.labelHidden?: boolean`. When true, the label text is rendered inside `<span className="sr-only">`.

- [ ] **Step 1: Write the failing test.** Append inside `describe("CheckboxField", …)`:

```tsx
it("keeps a hidden label as the accessible name when labelHidden is set", () => {
  render(<CheckboxField checked={false} onChange={() => {}} label="Weather on Mon" labelHidden />);
  const checkbox = screen.getByRole("checkbox", { name: "Weather on Mon" });
  expect(checkbox.closest("label")?.querySelector(".sr-only")?.textContent).toBe("Weather on Mon");
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/client/checkbox-field.test.tsx`. Expected: FAIL (no `.sr-only`).

- [ ] **Step 3: Implement**

In `CheckboxFieldProps`, add:

```ts
  /** Render `label` for assistive tech only (a matrix cell whose row and column headers carry
   * the visible meaning). The wrapping `<label>` still names the checkbox. */
  labelHidden?: boolean;
```

Destructure `labelHidden` in the function signature. Replace the trailing `{label}` with:

```tsx
{
  labelHidden ? <span className="sr-only">{label}</span> : label;
}
```

When the label is hidden, drop the `gap-2`: change the wrapper class to `cn("inline-flex items-center text-control", !labelHidden && "gap-2", disabled && "opacity-50", className)`.

- [ ] **Step 4: Verify**

Run `npx vitest run tests/client/checkbox-field.test.tsx` (PASS) and `npm run check:ui-catalog` (PASS, no change).

- [ ] **Step 5: Commit**

```bash
git add src/client/components/CheckboxField.tsx tests/client/checkbox-field.test.tsx
git commit -m "feat(ui): let CheckboxField hide its label for matrix cells"
```

---

## Task 3: i18n block and `BlockMatrix`

**Files:**

- Modify: `src/client/i18n/messages.ts`
- Create: `src/client/daily-briefing/admin/BlockMatrix.tsx`
- Test: `tests/client/daily-briefing-block-matrix.test.tsx`

**Interfaces:**

- Consumes (Task 1): `ALL_BLOCK_TYPES`, `BLOCK_LABEL_KEYS`, `BlockRegistryType`, `BlockOrderInstance`, `BlockParams`, `MemberBlockSettings`, `effectiveMatrixBlockTypes`, `effectiveBlockDays`, `WEEKDAY_LABEL_KEYS`, `DEFAULT_DISABLED_BLOCK_TYPES`, `LEVEL_BLOCK_TYPES`, `LEVELS`, `DIFFICULTY_BLOCK_TYPES`, `DIFFICULTIES`, `DIFFICULTY_LABEL_KEYS`, `CORPUS_LANGUAGE_AVAILABILITY`. Also `weekdayDisplayOrder` (shared wave) and `CheckboxField.labelHidden` (Task 2).
- Produces:

```ts
export interface BlockMatrixProps {
  memberName: string;
  blockOrder: BlockOrderInstance[];
  resolve: (blockType: BlockRegistryType) => MemberBlockSettings;
  /** The member's briefing days (pause schedule); all seven when none is stored. */
  schedule: readonly WeekdayCode[];
  savingType: BlockRegistryType | null;
  scheduleSaving: boolean;
  orderSaving: boolean;
  /** Overrides the household week start (tests). */
  weekStartDay?: 0 | 1;
  onToggleCell: (blockType: BlockRegistryType, day: WeekdayCode) => void;
  onParamChange: (blockType: BlockRegistryType, patch: Partial<BlockParams>) => void;
  onToggleDay: (day: WeekdayCode) => void;
  onReorder: (activeType: BlockRegistryType, overType: BlockRegistryType) => void;
}
export function BlockMatrix(props: BlockMatrixProps): JSX.Element;
```

- [ ] **Step 1: Add the i18n blocks**

In `messages.ts`, insert after `"dailyBriefing.admin.imageError"` in **en**:

```ts
    // admin-briefing-polish
    "dailyBriefing.admin.pageDescription":
      "Choose who gets a daily briefing and when, what each member's briefing contains, and review, regenerate or print past briefings.",
    "dailyBriefing.admin.tabSchedule": "Schedule",
    "dailyBriefing.admin.tabBlocks": "Blocks",
    "dailyBriefing.admin.tabBriefings": "Briefings",
    "dailyBriefing.admin.memberLabel": "Member",
    "dailyBriefing.admin.offMarker": "off",
    "dailyBriefing.admin.optedOutNotice":
      "The daily briefing is off for {name}. Turn it on to choose blocks and generate briefings.",
    "dailyBriefing.admin.turnOn": "Turn on daily briefing",
    "dailyBriefing.admin.automationTitle": "Automatic generation",
    "dailyBriefing.admin.automationHint":
      "Every day at this time a briefing is generated for each member who has it on.",
    "dailyBriefing.admin.autoPrintLabel": "Auto-print after morning chores",
    "dailyBriefing.admin.generateTitle": "Generate briefings",
    "dailyBriefing.admin.generateAllButton": "Generate for all members",
    "dailyBriefing.admin.generateAllHint":
      "Generates the briefing for this date for every member who has it on. Paused members are skipped.",
    "dailyBriefing.admin.membersTitle": "Members",
    "dailyBriefing.admin.columnBriefing": "Daily briefing",
    "dailyBriefing.admin.columnDays": "Days",
    "dailyBriefing.admin.columnResult": "Result for {date}",
    "dailyBriefing.admin.columnResultNoDate": "Result",
    "dailyBriefing.admin.columnOpen": "Open",
    "dailyBriefing.admin.daysEvery": "Every day",
    "dailyBriefing.admin.daysNone": "Paused every day",
    "dailyBriefing.admin.resultPaused": "Paused",
    "dailyBriefing.admin.resultNotGenerated": "Not generated",
    "dailyBriefing.admin.openBlocksAria": "Open blocks for {name}",
    "dailyBriefing.admin.openBriefingsAria": "Open briefings for {name}",
    "dailyBriefing.admin.openBlocks": "Open Blocks",
    "dailyBriefing.admin.openBriefings": "Open Briefings",
    "dailyBriefing.admin.blocksCaption":
      "Rows are blocks in print order, the same for every member: drag ⠿ to reorder. Tick the days each block prints for {name}; untick a day under “Briefing runs” to pause {name}'s briefing that day.",
    "dailyBriefing.admin.blockColumn": "Block",
    "dailyBriefing.admin.scheduleRowLabel": "Briefing runs",
    "dailyBriefing.admin.dayRunsLabel": "Briefing on {day}",
    "dailyBriefing.admin.cellLabel": "{block} on {day}",
    "dailyBriefing.admin.reorderLabel": "Reorder {block}",
    "dailyBriefing.admin.dragInstructions":
      "Press Space to pick up a block, use the arrow keys to move it, and press Space again to drop it.",
    "dailyBriefing.admin.dragStarted": "Picked up {block}.",
    "dailyBriefing.admin.dragOver": "{block} moved to position {position}.",
    "dailyBriefing.admin.dragEnded": "{block} dropped.",
    "dailyBriefing.admin.dragCancelled": "Reorder cancelled.",
```

and in **es**, after its `"dailyBriefing.admin.imageError"`:

```ts
    // admin-briefing-polish
    "dailyBriefing.admin.pageDescription":
      "Elige quién recibe el resumen diario y cuándo, qué contiene el de cada miembro, y revisa, regenera o imprime resúmenes anteriores.",
    "dailyBriefing.admin.tabSchedule": "Programación",
    "dailyBriefing.admin.tabBlocks": "Bloques",
    "dailyBriefing.admin.tabBriefings": "Resúmenes",
    "dailyBriefing.admin.memberLabel": "Miembro",
    "dailyBriefing.admin.offMarker": "desactivado",
    "dailyBriefing.admin.optedOutNotice":
      "El resumen diario está desactivado para {name}. Actívalo para elegir bloques y generar resúmenes.",
    "dailyBriefing.admin.turnOn": "Activar el resumen diario",
    "dailyBriefing.admin.automationTitle": "Generación automática",
    "dailyBriefing.admin.automationHint":
      "Cada día a esta hora se genera el resumen de cada miembro que lo tiene activado.",
    "dailyBriefing.admin.autoPrintLabel": "Imprimir al terminar las tareas de la mañana",
    "dailyBriefing.admin.generateTitle": "Generar resúmenes",
    "dailyBriefing.admin.generateAllButton": "Generar para todos los miembros",
    "dailyBriefing.admin.generateAllHint":
      "Genera el resumen de esta fecha para cada miembro que lo tiene activado. Se omiten los miembros en pausa.",
    "dailyBriefing.admin.membersTitle": "Miembros",
    "dailyBriefing.admin.columnBriefing": "Resumen diario",
    "dailyBriefing.admin.columnDays": "Días",
    "dailyBriefing.admin.columnResult": "Resultado del {date}",
    "dailyBriefing.admin.columnResultNoDate": "Resultado",
    "dailyBriefing.admin.columnOpen": "Abrir",
    "dailyBriefing.admin.daysEvery": "Todos los días",
    "dailyBriefing.admin.daysNone": "En pausa todos los días",
    "dailyBriefing.admin.resultPaused": "En pausa",
    "dailyBriefing.admin.resultNotGenerated": "No generado",
    "dailyBriefing.admin.openBlocksAria": "Abrir los bloques de {name}",
    "dailyBriefing.admin.openBriefingsAria": "Abrir los resúmenes de {name}",
    "dailyBriefing.admin.openBlocks": "Abrir Bloques",
    "dailyBriefing.admin.openBriefings": "Abrir Resúmenes",
    "dailyBriefing.admin.blocksCaption":
      "Las filas son los bloques en orden de impresión, el mismo para todos: arrastra ⠿ para reordenar. Marca los días en que se imprime cada bloque para {name}; desmarca un día en «Hay resumen» para pausar el resumen de {name} ese día.",
    "dailyBriefing.admin.blockColumn": "Bloque",
    "dailyBriefing.admin.scheduleRowLabel": "Hay resumen",
    "dailyBriefing.admin.dayRunsLabel": "Resumen el {day}",
    "dailyBriefing.admin.cellLabel": "{block} el {day}",
    "dailyBriefing.admin.reorderLabel": "Reordenar {block}",
    "dailyBriefing.admin.dragInstructions":
      "Pulsa Espacio para coger un bloque, muévelo con las flechas y pulsa Espacio otra vez para soltarlo.",
    "dailyBriefing.admin.dragStarted": "{block} cogido.",
    "dailyBriefing.admin.dragOver": "{block} movido a la posición {position}.",
    "dailyBriefing.admin.dragEnded": "{block} soltado.",
    "dailyBriefing.admin.dragCancelled": "Reordenación cancelada.",
```

Then delete the keys the spec (D16) retires, but only after `rtk proxy grep -rn "<key>" src tests` shows no use outside `messages.ts`. Do this deletion in Task 6, once the page no longer uses them.

- [ ] **Step 2: Write the failing test** `tests/client/daily-briefing-block-matrix.test.tsx`

```tsx
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockMatrix, type BlockMatrixProps } from "@/daily-briefing/admin/BlockMatrix";
import {
  defaultMemberBlockSettings,
  type BlockRegistryType,
  type MemberBlockSettings,
} from "@/daily-briefing/admin/briefingBlocks";
import { assertKioskDensityCompliant } from "./helpers/density";
import { injectDensityStyles } from "./helpers/densityStyles";

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-density");
});

const ALL = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

function renderMatrix(overrides: Partial<BlockMatrixProps> = {}, rows: MemberBlockSettings[] = []) {
  const props: BlockMatrixProps = {
    memberName: "Lisa",
    blockOrder: [],
    resolve: (type: BlockRegistryType) =>
      rows.find((r) => r.blockType === type) ?? defaultMemberBlockSettings("m1", type),
    schedule: ALL,
    savingType: null,
    scheduleSaving: false,
    orderSaving: false,
    weekStartDay: 1,
    onToggleCell: vi.fn(),
    onParamChange: vi.fn(),
    onToggleDay: vi.fn(),
    onReorder: vi.fn(),
    ...overrides,
  };
  render(<BlockMatrix {...props} />);
  return props;
}

describe("BlockMatrix", () => {
  it("puts the weekday columns in household week-start order, headers and cells aligned", () => {
    renderMatrix({ weekStartDay: 0 });
    const headings = screen
      .getAllByTestId(/^daily-briefing-block-weekday-heading-/)
      .map((el) => el.dataset.testid?.replace("daily-briefing-block-weekday-heading-", ""));
    expect(headings).toEqual(["sun", "mon", "tue", "wed", "thu", "fri", "sat"]);
    const row = screen.getByTestId("daily-briefing-admin-block-settings-row-weather");
    const cells = within(row)
      .getAllByRole("checkbox")
      .map((el) => el.dataset.testid?.replace("daily-briefing-block-cell-weather-", ""));
    expect(cells).toEqual(["sun", "mon", "tue", "wed", "thu", "fri", "sat"]);
  });

  it("names each cell by block and day and reports toggles", () => {
    const props = renderMatrix();
    const cell = screen.getByRole("checkbox", { name: "Weather on Tue" });
    expect(cell).toBeChecked();
    fireEvent.click(cell);
    expect(props.onToggleCell).toHaveBeenCalledWith("weather", "tue");
  });

  it("shows a disabled block as all off, with onThisDay's default-off note", () => {
    renderMatrix();
    for (const day of ALL) {
      expect(screen.getByTestId(`daily-briefing-block-cell-onThisDay-${day}`)).not.toBeChecked();
    }
    expect(
      screen.getByTestId("daily-briefing-admin-block-default-disabled-onThisDay")
    ).toBeVisible();
  });

  it("disables a paused column's cells but keeps their value, and toggles the pause", () => {
    const props = renderMatrix({ schedule: ["mon", "tue", "wed", "thu", "fri"] });
    expect(screen.getByTestId("daily-briefing-schedule-day-sun")).not.toBeChecked();
    expect(screen.getByTestId("daily-briefing-block-cell-weather-sun")).toBeDisabled();
    expect(screen.getByTestId("daily-briefing-block-cell-weather-sun")).toBeChecked();
    expect(screen.getByTestId("daily-briefing-block-cell-weather-mon")).toBeEnabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Briefing on Sun" }));
    expect(props.onToggleDay).toHaveBeenCalledWith("sun");
  });

  it("disables only the saving row, and the pause row while the schedule saves", () => {
    renderMatrix({ savingType: "weather", scheduleSaving: true });
    expect(screen.getByTestId("daily-briefing-block-cell-weather-mon")).toBeDisabled();
    expect(screen.getByTestId("daily-briefing-block-cell-dadJoke-mon")).toBeEnabled();
    expect(screen.getByTestId("daily-briefing-schedule-day-mon")).toBeDisabled();
  });

  it("offers params inline and reports changes", () => {
    const props = renderMatrix();
    fireEvent.change(screen.getByTestId("daily-briefing-admin-block-difficulty-trivia"), {
      target: { value: "hard" },
    });
    expect(props.onParamChange).toHaveBeenCalledWith("trivia", { difficulty: "hard" });
    fireEvent.change(screen.getByTestId("daily-briefing-admin-block-level-wordOfDay"), {
      target: { value: "" },
    });
    expect(props.onParamChange).toHaveBeenCalledWith("wordOfDay", { level: undefined });
  });

  it("names the drag handles and disables them while the order saves", () => {
    renderMatrix({ orderSaving: true });
    expect(screen.getByRole("button", { name: "Reorder Weather" })).toBeDisabled();
  });

  it("meets kiosk density", async () => {
    const uninject = await injectDensityStyles({
      extraCandidates: ["size-[var(--control-height)]"],
    });
    document.documentElement.setAttribute("data-density", "kiosk");
    try {
      renderMatrix();
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });
});
```

If `assertKioskDensityCompliant` flags the native `<select>`s, look at how `tests/client/announcements-briefing-admin.test.tsx` handles the round-1 matrix (it already passes with these selects) and mirror its `injectDensityStyles` candidates.

- [ ] **Step 3: Run it and confirm it fails**

Run: `npx vitest run tests/client/daily-briefing-block-matrix.test.tsx`. Expected: FAIL (module not found).

- [ ] **Step 4: Implement** `src/client/daily-briefing/admin/BlockMatrix.tsx`

```tsx
import type { CSSProperties } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { NATIVE_SELECT_CLASSES } from "@/lib/recipes";
import { useHouseholdSettings } from "@/lib/householdSettings";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { CheckboxField } from "@/components/CheckboxField";
import { weekdayDisplayOrder, type WeekdayCode } from "@/components/WeekdayPicker";
import {
  BLOCK_LABEL_KEYS,
  CORPUS_LANGUAGE_AVAILABILITY,
  DEFAULT_DISABLED_BLOCK_TYPES,
  DIFFICULTIES,
  DIFFICULTY_BLOCK_TYPES,
  DIFFICULTY_LABEL_KEYS,
  LEVEL_BLOCK_TYPES,
  LEVELS,
  WEEKDAY_LABEL_KEYS,
  effectiveBlockDays,
  effectiveMatrixBlockTypes,
  type BlockOrderInstance,
  type BlockParams,
  type BlockRegistryType,
  type MemberBlockSettings,
} from "./briefingBlocks";

export interface BlockMatrixProps {
  memberName: string;
  blockOrder: BlockOrderInstance[];
  resolve: (blockType: BlockRegistryType) => MemberBlockSettings;
  /** The member's briefing days (pause schedule); all seven when none is stored. */
  schedule: readonly WeekdayCode[];
  savingType: BlockRegistryType | null;
  scheduleSaving: boolean;
  orderSaving: boolean;
  /** Overrides the household week start (tests). */
  weekStartDay?: 0 | 1;
  onToggleCell: (blockType: BlockRegistryType, day: WeekdayCode) => void;
  onParamChange: (blockType: BlockRegistryType, patch: Partial<BlockParams>) => void;
  onToggleDay: (day: WeekdayCode) => void;
  onReorder: (activeType: BlockRegistryType, overType: BlockRegistryType) => void;
}

/** Blocks × weekdays for one member (spec D3/D4; reference BlockMatrix.tsx). Row order is the
 * household block order; cells are the member's per-block days; the "Briefing runs" row is the
 * member's pause schedule. Presentational: the page owns every write. */
export function BlockMatrix(props: BlockMatrixProps) {
  const t = useT();
  const household = useHouseholdSettings();
  const days = weekdayDisplayOrder(props.weekStartDay ?? household.weekStartDay);
  const types = effectiveMatrixBlockTypes(props.blockOrder);
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(TouchSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const blockName = (id: UniqueIdentifier) => {
    const key = BLOCK_LABEL_KEYS[String(id) as BlockRegistryType];
    return key ? t(key) : String(id);
  };
  const dayName = (day: WeekdayCode) => t(WEEKDAY_LABEL_KEYS[day]);

  function handleDragEnd(event: DragEndEvent) {
    if (!event.over || props.orderSaving || event.active.id === event.over.id) return;
    props.onReorder(
      String(event.active.id) as BlockRegistryType,
      String(event.over.id) as BlockRegistryType
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
        accessibility={{
          screenReaderInstructions: { draggable: t("dailyBriefing.admin.dragInstructions") },
          announcements: {
            onDragStart: ({ active }) =>
              t("dailyBriefing.admin.dragStarted").replace("{block}", blockName(active.id)),
            onDragOver: ({ active, over }) =>
              over
                ? t("dailyBriefing.admin.dragOver")
                    .replace("{block}", blockName(active.id))
                    .replace(
                      "{position}",
                      String(types.indexOf(String(over.id) as BlockRegistryType) + 1)
                    )
                : "",
            onDragEnd: ({ active }) =>
              t("dailyBriefing.admin.dragEnded").replace("{block}", blockName(active.id)),
            onDragCancel: () => t("dailyBriefing.admin.dragCancelled"),
          },
        }}
      >
        <table className="w-full border-collapse text-sm" data-testid="daily-briefing-block-matrix">
          <thead>
            <tr className="bg-muted">
              <th scope="col" className="border-b px-3 py-2 text-left">
                {t("dailyBriefing.admin.blockColumn")}
              </th>
              {days.map((day) => (
                <th
                  key={day}
                  scope="col"
                  className="border-b px-1 py-2 text-center font-medium"
                  data-testid={`daily-briefing-block-weekday-heading-${day}`}
                >
                  {dayName(day)}
                </th>
              ))}
            </tr>
            <tr className="bg-muted/60">
              <th scope="row" className="border-b px-3 py-1 text-left font-medium">
                {t("dailyBriefing.admin.scheduleRowLabel")}
              </th>
              {days.map((day) => (
                <td key={day} className="border-b px-1 py-1 text-center">
                  <CheckboxField
                    data-testid={`daily-briefing-schedule-day-${day}`}
                    checked={props.schedule.includes(day)}
                    disabled={props.scheduleSaving}
                    onChange={() => props.onToggleDay(day)}
                    label={t("dailyBriefing.admin.dayRunsLabel").replace("{day}", dayName(day))}
                    labelHidden
                    className="justify-center"
                  />
                </td>
              ))}
            </tr>
          </thead>
          <SortableContext items={types} strategy={verticalListSortingStrategy}>
            <tbody data-testid="daily-briefing-admin-block-settings-list">
              {types.map((type, index) => (
                <BlockRow
                  key={type}
                  type={type}
                  index={index}
                  days={days}
                  settings={props.resolve(type)}
                  schedule={props.schedule}
                  saving={props.savingType === type}
                  orderSaving={props.orderSaving}
                  dayName={dayName}
                  onToggleCell={props.onToggleCell}
                  onParamChange={props.onParamChange}
                />
              ))}
            </tbody>
          </SortableContext>
        </table>
      </DndContext>
    </div>
  );
}

interface BlockRowProps {
  type: BlockRegistryType;
  index: number;
  days: readonly WeekdayCode[];
  settings: MemberBlockSettings;
  schedule: readonly WeekdayCode[];
  saving: boolean;
  orderSaving: boolean;
  dayName: (day: WeekdayCode) => string;
  onToggleCell: BlockMatrixProps["onToggleCell"];
  onParamChange: BlockMatrixProps["onParamChange"];
}

function BlockRow({
  type,
  index,
  days,
  settings,
  schedule,
  saving,
  orderSaving,
  dayName,
  onToggleCell,
  onParamChange,
}: BlockRowProps) {
  const t = useT();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: type,
    disabled: orderSaving,
  });
  const label = t(BLOCK_LABEL_KEYS[type]);
  const on = new Set(effectiveBlockDays(settings));
  const languages = CORPUS_LANGUAGE_AVAILABILITY[type];

  return (
    <tr
      ref={setNodeRef}
      data-testid={`daily-briefing-admin-block-settings-row-${type}`}
      // eslint-disable-next-line ui-policy/debt -- DnD frame values only forward CSS custom properties; token classes own presentation.
      style={
        {
          "--drag-transform": CSS.Transform.toString(transform) ?? "none",
          "--drag-transition": transition ?? "none",
        } as CSSProperties
      }
      className={cn(
        "[transform:var(--drag-transform)] [transition:var(--drag-transition)]",
        index % 2 === 0 ? "bg-card" : "bg-muted/30",
        isDragging && "opacity-70"
      )}
    >
      <th scope="row" className="border-b px-2 py-1 text-left align-middle font-normal">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="shrink-0 cursor-grab touch-none active:cursor-grabbing"
            aria-label={t("dailyBriefing.admin.reorderLabel").replace("{block}", label)}
            disabled={orderSaving}
            data-testid={`daily-briefing-admin-block-drag-${type}`}
            {...attributes}
            {...listeners}
          >
            <GripVertical aria-hidden="true" className="size-4" />
          </Button>
          <span className="font-medium">{label}</span>
          {DEFAULT_DISABLED_BLOCK_TYPES.has(type) && (
            <span
              className="text-xs text-muted-foreground"
              data-testid={`daily-briefing-admin-block-default-disabled-${type}`}
            >
              {t("dailyBriefing.admin.onThisDayDefaultDisabledNote")}
            </span>
          )}
          {LEVEL_BLOCK_TYPES.has(type) && (
            <ParamSelect
              label={t("dailyBriefing.admin.blockLevelLabel")}
              testId={`daily-briefing-admin-block-level-${type}`}
              value={settings.params?.level ?? ""}
              disabled={saving}
              options={LEVELS.map((level) => ({ value: level, label: level }))}
              onChange={(value) =>
                onParamChange(type, {
                  level: value === "" ? undefined : (value as BlockParams["level"]),
                })
              }
            />
          )}
          {DIFFICULTY_BLOCK_TYPES.has(type) && (
            <ParamSelect
              label={t("dailyBriefing.admin.blockDifficultyLabel")}
              testId={`daily-briefing-admin-block-difficulty-${type}`}
              value={settings.params?.difficulty ?? ""}
              disabled={saving}
              options={DIFFICULTIES.map((d) => ({ value: d, label: t(DIFFICULTY_LABEL_KEYS[d]) }))}
              onChange={(value) =>
                onParamChange(type, { difficulty: value === "" ? undefined : value })
              }
            />
          )}
          {languages && (
            <ParamSelect
              label={t("dailyBriefing.admin.blockLanguageLabel")}
              testId={`daily-briefing-admin-block-language-${type}`}
              value={settings.params?.language ?? ""}
              disabled={saving}
              options={languages.map((language) => ({
                value: language,
                label: t(
                  language === "es"
                    ? "dailyBriefing.admin.language.es"
                    : "dailyBriefing.admin.language.en"
                ),
              }))}
              onChange={(value) =>
                onParamChange(type, { language: value === "" ? undefined : value })
              }
            />
          )}
        </div>
      </th>
      {days.map((day) => {
        const paused = !schedule.includes(day);
        return (
          <td key={day} className={cn("border-b px-1 py-1 text-center", paused && "bg-muted")}>
            <CheckboxField
              data-testid={`daily-briefing-block-cell-${type}-${day}`}
              checked={on.has(day)}
              disabled={saving || paused}
              onChange={() => onToggleCell(type, day)}
              label={t("dailyBriefing.admin.cellLabel")
                .replace("{block}", label)
                .replace("{day}", dayName(day))}
              labelHidden
              className="justify-center"
            />
          </td>
        );
      })}
    </tr>
  );
}

function ParamSelect({
  label,
  testId,
  value,
  disabled,
  options,
  onChange,
}: {
  label: string;
  testId: string;
  value: string;
  disabled: boolean;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <Label className="flex items-center gap-1 text-xs">
      {label}
      <select
        data-testid={testId}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={NATIVE_SELECT_CLASSES}
      >
        <option value="">—</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Label>
  );
}
```

If `npm run lint` rejects the raw `<select>` (`ui-policy/raw-controls`), copy the exact per-line disable that the round-1 `DailyBriefingManagement.tsx` selects use. The same select markup passed lint there.

- [ ] **Step 5: Run it and confirm it passes**

Run `npx vitest run tests/client/daily-briefing-block-matrix.test.tsx tests/client/daily-briefing-i18n-parity.test.ts` and `npx eslint src/client/daily-briefing/admin/BlockMatrix.tsx`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/client/i18n/messages.ts src/client/daily-briefing/admin/BlockMatrix.tsx tests/client/daily-briefing-block-matrix.test.tsx
git commit -m "feat(briefing): compact blocks x weekdays matrix with touch and keyboard reorder"
```

---

## Task 4: Schedule tab (automation, generate briefings, members table)

**Files:**

- Create: `src/client/daily-briefing/admin/BriefingAutomationCard.tsx`
- Create: `src/client/daily-briefing/admin/BriefingScheduleTab.tsx`
- Test: `tests/client/daily-briefing-schedule-tab.test.tsx`

**Interfaces:**

- Consumes: `MemberResult`, `WEEKDAY_LABEL_KEYS`, `AutoPrintTrigger` (Task 1); `weekdayDisplayOrder`; `MemberDTO` and `BriefingSchedule` from `../../../shared`.
- Produces:

```ts
export interface AutomationSettings {
  generationTime: string;
  autoPrintBound: boolean;
}
export function BriefingAutomationCard(props: {
  stored: AutomationSettings;
  onSaved: (next: AutomationSettings) => void;
}): JSX.Element;

export type BriefingTab = "schedule" | "blocks" | "preview";
export interface ScheduleResults {
  date: string | null;
  statuses: Record<string, MemberResult>;
}
export interface BriefingScheduleTabProps {
  members: MemberDTO[];
  optIns: Record<string, boolean>;
  pendingOptInIds: ReadonlySet<string>;
  optInLocked: boolean; // generate-all running or a workspace action running
  onOptInChange: (memberId: string, enabled: boolean) => void;
  /** null until settings load; then member id → briefing days. */
  schedules: Record<string, WeekdayCode[]> | null;
  automation: AutomationSettings | null; // null = settings not loaded
  onAutomationSaved: (next: AutomationSettings) => void;
  date: string | null;
  today: string | null;
  onDateChange: (date: string) => void;
  generatingAll: boolean;
  canGenerateAll: boolean;
  generateAllInfo: string | null;
  onGenerateAll: () => void;
  results: ScheduleResults | null;
  onOpen: (memberId: string, tab: Exclude<BriefingTab, "schedule">) => void;
  weekStartDay?: 0 | 1;
}
export function scheduleSummary(
  days: readonly WeekdayCode[] | undefined,
  order: readonly WeekdayCode[],
  t: (key: MessageKey) => string
): string;
```

- [ ] **Step 1: Write the failing test** `tests/client/daily-briefing-schedule-tab.test.tsx`

```tsx
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BriefingScheduleTab,
  scheduleSummary,
  type BriefingScheduleTabProps,
} from "@/daily-briefing/admin/BriefingScheduleTab";
import { BriefingAutomationCard } from "@/daily-briefing/admin/BriefingAutomationCard";
import { messages } from "@/i18n/messages";

afterEach(cleanup);

const t = (key: keyof typeof messages.en) => messages.en[key];
const member = (id: string, name: string) => ({
  id,
  displayName: name,
  colorKey: "blue" as const,
  role: "child" as const,
  lifecycle: "active" as const,
  createdAt: 1,
  updatedAt: 1,
  birthDate: null,
});

function renderTab(overrides: Partial<BriefingScheduleTabProps> = {}) {
  const props: BriefingScheduleTabProps = {
    members: [member("m-lisa", "Lisa"), member("m-bart", "Bart")],
    optIns: { "m-lisa": true },
    pendingOptInIds: new Set(),
    optInLocked: false,
    onOptInChange: vi.fn(),
    schedules: { "m-lisa": ["mon", "tue", "wed", "thu", "fri"] },
    automation: { generationTime: "06:00", autoPrintBound: false },
    onAutomationSaved: vi.fn(),
    date: null,
    today: "2026-10-15",
    onDateChange: vi.fn(),
    generatingAll: false,
    canGenerateAll: true,
    generateAllInfo: null,
    onGenerateAll: vi.fn(),
    results: null,
    onOpen: vi.fn(),
    weekStartDay: 1,
    ...overrides,
  };
  render(<BriefingScheduleTab {...props} />);
  return props;
}

describe("scheduleSummary", () => {
  const monFirst = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
  const sunFirst = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
  it("says every day, paused every day, or the days in display order", () => {
    expect(scheduleSummary(undefined, monFirst, t)).toBe("Every day");
    expect(scheduleSummary([], monFirst, t)).toBe("Paused every day");
    expect(scheduleSummary(["mon", "sun"], sunFirst, t)).toBe("Sun, Mon");
  });
});

describe("BriefingScheduleTab", () => {
  it("lists every member with the opt-in, days and open buttons", () => {
    const props = renderTab();
    expect(screen.getByRole("checkbox", { name: "Lisa: Enabled" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Bart: Enabled" })).not.toBeChecked();
    expect(screen.getByTestId("daily-briefing-member-days-m-lisa")).toHaveTextContent(
      "Mon, Tue, Wed, Thu, Fri"
    );
    expect(screen.getByTestId("daily-briefing-member-days-m-bart")).toHaveTextContent("—");
    fireEvent.click(screen.getByTestId("daily-briefing-opt-in-m-bart"));
    expect(props.onOptInChange).toHaveBeenCalledWith("m-bart", true);
    fireEvent.click(screen.getByRole("button", { name: "Open blocks for Bart" }));
    expect(props.onOpen).toHaveBeenCalledWith("m-bart", "blocks");
    fireEvent.click(screen.getByTestId("daily-briefing-open-briefings-m-lisa"));
    expect(props.onOpen).toHaveBeenCalledWith("m-lisa", "preview");
  });

  it("shows the household today in the date input and reports a new date", () => {
    const props = renderTab();
    const input = screen.getByTestId("daily-briefing-generate-date");
    expect(input).toHaveValue("2026-10-15");
    fireEvent.change(input, { target: { value: "2026-10-12" } });
    expect(props.onDateChange).toHaveBeenCalledWith("2026-10-12");
  });

  it("titles the result column with the date and shows each member's result", () => {
    renderTab({
      date: "2026-10-12",
      results: { date: "2026-10-12", statuses: { "m-lisa": "ready", "m-bart": "paused" } },
    });
    expect(screen.getByText("Result for 2026-10-12")).toBeVisible();
    expect(screen.getByTestId("daily-briefing-member-status-m-lisa")).toHaveTextContent("Ready");
    expect(screen.getByTestId("daily-briefing-member-status-m-bart")).toHaveTextContent("Paused");
  });

  it("hides results that belong to another date", () => {
    renderTab({
      date: "2026-10-13",
      results: { date: "2026-10-12", statuses: { "m-lisa": "ready" } },
    });
    expect(screen.getByTestId("daily-briefing-member-status-m-lisa")).toHaveTextContent("—");
  });

  it("disables Generate for all members when it cannot run, with the hint", () => {
    renderTab({ canGenerateAll: false, optIns: {} });
    expect(screen.getByTestId("daily-briefing-generate-all")).toBeDisabled();
    expect(screen.getByText("Enable Daily Briefing for a member before generating.")).toBeVisible();
  });

  it("does not render the automation card until settings load", () => {
    renderTab({ automation: null, schedules: null });
    expect(screen.queryByTestId("daily-briefing-admin-settings-save")).toBeNull();
    expect(screen.getByTestId("daily-briefing-member-days-m-lisa")).toHaveTextContent("—");
  });
});

describe("BriefingAutomationCard", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));

  it("enables Save only while a value differs from the stored one, then saves", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          generationTime: "07:30",
          autoPrintTrigger: "morning_complete",
          updatedAt: 1,
        }),
        { status: 200 }
      )
    );
    const onSaved = vi.fn();
    render(
      <BriefingAutomationCard
        stored={{ generationTime: "06:00", autoPrintBound: false }}
        onSaved={onSaved}
      />
    );
    const save = screen.getByTestId("daily-briefing-admin-settings-save");
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByTestId("daily-briefing-admin-generation-time"), {
      target: { value: "07:30" },
    });
    expect(save).toBeEnabled();
    fireEvent.change(screen.getByTestId("daily-briefing-admin-generation-time"), {
      target: { value: "06:00" },
    });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByTestId("daily-briefing-admin-generation-time"), {
      target: { value: "07:30" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Auto-print after morning chores" }));
    fireEvent.click(save);
    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith({ generationTime: "07:30", autoPrintBound: true })
    );
    expect(JSON.parse(String(vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.body))).toEqual({
      generationTime: "07:30",
      autoPrintTrigger: "morning_complete",
    });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/client/daily-briefing-schedule-tab.test.tsx`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `BriefingAutomationCard.tsx`

```tsx
import { useEffect, useState } from "react";
import { useT } from "@/i18n";
import { authFetch } from "@/lib/credential";
import { LocalizedApiError, responseMessage } from "@/lib/api-error";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckboxField } from "@/components/CheckboxField";
import { ErrorNotice } from "@/components/ErrorNotice";

export interface AutomationSettings {
  generationTime: string;
  autoPrintBound: boolean;
}

/** Household-wide automatic generation (spec D10). Save is enabled only while the draft differs
 * from the stored values. The trigger is sent as a BINDING ("morning_complete" | null). */
export function BriefingAutomationCard({
  stored,
  onSaved,
}: {
  stored: AutomationSettings;
  onSaved: (next: AutomationSettings) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(stored);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setDraft(stored), [stored.generationTime, stored.autoPrintBound]);

  const dirty =
    draft.generationTime !== stored.generationTime ||
    draft.autoPrintBound !== stored.autoPrintBound;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const response = await authFetch("/api/daily-briefing/settings", {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          generationTime: draft.generationTime,
          autoPrintTrigger: draft.autoPrintBound ? "morning_complete" : null,
        }),
      });
      if (!response.ok) {
        throw new LocalizedApiError(
          await responseMessage(response, t("dailyBriefing.admin.settingsSaveError"))
        );
      }
      const snapshot = (await response.json()) as {
        generationTime: string;
        autoPrintTrigger: "morning_complete" | null;
      };
      onSaved({
        generationTime: snapshot.generationTime,
        autoPrintBound: snapshot.autoPrintTrigger === "morning_complete",
      });
    } catch (cause) {
      setError(
        cause instanceof LocalizedApiError
          ? cause.message
          : t("dailyBriefing.admin.settingsSaveError")
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card data-testid="daily-briefing-admin-settings">
      <CardHeader>
        <CardTitle>{t("dailyBriefing.admin.automationTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ErrorNotice message={error} data-testid="daily-briefing-admin-settings-error" />
        <Label className="flex flex-col items-start gap-1">
          {t("dailyBriefing.admin.generationTimeLabel")}
          <Input
            type="time"
            data-testid="daily-briefing-admin-generation-time"
            value={draft.generationTime}
            disabled={saving}
            onChange={(event) => setDraft({ ...draft, generationTime: event.target.value })}
            className="w-32"
          />
        </Label>
        <CheckboxField
          data-testid="daily-briefing-admin-trigger-binding"
          checked={draft.autoPrintBound}
          disabled={saving}
          onChange={(checked) => setDraft({ ...draft, autoPrintBound: checked })}
          label={t("dailyBriefing.admin.autoPrintLabel")}
        />
        <p className="text-sm text-muted-foreground">{t("dailyBriefing.admin.automationHint")}</p>
        <Button
          type="button"
          className="w-fit"
          data-testid="daily-briefing-admin-settings-save"
          disabled={!dirty || saving}
          onClick={() => void save()}
        >
          {saving
            ? t("dailyBriefing.admin.settingsSaving")
            : t("dailyBriefing.admin.settingsSaveButton")}
        </Button>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 4: Implement** `BriefingScheduleTab.tsx`

```tsx
import { useT } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";
import { cn } from "@/lib/utils";
import { useHouseholdSettings } from "@/lib/householdSettings";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckboxField } from "@/components/CheckboxField";
import { weekdayDisplayOrder, type WeekdayCode } from "@/components/WeekdayPicker";
import { BriefingAutomationCard, type AutomationSettings } from "./BriefingAutomationCard";
import { MEMBER_DOT_CLASS } from "@/components/MemberPills";
import { WEEKDAY_LABEL_KEYS, type MemberResult } from "./briefingBlocks";
import type { MemberDTO } from "../../../shared";

export type BriefingTab = "schedule" | "blocks" | "preview";
export interface ScheduleResults {
  date: string | null;
  statuses: Record<string, MemberResult>;
}
export interface BriefingScheduleTabProps {
  members: MemberDTO[];
  optIns: Record<string, boolean>;
  pendingOptInIds: ReadonlySet<string>;
  optInLocked: boolean;
  onOptInChange: (memberId: string, enabled: boolean) => void;
  schedules: Record<string, WeekdayCode[]> | null;
  automation: AutomationSettings | null;
  onAutomationSaved: (next: AutomationSettings) => void;
  date: string | null;
  today: string | null;
  onDateChange: (date: string) => void;
  generatingAll: boolean;
  canGenerateAll: boolean;
  generateAllInfo: string | null;
  onGenerateAll: () => void;
  results: ScheduleResults | null;
  onOpen: (memberId: string, tab: Exclude<BriefingTab, "schedule">) => void;
  weekStartDay?: 0 | 1;
}

const RESULT_KEYS: Record<MemberResult, MessageKey> = {
  ready: "dailyBriefing.status.ready",
  partial: "dailyBriefing.status.partial",
  pending: "dailyBriefing.status.pending",
  failed: "dailyBriefing.status.failed",
  "render-failed": "dailyBriefing.status.render-failed",
  paused: "dailyBriefing.admin.resultPaused",
  notGenerated: "dailyBriefing.admin.resultNotGenerated",
};

/** "Every day" | "Paused every day" | the days in display order (spec D8). */
export function scheduleSummary(
  days: readonly WeekdayCode[] | undefined,
  order: readonly WeekdayCode[],
  t: (key: MessageKey) => string
): string {
  if (days === undefined || days.length === order.length) return t("dailyBriefing.admin.daysEvery");
  if (days.length === 0) return t("dailyBriefing.admin.daysNone");
  return order
    .filter((day) => days.includes(day))
    .map((day) => t(WEEKDAY_LABEL_KEYS[day]))
    .join(", ");
}

/** Household scope (spec D1/D8/D10): automatic generation, generate for a date, who receives it. */
export function BriefingScheduleTab(props: BriefingScheduleTabProps) {
  const t = useT();
  const household = useHouseholdSettings();
  const order = weekdayDisplayOrder(props.weekStartDay ?? household.weekStartDay);
  const shownDate = props.date ?? props.today;
  const results = props.results && props.results.date === shownDate ? props.results.statuses : null;
  const anyOn = props.members.some((member) => props.optIns[member.id]);

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-6 lg:grid-cols-2">
        {props.automation && (
          <BriefingAutomationCard stored={props.automation} onSaved={props.onAutomationSaved} />
        )}
        <Card>
          <CardHeader>
            <CardTitle>{t("dailyBriefing.admin.generateTitle")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap items-end gap-3">
              <Label className="flex flex-col items-start gap-1">
                {t("dailyBriefing.admin.previewDateLabel")}
                <Input
                  type="date"
                  data-testid="daily-briefing-generate-date"
                  value={shownDate ?? ""}
                  onChange={(event) => event.target.value && props.onDateChange(event.target.value)}
                  className="w-44"
                />
              </Label>
              <Button
                type="button"
                data-testid="daily-briefing-generate-all"
                disabled={!props.canGenerateAll || props.generatingAll}
                onClick={props.onGenerateAll}
              >
                {props.generatingAll
                  ? t("dailyBriefing.management.generating")
                  : t("dailyBriefing.admin.generateAllButton")}
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              {anyOn
                ? t("dailyBriefing.admin.generateAllHint")
                : t("dailyBriefing.management.noOptedInMembers")}
            </p>
            {props.generateAllInfo && (
              <p
                className="text-control text-muted-foreground"
                data-testid="daily-briefing-generate-all-info"
                role="status"
                aria-live="polite"
              >
                {props.generateAllInfo}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("dailyBriefing.admin.membersTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          {props.members.length === 0 ? (
            <p className="text-control text-muted-foreground">
              {t("dailyBriefing.management.noActiveMembers")}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table
                className="w-full border-collapse text-sm"
                data-testid="daily-briefing-members-table"
              >
                <thead>
                  <tr className="text-left">
                    <th scope="col" className="border-b px-2 py-2">
                      {t("dailyBriefing.admin.memberLabel")}
                    </th>
                    <th scope="col" className="border-b px-2 py-2">
                      {t("dailyBriefing.admin.columnBriefing")}
                    </th>
                    <th scope="col" className="border-b px-2 py-2">
                      {t("dailyBriefing.admin.columnDays")}
                    </th>
                    <th scope="col" className="border-b px-2 py-2">
                      {shownDate
                        ? t("dailyBriefing.admin.columnResult").replace("{date}", shownDate)
                        : t("dailyBriefing.admin.columnResultNoDate")}
                    </th>
                    <th scope="col" className="border-b px-2 py-2">
                      {t("dailyBriefing.admin.columnOpen")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {props.members.map((member) => {
                    const on = Boolean(props.optIns[member.id]);
                    const pending = props.pendingOptInIds.has(member.id);
                    const result = results?.[member.id];
                    const enabledText = pending
                      ? t("dailyBriefing.management.optInSaving")
                      : t("dailyBriefing.management.optIn");
                    return (
                      <tr key={member.id} data-testid={`daily-briefing-member-row-${member.id}`}>
                        <th scope="row" className="border-b px-2 py-2 text-left font-medium">
                          <span className="inline-flex items-center gap-2">
                            <span
                              aria-hidden="true"
                              className={cn(
                                "size-3 rounded-full border border-background",
                                MEMBER_DOT_CLASS[member.colorKey]
                              )}
                            />
                            {member.displayName}
                          </span>
                        </th>
                        <td className="border-b px-2 py-2">
                          <CheckboxField
                            checked={on}
                            disabled={pending || props.optInLocked}
                            data-testid={`daily-briefing-opt-in-${member.id}`}
                            onChange={(checked) => props.onOptInChange(member.id, checked)}
                            label={enabledText}
                            aria-label={`${member.displayName}: ${enabledText}`}
                          />
                        </td>
                        <td
                          className="border-b px-2 py-2"
                          data-testid={`daily-briefing-member-days-${member.id}`}
                        >
                          {on && props.schedules
                            ? scheduleSummary(props.schedules[member.id], order, t)
                            : "—"}
                        </td>
                        <td
                          className="border-b px-2 py-2"
                          data-testid={`daily-briefing-member-status-${member.id}`}
                        >
                          {result ? t(RESULT_KEYS[result]) : "—"}
                        </td>
                        <td className="border-b px-2 py-2">
                          <span className="flex flex-wrap gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              data-testid={`daily-briefing-open-blocks-${member.id}`}
                              aria-label={t("dailyBriefing.admin.openBlocksAria").replace(
                                "{name}",
                                member.displayName
                              )}
                              onClick={() => props.onOpen(member.id, "blocks")}
                            >
                              {t("dailyBriefing.admin.tabBlocks")}
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              data-testid={`daily-briefing-open-briefings-${member.id}`}
                              aria-label={t("dailyBriefing.admin.openBriefingsAria").replace(
                                "{name}",
                                member.displayName
                              )}
                              onClick={() => props.onOpen(member.id, "preview")}
                            >
                              {t("dailyBriefing.admin.tabBriefings")}
                            </Button>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
```

Two points to check in this code:

- `MEMBER_DOT_CLASS`: shared-pills spec D4 moved it into `MemberPills.tsx`. If that file does not export it, add `export` to its declaration there (a one-word change in a shared file; record it), or import it from wherever the wave put it. Do not copy the map.
- `aria-label` on the Open buttons: the accessible-names audit prefers a visible name. If `check:accessible-names` flags the mismatch (visible "Blocks" vs name "Open blocks for Bart"), drop the `aria-label`. The test then uses `data-testid` instead of the role name.

- [ ] **Step 5: Run it and confirm it passes**

Run: `npx vitest run tests/client/daily-briefing-schedule-tab.test.tsx`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/client/daily-briefing/admin/BriefingAutomationCard.tsx src/client/daily-briefing/admin/BriefingScheduleTab.tsx tests/client/daily-briefing-schedule-tab.test.tsx
git commit -m "feat(briefing): Schedule tab with automation, generate briefings for a date and members"
```

---

## Task 5: Member bar with the opted-out gate, and the workspace rework

**Files:**

- Create: `src/client/daily-briefing/admin/BriefingMemberBar.tsx`
- Modify: `src/client/daily-briefing/admin/BriefingWorkspace.tsx`
- Delete: `src/client/daily-briefing/admin/BriefingMemberPills.tsx`
- Test: `tests/client/daily-briefing-workspace.test.tsx`

**Interfaces:**

- Produces:

```ts
export function BriefingMemberBar(props: {
  members: MemberDTO[];
  optIns: Record<string, boolean>;
  selectedId: string;
  onSelect: (memberId: string) => void;
  turnOnPending: boolean;
  onTurnOn: (memberId: string) => void;
}): JSX.Element;

export interface BriefingWorkspaceProps {
  member: MemberDTO; // opted in: the page gates
  date: string | null; // page date; null = household today
  today: string | null; // household today from the shell timezone, when known
  onDateChange: (date: string) => void;
  active: boolean; // Briefings tab visible
  blocked: boolean; // generate-all running or an opt-in PUT pending
  refreshKey: number; // bumped after Generate briefings
  onGenerated: (briefing: Briefing) => void;
  onBusyChange: (busy: boolean) => void;
  onOpenBlocks: () => void;
}
```

- [ ] **Step 1: Implement** `BriefingMemberBar.tsx`

```tsx
import { useT } from "@/i18n";
import { Button } from "@/components/ui/button";
import { MemberPills } from "@/components/MemberPills";
import type { MemberDTO } from "../../../shared";

/** One member choice for Blocks and Briefings (spec D5) plus the opted-out gate notice (D9). */
export function BriefingMemberBar({
  members,
  optIns,
  selectedId,
  onSelect,
  turnOnPending,
  onTurnOn,
}: {
  members: MemberDTO[];
  optIns: Record<string, boolean>;
  selectedId: string;
  onSelect: (memberId: string) => void;
  turnOnPending: boolean;
  onTurnOn: (memberId: string) => void;
}) {
  const t = useT();
  const selected = members.find((member) => member.id === selectedId);
  const off = t("dailyBriefing.admin.offMarker");
  return (
    <div className="flex flex-col gap-4">
      <MemberPills
        mode="single"
        members={members.map((member) => ({
          ...member,
          inactiveLabel: optIns[member.id] ? undefined : off,
        }))}
        value={selectedId || null}
        onChange={onSelect}
        groupLabel={t("dailyBriefing.admin.memberLabel")}
        testIdPrefix="daily-briefing-member-pill"
      />
      {selected && !optIns[selected.id] && (
        <div
          className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted px-4 py-3 text-control"
          data-testid="daily-briefing-opted-out"
        >
          <p>{t("dailyBriefing.admin.optedOutNotice").replace("{name}", selected.displayName)}</p>
          <Button
            type="button"
            data-testid="daily-briefing-turn-on"
            disabled={turnOnPending}
            onClick={() => onTurnOn(selected.id)}
          >
            {t("dailyBriefing.admin.turnOn")}
          </Button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Retarget the workspace tests first** (`tests/client/daily-briefing-workspace.test.tsx`)

`renderWorkspace` must render the new props. Replace its props with:

```tsx
<BriefingWorkspace
  member={ben}
  date={null}
  today={null}
  onDateChange={onDateChange}
  active
  blocked={false}
  refreshKey={0}
  onGenerated={onGenerated}
  onBusyChange={() => {}}
  onOpenBlocks={onOpenBlocks}
/>
```

Make it a small stateful harness: `function Harness() { const [date, setDate] = useState<string|null>(null); … }`, so date changes flow back as they do on the page. Keep every test title (the cohort pins them) except these:

- "disables Generate for a member without the briefing turned on" → replace it with **"offers Open Blocks from the paused notice"**: it clicks `daily-briefing-paused-open-blocks` after the paused response and expects `onOpenBlocks` to have been called.
- "Show loads any typed date and refetches the image" → rename to **"changing the date loads that date and refetches the image"**: it changes `daily-briefing-admin-preview-date` and expects the read and the image for the new date, with no Show button.
- "keeps the history when the current member is selected again" → **delete** it. Member selection is now the page's job, and the workspace is keyed by member.

The paused-notice text now ends with "in Blocks" (the `{blocks}` placeholder is the tab name).

- [ ] **Step 3: Run it and confirm it fails**

Run: `npx vitest run tests/client/daily-briefing-workspace.test.tsx`. Expected: FAIL (props mismatch).

- [ ] **Step 4: Rework** `BriefingWorkspace.tsx`

1. Replace the props interface with `BriefingWorkspaceProps` above.
2. Delete:
   - the `memberId`, `selectedDate` and `dateInput` state
   - `currentMember`
   - `selectMember`, `showTypedDate`
   - the `useEffect` on `members`
   - the `BriefingMemberPills` element, the sr-only `<select>`
   - the `members.length === 0` branch
   - `optedIn` and the `daily-briefing-needs-opt-in` paragraph
   - the `daily-briefing-admin-preview-show` button
3. Derive the state:

```ts
const memberId = member.id;
const activeDate = date ?? history?.today ?? today;
const isToday = date === null || date === (history?.today ?? today);
```

4. Make the reads depend on `refreshKey`:

```ts
useEffect(() => {
  if (active) void loadHistory();
}, [active, refreshKey]);
useEffect(() => {
  if (active && activeDate) void loadRead(activeDate);
}, [active, activeDate, version, refreshKey]);
```

`loadHistory()` and `loadRead(date)` lose their `forMember` parameter and use `memberId`. Keep the `latestRead` guard. 5. History entry `onClick={() => onDateChange(entry.date)}`. `aria-pressed` stays `entry.date === activeDate`. 6. The date input:

```tsx
<Input
  type="date"
  data-testid="daily-briefing-admin-preview-date"
  value={activeDate ?? ""}
  onChange={(event) => event.target.value && onDateChange(event.target.value)}
  className="w-40"
/>
```

Move it into the actions row, before Generate, so date and actions read as one line. The image refetch on a date change comes from `BriefingImage`'s own `date` dependency. 7. In `generate()`:

- the body is `isToday ? { memberId } : { memberId, date: activeDate }`
- the guard becomes `if (blocked || generating) return;`
- after success: `if (result.date !== activeDate) onDateChange(result.date); setVersion(v => v + 1); void loadHistory(); onGenerated(result);`
- drop the `currentMember` check (the page keys the component by member)

8. The paused notice: `.replace("{name}", member.displayName)`, and `.replace("{blocks}", t("dailyBriefing.admin.tabBlocks"))`. Render it with a button:

```tsx
{
  notice && (
    <div className="flex flex-wrap items-center gap-3">
      <p role="status" aria-live="polite" data-testid={notice.testId} className="text-control">
        {notice.text}
      </p>
      {notice.testId === "daily-briefing-paused-notice" && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="daily-briefing-paused-open-blocks"
          onClick={onOpenBlocks}
        >
          {t("dailyBriefing.admin.openBlocks")}
        </Button>
      )}
    </div>
  );
}
```

9. Pass `version + refreshKey` as `BriefingImage`'s `version`, so a Generate briefings run refetches the image.

- [ ] **Step 5: Delete the old pills and verify**

Delete `BriefingMemberPills.tsx`; `rtk proxy grep -rn "BriefingMemberPills\|pillMembers" src tests` must return nothing once Task 6 is done. Run `npx vitest run tests/client/daily-briefing-workspace.test.tsx`. Expected: PASS. (The page compiles again only after Task 6, so run `tsc` there.)

- [ ] **Step 6: Commit**

```bash
git add -A src/client/daily-briefing/admin tests/client/daily-briefing-workspace.test.tsx
git commit -m "feat(briefing): shared member bar with the opted-out gate; workspace follows the page member and date"
```

---

## Task 6: Rewrite the page shell

**Files:**

- Modify (rewrite): `src/client/admin/DailyBriefingManagement.tsx`
- Modify: `src/client/i18n/messages.ts` (delete the keys that are now unused)
- Test: `tests/client/daily-briefing-management.test.tsx`

**Interfaces:**

- Consumes everything from Tasks 1–5.
- Produces: `export function DailyBriefingManagement(): JSX.Element`. It has no other exports. `WEEKDAY_LABEL_KEYS` and the other helpers live in `briefingBlocks.ts`.

- [ ] **Step 1: Rewrite the management tests.** These go in `tests/client/daily-briefing-management.test.tsx`.

Keep the helpers (`activeMembers`, `jsonResponse`, `workspaceResponse`, `renderManagement`). Add a `settingsResponse(overrides)` helper that returns the settings view with `memberSchedules: []` by default. Each case below is either a renamed old title or a new one; keep the old title wherever it still holds, because the cohort pins titles.

1. **"restores the v1-like Blocks and Preview / Generate workspaces"** becomes **"opens on Schedule and offers Blocks and Briefings tabs for the selected member"**.
   - Schedule is selected by default and the members table is visible.
   - Click `daily-briefing-tab-blocks`: `daily-briefing-member-pill-member-ada` is checked (Ada is opted in) and `daily-briefing-block-matrix` is visible.
   - Click `daily-briefing-tab-preview`: the same pill is still checked and `daily-briefing-generate` is visible.
2. **"reorders block rows by drag and persists the complete effective order"** becomes **"keyboard reorder persists the complete effective order and reverts on failure"**.
   - Use `fireEvent.keyDown(handle, { key: " ", code: "Space" })`, then `ArrowUp`, then `Space`, on `daily-briefing-admin-block-drag-weather`.
   - dnd-kit's KeyboardSensor uses rects, which are all zero in jsdom. If the move does not happen in jsdom, replace this case with one that renders the page and drives `BlockMatrix`'s `onReorder`.
     - Do that through `vi.mock("@/daily-briefing/admin/BlockMatrix", …)`, which captures the props and calls `props.onReorder("weather", "shotgun")`.
     - Assert: the PUT body has length 21 and starts with weather; on a 400 response the row order returns to the previous one and `daily-briefing-blocks-error` shows.
   - The real drag is covered by the e2e in Task 9.
3. **"posts the empty Generate-all body and renders every returned member status"**: keep the title.
   - Stay on Schedule and click `daily-briefing-generate-all`. The body is exactly `"{}"`.
   - Statuses: `daily-briefing-member-status-member-ada` has text "Ready" and `-ben` has "Partial". The cell shows the status only; "Ada: Ready" no longer applies.
   - Both members must be opted in so the button is enabled.
4. New: **"Generate for all members on another date sends that date and marks paused members"**.
   - Opt-ins: ada and ben. Ben's schedule is `["mon","tue","wed","thu","fri"]`.
   - Change `daily-briefing-generate-date` to `2026-10-18` (a Sunday). Generate returns `{status:"completed", count:1, generated:[{memberId:"member-ada", status:"ready"}]}`.
   - Assert the body is `{"date":"2026-10-18"}`, ben's status is "Paused" and ada's is "Ready".
5. **"renders an already_running Generate-all response as a non-error informational message"**: keep the title.
   - Remove the `daily-briefing-member-select` step.
   - Instead, click `daily-briefing-tab-preview` and continue with the pill already selected.
   - The rest stays as it is.
6. **"keeps Generate-all disabled while an earlier opt-in PUT is still pending"**: keep the title.
   - Toggle `daily-briefing-opt-in-member-ben` on Schedule while the PUT hangs.
   - Assert `daily-briefing-generate-all` is disabled.
   - Switch to Briefings (Ada selected): `daily-briefing-generate` is disabled.
   - Remove the member-select lines.
7. **"pauses a weekday for the selected member, disables that column and shows the notice"**: keep the title.
   - Click `daily-briefing-tab-blocks` first.
   - Replace `daily-briefing-admin-block-weekday-weather-<day>` with `daily-briefing-block-cell-weather-<day>`.
   - Add: click `daily-briefing-settings-changed-open`, then `daily-briefing-tab-preview` is `aria-selected=true`.
8. New: **"an opted-out member is gated on Blocks and Briefings until turned on"**.
   - Ben is off, and Ada is on and selected by default.
   - Go to Blocks and click `daily-briefing-member-pill-member-ben`. `daily-briefing-opted-out` is visible and `daily-briefing-block-matrix` is absent.
   - Click `daily-briefing-turn-on`: a PUT to `/api/daily-briefing/opt-in/member-ben` with `{enabled:true}`. The matrix appears and no new settings GET was made; count the `/api/daily-briefing/settings` calls (1).
   - Then opt Ben out from Schedule and go back to Blocks: the notice is back (Review Focus 5).
9. New: **"toggling a cell writes the effective day set for that block"**.
   - `memberBlockSettings` holds `[{memberId:"member-ada", blockType:"dadJoke", enabled:false, weekdays:["mon"], params:null, updatedAt:1}]`.
   - Click `daily-briefing-block-cell-dadJoke-fri`. The PUT goes to `/api/daily-briefing/block-settings/member-ada/dadJoke` with body `{enabled:true, weekdays:["fri"]}`.
10. **"offers Retry when members fail to load, and when settings fail to load"**: keep the title.
    - The after-retry assertion becomes `daily-briefing-member-row-member-ben` visible.
    - Settings: `daily-briefing-settings-load-error` is visible. Then Retry, go to Blocks, and the matrix is visible (Ada must be opted in for it to render).
11. **"titles the page with its sidebar label"**: unchanged.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/client/daily-briefing-management.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Rewrite** `src/client/admin/DailyBriefingManagement.tsx`

```tsx
import { LocalizedApiError, responseMessage } from "@/lib/api-error";
import { useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/credential";
import { useT } from "@/i18n";
import { useHouseholdSettings } from "@/lib/householdSettings";
import { todayInHouseholdTimezone } from "@/lib/household-date";
import { AdminPanel } from "@/components/AdminPanel";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Button } from "@/components/ui/button";
import { CANONICAL_WEEKDAY_ORDER, type WeekdayCode } from "@/components/WeekdayPicker";
import { BlockMatrix } from "@/daily-briefing/admin/BlockMatrix";
import { BriefingMemberBar } from "@/daily-briefing/admin/BriefingMemberBar";
import { BriefingWorkspace } from "@/daily-briefing/admin/BriefingWorkspace";
import {
  BriefingScheduleTab,
  type BriefingTab,
  type ScheduleResults,
} from "@/daily-briefing/admin/BriefingScheduleTab";
import type { AutomationSettings } from "@/daily-briefing/admin/BriefingAutomationCard";
import {
  cellToggleInput,
  reorderBlockOrderByType,
  resolveMemberBlockSettings,
  weekdayOfDate,
  type BlockOrderInstance,
  type BlockParams,
  type BlockRegistryType,
  type DailyBriefingSettingsView,
  type MemberBlockSettings,
  type MemberResult,
} from "@/daily-briefing/admin/briefingBlocks";
import type { BriefingSchedule, GenerateAllResponse, MemberDTO, OptInState } from "../../shared";

/* DailyBriefingManagement — the Briefing admin page (spec 2026-10-15-admin-briefing-polish).
 * Three scoped tabs: Schedule (household: automatic generation, generate for a date, who gets
 * it), Blocks (member: blocks × weekdays and the pause row) and Briefings (member + date:
 * history, regenerate, view, print). The member and the date are page state shared by the tabs.
 * Opt-in lives only in the Schedule members table; an opted-out member is gated on the member
 * tabs. Settings writes never regenerate (FR-025); none of the handlers below call /generate
 * except the explicit Generate actions. No destructive action exists, so no ConfirmDialog. */

type SettingsData = {
  automation: AutomationSettings;
  blockOrder: BlockOrderInstance[];
  blockSettings: MemberBlockSettings[];
  schedules: Record<string, WeekdayCode[]>;
};

const TAB_LABEL_KEYS = {
  schedule: "dailyBriefing.admin.tabSchedule",
  blocks: "dailyBriefing.admin.tabBlocks",
  preview: "dailyBriefing.admin.tabBriefings",
} as const;

export function DailyBriefingManagement() {
  const t = useT();
  const { timezone } = useHouseholdSettings();
  const today = timezone ? todayInHouseholdTimezone(timezone) : null;

  const [tab, setTab] = useState<BriefingTab>("schedule");
  const [members, setMembers] = useState<MemberDTO[]>([]);
  const [optIns, setOptIns] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [membersLoadFailed, setMembersLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingOptIns, setPendingOptIns] = useState<Set<string>>(() => new Set());

  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsLoadError, setSettingsLoadError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState("");
  const [date, setDate] = useState<string | null>(null);

  const [generatingAll, setGeneratingAll] = useState(false);
  const [generateAllInfo, setGenerateAllInfo] = useState<string | null>(null);
  const [results, setResults] = useState<ScheduleResults | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const generationRequestId = useRef(0);

  const [blocksError, setBlocksError] = useState<string | null>(null);
  const [savingType, setSavingType] = useState<BlockRegistryType | null>(null);
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [orderSaving, setOrderSaving] = useState(false);
  const [settingsChanged, setSettingsChanged] = useState(false);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);

  useEffect(() => {
    void loadMembers();
    void loadSettings();
  }, []);

  async function loadMembers() {
    setLoading(true);
    setError(null);
    setMembersLoadFailed(false);
    try {
      const [membersResponse, optInsResponse] = await Promise.all([
        authFetch("/api/members", { credentials: "include" }),
        authFetch("/api/daily-briefing/opt-in", { credentials: "include" }),
      ]);
      if (!membersResponse.ok || !optInsResponse.ok) throw new Error("load members failed");
      const all = (await membersResponse.json()) as MemberDTO[];
      const states = (await optInsResponse.json()) as OptInState[];
      const active = all.filter((member) => member.lifecycle === "active");
      const nextOptIns = Object.fromEntries(states.map((s) => [s.memberId, s.enabled]));
      setMembers(active);
      setOptIns(nextOptIns);
      setSelectedId(
        (current) => current || (active.find((m) => nextOptIns[m.id]) ?? active[0])?.id || ""
      );
    } catch {
      setError(t("dailyBriefing.management.loadError"));
      setMembersLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }

  async function loadSettings() {
    setSettingsLoading(true);
    setSettingsLoadError(null);
    try {
      const response = await authFetch("/api/daily-briefing/settings", { credentials: "include" });
      if (!response.ok) throw new Error("load settings failed");
      // Defensive on shape (admin-gate-panel-reset.test.tsx feeds every panel a generic 200).
      const data = (await response.json()) as Partial<DailyBriefingSettingsView>;
      setSettings({
        automation: {
          generationTime: typeof data.generationTime === "string" ? data.generationTime : "06:00",
          autoPrintBound: data.autoPrintTrigger === "morning_complete",
        },
        blockOrder: Array.isArray(data.blockOrder) ? data.blockOrder : [],
        blockSettings: Array.isArray(data.memberBlockSettings) ? data.memberBlockSettings : [],
        schedules: Object.fromEntries(
          (Array.isArray(data.memberSchedules) ? data.memberSchedules : []).map(
            (s: BriefingSchedule) => [s.memberId, s.weekdays]
          )
        ),
      });
    } catch {
      setSettings(null);
      setSettingsLoadError(t("dailyBriefing.admin.settingsLoadError"));
    } finally {
      setSettingsLoading(false);
    }
  }

  async function setOptIn(memberId: string, enabled: boolean) {
    setPendingOptIns((previous) => new Set(previous).add(memberId));
    setError(null);
    setGenerateAllInfo(null);
    try {
      const response = await authFetch(`/api/daily-briefing/opt-in/${memberId}`, {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!response.ok) {
        throw new LocalizedApiError(
          await responseMessage(response, t("dailyBriefing.management.optInError"))
        );
      }
      const state = (await response.json()) as OptInState;
      generationRequestId.current += 1;
      setOptIns((previous) => ({ ...previous, [state.memberId]: state.enabled }));
      if (!state.enabled) {
        setResults((previous) => {
          if (!previous || previous.statuses[state.memberId] === undefined) return previous;
          const statuses = { ...previous.statuses };
          delete statuses[state.memberId];
          return { ...previous, statuses };
        });
      }
    } catch (cause) {
      setError(
        cause instanceof LocalizedApiError
          ? cause.message
          : t("dailyBriefing.management.optInError")
      );
    } finally {
      setPendingOptIns((previous) => {
        const next = new Set(previous);
        next.delete(memberId);
        return next;
      });
    }
  }

  const optedIn = members.filter((member) => optIns[member.id]);
  const hasPendingOptIns = pendingOptIns.size > 0;
  const selected = members.find((member) => member.id === selectedId);
  const selectedOn = Boolean(selected && optIns[selected.id]);

  async function generateAll() {
    if (hasPendingOptIns || optedIn.length === 0) return;
    const requestId = ++generationRequestId.current;
    const target = date ?? today;
    setGeneratingAll(true);
    setError(null);
    setGenerateAllInfo(null);
    try {
      const response = await authFetch("/api/daily-briefing/generate-all", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        // Midnight-safe (spec D7): today is resolved by the server.
        body: JSON.stringify(date && date !== today ? { date } : {}),
      });
      if (!response.ok) {
        throw new LocalizedApiError(
          await responseMessage(response, t("dailyBriefing.management.generateAllError"))
        );
      }
      const result = (await response.json()) as GenerateAllResponse;
      if (generationRequestId.current !== requestId) return;
      if (result.status === "already_running") {
        setGenerateAllInfo(t("dailyBriefing.management.generateAllAlreadyRunning"));
        return;
      }
      const statuses: Record<string, MemberResult> = Object.fromEntries(
        result.generated.map(({ memberId, status }) => [memberId, status])
      );
      const weekday = target ? weekdayOfDate(target) : null;
      for (const member of optedIn) {
        if (statuses[member.id] !== undefined) continue;
        const days = settings?.schedules[member.id] ?? CANONICAL_WEEKDAY_ORDER;
        statuses[member.id] = weekday && !days.includes(weekday) ? "paused" : "notGenerated";
      }
      setResults({ date: target, statuses });
      setRefreshKey((value) => value + 1);
    } catch (cause) {
      if (generationRequestId.current === requestId) {
        setError(
          cause instanceof LocalizedApiError
            ? cause.message
            : t("dailyBriefing.management.generateAllError")
        );
      }
    } finally {
      setGeneratingAll(false);
    }
  }

  async function putJson(url: string, body: unknown, fallback: string): Promise<unknown> {
    const response = await authFetch(url, {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new LocalizedApiError(await responseMessage(response, fallback));
    return response.json();
  }

  function blockWriteFailed(cause: unknown, fallback: string) {
    setBlocksError(cause instanceof LocalizedApiError ? cause.message : fallback);
  }

  async function saveBlock(
    type: BlockRegistryType,
    input: { enabled?: boolean; weekdays?: WeekdayCode[] | null; params?: BlockParams }
  ) {
    if (!settings || !selected) return;
    setSavingType(type);
    setBlocksError(null);
    const fallback = t("dailyBriefing.admin.blockSettingsSaveError");
    try {
      const updated = (await putJson(
        `/api/daily-briefing/block-settings/${selected.id}/${type}`,
        input,
        fallback
      )) as MemberBlockSettings;
      setSettings(
        (previous) =>
          previous && {
            ...previous,
            blockSettings: [
              ...previous.blockSettings.filter(
                (row) => !(row.memberId === updated.memberId && row.blockType === updated.blockType)
              ),
              updated,
            ],
          }
      );
      setSettingsChanged(true);
    } catch (cause) {
      blockWriteFailed(cause, fallback);
    } finally {
      setSavingType((current) => (current === type ? null : current));
    }
  }

  async function toggleDay(day: WeekdayCode) {
    if (!settings || !selected) return;
    const current = new Set(settings.schedules[selected.id] ?? CANONICAL_WEEKDAY_ORDER);
    if (current.has(day)) current.delete(day);
    else current.add(day);
    const weekdays = CANONICAL_WEEKDAY_ORDER.filter((d) => current.has(d));
    setScheduleSaving(true);
    setBlocksError(null);
    const fallback = t("dailyBriefing.admin.scheduleSaveError");
    try {
      const saved = (await putJson(
        `/api/daily-briefing/schedule/${selected.id}`,
        { weekdays },
        fallback
      )) as BriefingSchedule;
      setSettings(
        (previous) =>
          previous && {
            ...previous,
            schedules: { ...previous.schedules, [saved.memberId]: saved.weekdays },
          }
      );
      setSettingsChanged(true);
    } catch (cause) {
      blockWriteFailed(cause, fallback);
    } finally {
      setScheduleSaving(false);
    }
  }

  async function reorder(activeType: BlockRegistryType, overType: BlockRegistryType) {
    if (!settings) return;
    const previous = settings.blockOrder;
    const next = reorderBlockOrderByType(previous, activeType, overType);
    if (next === previous) return;
    setSettings((s) => s && { ...s, blockOrder: next });
    setOrderSaving(true);
    setBlocksError(null);
    const fallback = t("dailyBriefing.admin.blockOrderSaveError");
    try {
      // Body is the ordered array itself; a type may repeat (INV-05).
      const data = (await putJson("/api/daily-briefing/block-order", next, fallback)) as {
        blockOrder: BlockOrderInstance[];
      };
      setSettings((s) => s && { ...s, blockOrder: data.blockOrder });
      setSettingsChanged(true);
    } catch (cause) {
      setSettings((s) => s && { ...s, blockOrder: previous });
      blockWriteFailed(cause, fallback);
    } finally {
      setOrderSaving(false);
    }
  }

  function selectMember(memberId: string) {
    setSelectedId(memberId);
    setSettingsChanged(false);
    setBlocksError(null);
  }

  // Keep the selection valid if the selected member disappears (archived elsewhere + Retry).
  useEffect(() => {
    if (!loading && selectedId && !members.some((m) => m.id === selectedId)) {
      setSelectedId(members[0]?.id ?? "");
    }
  }, [loading, members, selectedId]);

  if (loading && members.length === 0 && !membersLoadFailed) {
    return (
      <AdminPanel title={t("admin.sidebar.briefing")} data-testid="daily-briefing-management">
        <p className="text-control text-muted-foreground">
          {t("dailyBriefing.management.loading")}
        </p>
      </AdminPanel>
    );
  }

  return (
    <AdminPanel
      title={t("admin.sidebar.briefing")}
      description={t("dailyBriefing.admin.pageDescription")}
      data-testid="daily-briefing-management"
    >
      <div
        role="tablist"
        aria-label={t("admin.sidebar.briefing")}
        className="flex w-fit gap-1 rounded-lg border bg-muted p-1"
      >
        {(["schedule", "blocks", "preview"] as const).map((id) => (
          <Button
            key={id}
            type="button"
            role="tab"
            variant={tab === id ? "default" : "ghost"}
            aria-selected={tab === id}
            data-testid={`daily-briefing-tab-${id}`}
            onClick={() => setTab(id)}
          >
            {t(TAB_LABEL_KEYS[id])}
          </Button>
        ))}
      </div>

      <ErrorNotice message={error} />
      {membersLoadFailed && (
        <Button
          type="button"
          variant="outline"
          className="w-fit"
          data-testid="daily-briefing-retry"
          onClick={() => void loadMembers()}
        >
          {t("dailyBriefing.admin.retry")}
        </Button>
      )}
      {!settingsLoading && settingsLoadError && (
        <div className="flex flex-col items-start gap-2">
          <ErrorNotice
            message={settingsLoadError}
            data-testid="daily-briefing-settings-load-error"
          />
          <Button
            type="button"
            variant="outline"
            data-testid="daily-briefing-settings-retry"
            onClick={() => void loadSettings()}
          >
            {t("dailyBriefing.admin.retry")}
          </Button>
        </div>
      )}

      <div hidden={tab !== "schedule"} data-testid="daily-briefing-schedule-workspace">
        <BriefingScheduleTab
          members={members}
          optIns={optIns}
          pendingOptInIds={pendingOptIns}
          optInLocked={generatingAll || workspaceBusy}
          onOptInChange={(id, enabled) => void setOptIn(id, enabled)}
          schedules={settings?.schedules ?? null}
          automation={settings?.automation ?? null}
          onAutomationSaved={(automation) => setSettings((s) => s && { ...s, automation })}
          date={date}
          today={today}
          onDateChange={setDate}
          generatingAll={generatingAll}
          canGenerateAll={optedIn.length > 0 && !hasPendingOptIns && !workspaceBusy}
          generateAllInfo={generateAllInfo}
          onGenerateAll={() => void generateAll()}
          results={results}
          onOpen={(memberId, target) => {
            selectMember(memberId);
            setTab(target);
          }}
        />
      </div>

      <div hidden={tab === "schedule"} className="flex flex-col gap-6">
        {members.length === 0 ? (
          <p className="text-control text-muted-foreground">
            {t("dailyBriefing.management.noActiveMembers")}
          </p>
        ) : (
          <BriefingMemberBar
            members={members}
            optIns={optIns}
            selectedId={selectedId}
            onSelect={selectMember}
            turnOnPending={selected ? pendingOptIns.has(selected.id) : false}
            onTurnOn={(id) => void setOptIn(id, true)}
          />
        )}

        {selected && selectedOn && (
          <>
            <div
              hidden={tab !== "blocks"}
              data-testid="daily-briefing-blocks-workspace"
              className="flex flex-col gap-4"
            >
              <p className="text-sm text-muted-foreground">
                {t("dailyBriefing.admin.blocksCaption").replaceAll("{name}", selected.displayName)}
              </p>
              {settingsChanged && (
                <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-accent px-4 py-3 text-control text-accent-foreground">
                  <p role="status" aria-live="polite" data-testid="daily-briefing-settings-changed">
                    {t("dailyBriefing.admin.settingsChanged")}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="daily-briefing-settings-changed-open"
                    onClick={() => setTab("preview")}
                  >
                    {t("dailyBriefing.admin.openBriefings")}
                  </Button>
                </div>
              )}
              <ErrorNotice message={blocksError} data-testid="daily-briefing-blocks-error" />
              {settings && (
                <BlockMatrix
                  memberName={selected.displayName}
                  blockOrder={settings.blockOrder}
                  resolve={(type) =>
                    resolveMemberBlockSettings(settings.blockSettings, selected.id, type)
                  }
                  schedule={settings.schedules[selected.id] ?? CANONICAL_WEEKDAY_ORDER}
                  savingType={savingType}
                  scheduleSaving={scheduleSaving}
                  orderSaving={orderSaving}
                  onToggleCell={(type, day) =>
                    void saveBlock(
                      type,
                      cellToggleInput(
                        resolveMemberBlockSettings(settings.blockSettings, selected.id, type),
                        day
                      )
                    )
                  }
                  onParamChange={(type, patch) => {
                    const current = resolveMemberBlockSettings(
                      settings.blockSettings,
                      selected.id,
                      type
                    );
                    void saveBlock(type, { params: { ...current.params, ...patch } });
                  }}
                  onToggleDay={(day) => void toggleDay(day)}
                  onReorder={(a, o) => void reorder(a, o)}
                />
              )}
            </div>
            <div hidden={tab !== "preview"} data-testid="daily-briefing-preview-workspace">
              <BriefingWorkspace
                key={selected.id}
                member={selected}
                date={date}
                today={today}
                onDateChange={setDate}
                active={tab === "preview"}
                blocked={generatingAll || hasPendingOptIns}
                refreshKey={refreshKey}
                onBusyChange={setWorkspaceBusy}
                onOpenBlocks={() => setTab("blocks")}
                onGenerated={(briefing) => {
                  setResults((previous) =>
                    previous && previous.date === briefing.date
                      ? {
                          ...previous,
                          statuses: { ...previous.statuses, [briefing.memberId]: briefing.status },
                        }
                      : { date: briefing.date, statuses: { [briefing.memberId]: briefing.status } }
                  );
                  setSettingsChanged(false);
                  setGenerateAllInfo(null);
                }}
              />
            </div>
          </>
        )}
      </div>
    </AdminPanel>
  );
}
```

Notes for the implementer:

- `memberName` is passed so the matrix can be reused. If eslint flags it as unused inside `BlockMatrix`, drop the prop from both files.
- `replaceAll` requires ES2021 lib. If `tsc` rejects it, use `.split("{name}").join(name)`.
- Turn-on keeps the already-loaded `settings`, so nothing is refetched (Review Focus 5).

- [ ] **Step 4: Delete the now-unused i18n keys** (spec D16) from both locales, checking each with `rtk proxy grep -rn '"<key>"\|<key>' src tests` first:
  - `dailyBriefing.admin.blockOrderTitle|blockOrderEmpty|blockOrderMoveUp|blockOrderMoveDown|blockOrderRemove|blockOrderAddLabel|blockOrderAddPlaceholder|blockOrderAddButton|blockOrderSaveButton`. `blockOrderSaveError` stays; the reorder uses it.
  - `blockEnabledLabel`, `memberBlockSettingsTitle`, `memberBlockSelectMember`, `memberBlockSelectMemberPlaceholder`, `blockWeekdaysLabel`, `scheduleDayLabel`, `scheduleCaption`, `triggerBindingLabel`, `triggerBindingBound`, `triggerBindingUnbound`, `settingsTitle`, `previewShowButton`, `needsOptIn`, `noPillMembers`
  - `dailyBriefing.management.description|optInTitle|generateTitle|generateAll|generatingAll|selectMember|selectMemberPlaceholder|statusesTitle|status`

Keep any key that is still used. If a key is used by something you are not changing (for example `management.status` in the workspace's status line), keep it.

- [ ] **Step 5: Run the tests and the type check**

```bash
npx vitest run tests/client/daily-briefing-management.test.tsx tests/client/daily-briefing-workspace.test.tsx tests/client/daily-briefing-block-matrix.test.tsx tests/client/daily-briefing-schedule-tab.test.tsx tests/client/daily-briefing-blocks.test.ts tests/client/daily-briefing-i18n-parity.test.ts
npx tsc --noEmit -p .
npx eslint src/client/admin/DailyBriefingManagement.tsx src/client/daily-briefing/admin
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A src/client tests/client/daily-briefing-management.test.tsx
git commit -m "feat(briefing): three scoped tabs, opt-in gate and one member bar on the Briefing page"
```

---

## Task 7: Retarget the remaining client tests

**Files:** `tests/client/daily-briefing-admin.test.tsx`, `tests/client/announcements-briefing-admin.test.tsx`, `tests/client/daily-briefing-admin-mirror-fence.test.tsx`

In every test that renders the page and needs Blocks content, the selected member must be **opted in**: make the mocked `/api/daily-briefing/opt-in` return `[{memberId:"member-ada", enabled:true}]`. Then click `daily-briefing-tab-blocks`. Keep titles where the behaviour still holds; record every rename or deletion in the report (Task 10 resyncs the cohort).

- [ ] **Step 1: `daily-briefing-admin.test.tsx`**
  - L70 "loads settings and saves generation time + trigger binding as morning_complete/null": drop the `-trigger-binding-state` "Bound" assertion. Save is enabled only after a change (it already changes both values). The rest stays.
  - L118: unchanged.
  - L151 "block order editor sends the ordered array including a repeated type": **delete** it. The editor is gone (spec D2). Repeated-instance preservation is covered in `daily-briefing-blocks.test.ts`.
  - L188 (language select): replace the member-select step with Blocks tab + opted-in Ada. The assertions on `daily-briefing-admin-block-language-*` are unchanged.
  - L231 "weekday toggles always send the canonical mon..sun order regardless of click order": keep the title. Click `daily-briefing-block-cell-wordOfDay-fri`, then `-mon`, then `-fri`. Expected PUT bodies:
    1. `{enabled:true, weekdays:["mon","tue","wed","thu","sat","sun"]}`
    2. `{enabled:true, weekdays:["tue","wed","thu","sat","sun"]}`
    3. `{enabled:true, weekdays:["tue","wed","thu","fri","sat","sun"]}`

    The mock must echo each body into the stored row, so the next click starts from it.

  - L289 "surfaces onThisDay's default-disabled reality on its row": keep the title. Assert `daily-briefing-admin-block-default-disabled-onThisDay` is visible, every `daily-briefing-block-cell-onThisDay-<day>` is unchecked, and every `-dadJoke-<day>` is checked.
  - L329 (preview image): click `daily-briefing-tab-preview` (Ada is opted in). Then change `daily-briefing-admin-preview-date`; there is no Show click. The URL and base-path assertions are unchanged.
  - L393 "block order Save is disabled while the settings GET is pending…" and L432 "block order Save stays disabled after the settings GET fails": rename them to **"automation and matrix stay absent while the settings GET is pending, then appear"** and **"after the settings GET fails nothing can be written and Retry recovers"**.
    - Assert `daily-briefing-admin-settings-save` and `daily-briefing-block-matrix` are absent while pending or failed.
    - Assert no PUT is sent.
    - On failure, assert `daily-briefing-settings-load-error`.
  - L467 `it.each` "translates block and parameter labels without changing persisted identifiers (%s)": keep the title. Read the labels from the matrix instead of the add-select: the row `daily-briefing-admin-block-settings-row-animalFact` contains "Animal fact"/"Curiosidad animal", and `-shotgun` contains "Shotgun"/"Copiloto". The difficulty part is unchanged.
  - Keep `assertNoImplicitRegenerate` in every test.

- [ ] **Step 2: `daily-briefing-admin-mirror-fence.test.tsx`**
  - L60 "offers exactly the server's ALL_BLOCK_TYPES, in registry order" becomes **"lists exactly the server's ALL_BLOCK_TYPES as matrix rows, in registry order"**. With `blockOrder: []`, read the `data-testid`s of `/^daily-briefing-admin-block-settings-row-/` in DOM order and compare them to `[...ALL_BLOCK_TYPES]` from the server module.
  - L73 and L98: replace the member-select step with an opted-in member and the Blocks tab. The assertions are unchanged.

- [ ] **Step 3: `announcements-briefing-admin.test.tsx`**
  - Change the import of `WEEKDAY_LABEL_KEYS as DAILY_BRIEFING_WEEKDAY_LABEL_KEYS` to come from `@/daily-briefing/admin/briefingBlocks`. Update the header comment (L1–23) to say the briefing surface now uses matrix cells, not `WeekdayPicker`.
  - L518/519 and L531/532: the opt-in checkboxes are on the default Schedule tab and their names are unchanged, so these should pass as they are.
  - L548 "meets kiosk density collapsed, opted-in, block-order added, then removed (CENSUS FIRES ON REMOVAL)" becomes **"meets kiosk density on Schedule, Blocks and Briefings (CENSUS PER TAB)"**.
    - Phase 1: the Schedule tab. Phase 2: opt Ada in, then the Blocks tab. Phase 3: the Briefings tab.
    - For each phase, run `assertKioskDensityCompliant` and pin the exact interactive-control count you observe. Compute the counts by running once and reading the helper's census.
    - Sanity-check them: Blocks should hold 7 pause checkboxes, plus 21 drag handles, plus 147 cells, plus the param selects, plus the member pills and the tabs.
  - L683 "announces the settings-load failure through the block-order AND block-settings cards' own ErrorNotice…" becomes **"announces the settings-load failure once, above the tabs, with Retry"** (`daily-briefing-settings-load-error`, `role=alert`, plus `daily-briefing-settings-retry`).
  - L701 describe "WeekdayPicker adoption (DailyBriefingManagement)…": replace both tests with a describe **"Matrix cells (DailyBriefingManagement)"** containing:
    - **"names every cell by block and localized day"**: under Spanish, `getByRole("checkbox", { name: "Palabra del día el Lun" })` resolves inside the `wordOfDay` row. Use the actual es values of `dailyBriefing.admin.blockType.wordOfDay` and `dailyBriefing.admin.weekday.mon`.
    - **"unchecking fri then mon on wordOfDay emits the canonical order"**: the same canonical PUT expectations as admin L231.
  - L791/792 WEEKDAY_LABEL_KEYS: unchanged apart from the import.

- [ ] **Step 4: Run them**

```bash
npx vitest run tests/client/daily-briefing-admin.test.tsx tests/client/announcements-briefing-admin.test.tsx tests/client/daily-briefing-admin-mirror-fence.test.tsx tests/client/admin-gate-panel-reset.test.tsx
```

Expected: PASS. `admin-gate-panel-reset` only needs `daily-briefing-management` and the generic-shape tolerance in `loadSettings`.

- [ ] **Step 5: Commit**

```bash
git add tests/client
git commit -m "test(briefing): retarget admin tests to the matrix cells, tabs and opt-in gate"
```

---

## Task 8: UI contract doc

**Files:** `docs/ui/household-contract.md`

- [ ] **Step 1: Rewrite item 7** (≈ line 77) to:

```
7. `/admin/daily-briefing` — Briefing: three tabs (local state, no sub-paths).
   - Schedule (default): automatic generation time and auto-print after morning chores (Save enabled when changed); Generate briefings for a chosen date (Generate for all members); a Members table with the per-member opt-in (its only home), the briefing days summary, the result for the chosen date and Blocks/Briefings shortcuts.
   - Blocks and Briefings share one member pill bar (opted-out members marked "off", gated with a Turn on notice).
   - Blocks: per-member blocks × weekdays matrix in household week-start order, with a "Briefing runs" pause row, inline block parameters and drag/keyboard reorder of the household block order; "settings changed" notice links to Briefings.
   - Briefings: 30-day history, date, Generate/Regenerate, View PNG, Print to the queue, payload and image states; the paused notice links to Blocks.
```

- [ ] **Step 2: Commit**

```bash
git add docs/ui/household-contract.md
git commit -m "docs(ui): describe the Briefing page's three tabs"
```

---

## Task 9: E2E

**Files:** `tests/e2e/daily-briefing.spec.ts`

Read the two admin tests first: "admin opt-in -> Generate -> complete ordered catalogue and raster preview (#557)" (≈ L223) and ": morning chores done through the real UI auto-prints…" (≈ L697).

- [ ] **Step 1: Update the first admin test.** After the heading check (≈ L365–370):
  - **Remove** the click on `daily-briefing-tab-preview` that came before opt-in. Opt-in happens on the default Schedule tab.
  - `optIn()`: still clicks `daily-briefing-opt-in-${id}`. Click `daily-briefing-tab-schedule` first, so it works from any tab.
  - `generateFor(id)`: click `daily-briefing-tab-preview`, then `daily-briefing-member-pill-${id}` (instead of `daily-briefing-preview-member-${id}`), then `daily-briefing-generate`. Keep the `{memberId}` body assertion.
  - The date step (≈ L516–534):
    - use `daily-briefing-member-pill-${second}`;
    - fill `daily-briefing-admin-preview-date`;
    - **drop** the `daily-briefing-admin-preview-show` click;
    - keep the preview.png 200 wait and the image-loaded poll.
  - `toggleToday()` (≈ L538–561): `daily-briefing-tab-blocks`, then `daily-briefing-member-pill-${id}`, then `daily-briefing-schedule-day-${weekday}`. After the paused generate, also click `daily-briefing-paused-open-blocks` and expect `daily-briefing-tab-blocks` to have `aria-selected="true"`. Then toggle back as before.
- [ ] **Step 2: Update the auto-print test** (≈ L839–1027):
  - The trigger-binding check and save happen on the default Schedule tab; there is no tab click before them.
  - Opt-in clicks: click `daily-briefing-tab-schedule` first.
  - Generate: `daily-briefing-tab-preview`, then `daily-briefing-member-pill-${id}`, then `daily-briefing-generate`.
- [ ] **Step 3: Add one new test** in the same file, after the first admin test. Reuse that test's setup helpers: member creation through the API, the `m` messages, and `openAdminSection(page, "admin-nav-daily-briefing-management")`.

```ts
test("admin briefing tabs: opt-in gate, matrix cell, keyboard reorder and Generate briefings for a date", async ({
  page,
  request,
}) => {
  // Create two children through the API exactly like the first admin test does
  // (reuse its helper; neither is opted in).
  // 1. Open the page: Schedule is the default tab; both rows show "—" days.
  // 2. Blocks tab → pill for child A → `daily-briefing-opted-out` visible, matrix absent.
  //    Click `daily-briefing-turn-on` (wait for PUT /opt-in/<A> 200) → `daily-briefing-block-matrix` visible.
  // 3. Click `daily-briefing-block-cell-dadJoke-mon` (wait for PUT /block-settings/<A>/dadJoke 200)
  //    → it becomes unchecked; `daily-briefing-settings-changed` visible.
  // 4. Keyboard reorder: focus `daily-briefing-admin-block-drag-weather`, press Space, ArrowUp, Space;
  //    wait for PUT /api/daily-briefing/block-order 200; the first two rows' testids are
  //    weather before the row that preceded it.
  //    Restore: press the same sequence with ArrowDown so later specs see the original order.
  // 5. Schedule tab → fill `daily-briefing-generate-date` with the household date 7 days ago
  //    (compute from the same household-date helper the spec already uses) → click
  //    `daily-briefing-generate-all`; wait for POST /generate-all and assert the body is
  //    `{ date: <that date> }`; `daily-briefing-member-status-<A>` shows m["dailyBriefing.status.ready"]
  //    or m["dailyBriefing.status.partial"]; child B (off) shows "—".
  // 6. Click `daily-briefing-open-briefings-<A>` → Briefings tab, `daily-briefing-history-entry-<that date>` visible.
  // 7. Clean up like the first test does (opt A out through the API).
});
```

Write the body with the real helpers and selectors from the file. The comments above are the required steps and assertions, not code to paste. For step 4, if dnd-kit's keyboard sensor needs a short wait between keys in Chromium, add `await page.waitForTimeout(50)` between the presses (no other sleeps).

- [ ] **Step 4: Run it**

The build comes from Task 10's `check:standard`, or run `npm run build` now:

```bash
PORT=43224 MP_E2E_WEATHER_FIXTURE_PORT=44424 MP_E2E_QUOTE_FIXTURE_PORT=44434 npx playwright test tests/e2e/daily-briefing.spec.ts tests/e2e/admin-unlock-resilience.spec.ts tests/e2e/plugin-lifecycle-visual.spec.ts tests/e2e/accessible-names-audit.spec.ts --workers=3
```

Expected: all PASS. If `accessible-names-audit.spec.ts` does not exist, drop it from the command.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/daily-briefing.spec.ts
git commit -m "test(e2e): cover the Briefing tabs, opt-in gate, matrix and dated generate"
```

---

## Task 10: Independent coherence review loop (spec §8), then cohort resync and the gate

- [ ] **Step 1: Run the app for reviewers**

```bash
mkdir -p .data
DATA_DIR="$PWD/.data" npm run seed
DATA_DIR="$PWD/.data" PORT=43224 WEB_PORT=44524 npm run dev   # run in the background
```

The UI is on `http://localhost:44524`, and the admin PIN is in `.env.local` / `.env.example`. Opt in at least one seeded member, generate once, and leave another member opted out, so reviewers see every state.

- [ ] **Step 2: Round N (N = 1..5)**

Dispatch a **fresh** `general-purpose` subagent. Never reuse a reviewer. Give it this prompt verbatim, with the paths filled in:

```
You are an independent UX/coherence reviewer. Read-only: do not edit files, do not run git.
Subject: the Daily Briefing admin page of marplanner-project, worktree <ABSOLUTE WORKTREE PATH>.
Code: src/client/admin/DailyBriefingManagement.tsx and src/client/daily-briefing/admin/* (BlockMatrix,
BriefingScheduleTab, BriefingAutomationCard, BriefingMemberBar, BriefingWorkspace, BriefingImage,
briefingBlocks), the dailyBriefing.* strings in src/client/i18n/messages.ts (en AND es), and the
Printer page's auto-print link (src/client/admin/printer/PrinterSettingsTab.tsx).
Intent: docs/superpowers/specs/2026-10-15-admin-briefing-polish-design.md (sections 1, 4, 6).
Running app: http://localhost:44524 (admin PIN: <PIN>). Use the Playwright browser in a NEW tab you
open yourself (page.context().newPage()), close it when done, never resize or navigate tabs you did
not open. Check desktop and a ~400px-wide tab, and kiosk density if the shell offers the toggle.
Review ALL three tabs (Schedule, Blocks, Briefings) for:
1. Naming: same concept, same word everywhere (tabs, headings, buttons, notices, es and en).
2. Control placement: every setting has exactly one home; household vs member scope is obvious.
3. Duplicated settings or controls (two ways to change one value, or a read-out repeating a control).
4. Cross-tab flow: can a parent go from "who gets it" → "what's in it" → "what was generated" and
   back without hunting? Do notices link where they point?
5. Opted-out, disabled, loading, empty and error states: is each explained, does each offer the
   way forward, can anything be configured for an opted-out member?
6. Anything confusing to a non-technical parent.
Report a numbered list. Each finding: severity (Critical = broken/misleading behaviour; Important =
a coherence problem a parent will hit; Minor = polish), where (file:line or screen + control), what
is wrong, and the concrete change you recommend. End with the line "IMPORTANT_OR_CRITICAL: <count>".
```

- [ ] **Step 3: Fix the findings.**
  - Fix every Critical and Important finding.
  - Fix any Minor finding that costs a few lines.
  - A finding that contradicts a spec decision is not fixed silently: keep the decision, and note the finding and your reason in the report. The exception is a finding that shows the decision breaks the owner's intent (spec §1); then change it and say so.
  - Add or adjust tests for behaviour changes, and keep the whole suite green: `npx vitest run tests/client/daily-briefing* tests/client/announcements-briefing-admin.test.tsx`.
  - Commit with `fix(briefing): coherence review round N`.
- [ ] **Step 4: Repeat** Steps 2–3 with a NEW reviewer until one reports `IMPORTANT_OR_CRITICAL: 0`, or until 5 rounds have run. Record each round in the report: its findings, what you fixed, and what you declined and why. If the last round still has Important findings, list them under "Open".

- [ ] **Step 5: Stop the dev server**, then resync the cohort.

```bash
npm run test:cohorts:stamp            # prints the candidate id
export MP_CANDIDATE_ID=$(node tools/candidate-identity.mjs)   # or copy the printed id
npm run test:cohorts:vitest:list
npm run test:cohorts:vitest
```

Update `tests/fixtures/assembly-cohort.json`:

- **`testCohorts.runners.vitest.files`**:
  - add the new files `tests/client/daily-briefing-blocks.test.ts`, `tests/client/daily-briefing-block-matrix.test.tsx` and `tests/client/daily-briefing-schedule-tab.test.tsx`;
  - change the case lists of `checkbox-field.test.tsx`, `daily-briefing-management.test.tsx`, `daily-briefing-workspace.test.tsx`, `daily-briefing-admin.test.tsx`, `announcements-briefing-admin.test.tsx` and `daily-briefing-admin-mirror-fence.test.tsx`. Copy them exactly from `.quality/vitest-list.json`.

  Then run `node tools/verify-test-cohorts.mjs --expected tests/fixtures/assembly-cohort.json --raw-dir .quality --candidate "$MP_CANDIDATE_ID" --runners node,vitest` and fix every difference.

- **`testCohorts.runners.playwright.files`**: run `npx playwright test --list --reporter=json > .quality/pw-list.json`. Add the new test's spec id under the `tests/e2e/daily-briefing.spec.ts` entry, keyed exactly as its siblings are. Existing titles do not change.
- **`coveragePolicy.files`**:
  - Run `npm run check:coverage`.
  - Add entries (layer `client`) for `src/client/daily-briefing/admin/briefingBlocks.ts`, `BlockMatrix.tsx`, `BriefingScheduleTab.tsx`, `BriefingAutomationCard.tsx` and `BriefingMemberBar.tsx`, with the observed totals and rates.
  - **Remove** the `BriefingMemberPills.tsx` entry.
  - For `DailyBriefingManagement.tsx`, `BriefingWorkspace.tsx` and `CheckboxField.tsx`, set the totals to the observed values. Keep each rate at or above its previous value; if a rate falls, add the missing test instead of lowering the floor.
  - Touch only these entries.

- [ ] **Step 6: Commit, then the standard gate from a clean tree**

```bash
git add tests/fixtures/assembly-cohort.json
git commit -m "chore: resync assembly cohort for the daily briefing coherence pass"
git status --short    # must be empty
MP_CANDIDATE_ID=$(node tools/candidate-identity.mjs) npm run check:standard
```

Expected: PASS. Common fixes:

- `npx prettier --write <touched files>`
- `check:accessible-names`: every cell and pause checkbox is named through its hidden label, and the drag handles through `aria-label`.
- `check:ui-debt`: inline styles go up by exactly 1, from the BlockMatrix row; never edit the baselines.
- `check:ui-catalog`: no change expected.
- `check:openapi`: no change expected.

Commit the fixes and re-run until it is green from a clean tree.

- [ ] **Step 7: Aggregate gate** (it also verifies the Playwright inventory):

```bash
PORT=43224 MP_E2E_WEATHER_FIXTURE_PORT=44424 MP_E2E_QUOTE_FIXTURE_PORT=44434 MP_CANDIDATE_ID=$(node tools/candidate-identity.mjs) npm run check:aggregate-only
```

Expected: PASS. If it reports Playwright inventory drift, fix `testCohorts.runners.playwright.files`, commit, and re-run Steps 6–7.

---

## Task 11: Commit on the worktree branch and report

- [ ] Confirm the spec and plan copies from Task 0 are committed: `git log --oneline main..HEAD` and `git status --short` (it must be clean).
- [ ] **Fallback if git is refused** in your worktree:
  - leave everything uncommitted;
  - list every created, modified or deleted file with its absolute path (new files separately);
  - say that `check:standard` could not run from a committed tree. The orchestrator collects the work by patch.
- [ ] Write `REPORT-briefing-polish.md` in the worktree root (not committed) with:
  - the branch name and HEAD SHA;
  - the gate commands and their results (`check:standard`, `check:aggregate-only` with pass counts);
  - the cohort and coverage entries you changed, and the test titles you renamed or deleted;
  - each review-loop round: its findings, fixes, and declined items with reasons, plus the final reviewer's count;
  - every deviation from this plan or the spec, with the reason, including any shared-component API adaptation (A1) and whether `MEMBER_DOT_CLASS` had to be exported.
- [ ] Reply `DONE`.

## Orchestrator addendum (from the shared-pills wave, PR #40)

Shared components landed with the API in the shared-pills spec, no deviations. Address these leftovers from its final review in this rework:

- `BriefingWorkspace` still renders an sr-only `<select>` next to the member radiogroup: screen readers get two controls for one choice. Remove it.
- Arrow keys on the member radiogroup now select a member immediately (native radio behaviour). Make sure that selecting a member on arrow-key focus does not trigger expensive loads in a way that feels broken (debounce or load on settle), or document why it is fine.
- If any weekday pill row remains inside a `grid-cols-7`, centre the pills under their headers (the shared `PillControl` base is left-aligned).
