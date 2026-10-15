# Admin Messages Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On `/admin/daily-messages`, pick the member with the shared member pills and zebra-stripe the 14 day rows by week from the household week start.

**Architecture:** One pure helper (`weekBands`) decides each row's band; `DailyMessagesManagement.tsx` renders `MemberPills mode="single"` instead of the select and tags each `<li>` with the band. No backend, no new i18n keys.

**Tech Stack:** React, Tailwind v4, vitest + Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-15-admin-messages-polish-design.md`

**Start of execution:** you work in your own worktree branched from main AFTER the shared-pills wave merged. First copy this plan and the spec from `/Users/diego/Dev/marplanner-project/docs/superpowers/{specs,plans}/2026-10-15-admin-messages-polish*.md` into the same relative paths in your branch and commit them. If a shared component API (`MemberPills`, `ChoicePills`, `WeekdayPicker`) differs from the shared-pills plan when you start, adapt to the real one (read `src/client/components/MemberPills.tsx` and `src/client/ui.ts` first).

## Global Constraints

- Ports for any e2e run: `PORT=43222 MP_E2E_WEATHER_FIXTURE_PORT=44422 MP_E2E_QUOTE_FIXTURE_PORT=44432`.
- No new strings: reuse `dailyMessages.management.selectMember` ("Member" / "Miembro").
- Do not hand-roll pills; import `MemberPills` from `@/ui` (or `@/components/MemberPills` if `@/ui` does not export it).
- Keep every existing testid on this page: `daily-messages-select-member` (now on the wrapper div), `daily-messages-day-${date}`, `daily-messages-text-${date}`, delete/retry/window ids.
- Technical output (code, commits) in English.

## Review Focus

- Window starting exactly on a week-start day: first week plain, second shaded (test in Task 1 and Task 2).
- `weekStartDay` null (settings not loaded): falls back to Monday, no crash, re-bands when settings arrive (Task 1 null case).
- Clicking the already-selected pill does not reload or clear drafts (Task 2).
- Switching member quickly: stale response from the previous member is still ignored (existing `loadRequestIdRef` logic must be untouched; Task 2 asserts the new member's text appears and the old one's does not).
- Unsaved draft text is not lost by banding re-renders (band class changes only; `key` unchanged).

---

### Task 1: `weekBands` helper

**Files:**
- Create: `src/client/admin/daily-messages-weeks.ts`
- Test: `tests/client/daily-messages-weeks.test.ts`

**Interfaces:**
- Produces: `export type WeekBand = "plain" | "shaded"; export function weekBands(dates: readonly string[], weekStartDay: number | null | undefined): WeekBand[]` (same length and order as `dates`).

- [ ] **Step 1: Write the failing test** `tests/client/daily-messages-weeks.test.ts`

```ts
import { describe, expect, it } from "vitest";

import { weekBands } from "@/admin/daily-messages-weeks";

