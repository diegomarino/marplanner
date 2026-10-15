# Admin Settings Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or subagent-driven-development) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Settings page in two columns (Settings | Weather), a grid-aligned weather form, one Save under both columns, and four always-editable day-period cards with no layout shift.

**Architecture:** Pure client work in `src/client/admin/{SettingsManagement,WeatherManagement,DayPeriodsManagement}.tsx`. Container queries (Tailwind v4 `@container`) drive the columns because the admin sidebar eats 240px. Save logic of the page is unchanged (it already compares against the persisted values); day periods keep PATCH-per-period with one Save per card.

**Tech Stack:** React, Tailwind v4, vitest + Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-15-admin-settings-polish-design.md`

## Global Constraints

- Node 24.21.0 via `fnm exec --using=24.21.0` for every npm/npx command. Setup: `cp <maintainer-workspace>/.env.local .` then `npm ci`.
- Copy the spec and this plan into your branch first (same relative paths): from `<maintainer-workspace>/docs/superpowers/specs/2026-10-15-admin-settings-polish-design.md` and `.../plans/2026-10-15-admin-settings-polish.md`.
- Shared components from the shared-pills wave (`ChoicePills`, `MemberPills`, `WeekdayPicker` from `@/ui`) are used as they are; if a shared component API differs from the shared-pills plan when you start, adapt to the real one. Never duplicate them. Settings already uses `ChoicePills`; leave that.
- The weather form must keep the decimal-only coordinate validation from commit dd859714 (`DECIMAL` regex, `weatherFormProblem`, `weather-hint`). Do not loosen it.
- i18n: new keys only in one `// admin-settings-polish` block per locale (en and es) at the end of the existing admin keys in `src/client/i18n/messages.ts`.
- Use `ConfirmDialog` instead of `window.confirm` (none needed here), Retry on load errors, page headings equal sidebar labels (unchanged: "Settings").
- Do not add `*_CLASSES` constants outside `src/client/lib/recipes.ts`; no raw `<input>` (use `@/components/ui/input`); no new inline styles.
- Do not push, open PRs or touch git state outside your worktree branch. Do not run git stash.

## Review Focus

- Revert-to-stored disables Save again (language flip and back; weather typed then retyped; a clear then re-entry): pinned in Task 2.
- `0x10`, `1e3`, a lone latitude: Save stays disabled, hint shows (dd859714 regression): Task 2.
- Day period saved to an out-of-order time: error shown, draft kept, nothing persisted: Task 3.
- Two periods edited at once: each card saves independently and only its own draft clears: Task 3.
- Post-save refresh must not flash "Loading..." or move the cards: Task 3 (unit) and Task 4 (e2e).
- Weather plugin inactive: Settings column renders alone, Save still works for locale: existing test stays green.

---

### Task 0: Worktree and baseline

- [ ] Branch from main (after the shared-pills wave merged), copy `.env.local`, `npm ci`, copy the spec and plan in, commit them: `git add docs/superpowers && git commit -m "docs: admin settings polish spec and plan"`.
- [ ] Baseline: `fnm exec --using=24.21.0 npx vitest run tests/client/settings-management.test.tsx tests/client/weather-management.test.tsx tests/client/day-periods-management.test.tsx tests/client/day-periods-messages-admin.test.tsx` -> all pass.

### Task 1: Weather form as an aligned grid

**Files:** Modify `src/client/admin/WeatherManagement.tsx`; Test `tests/client/weather-management.test.tsx`.

**Interfaces:** Consumes the existing exports (`WeatherManagement`, `WeatherFormState`, `weatherFormProblem`, ...) - unchanged. Produces: same props and testids; fields now sit in a two-column grid.

