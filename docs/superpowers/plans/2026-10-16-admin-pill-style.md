# Member pill style, PIN backspace key and Options shortcut — plan

Owner decisions (2026-10-16), taken from an interactive mockup comparing every current member-pill style with the proposal. The owner chose option **D**:

## 1. Member pills (`src/client/components/MemberPills.tsx` and its internal `PillControl`)

- **Selected:** pill filled with the member colour (`var(--color-member-<key>-500)`), white text (`--member-avatar-foreground`), font-weight 600, 1px border always present but transparent. No colour dot.
- **Not selected:** pill filled with `--muted`, text `--muted-foreground`, transparent 1px border, weight 500. No colour dot.
- **Width never changes on selection:** each label reserves the width of its bold version (e.g. an inline-grid label with a hidden bold `::after` copy of the text via `data-text`), so selecting never shifts the pills beside it. Add a test that asserts the reserve element exists; the visual check is in e2e/screens.
- **Off (member that cannot be picked here):** the pill keeps its shape with a **transparent background** (page shows through), a **1px solid `--border`** border, text `--muted-foreground`, weight 400, label "<Name> (off)". It is **not selectable**: disabled input, no hover, no click effect, and it is never returned in `onChange`. Replace the current dashed `inactiveLabel` styling with this. Rename the prop if clearer (e.g. `offLabel`) and keep the accessible name including the marker.
- `memberFilterStyle` in `src/client/calendar/member-event-style.ts` is no longer needed by MemberPills; remove it if unused after step 2.

## 2. Calendar member filter (`src/client/calendar/CalendarView.tsx`)

- Today it fills every selected member pill with the same amber (`--accent`). Switch the member pills to the same D style (ideally render `MemberPills mode="multi"`; if its semantics do not fit, reuse the same visual classes). The "All-day events" pill keeps its own amber style: it is not a member.

## 3. Consequences for pages using "off"

- **Daily Briefing** (`BriefingMemberBar`, `DailyBriefingManagement`): opted-out members render as off pills and cannot be selected. Remove the "Turn on daily briefing" gate notice that appeared after selecting an off member; opt-in stays in the Schedule tab's members table. If the selected member gets opted out, select the first opted-in member; if none is opted in, Blocks and Briefings show one line pointing to the Schedule tab (with a button that switches to it).
- **Reminders / Messages / others**: archived or otherwise unavailable members use the same off pill (not selectable) wherever they were previously shown with the dashed inactive style.
- Keep the two Codex fixes from PR #41 (result invalidation on zero opted-in members; workspace blocked while a generation runs).

## 4. PIN keypad delete key (`src/client/admin/AdminGate.tsx`, `admin-pin-backspace`)

- It renders as a bare icon while every digit key is a filled circle. Give it the same circular key surface, size and border as the digits (keep the icon, its accessible name "Backspace" and the testid).

## 5. Options menu shortcut (`src/client/shell/HouseholdChrome.tsx`)

- While the Options menu has exactly one entry (Admin), the "Options" button must act as the Admin affordance itself instead of opening a one-item menu: same long-press/hold behaviour and delay as today's `admin-affordance` (respecting the existing flag that decides whether a hold is required), same testid `admin-affordance` on the actionable control so e2e helpers keep working, visible label "Options" unchanged unless an existing test/contract names it otherwise.
- Keep the menu code path for when a second entry exists (e.g. a future "Print today's briefing"): derive "single entry" from the list of entries, do not delete the menu.

## Tests, docs, gate

- TDD for each item. Update unit tests that assert the old tinted/dashed styles or the gate notice, `tests/e2e/admin-nav.ts` / unlock helpers if the Options flow changes, and `docs/ui/component-contract.md`, `docs/ui/household-contract.md` where they describe these controls. Regenerate `COMPONENTS.md` if the tooling requires it.
- Do not add or change kiosk density tests (owner instruction).
- Gate: `npm run check:standard` on a clean committed tree (MP_CANDIDATE_ID from `tools/candidate-identity.mjs`), then `npm run check:aggregate-only` with `PORT=43231 MP_E2E_WEATHER_FIXTURE_PORT=44441 MP_E2E_QUOTE_FIXTURE_PORT=44451`. Resync `tests/fixtures/assembly-cohort.json` for changed vitest cases, Playwright ids and coverage entries (lower minimumTotals only where code shrank; never lower minimumRates). If a run fails only on a 5 s timeout in a file you did not touch, rerun that file alone and note it.