function window14(from: string): string[] {
  return Array.from({ length: 14 }, (_, i) => {
    const d = new Date(`${from}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
}
const runs = (bands: string[]) =>
  bands.reduce<[string, number][]>((acc, band) => {
    const last = acc[acc.length - 1];
    if (last && last[0] === band) last[1] += 1;
    else acc.push([band, 1]);
    return acc;
  }, []);

describe("weekBands", () => {
  it("Monday start, list starts mid-week (Thu 2026-01-15): plain lead-in, then shaded week, then plain", () => {
    expect(runs(weekBands(window14("2026-01-15"), 1))).toEqual([
      ["plain", 4],
      ["shaded", 7],
      ["plain", 3],
    ]);
  });

  it("Sunday start, list starts mid-week (Thu): lead-in is Thu-Sat", () => {
    expect(runs(weekBands(window14("2026-01-15"), 0))).toEqual([
      ["plain", 3],
      ["shaded", 7],
      ["plain", 4],
    ]);
  });

  it("list starting exactly on a Monday: first week plain, second shaded", () => {
    expect(runs(weekBands(window14("2026-01-19"), 1))).toEqual([
      ["plain", 7],
      ["shaded", 7],
    ]);
  });

  it("list starting exactly on a Sunday with Sunday start: first week plain, second shaded", () => {
    expect(runs(weekBands(window14("2026-01-18"), 0))).toEqual([
      ["plain", 7],
      ["shaded", 7],
    ]);
  });

  it("a Monday-start window under a Sunday-start household treats Monday as mid-week", () => {
    expect(runs(weekBands(window14("2026-01-19"), 0))).toEqual([
      ["plain", 6],
      ["shaded", 7],
      ["plain", 1],
    ]);
  });

  it("falls back to Monday for null, undefined and unexpected values", () => {
    const monday = weekBands(window14("2026-01-15"), 1);
    expect(weekBands(window14("2026-01-15"), null)).toEqual(monday);
    expect(weekBands(window14("2026-01-15"), undefined)).toEqual(monday);
    expect(weekBands(window14("2026-01-15"), 7)).toEqual(monday);
  });

  it("returns an empty list for no dates", () => {
    expect(weekBands([], 1)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** (module missing): `npx vitest run tests/client/daily-messages-weeks.test.ts`

- [ ] **Step 3: Implement** `src/client/admin/daily-messages-weeks.ts`

```ts
export type WeekBand = "plain" | "shaded";

/**
 * Band of each date for the Messages zebra. A new week begins on every week-start day after the
 * first date, so the lead-in chunk (or the first full week) is always plain and bands then
 * alternate. `weekStartDay` is 0 (Sunday) or 1 (Monday); anything else, including null before
 * the household settings load, is treated as Monday.
 */
export function weekBands(
  dates: readonly string[],
  weekStartDay: number | null | undefined
): WeekBand[] {
  const startsOn = weekStartDay === 0 ? 0 : 1;
  let weeks = 0;
  return dates.map((date, index) => {
    if (index > 0 && new Date(`${date}T00:00:00Z`).getUTCDay() === startsOn) weeks += 1;
    return weeks % 2 === 1 ? "shaded" : "plain";
  });
}
```

- [ ] **Step 4: Run, expect PASS**: `npx vitest run tests/client/daily-messages-weeks.test.ts`
- [ ] **Step 5: Commit**: `git add src/client/admin/daily-messages-weeks.ts tests/client/daily-messages-weeks.test.ts && git commit -m "feat(admin): add the week banding helper for the Messages list"`

### Task 2: Member pills and zebra in the page

**Files:**
- Modify: `src/client/admin/DailyMessagesManagement.tsx`
- Modify: `tests/client/daily-messages-management.test.tsx`
- Modify: `tests/client/day-periods-messages-admin.test.tsx`

**Interfaces:**
- Consumes: `weekBands` (Task 1); `MemberPills` single mode (`@/ui`): props `mode="single"`, `members`, `value: string | null`, `onChange(id: string)`, `groupLabel`, `testIdPrefix`. `Member` structurally satisfies `MemberPillsMember`.

- [ ] **Step 1: Update tests first.**

In `tests/client/daily-messages-management.test.tsx`:
1. Make the fetch mock accept a members list and a per-member message map. Change `renderManagement(messages = [])` to `renderManagement(messages: DailyMessage[] = [], options: { members?: Member[]; weekStartDay?: 0 | 1; byMember?: Record<string, DailyMessage[]> } = {})`: `/api/settings` returns `{ locale: { timezone: "UTC", language: "en", ...(options.weekStartDay === undefined ? {} : { weekStartDay: options.weekStartDay }) } }`; `/api/members` returns `options.members ?? [member()]`; the messages GET returns `options.byMember?.[new URL(url, "http://x").searchParams.get("memberId") ?? ""] ?? messages`. Make `member(overrides: Partial<Member> = {})` spread overrides.
2. Replace the test "keeps the loaded editor visible when the active member is selected again" with:

```tsx
it("keeps the loaded editor visible when the checked member pill is clicked again", async () => {
  const mockFetch = renderManagement([message()]);
  expect(await screen.findAllByTestId(/^daily-messages-day-/)).toHaveLength(14);
  const callsBefore = mockFetch.mock.calls.length;

  fireEvent.click(screen.getByTestId("daily-messages-member-member-1"));

  expect(screen.getAllByTestId(/^daily-messages-day-/)).toHaveLength(14);
  expect(screen.getByTestId("daily-messages-text-2026-01-15")).toHaveValue("Have a great day!");
  expect(mockFetch.mock.calls.length).toBe(callsBefore);
});

it("selects members with pills, defaults to the first and loads the picked member's window", async () => {
  renderManagement([], {
    members: [member(), member({ id: "member-2", displayName: "Bo", colorKey: "green" })],
    byMember: { "member-2": [message({ id: "m2", memberId: "member-2", text: "Bo's note" })] },
  });
  expect(await screen.findAllByTestId(/^daily-messages-day-/)).toHaveLength(14);
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  expect(screen.getByRole("radiogroup", { name: "Member" })).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: /Alex/ })).toBeChecked();

  fireEvent.click(screen.getByRole("radio", { name: /Bo/ }));

  await waitFor(() =>
    expect(screen.getByTestId("daily-messages-text-2026-01-15")).toHaveValue("Bo's note")
  );
  expect(screen.getByRole("radio", { name: /Bo/ })).toBeChecked();
});
```
(Adjust `colorKey: "green"` to any valid `MemberColorKey` in `src/shared` if "green" is not one. If the radio's accessible name includes extra text, loosen the regex.)
3. Add zebra tests (TODAY is Thursday 2026-01-15):

```tsx
const bandOf = (date: string) =>
  screen.getByTestId(`daily-messages-day-${date}`).getAttribute("data-week-band");

it("bands the 14 days by week from a Monday week start: plain, shaded, plain", async () => {
  renderManagement([], { weekStartDay: 1 });
  await screen.findAllByTestId(/^daily-messages-day-/);
  await waitFor(() => expect(bandOf("2026-01-19")).toBe("shaded"));
  expect(bandOf("2026-01-15")).toBe("plain");
  expect(bandOf("2026-01-18")).toBe("plain");
  expect(bandOf("2026-01-25")).toBe("shaded");
  expect(bandOf("2026-01-26")).toBe("plain");
  expect(screen.getByTestId("daily-messages-day-2026-01-19")).toHaveClass("bg-muted/50");
  expect(screen.getByTestId("daily-messages-day-2026-01-15")).not.toHaveClass("bg-muted/50");
});

it("bands from a Sunday week start", async () => {
  renderManagement([], { weekStartDay: 0 });
  await screen.findAllByTestId(/^daily-messages-day-/);
  await waitFor(() => expect(bandOf("2026-01-18")).toBe("shaded"));
  expect(bandOf("2026-01-17")).toBe("plain");
  expect(bandOf("2026-01-24")).toBe("shaded");
  expect(bandOf("2026-01-25")).toBe("plain");
});
```
Also in the existing "moves through 14-day windows" test, after clicking next (window starts Thu 2026-01-29), nothing else needed.

In `tests/client/day-periods-messages-admin.test.tsx`, in the test at ~line 440 ("active member and an empty 14-day editor"), update the title text to "(2 navigation buttons + 1 member pill + 14 textareas)" and add `expect(document.body.querySelector("select")).toBeNull();`. Census counts 17/19/18 stay as is (one radio replaces one select).

- [ ] **Step 2: Run, expect FAIL**: `npx vitest run tests/client/daily-messages-management.test.tsx tests/client/day-periods-messages-admin.test.tsx`

- [ ] **Step 3: Implement** in `DailyMessagesManagement.tsx`:
  1. Imports: remove `Field` and `NATIVE_SELECT_CLASSES`; add `import { MemberPills } from "@/ui";` (or the component path) and `import { weekBands } from "./daily-messages-weeks";`.
  2. `const { timezone: householdTimezone, weekStartDay } = useHouseholdSettings();`
  3. After `dates`: `const bands = useMemo(() => weekBands(dates, weekStartDay), [dates, weekStartDay]);`
  4. Replace the `<Field ...><select>...</select></Field>` block with:

```tsx
<div className="space-y-2" data-testid="daily-messages-select-member">
  <p className="text-sm font-medium">{t("dailyMessages.management.selectMember")}</p>
  <MemberPills
    mode="single"
    groupLabel={t("dailyMessages.management.selectMember")}
    members={activeMembers}
    value={selectedMemberId || null}
    testIdPrefix="daily-messages-member"
    onChange={(memberId) => {
      if (memberId === selectedMemberId) return;
      setLoadingMessages(true);
      setMessagesList([]);
      setDrafts({});
      setSelectedMemberId(memberId);
    }}
  />
</div>
```
  5. In `dates.map((date) => ...)` change to `dates.map((date, index) => ...)`, then `const band = bands[index] ?? "plain";`, add `data-week-band={band}` to the `<li>` and append `band === "shaded" && "bg-muted/50"` to its class via `cn` from `@/lib/utils` (use whatever class-merge helper the file's neighbours import; `grep -n "import { cn }" src/client/admin/*.tsx`) .
  6. The `<ul className="space-y-2">` stays (rows keep their gap; the band is the row background).

- [ ] **Step 4: Run, expect PASS** (both test files), then `npx tsc --noEmit -p .` style typecheck via `npm run typecheck`.
- [ ] **Step 5: Commit**: `git commit -am "feat(admin): pick the Messages member with pills and band the days by week"`

### Task 3: e2e and docs

**Files:**
- Modify: `tests/e2e/daily-messages.spec.ts` (lines ~92-96)
- Modify: `tests/e2e/member-lifecycle.spec.ts` (lines ~176-177)
- Modify: `docs/ui/household-contract.md` (the Messages sentence near line 61)

- [ ] **Step 1: Update `daily-messages.spec.ts`.** Replace the `getByLabel(...selectOption)` step with:

```ts
await page.getByRole("radio", { name: new RegExp(memberName) }).check();
```
and fix the comment above it ("the pill may default to a pre-existing active member"). After the loading wait, add a banding sanity check that does not depend on the weekday:

```ts
const bands = await page
  .locator('[data-testid^="daily-messages-day-"]')
  .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-week-band")));
expect(bands).toHaveLength(14);
expect(bands[0]).toBe("plain");
expect(bands).toContain("shaded");
```
(Wait for the 14 rows first: `await expect(page.locator('[data-testid^="daily-messages-day-"]')).toHaveCount(14);`. Note `daily-messages-day-` prefix also matches nothing else; `daily-messages-delete-` and `-text-` differ.) Do not rename the test title.

- [ ] **Step 2: Update `member-lifecycle.spec.ts`.** Replace the `option[value=...]` assertion with `await expect(page.getByTestId(\`daily-messages-member-${memberId}\`)).toBeVisible(); await expect(page.getByRole("radio", { name: editedName })).toBeVisible();` (name match may be a regexp if the pill name carries extra text).

- [ ] **Step 3: Docs.** In `docs/ui/household-contract.md` replace "Messages (`/admin/daily-messages`) keeps its 14-day editor and offers Retry when a load fails." with: "Messages (`/admin/daily-messages`) chooses the member with member pills, keeps its 14-day editor, alternates the rows' background per week from the household week start (the first chunk is plain, then shaded, then plain) and offers Retry when a load fails." Re-wrap the paragraph to the file's line width and run `npx prettier --check docs/ui/household-contract.md`.

- [ ] **Step 4: Run e2e**: `PORT=43222 MP_E2E_WEATHER_FIXTURE_PORT=44422 MP_E2E_QUOTE_FIXTURE_PORT=44432 npx playwright test tests/e2e/daily-messages.spec.ts tests/e2e/member-lifecycle.spec.ts --workers=3`. Expect PASS.
- [ ] **Step 5: Commit**: `git commit -am "test(admin): drive the Messages member pills in e2e and document the page"`

### Task 4: Gate and inventory

- [ ] **Step 1:** `export MP_CANDIDATE_ID=$(node tools/candidate-identity.mjs)` on a clean committed tree (check how the script prints the id; `node tools/candidate-identity.mjs --help` or read its CLI), then `npm run check:standard`.
- [ ] **Step 2: Resync `tests/fixtures/assembly-cohort.json`** where the gate demands it:
  - `testCohorts.runners.vitest.files`: add `tests/client/daily-messages-weeks.test.ts` with its 7 case names (exact titles from `.quality/vitest-list.json`), and update the case lists of `tests/client/daily-messages-management.test.tsx` (renamed/added: the two member-pill tests and two zebra tests, the removed select test) and `tests/client/day-periods-messages-admin.test.tsx` (the renamed density title).
  - `coveragePolicy.files`: add `src/client/admin/daily-messages-weeks.ts` (`layer: "client"`) with `minimumTotals` / `minimumRates` taken from `coverage/coverage-final.json` after a vitest run (copy the shape of the neighbouring entries; look at `tools/verify-coverage.mjs` for how totals are compared), and re-measure `src/client/admin/DailyMessagesManagement.tsx` (current minimum totals lines 138, statements 173, functions 41, branches 84; lower or raise them to match the measured totals, never leave a minimum above the measured value).
  - Re-run `npm run check:standard` until green. Also bump the candidate stamp only through the repo's own commands (`npm run test:cohorts:stamp` is part of check:standard).
- [ ] **Step 3:** `PORT=43222 MP_E2E_WEATHER_FIXTURE_PORT=44422 MP_E2E_QUOTE_FIXTURE_PORT=44432 npm run check:aggregate-only` (it also verifies the Playwright inventory; no spec was added or retitled, so the inventory should already match; if it does not, add the spec ids listed by `npx playwright test --list --reporter=json` under `testCohorts.runners.playwright.files`).
- [ ] **Step 4:** Commit the fixture (`git commit -am "test: resync the assembly cohort for the Messages polish"`), write `REPORT-messages-polish.md` at the worktree root (what changed, gate results, any adaptation to the shared component API), commit it, and reply `DONE`.
