# Admin Messages polish: member pills and zebra by week

Date: 2026-10-15. Status: approved by delegation (the owner waived review). Slug: `messages-polish`. Page: `/admin/daily-messages` (`src/client/admin/DailyMessagesManagement.tsx`).

## Intent (owner feedback, round 2)

1. Choose the member with the shared member pills, not the dropdown.
2. Zebra by week: group the 14 visible days into weeks using the household week-start setting and alternate the row background per week. The first visible chunk is unshaded. If the list starts mid-week, shading starts at the first week-start day. If the list starts exactly on a week-start day, the first week is unshaded and shading starts with the second week. The pattern is always plain / shaded / plain.

Success criteria: pills replace the `<select>` with the same behaviour (default first active member, switching reloads that member's window, stale responses ignored); the band of each row is a pure function of its date, the window start and `weekStartDay`; everything else on the page (14-day window, blur-to-save, delete confirm, Retry) is unchanged.

## Current state (verified in `feat/admin-parity`)

- `DailyMessagesManagement.tsx` renders `<Field label=selectMember><select data-testid="daily-messages-select-member" className={NATIVE_SELECT_CLASSES}>` over `activeMembers` (`Member[]`, lifecycle `active`). `selectedMemberId` defaults to the first active member. On change it clears list and drafts, sets loading, sets the id.
- Rows: `<li data-testid="daily-messages-day-${date}" className="flex items-start gap-3 rounded-lg border border-transparent px-2 py-1 ... focus-within:border-border focus-within:bg-card">` for `dates` (14 ISO dates from `windowFrom`, `buildDateWindow`).
- `useHouseholdSettings()` exposes `{ timezone, language, weekStartDay }`; `weekStartDay` is `number | null` (server accepts only 0 Sunday or 1 Monday; null before load or outside a provider).
- Pinned by tests: `tests/client/daily-messages-management.test.tsx:135` (fires `change` on the select), `tests/client/day-periods-messages-admin.test.tsx:418` (waits for testid `daily-messages-select-member`) plus census counts (17, 19, 18 controls, with one member), `tests/e2e/daily-messages.spec.ts:94-96` (`getByLabel(selectMember).selectOption`), `tests/e2e/member-lifecycle.spec.ts:176-177` (`option[value=id]` has the edited name). `tests/client/daily-messages-i18n-parity.test.ts` pins `dailyMessages.management.selectMember` = "Member" / "Miembro".

## Shared components used (from the shared-pills wave; adapt to the real API if it differs)

`MemberPills` from `@/ui`: `mode="single"`, `members` (id, displayName, colorKey), `value: string | null`, `onChange(id)`, `groupLabel`, `testIdPrefix` (`${prefix}-${id}` on each native radio). Do not hand-roll pills or colours.

## Decisions

- **D1 Member pills.** Replace the `<select>` and its `Field` with a block: a visible caption `<p>` (existing key `dailyMessages.management.selectMember`, no new strings) and `<MemberPills mode="single" groupLabel={same string} members={activeMembers} value={selectedMemberId || null} onChange={...} testIdPrefix="daily-messages-member" />`. The wrapper div keeps `data-testid="daily-messages-select-member"` so existing waits on that id still work. The change handler keeps the "same member = no-op" guard and the reset sequence. The `NATIVE_SELECT_CLASSES` import goes away.
- **D2 Week bands.** New pure module `src/client/admin/daily-messages-weeks.ts`:
  `weekBands(dates, weekStartDay): ("plain" | "shaded")[]`. A week-start day is `weekStartDay === 0 ? 0 : 1` (null or unknown falls back to Monday, the same fallback as `weekdayDisplayOrder`). Walk the dates in order, keep a counter `weeks`; for index > 0 whose UTC weekday equals the week-start day, `weeks += 1`; the band is `shaded` when `weeks` is odd. Index 0 never increments, so a window that starts exactly on a week-start day gets its first week plain, and a mid-week start gets a plain lead-in chunk. 14 days therefore yields at most plain / shaded / plain, by construction.
- **D3 Rendering.** Each `<li>` gets `data-week-band="plain|shaded"` (stable hook for tests) and, when shaded, the class `bg-muted/50` (same token family as `DailyBriefingManagement` zebra `bg-muted/30` and the calendar month view; `/50` for legibility under textareas). `focus-within:bg-card` and the transparent border stay, so the focused row still lifts. Shading is not the only signal for any information (it is decoration), so no text alternative is needed. Bands are computed with `useMemo` from `dates` and `weekStartDay` and recompute when the window navigates.
- **D4 Week start source.** `const { timezone, weekStartDay } = useHouseholdSettings()`. No prop override.
- **D5 No backend, no new copy, no new i18n keys.** The `// admin-messages-polish` i18n block rule from round 1 therefore has nothing to add; do not create an empty block.
- **D6 Docs.** `docs/ui/household-contract.md` line ~61 ("Messages ... keeps its 14-day editor and offers Retry"): add that the member is chosen with member pills and the 14 days alternate their background per week from the household week start. No feature-spec FR change (UI only; `docs/features/daily-messages.md` FRs are about the API).

## Testing

- New `tests/client/daily-messages-weeks.test.ts`: cases listed in the plan (Monday start mid-week, Sunday start mid-week, window starting on week start for both settings, null fallback, empty list, 14 days never exceed three bands).
- `tests/client/daily-messages-management.test.tsx`: replace the select test with pill tests (default first member checked, clicking another member loads that member's window, clicking the checked pill keeps the editor), add zebra DOM tests for Monday and Sunday week starts.
- `tests/client/day-periods-messages-admin.test.tsx`: wait on the wrapper testid (unchanged), counts stay 17/19/18 (one radio replaces one select); add a short assertion that no `<select>` remains.
- e2e (no new spec file): update `daily-messages.spec.ts` to pick the member by `getByRole("radio", { name })` and assert the bands on the first rows; update `member-lifecycle.spec.ts` to assert the pill's name.
- Inventory: resync `tests/fixtures/assembly-cohort.json` (new vitest cases, new coverage entry for `daily-messages-weeks.ts`, remeasured entry for `DailyMessagesManagement.tsx`). No Playwright spec is added, so the Playwright list is unchanged unless a test title changes (do not rename titles).

## Assumptions

- A1: Admin pages render under `HouseholdSettingsProvider`, so `weekStartDay` is available (null only while loading, which falls back to Monday and re-renders when it arrives).
- A2: The reference app's Messages page has no zebra; this is owner-specified behaviour, not a port.
- A3: Only active members are selectable, as today; inactive members stay out of the pills (no `inactiveLabel` use).
- A4: Playwright `.check()`/`.click()` on a stretched, `opacity: 0` radio works (the shared pills wave relies on the same).