- [ ] **Step 1: Failing test** (append to the `WeatherManagement` describe in `tests/client/weather-management.test.tsx`, using that file's existing render helper; adapt its name):

```tsx
it("lays the fields out as label/input pairs in one grid, inputs full width", () => {
  renderWeather(); // the file's existing helper that renders <WeatherManagement .../>
  const grid = screen.getByTestId("weather-fields");
  for (const id of ["weather-lat-input", "weather-lon-input", "weather-label-input"]) {
    const input = screen.getByTestId(id);
    expect(grid).toContainElement(input);
    expect(input).toHaveClass("w-full");
    // label is a sibling grid item bound by htmlFor, not a wrapper
    expect(input.closest("label")).toBeNull();
  }
  expect(screen.getByLabelText("Latitude")).toBe(screen.getByTestId("weather-lat-input"));
});
```

(Use the real English caption of `weather.management.latLabel` in `messages.ts`.)

- [ ] **Step 2:** run it, expect FAIL (no `weather-fields`).
- [ ] **Step 3: Implement.** In `WeatherManagement.tsx` import `useId` from react and `Label` from `@/components/ui/label`; remove the `LABEL_INLINE_CLASSES` import if unused. Replace the three `<label>` blocks, hint and button row inside the card with:

```tsx
const uid = useId();
...
<div className="bg-card flex flex-col gap-4 rounded-lg p-4 shadow">
  <div
    data-testid="weather-fields"
    className="grid grid-cols-1 items-center gap-x-3 gap-y-3 @sm:grid-cols-[max-content_1fr]"
  >
    <Label htmlFor={`${uid}-lat`}>{t("weather.management.latLabel")}</Label>
    <Input id={`${uid}-lat`} type="text" inputMode="decimal" data-testid="weather-lat-input"
      value={value.lat} disabled={disabled} onChange={(e) => onChange({ lat: e.target.value })}
      className="w-full min-w-0" />
    <Label htmlFor={`${uid}-lon`}>{t("weather.management.lonLabel")}</Label>
    <Input id={`${uid}-lon`} type="text" inputMode="decimal" data-testid="weather-lon-input"
      value={value.lon} disabled={disabled} onChange={(e) => onChange({ lon: e.target.value })}
      className="w-full min-w-0" />
    <Label htmlFor={`${uid}-label`}>{t("weather.management.labelLabel")}</Label>
    <Input id={`${uid}-label`} type="text" data-testid="weather-label-input" value={value.label}
      disabled={disabled} onChange={(e) => onChange({ label: e.target.value })}
      placeholder={t("weather.management.labelPlaceholder")} className="w-full min-w-0" />
  </div>
  {problem !== null && ( /* unchanged hint paragraph */ )}
  <div className="flex flex-wrap gap-2"> /* unchanged Locate and Clear buttons */ </div>
</div>
```

`@sm:` resolves against the page's `@container` (Task 2); without a container ancestor (unit tests) the grid stays one column, which is fine. Check `Label` renders a `<label>` and accepts `htmlFor`.

- [ ] **Step 4:** run `tests/client/weather-management.test.tsx` and `tests/client/network-weather-admin.test.tsx`; fix any query that relied on the nested label (use `getByLabelText`). All pass, including the decimal tests.
- [ ] **Step 5:** commit `feat(admin): lay the weather fields out on one aligned grid`.

### Task 2: Two columns and the single Save

**Files:** Modify `src/client/admin/SettingsManagement.tsx`; Test `tests/client/settings-management.test.tsx`; Modify `tests/e2e/admin-settings.spec.ts`.

**Interfaces:** Produces testids `settings-columns` (the grid), existing `settings-save`, `settings-saved`, `settings-management`.

- [ ] **Step 1: Failing tests** (settings-management.test.tsx; use the file's `mockApi`, `renderSettings`, `SETTINGS`; look at the existing "saves a pill change" test for the exact click and typing helpers):

```tsx
it("puts the Settings and Weather panels in one two-column grid above a single Save", async () => {
  mockApi(SETTINGS);
  renderSettings();
  const save = await screen.findByTestId("settings-save");
  const columns = screen.getByTestId("settings-columns");
  expect(columns).toContainElement(screen.getByTestId("settings-timezone"));
  expect(columns).toContainElement(screen.getByTestId("weather-management"));
  expect(columns).not.toContainElement(save);
  expect(screen.getAllByTestId("settings-save")).toHaveLength(1);
});

it("enables Save on any edit and disables it again when the edit is reverted", async () => {
  mockApi(SETTINGS);
  renderSettings();
  const save = await screen.findByTestId("settings-save");
  expect(save).toBeDisabled();
  fireEvent.click(screen.getByRole("radio", { name: "Español" }));
  expect(save).toBeEnabled();
  fireEvent.click(screen.getByRole("radio", { name: "English" }));
  expect(save).toBeDisabled();
  const lat = screen.getByTestId("weather-lat-input");
  const lon = screen.getByTestId("weather-lon-input");
  const originalLat = (lat as HTMLInputElement).value;
  const originalLon = (lon as HTMLInputElement).value;
  fireEvent.change(lat, { target: { value: "1.5" } });
  fireEvent.change(lon, { target: { value: "2.5" } });
  expect(save).toBeEnabled();
  fireEvent.change(lat, { target: { value: originalLat } });
  fireEvent.change(lon, { target: { value: originalLon } });
  expect(save).toBeDisabled();
});

it.each(["0x10", "1e3", "abc"])("keeps Save blocked for the non-decimal latitude %s", async (bad) => {
  mockApi(SETTINGS);
  renderSettings();
  const save = await screen.findByTestId("settings-save");
  fireEvent.change(screen.getByTestId("weather-lat-input"), { target: { value: bad } });
  fireEvent.change(screen.getByTestId("weather-lon-input"), { target: { value: "2" } });
  expect(save).toBeDisabled();
  expect(screen.getByTestId("weather-hint")).toBeInTheDocument();
});
```

If the existing helpers pass `SETTINGS` without a weather object, give the test its own settings including `weather: { lat: 40.4, lon: -3.7, label: "Home" }`.

- [ ] **Step 2:** run; the first test FAILS (no `settings-columns`), the other two may already pass (they pin existing behaviour; that is expected).
- [ ] **Step 3: Implement** in `SettingsManagement.tsx` the return block:

```tsx
<div className="@container flex flex-col gap-8" data-testid="settings-management">
  <div className="grid items-start gap-6 @2xl:grid-cols-2" data-testid="settings-columns">
    <AdminPanel title={...} description={...}>
      {/* unchanged: ErrorNotice, Retry, the locale card or the loading dots */}
    </AdminPanel>
    {form && (
      <PluginContribution pluginId="weather" group="admin" contributionId="weather">
        {form.weather && (
          <WeatherManagement value={form.weather} onChange={changeWeather} disabled={saving} />
        )}
      </PluginContribution>
    )}
  </div>
  {form && (
    <div className="flex flex-col gap-2"> {/* unchanged Save row, Saved status, scope note */} </div>
  )}
  <DayPeriodsManagement />
</div>
```

Change the timezone `Field` `className="w-72"` to `className="w-full"`. The ChoicePills rows keep their markup. Do not touch `save()`, `canSave`, dirty logic.

- [ ] **Step 4:** run settings and weather suites -> pass.
- [ ] **Step 5: e2e** `tests/e2e/admin-settings.spec.ts`: after `openAdminSection(page, "admin-nav-settings")` add layout and revert checks inside the existing `try` (the test already restores locale in `finally`):

```ts
const settingsPanel = page.getByTestId("settings-timezone");
const weatherPanel = page.getByTestId("weather-management");
await expect(weatherPanel).toBeVisible();
const a = (await settingsPanel.boundingBox())!;
const b = (await weatherPanel.boundingBox())!;
expect(Math.abs(a.y - b.y)).toBeLessThan(200); // same row, side by side
expect(b.x).toBeGreaterThan(a.x + a.width - 1);
const boxes = await Promise.all(
  ["weather-lat-input", "weather-lon-input", "weather-label-input"].map(
    async (id) => (await page.getByTestId(id).boundingBox())!
  )
);
for (const box of boxes) {
  expect(Math.abs(box.x - boxes[0].x)).toBeLessThan(1);
  expect(Math.abs(box.width - boxes[0].width)).toBeLessThan(1);
}
await expect(page.getByTestId("settings-save")).toBeDisabled();
await page.getByTestId(`settings-week-start-${target}`).click();
await expect(page.getByTestId("settings-save")).toBeEnabled();
await page.getByTestId(`settings-week-start-${before.locale.weekStartDay}`).click();
await expect(page.getByTestId("settings-save")).toBeDisabled();
await page.getByTestId(`settings-week-start-${target}`).click();
```

The weather panel only exists while the weather plugin is active in the e2e seed (`tests/e2e/weather.spec.ts` configures it from Settings, so it is); if the panel is absent in this spec, activate nothing new and drop the side-by-side lines, but keep the Save revert lines. Replace the shared-pills `toBeChecked()` assertion untouched.

- [ ] **Step 6:** run `PORT=43221 MP_E2E_WEATHER_FIXTURE_PORT=44421 MP_E2E_QUOTE_FIXTURE_PORT=44431 fnm exec --using=24.21.0 npx playwright test tests/e2e/admin-settings.spec.ts tests/e2e/weather.spec.ts --workers=3`. Pass.
- [ ] **Step 7:** commit `feat(admin): show Settings and Weather side by side under one Save`.

### Task 3: Always-editable day periods, 4 columns

**Files:** Modify `src/client/admin/DayPeriodsManagement.tsx`, `src/client/i18n/messages.ts`; Test `tests/client/day-periods-management.test.tsx`, `tests/client/day-periods-messages-admin.test.tsx`, `tests/e2e/day-periods.spec.ts`, `tests/e2e/accessible-names-audit.spec.ts`.

**Interfaces:** Testids kept: `day-periods-management`, `day-period-<id>` (card), `day-periods-start-input-<id>`, `day-periods-save-<id>`, `day-periods-error`, `day-periods-empty`. Removed: `day-periods-edit-<id>`, `day-periods-cancel-<id>`. New: `day-periods-grid`, `day-periods-retry`.

- [ ] **Step 1: Failing unit tests** in `tests/client/day-periods-management.test.tsx` (add `fireEvent` to imports; reuse its fetch stub style, extended with a PATCH branch that records calls and answers 200 with the period; a second GET after PATCH returns the updated list):

```tsx
it("renders four cards with editable inputs and no Edit button", async () => {
  stubPeriods();
  renderManagement();
  const grid = await screen.findByTestId("day-periods-grid");
  expect(grid.children).toHaveLength(4);
  for (const id of ["morning", "afternoon", "evening", "night"]) {
    expect(screen.getByTestId(`day-periods-start-input-${id}`)).toBeEnabled();
    expect(screen.getByTestId(`day-periods-save-${id}`)).toBeDisabled();
  }
  expect(screen.queryByTestId("day-periods-edit-morning")).toBeNull();
});

it("enables only the edited card's Save and disables it again when reverted", async () => {
  stubPeriods();
  renderManagement();
  const input = await screen.findByTestId("day-periods-start-input-afternoon");
  fireEvent.change(input, { target: { value: "11:30" } });
  expect(screen.getByTestId("day-periods-save-afternoon")).toBeEnabled();
  expect(screen.getByTestId("day-periods-save-evening")).toBeDisabled();
  fireEvent.change(input, { target: { value: "12:00" } });
  expect(screen.getByTestId("day-periods-save-afternoon")).toBeDisabled();
});

it("saves one card with PATCH, keeps other drafts, and never shows Loading again", async () => {
  const { patches } = stubPeriods();
  renderManagement();
  await screen.findByTestId("day-periods-grid");
  fireEvent.change(screen.getByTestId("day-periods-start-input-afternoon"), { target: { value: "11:30" } });
  fireEvent.change(screen.getByTestId("day-periods-start-input-evening"), { target: { value: "18:30" } });
  fireEvent.click(screen.getByTestId("day-periods-save-afternoon"));
  await waitFor(() => expect(patches).toEqual([["afternoon", { start: "11:30" }]]));
  expect(screen.queryByText("Loading…")).toBeNull();
  await waitFor(() => expect(screen.getByTestId("day-periods-save-afternoon")).toBeDisabled());
  expect(screen.getByTestId("day-periods-start-input-evening")).toHaveValue("18:30");
  expect(screen.getByTestId("day-periods-save-evening")).toBeEnabled();
});

it("rejects an out-of-order time before any request and keeps the draft", async () => {
  const { patches } = stubPeriods();
  renderManagement();
  const input = await screen.findByTestId("day-periods-start-input-afternoon");
  fireEvent.change(input, { target: { value: "04:00" } });
  fireEvent.click(screen.getByTestId("day-periods-save-afternoon"));
  expect(await screen.findByTestId("day-periods-error")).toBeInTheDocument();
  expect(patches).toEqual([]);
  expect(input).toHaveValue("04:00");
});

it("offers Retry when the list cannot be loaded", async () => {
  stubPeriods({ failFirstList: true });
  renderManagement();
  fireEvent.click(await screen.findByTestId("day-periods-retry"));
  expect(await screen.findByTestId("day-periods-grid")).toBeInTheDocument();
});
```

`stubPeriods` is a small helper you add to that file next to `PERIODS`: a `vi.stubGlobal("fetch", ...)` stub answering `/api/settings`, GET `/api/day-periods` (current periods; if `failFirstList` the first call returns 500), and PATCH `/api/day-periods/:id` (records `[id, JSON.parse(body)]` into `patches`, updates its list, returns the updated period). It returns `{ patches }`.

- [ ] **Step 2:** run; expect FAIL.
- [ ] **Step 3: Implement** in `DayPeriodsManagement.tsx` (keep everything not mentioned: timezone/active-period effects, `DAY_PERIOD_LABEL_KEYS`, the unlock wrapper):
  - Remove `editingPeriodId`, `editingStart`, `handleStartEdit`, `handleCancelEdit`. Add `const [drafts, setDrafts] = useState<Partial<Record<PeriodId, string>>>({}); const [savingId, setSavingId] = useState<PeriodId | null>(null);`
  - `handleSave(id)`: `const start = (drafts[id] ?? "").trim();` build `proposed` from the stored `periods` with that one start, run the existing `validateStartOrdering` try/catch error mapping unchanged (set error and return, draft kept), then the existing PATCH; on success `refreshPeriods(); setDrafts(({[id]: _, ...rest}) => rest);` on failure `setError(t("dayPeriods.action.saveError"))`; `finally` clears `savingId`. Clear `error` at the start of a save and when a draft changes.
  - `refreshPeriods`: only `setLoading(true)` when `periods` is empty, i.e. the loading line renders as `loading && periods.length === 0`. Keep the `setLoading(false)` in finally.
  - Render: after `ErrorNotice`, when the first load failed (`error` set and `periods.length === 0` and not loading) render `<Button type="button" variant="outline" data-testid="day-periods-retry" onClick={refreshPeriods}>{t("dayPeriods.management.retry")}</Button>`. The list:

```tsx
<div data-testid="day-periods-grid" className="grid grid-cols-1 gap-3 @md:grid-cols-2 @4xl:grid-cols-4">
  {periods.map((period) => {
    // derivedEnd etc. inside the existing try/catch
    const draft = drafts[period.id];
    const dirty = draft !== undefined && draft !== period.start;
    return (
      <div key={period.id} role="group" aria-labelledby={`day-period-title-${period.id}`}
        data-testid={`day-period-${period.id}`}
        className={cn("flex flex-col gap-2 rounded-md border p-3", isActive && "border-primary bg-primary/5")}>
        <div className="flex min-h-8 flex-wrap items-center gap-2">
          <strong id={`day-period-title-${period.id}`}>{t(DAY_PERIOD_LABEL_KEYS[period.id])}</strong>
          {isActive && (<span className="bg-primary/10 text-primary rounded px-2 py-0.5 text-xs">{t("dayPeriods.activeNow")}</span>)}
        </div>
        <span className="text-muted-foreground text-control">{period.start} – {derivedEndTimeStr}</span>
        <Field label={t("dayPeriods.action.editStartLabel")}>
          <Input type="time" value={draft ?? period.start} disabled={savingId !== null}
            data-testid={`day-periods-start-input-${period.id}`}
            onChange={(e) => { setError(null); setDrafts((d) => ({ ...d, [period.id]: e.target.value })); }} />
        </Field>
        <Button type="button" size="sm" data-testid={`day-periods-save-${period.id}`}
          onClick={() => handleSave(period.id)} disabled={!dirty || !draft || savingId !== null}>
          {savingId === period.id ? t("dayPeriods.management.saving") : t("dayPeriods.action.save")}
        </Button>
      </div>
    );
  })}
</div>
```

  The page root `@container` from Task 2 drives `@md:`/`@4xl:`. Note the e2e text assertion `afternoonCard toContainText(/\d{2}:\d{2}\s*–\s*\d{2}:\d{2}/)` still matches the range line.
  - i18n: add `"dayPeriods.management.retry"` (en "Retry", es "Reintentar") in the `// admin-settings-polish` block of both locales. Then `grep -rn "dayPeriods.action.edit\"\|dayPeriods.action.cancel" src tests`; if only `messages.ts` remains, delete both keys in both locales (and the i18n parity test needs no change; run it).

- [ ] **Step 4:** run `tests/client/day-periods-management.test.tsx` -> pass.
- [ ] **Step 5: Update density tests** in `tests/client/day-periods-messages-admin.test.tsx` (the "DayPeriodsManagement kiosk density" describe): keep the zero-control census test; replace the next three plus the deliberate-negative with:
  - "meets kiosk density with all four periods editable (4 inputs + 4 Save buttons = 8 controls)": `countInteractiveControls(document.body)` is `8`, `assertKioskDensityCompliant` does not throw.
  - "census fires on change: editing a time does not add or remove controls": after `fireEvent.change(getByTestId("day-periods-start-input-afternoon"), {target:{value:"11:30"}})` still `8` and compliant.
  - deliberate negative: shrink `day-periods-save-morning` (height 16px, font-size 10px) and expect the same `DensityViolationError` messages as before, then revert.
  Remove the edit/cancel clicks (6 -> 4 test).
- [ ] **Step 6: e2e.**
  - `tests/e2e/day-periods.spec.ts`: US2 edit: drop the Edit click; `const timeInput = page.getByTestId("day-periods-start-input-afternoon")`; read its value; `fill("11:30")`; click `afternoonCard.getByRole("button", { name: m["dayPeriods.action.save"] })` (cards are groups so the scoped name is unambiguous); same assertions after. Negative: fill "04:00", click Save, expect `day-periods-error`; then restore by `fill(newAfternoonStart)` instead of the Cancel click (assert Save disabled). Add: before editing, record `boundingBox()` of the four cards and assert equal `y` (one row at 1280px) and equal heights; after typing a value assert the boxes unchanged (no layout jump).
  - `tests/e2e/accessible-names-audit.spec.ts` "Day Periods edit mode" test: remove the Edit click and the `input[type="time"]` wait; wait for `getByTestId("day-period-afternoon")` instead and rename the test "Day Periods (always editable) has no unnamed control". If the first Day Periods test is now identical, keep both only if the second types a draft first (fill `day-periods-start-input-afternoon` with "11:31" without saving, so the enabled Save state is audited).
- [ ] **Step 7:** run `PORT=43221 MP_E2E_WEATHER_FIXTURE_PORT=44421 MP_E2E_QUOTE_FIXTURE_PORT=44431 fnm exec --using=24.21.0 npx playwright test tests/e2e/day-periods.spec.ts tests/e2e/accessible-names-audit.spec.ts --workers=3`. Pass (day-periods spec mutates afternoon start; it already does today).
- [ ] **Step 8:** commit `feat(admin): make the four day periods editable in place`.

### Task 4: Docs

**Files:** Modify `docs/ui/household-contract.md` (item 13).

- [ ] Rewrite item 13 to: "`/admin/settings` - language, week start and time zone in the left column and, while the weather plugin is active, the weather location in the right column (stacked on narrow content), with one Save below both columns that is enabled only while a value differs from the stored one; below, the four day periods in a row, each always editable with its own Save."
- [ ] Commit `docs: describe the polished Settings page`.

### Task 5: Gate

- [ ] Clean committed tree: `git status --short` empty. `export MP_CANDIDATE_ID=$(fnm exec --using=24.21.0 node tools/candidate-identity.mjs)` then `fnm exec --using=24.21.0 npm run check:standard`.
- [ ] If the cohort check or coverage fails, resync `tests/fixtures/assembly-cohort.json` (never hand-wave the numbers; use the generated lists):
  - Vitest: new/renamed test names for files in `testCohorts.runners.vitest.files` come from `.quality/vitest-list.json` (`npm run test:cohorts:vitest:list`). Files touched here: `tests/client/settings-management.test.tsx`, `weather-management.test.tsx`, `day-periods-management.test.tsx`, `day-periods-messages-admin.test.tsx` (renamed/removed density cases). Replace each file's case list with the listed names. No new vitest files are expected; if you add one, add it.
  - Coverage: `coveragePolicy.files` entries for `src/client/admin/SettingsManagement.tsx`, `WeatherManagement.tsx`, `DayPeriodsManagement.tsx`: update `minimumTotals`/`minimumRates` to the remeasured values from `coverage/coverage-final.json` only if the report says they dropped below the minimums or the check demands it; no new source files are expected.
  - Playwright: no new spec files; test titles in `admin-settings.spec.ts`, `day-periods.spec.ts`, `accessible-names-audit.spec.ts` that you renamed must be updated under `testCohorts.runners.playwright.files` keyed by spec id (from `playwright test --list --reporter=json`, i.e. `.quality/playwright-list.json`).
  Re-run `check:standard` until green; commit the fixture: `chore: resync the reviewed inventory for the Settings polish`.
- [ ] `PORT=43221 MP_E2E_WEATHER_FIXTURE_PORT=44421 MP_E2E_QUOTE_FIXTURE_PORT=44431 fnm exec --using=24.21.0 npm run check:aggregate-only` (verifies the Playwright inventory). Fix inventory drift (fixture again) until green, commit.
- [ ] Final: commit everything on the worktree branch (clean tree), write `REPORT-settings-polish.md` at the worktree root (not committed): commits, what was done, deviations, gate numbers, open issues. Reply DONE.

## Self-review

- Spec D1-D2 -> Task 2; D3-D4 -> Tasks 1-2; D5-D8 -> Task 3; D10 i18n -> Task 3; household-contract -> Task 4; gates -> Task 5.
- Names consistent: `settings-columns`, `weather-fields`, `day-periods-grid`, `day-periods-retry`, `drafts`, `savingId`.
- Known risk: container-query classes are not computed in jsdom; layout is pinned by e2e bounding boxes only.
