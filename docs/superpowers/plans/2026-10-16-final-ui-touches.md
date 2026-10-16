# Final admin touches (Worker A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Options tap feedback, a per-row "every day" block toggle, member-colour chips in the
briefing schedule table, and an Active/Inactive toggle with muted inactive plugin cards.

**Architecture:** Client-only changes in four existing components; one pure helper beside
`cellToggleInput`. Reuse `@/ui` (`StatusToggle`, `Button`) and the routines `MemberChip`.

**Tech Stack:** React 19, TypeScript, Tailwind, Vitest + Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-16-final-ui-touches-design.md`

## Global Constraints

- Node 24.21.0 via `fnm exec --using=24.21.0` for every npm/npx command.
- i18n keys added to both the `en` and `es` blocks of `src/client/i18n/messages.ts`.
- Copy: hint "Hold to open Admin" / "Mantén pulsado para abrir Admin".
- No server/API change, no new shared component, no new density test.
- Docs in sync: `docs/ui/household-contract.md`, `docs/ui/plugin-management.md`.
- Gates: `check:standard` in a clean detached checkout, then `check:aggregate-only` with
  PORT=43251 MP_E2E_WEATHER_FIXTURE_PORT=44481 MP_E2E_QUOTE_FIXTURE_PORT=44491; resync
  `tests/fixtures/assembly-cohort.json`.

## Review Focus

- A completed hold followed by the pointer release must not flash the hint (locked PIN screen
  keeps the household bar) — Task 1 test "completed hold shows no hint".
- Keyboard users releasing Enter early get the same hint — Task 1 test.
- Row toggle on a default-disabled block (no stored row, `enabled:false`) shows "On" and writes
  `{enabled:true, weekdays:null}` — Task 2 helper test.
- Row toggle while the row is saving is disabled — Task 2 component test.
- Errored plugin is not pressed and its tap activates; errored card is not muted — Task 4 test.

---

### Task 1: Options tap hint

**Files:** Modify `src/client/shell/HouseholdChrome.tsx`, `src/client/i18n/messages.ts`;
Test `tests/client/household-options-menu.test.tsx`; e2e check in
`tests/e2e/admin-unlock-resilience.spec.ts`.

- [ ] Failing tests: (a) pointerDown+pointerUp on `admin-affordance` → `getByTestId("admin-hold-hint")`
      has text "Hold to open Admin", URL unchanged; (b) pointerDown, advance 3000 ms, pointerUp,
      click → no hint; (c) keyDown Enter + keyUp Enter → hint; (d) hint gone after 2500 ms.
- [ ] Implement: `holdHintVisible` state + timer ref; `releaseAdminHold()` used by `onPointerUp`
      and `onKeyUp`: if `adminHoldTimerRef.current` is pending → show hint (auto-hide 2500 ms);
      then `cancelAdminHold()`. `startAdminHold` hides the hint. Render
      `<span role="status" data-testid="admin-hold-hint">` absolutely under the button. Key
      `shell.options.holdHint`.
- [ ] Run tests, e2e tap check (tap → hint visible, still on `/`), commit.

### Task 2: Block row "every day" toggle

**Files:** `src/client/daily-briefing/admin/briefingBlocks.ts`, `BlockMatrix.tsx`,
`src/client/admin/DailyBriefingManagement.tsx`, messages; tests
`tests/client/daily-briefing-blocks.test.ts`, `daily-briefing-block-matrix.test.tsx`.

**Interfaces:** `rowToggleInput(settings: MemberBlockSettings): { enabled: boolean; weekdays: WeekdayCode[] | null }`;
`BlockMatrixProps.onToggleRow: (blockType: BlockRegistryType) => void`.

- [ ] Failing tests: helper — any day on → `{enabled:false, weekdays:[]}`; none on (incl.
      `enabled:false`) → `{enabled:true, weekdays:null}`. Matrix — column header "Every day";
      button `daily-briefing-block-row-toggle-{type}` text "Off" when on, "On" when off, aria
      "Turn {block} off every day"/"Turn {block} on every day", disabled when saving, calls
      `onToggleRow(type)`.
- [ ] Implement helper, column + button, wire `onToggleRow` → `saveBlock(type, rowToggleInput(...))`.
- [ ] Run tests, commit.

### Task 3: Member chips in the schedule table

**Files:** `src/client/daily-briefing/admin/BriefingScheduleTab.tsx`; test in
`tests/client/daily-briefing-management.test.tsx`.

- [ ] Failing test: the member row header contains an element with the member name whose class
      includes `bg-[var(--member-color)]` (MemberChip), and no dot.
- [ ] Replace the dot + name span with `<MemberChip member={member} />`; drop the
      `MEMBER_DOT_CLASS` import if unused. Run, commit.

### Task 4: Plugin toggle and muted inactive card

**Files:** `src/client/plugins/PluginManagement.tsx`; tests `tests/client/plugin-management.test.tsx`,
`tests/e2e/plugin-lifecycle.spec.ts`, `plugin-lifecycle-visual.spec.ts`; doc
`docs/ui/plugin-management.md`.

- [ ] Failing tests: card shows `getByRole("button", { name: "Weather", pressed: false })` with
      text "Inactive"; clicking it calls activate; active card's toggle `pressed: true`; inactive card
      has `bg-muted`, active/errored do not; busy → toggle disabled with `aria-busy`.
- [ ] Implement: `StatusToggle` in the header (`pressed={state==="active"}`, label
      `<span data-testid="plugin-state-{id}">{state text}</span>`, `accessibleName={label}`,
      `busy`, `aria-describedby` operation text, ref for focus return — forward via a wrapper span
      ref if StatusToggle lacks ref); remove the bottom action button; `bg-muted` when inactive.
- [ ] Update existing unit/e2e selectors that used "Activate X"/"Deactivate X". Run, commit.

### Task 5: Docs, inventory, gates

- [ ] Update `docs/ui/household-contract.md` (Options hint, blocks row, schedule chips) and
      `docs/ui/plugin-management.md`.
- [ ] Resync `tests/fixtures/assembly-cohort.json`; run `check:standard` in a clean detached
      checkout, then `check:aggregate-only` with the ports; commit.
