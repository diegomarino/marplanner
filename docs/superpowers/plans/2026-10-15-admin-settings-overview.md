# Admin Settings Rework and Overview Uptime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework `/admin/settings` (pill choices, curated grouped time zones, one Save covering locale and weather, auto-hiding "Saved", Retry) and add an Uptime row to `/admin` backed by a new `uptimeSeconds` field on `SystemStatus`.

**Architecture:** `WeatherManagement` becomes a controlled panel; `SettingsManagement` owns the form state for locale and weather and performs up to two sequential `PUT /api/settings` calls on one Save. A client-only `timezones.ts` provides the curated list. The server adds `uptimeSeconds` to the system-status response; the Overview formats it.

**Tech Stack:** React + TypeScript (Vite client), Fastify server, vitest (+ Testing Library), Playwright e2e, OpenAPI YAML under `docs/api/**`.

**Spec:** `docs/superpowers/specs/2026-10-15-admin-settings-overview-design.md` (read it first; it holds the Decisions/Assumptions and the i18n key table).

## Global Constraints

- Repo root of the main checkout: `<maintainer-workspace>`. Reference app (READ-ONLY, never use its DB): `<marplanner-v1>`.
- Work in your own git worktree/branch. The spec and this plan live UNTRACKED in the main checkout: copy both files into the same relative paths (`docs/superpowers/specs/2026-10-15-admin-settings-overview-design.md`, `docs/superpowers/plans/2026-10-15-admin-settings-overview.md`) in your branch and commit them with the work.
- Do not add a new shared UI primitive (no Sheet, no shared pills). Reuse `src/client/components/ui/*` and shared composites (`AdminPanel`, `ErrorNotice`, `Field`, ...).
- All UI strings go in `src/client/i18n/messages.ts`, en AND es, in ONE contiguous block per locale under the comment `// admin-settings-overview`, placed right after the last existing admin key of that locale (after `"admin.notFound.description"` in both locales). Technical output (code, commit messages) is English.
- Keep edits to shared hot files minimal and localized: `src/client/i18n/messages.ts`, `src/client/admin/AdminRoutes.tsx` (do not touch), `src/shared/index.ts`, `tests/fixtures/assembly-cohort.json`, `docs/ui/household-contract.md`.
- Backend change rule: update `src/shared` type, server route, `docs/api/telemetry/openapi.yaml`, and the feature spec under `docs/features/`.
- Replace nothing with `window.confirm`; this area has none.
- Verification gate (see Final Task): `npm run check:standard` from a clean committed tree, plus the affected e2e specs with `PORT=43208 npx playwright test <spec> --workers=3`.
- Test commands: single vitest file `npx vitest run tests/client/<file>`; boundary `npx vitest run tests/boundary/<file> --environment node`.

## Review Focus

1. Stored time zone not in the curated list (for example `Etc/GMT+3` or `America/Argentina/Cordoba`): must stay selectable, shown once, never silently replaced on Save (Task 2 and Task 4 tests).
2. Weather plugin inactive (`weather` key absent from `GET /api/settings`): no weather panel, no weather PUT, Save only reflects locale (Task 4 test).
3. Partial failure of the two-request Save (locale OK, weather rejected): locale must show as saved, weather edit must be kept and still dirty, the app must still be told to reload household settings (Task 4 test).
4. Half-filled or non-numeric coordinates: Save disabled with a visible reason, never a rejected request (Task 3 and Task 4 tests).
5. Older server during a deploy returns no `uptimeSeconds`, or a value under one minute: Overview shows an em dash or seconds, never `NaN` (Task 1 tests).

---

## File Structure

- Create: `src/client/admin/timezones.ts` — curated groups + `timeZoneGroups(current)`.
- Create: `tests/client/settings-timezones.test.ts`.
- Modify: `src/client/admin/WeatherManagement.tsx` — controlled panel + exported helpers.
- Modify: `src/client/admin/SettingsManagement.tsx` — pills, grouped select, one Save, Retry, Saved.
- Modify: `src/client/admin/AdminOverview.tsx` — Uptime row, exported `formatUptime`.
- Modify: `src/shared/index.ts` (SystemStatus), `src/server/routes/telemetry.ts`, `docs/api/telemetry/openapi.yaml`.
- Modify: `src/client/i18n/messages.ts`.
- Modify tests: `tests/boundary/system-status.test.ts`, `tests/client/admin-overview.test.tsx`, `tests/client/settings-management.test.tsx`, `tests/client/weather-management.test.tsx`, `tests/client/network-weather-admin.test.tsx` (weather describes only), `tests/e2e/weather.spec.ts`.
- Create: `tests/e2e/admin-settings.spec.ts`.
- Docs: `docs/features/client-logging-telemetry.md`, `docs/features/weather.md`, `docs/ui/household-contract.md`.
- Resync if the tooling demands: `tests/fixtures/assembly-cohort.json`.

---

### Task 0: Workspace

- [ ] **Step 1:** Create your worktree and branch from `main` (use the `superpowers:using-git-worktrees` skill). Name the branch `feat/admin-settings-overview`.
- [ ] **Step 2:** Copy the spec and this plan from `<maintainer-workspace>/docs/superpowers/{specs,plans}/` into the same paths in the worktree. Do not commit yet.
- [ ] **Step 3:** `npm ci` (if `node_modules` is absent) and `npx vitest run tests/client/settings-management.test.tsx` to confirm a green baseline.

---

### Task 1: Uptime on the system status (backend, docs, Overview row)

**Files:**
- Modify: `src/shared/index.ts:653-658`
- Modify: `src/server/routes/telemetry.ts:125-129`
- Modify: `docs/api/telemetry/openapi.yaml:177-193`
- Modify: `docs/features/client-logging-telemetry.md` (append one FR; see Step 8)
- Modify: `src/client/admin/AdminOverview.tsx`
- Modify: `src/client/i18n/messages.ts` (key `admin.overview.uptime`, in the block from Task 4; if Task 4 has not run yet, create the block here and Task 4 appends to it)
- Test: `tests/boundary/system-status.test.ts`, `tests/client/admin-overview.test.tsx`

**Interfaces:**
- Produces: `SystemStatus.uptimeSeconds: number`; `export function formatUptime(totalSeconds: number, locale: string): string` from `src/client/admin/AdminOverview.tsx`; test id `admin-overview-uptime`.

- [ ] **Step 1: Write the failing boundary test.** In `tests/boundary/system-status.test.ts`, test "tells an admin-capable device what is deployed": change the key assertion and add the uptime check.

```ts
expect(Object.keys(body).sort()).toEqual(["build", "checkedAt", "status", "uptimeSeconds"]);
expect(Number.isInteger(body.uptimeSeconds)).toBe(true);
expect(body.uptimeSeconds as number).toBeGreaterThanOrEqual(0);
```

- [ ] **Step 2: Run it, expect FAIL.** `npx vitest run tests/boundary/system-status.test.ts --environment node` fails on the key list.

- [ ] **Step 3: Implement the server side.**

`src/shared/index.ts` (interface `SystemStatus`):

```ts
export interface SystemStatus {
  status: "ok";
  checkedAt: string;
  /** Whole seconds since the server process started. */
  uptimeSeconds: number;
  build: BuildInfo;
}
```

`src/server/routes/telemetry.ts` (the `const status: SystemStatus` literal):

```ts
const status: SystemStatus = {
  status: "ok",
  checkedAt: new Date().toISOString(),
  uptimeSeconds: Math.floor(process.uptime()),
  build: getBuildInfo(),
};
```

`docs/api/telemetry/openapi.yaml` schema `SystemStatus`: add `uptimeSeconds` to `required` and `properties`:

```yaml
        - uptimeSeconds
...
        uptimeSeconds:
          type: integer
          minimum: 0
          description: Whole seconds since the server process started.
```

- [ ] **Step 4: Run boundary test and OpenAPI checks.** `npx vitest run tests/boundary/system-status.test.ts --environment node` PASS; `npm run check:openapi && npm run check:openapi-shapes` PASS.

- [ ] **Step 5: Write failing client tests.** In `tests/client/admin-overview.test.tsx`: add `uptimeSeconds: 183_720` (2 d 3 h 2 min) to the `STATUS` const and add:

```tsx
import { formatUptime } from "@/admin/AdminOverview";

describe("formatUptime", () => {
  it("shows the two largest non-zero units", () => {
    expect(formatUptime(183_720, "en-GB")).toMatch(/^2\s?d\s?3\s?h$/);
    expect(formatUptime(3_900, "en-GB")).toMatch(/^1\s?h\s?5\s?m(in)?$/);
  });
  it("shows seconds below one minute and clamps nonsense to zero", () => {
    expect(formatUptime(42, "en-GB")).toMatch(/^42\s?s$/);
    expect(formatUptime(-5, "en-GB")).toMatch(/^0\s?s$/);
  });
});
```

and inside `describe("AdminOverview")`:

```tsx
it("shows the uptime, or a dash when the server does not report it", async () => {
  mockBackend();
  const { unmount } = render(<AdminOverview onOpenTelemetry={vi.fn()} />);
  expect(await screen.findByTestId("admin-overview-uptime")).toHaveTextContent(/2\s?d\s?3\s?h/);
  unmount();
  cleanup();
  const { uptimeSeconds: _omit, ...legacy } = STATUS;
  mockBackend({ status: legacy });
  render(<AdminOverview onOpenTelemetry={vi.fn()} />);
  expect(await screen.findByTestId("admin-overview-uptime")).toHaveTextContent("—");
});
```

- [ ] **Step 6: Run, expect FAIL** (`formatUptime` missing). `npx vitest run tests/client/admin-overview.test.tsx`.

- [ ] **Step 7: Implement the UI.** In `AdminOverview.tsx`, above `StatusCard` add:

```tsx
const UPTIME_UNITS: ["day" | "hour" | "minute", number][] = [
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

/** Whole-second uptime as the two largest non-zero units ("2d 3h"), or seconds under a minute. */
export function formatUptime(totalSeconds: number, locale: string): string {
  const unit = (value: number, name: Intl.NumberFormatOptions["unit"]) =>
    new Intl.NumberFormat(locale, { style: "unit", unit: name, unitDisplay: "narrow" }).format(
      value
    );
  let remaining = Math.max(0, Math.floor(totalSeconds));
  if (remaining < 60) return unit(remaining, "second");
  const parts: string[] = [];
  for (const [name, size] of UPTIME_UNITS) {
    const value = Math.floor(remaining / size);
    remaining -= value * size;
    if (value > 0) parts.push(unit(value, name));
  }
  return parts.slice(0, 2).join(" ");
}
```

In the System Status card, after the "Last check" row:

```tsx
<StatusRow label={t("admin.overview.uptime")}>
  <span data-testid="admin-overview-uptime">
    {status
      ? typeof status.uptimeSeconds === "number"
        ? formatUptime(status.uptimeSeconds, locale)
        : "—"
      : "—"}
  </span>
</StatusRow>
```

Add `admin.overview.uptime` to both locales (en "Uptime", es "Tiempo en marcha") under the `// admin-settings-overview` block (see Task 4 Step 6 for exact placement).

- [ ] **Step 8: Docs.** In `docs/features/client-logging-telemetry.md`, find the highest `FR-0NN` and append the next number after it, in the same style: "Given the admin overview reads `GET /api/telemetry/system-status`, when the server answers, then the body MUST include `uptimeSeconds`, the whole seconds since the server process started." Update the Overview paragraph in `docs/ui/household-contract.md` (the `/admin` paragraph): add "and how long the server has been running".

- [ ] **Step 9: Run** `npx vitest run tests/client/admin-overview.test.tsx tests/client/admin-gate.test.tsx` PASS, then `npm run typecheck`.

- [ ] **Step 10: Commit** (worktree branch): `git add -A && git commit -m "feat(admin): report server uptime on the overview"`.

---

### Task 2: Curated time zone module

**Files:**
- Create: `src/client/admin/timezones.ts`
- Test: `tests/client/settings-timezones.test.ts`

**Interfaces:**
- Produces:

```ts
export interface TimeZoneOption { value: string; label: string }
export type TimeZoneGroupId = "current" | "utc" | "europe" | "americas" | "asiaPacific" | "africaMiddleEast";
export interface TimeZoneGroup { id: TimeZoneGroupId; options: TimeZoneOption[] }
export function timeZoneGroups(current: string): TimeZoneGroup[]
```

- [ ] **Step 1: Write the failing test** `tests/client/settings-timezones.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { timeZoneGroups } from "@/admin/timezones";

const values = (groups: ReturnType<typeof timeZoneGroups>) =>
  groups.flatMap((group) => group.options.map((option) => option.value));

describe("timeZoneGroups", () => {
  it("lists UTC first and the curated groups in order", () => {
    const groups = timeZoneGroups("Europe/Madrid");
    expect(groups.map((group) => group.id)).toEqual([
      "utc",
      "europe",
      "americas",
      "asiaPacific",
      "africaMiddleEast",
    ]);
    expect(groups[0]!.options).toEqual([{ value: "UTC", label: "UTC" }]);
  });

  it("gives curated zones a friendly label", () => {
    const europe = timeZoneGroups("UTC").find((group) => group.id === "europe")!;
    expect(europe.options).toContainEqual({
      value: "Europe/Madrid",
      label: "Madrid (CET/CEST)",
    });
  });

  it("has no duplicates and only zones the server accepts", () => {
    const all = values(timeZoneGroups("UTC"));
    expect(new Set(all).size).toBe(all.length);
    for (const zone of all) {
      expect(() => new Intl.DateTimeFormat(undefined, { timeZone: zone })).not.toThrow();
    }
  });

  it("keeps a stored zone outside the list selectable, once, in a leading group", () => {
    const groups = timeZoneGroups("America/Argentina/Cordoba");
    expect(groups[0]).toEqual({
      id: "current",
      options: [{ value: "America/Argentina/Cordoba", label: "America/Argentina/Cordoba" }],
    });
    expect(values(groups).filter((zone) => zone === "America/Argentina/Cordoba")).toHaveLength(1);
  });

  it("does not add a current group for listed zones or UTC", () => {
    expect(timeZoneGroups("Asia/Tokyo")[0]!.id).toBe("utc");
    expect(timeZoneGroups("UTC")[0]!.id).toBe("utc");
  });

  it("replaces underscores in the label of an unlisted zone", () => {
    const [current] = timeZoneGroups("America/Port_of_Spain");
    expect(current!.options[0]!.label).toBe("America/Port of Spain");
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (module missing): `npx vitest run tests/client/settings-timezones.test.ts`.

- [ ] **Step 3: Implement** `src/client/admin/timezones.ts`. Copy the 37 entries from `<marplanner-v1>/packages/shared/src/constants/timezones.ts` (`TIMEZONE_OPTIONS`) into the four groups keeping their `value` and `label` exactly (12 Europe, 11 Americas, 10 Asia-Pacific, 4 Africa & Middle East = 37; copy exactly). Shape:

```ts
export interface TimeZoneOption {
  value: string;
  label: string;
}
export type TimeZoneGroupId =
  | "current"
  | "utc"
  | "europe"
  | "americas"
  | "asiaPacific"
  | "africaMiddleEast";
export interface TimeZoneGroup {
  id: TimeZoneGroupId;
  options: TimeZoneOption[];
}

/** Zones the household picker offers, with friendly labels (place names are not translated). */
const CURATED: TimeZoneGroup[] = [
  { id: "utc", options: [{ value: "UTC", label: "UTC" }] },
  {
    id: "europe",
    options: [
      { value: "Europe/London", label: "London (GMT/BST)" },
      { value: "Europe/Madrid", label: "Madrid (CET/CEST)" },
      // ...the rest of the reference's Europe entries, verbatim
    ],
  },
  // americas, asiaPacific, africaMiddleEast: same, verbatim from the reference
];

/** The groups to render. A stored zone outside the curated list is offered in a leading
 * "current" group, so opening the page and saving never swaps it for something else.
 */
export function timeZoneGroups(current: string): TimeZoneGroup[] {
  const listed = CURATED.some((group) => group.options.some((option) => option.value === current));
  if (listed || current.trim() === "") return CURATED;
  return [
    { id: "current", options: [{ value: current, label: current.replaceAll("_", " ") }] },
    ...CURATED,
  ];
}
```

NOTE the test "keeps a stored zone outside the list selectable" expects label `America/Argentina/Cordoba` (no underscores, so `replaceAll` leaves it unchanged); the underscore test expects `America/Port of Spain`. Both pass with the code above.

- [ ] **Step 4: Run, expect PASS.** `npx vitest run tests/client/settings-timezones.test.ts`.
- [ ] **Step 5: Commit** `feat(admin): curated grouped time zone list`.

---

### Task 3: WeatherManagement becomes a controlled panel

**Files:**
- Modify: `src/client/admin/WeatherManagement.tsx` (rewrite)
- Modify: `tests/client/weather-management.test.tsx` (rewrite)
- Modify: `tests/client/network-weather-admin.test.tsx` (weather describes only, from `describe("WeatherManagement — kiosk density` to end of file, and the `mockWeatherBackend`/`renderWeather` helpers)
- Modify: `src/client/i18n/messages.ts` (delete now-unused `weather.management.loading|loadError|save|saving|saveError|clearError`, both locales; keep every other `weather.management.*` key)

**Interfaces:**
- Produces (all exported from `src/client/admin/WeatherManagement.tsx`):

```ts
export interface WeatherFormState { lat: string; lon: string; label: string }
export const EMPTY_WEATHER_FORM: WeatherFormState
export function toWeatherFormState(weather: WeatherSettingsObject): WeatherFormState
export function weatherFormProblem(form: WeatherFormState): "partial" | "invalid" | null
export function weatherFormDirty(a: WeatherFormState, b: WeatherFormState): boolean
export function weatherPayload(form: WeatherFormState): Record<string, unknown>
export interface WeatherManagementProps {
  value: WeatherFormState;
  onChange: (patch: Partial<WeatherFormState>) => void;
  disabled?: boolean;
}
export function WeatherManagement(props: WeatherManagementProps): JSX.Element
```
- Test ids kept: `weather-management`, `weather-lat-input`, `weather-lon-input`, `weather-label-input`, `weather-locate`, `weather-clear`, `weather-error`. New: `weather-hint`. Removed: `weather-save`.

- [ ] **Step 1: Write the failing tests.** Replace `tests/client/weather-management.test.tsx` with a harness-based suite (keep the file header comment style; keep the `@/lib/householdSettings` mock so `LanguageProvider` resolves synchronously):

```tsx
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LanguageProvider } from "@/i18n";
import { messages } from "@/i18n/messages";
import {
  EMPTY_WEATHER_FORM,
  WeatherManagement,
  toWeatherFormState,
  weatherFormDirty,
  weatherFormProblem,
  weatherPayload,
  type WeatherFormState,
} from "@/admin/WeatherManagement";

const household = { timezone: "Europe/Madrid", language: "en", weekStartDay: 1 };
vi.mock("@/lib/householdSettings", () => ({
  useHouseholdSettings: () => household,
  useHouseholdSettingsContext: () => household,
}));

function Harness({ initial = EMPTY_WEATHER_FORM }: { initial?: WeatherFormState }) {
  const [value, setValue] = useState(initial);
  return (
    <LanguageProvider>
      <WeatherManagement value={value} onChange={(patch) => setValue((c) => ({ ...c, ...patch }))} />
    </LanguageProvider>
  );
}

describe("weather form helpers", () => {
  it("maps settings to strings and back to a payload without a blank label", () => {
    const form = toWeatherFormState({ lat: 40.4168, lon: -3.7038, label: "Madrid" });
    expect(form).toEqual({ lat: "40.4168", lon: "-3.7038", label: "Madrid" });
    expect(weatherPayload(form)).toEqual({ lat: 40.4168, lon: -3.7038, label: "Madrid" });
    expect(weatherPayload({ lat: "1", lon: "2", label: "  " })).toEqual({ lat: 1, lon: 2 });
    expect(weatherPayload(EMPTY_WEATHER_FORM)).toEqual({ lat: null, lon: null });
  });
  it("flags a partial or non-numeric pair", () => {
    expect(weatherFormProblem(EMPTY_WEATHER_FORM)).toBeNull();
    expect(weatherFormProblem({ lat: "1", lon: "2", label: "" })).toBeNull();
    expect(weatherFormProblem({ lat: "1", lon: "", label: "" })).toBe("partial");
    expect(weatherFormProblem({ lat: "1", lon: "x", label: "" })).toBe("invalid");
  });
  it("compares forms field by field", () => {
    expect(weatherFormDirty(EMPTY_WEATHER_FORM, { ...EMPTY_WEATHER_FORM })).toBe(false);
    expect(weatherFormDirty(EMPTY_WEATHER_FORM, { ...EMPTY_WEATHER_FORM, label: "x" })).toBe(true);
  });
});

describe("WeatherManagement", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    Reflect.deleteProperty(navigator, "geolocation");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("shows the values it is given and blank inputs when unset", () => {
    render(<Harness initial={{ lat: "40.4168", lon: "-3.7038", label: "Madrid" }} />);
    expect(screen.getByTestId("weather-lat-input")).toHaveValue(40.4168);
    expect(screen.getByTestId("weather-label-input")).toHaveValue("Madrid");
    cleanup();
    render(<Harness />);
    expect(screen.getByTestId("weather-lat-input")).toHaveValue(null);
    expect(screen.getByTestId("weather-label-input")).toHaveValue("");
  });

  it("reports edits through onChange and never touches the network", () => {
    render(<Harness />);
    fireEvent.change(screen.getByTestId("weather-lat-input"), { target: { value: "10" } });
    expect(screen.getByTestId("weather-lat-input")).toHaveValue(10);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("disables Locate when geolocation is absent", () => {
    render(<Harness />);
    expect(screen.getByTestId("weather-locate")).toBeDisabled();
  });

  it("geolocation prefills rounded lat/lon and writes nothing (FR-010)", async () => {
    const getCurrentPosition = vi.fn((ok: (p: GeolocationPosition) => void) =>
      ok({ coords: { latitude: 51.507351234, longitude: -0.12775891 } } as GeolocationPosition)
    );
    Object.defineProperty(navigator, "geolocation", {
      value: { getCurrentPosition },
      configurable: true,
    });
    render(<Harness />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("weather-locate"));
    });
    expect(screen.getByTestId("weather-lat-input")).toHaveValue(51.5074);
    expect(screen.getByTestId("weather-lon-input")).toHaveValue(-0.1278);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("announces a refused geolocation without changing the fields", async () => {
    Object.defineProperty(navigator, "geolocation", {
      value: { getCurrentPosition: (_ok: unknown, fail: () => void) => fail() },
      configurable: true,
    });
    render(<Harness initial={{ lat: "1", lon: "2", label: "" }} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("weather-locate"));
    });
    expect(screen.getByTestId("weather-error")).toHaveTextContent(
      messages.en["weather.management.geolocationError"]
    );
    expect(screen.getByTestId("weather-lat-input")).toHaveValue(1);
  });

  it("Clear empties all three fields locally and is disabled once blank", () => {
    render(<Harness initial={{ lat: "1", lon: "2", label: "Home" }} />);
    fireEvent.click(screen.getByTestId("weather-clear"));
    expect(screen.getByTestId("weather-lat-input")).toHaveValue(null);
    expect(screen.getByTestId("weather-label-input")).toHaveValue("");
    expect(screen.getByTestId("weather-clear")).toBeDisabled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("explains a half-filled pair", () => {
    render(<Harness initial={{ lat: "1", lon: "", label: "" }} />);
    expect(screen.getByTestId("weather-hint")).toHaveTextContent(
      messages.en["admin.settings.weatherIncomplete"]
    );
  });
});
```

Note: the test file uses `admin.settings.weatherIncomplete`, added in Task 4 Step 6. Add that key (and the whole block) now if you run Task 3 first; Task 4 then only checks it is present.

- [ ] **Step 2: Run, expect FAIL.** `npx vitest run tests/client/weather-management.test.tsx`.

- [ ] **Step 3: Rewrite `WeatherManagement.tsx`.** Keep the AdminPanel frame, the three `<label className={LABEL_INLINE_CLASSES}>` inputs with the same test ids, the geolocation helper functions, `formatGeolocationCoordinate`, and the `hasGeolocation()` guard. Remove: all fetching, `loading`, Save, `saved`, persisted state. New pieces:

```tsx
export interface WeatherFormState { lat: string; lon: string; label: string }
export const EMPTY_WEATHER_FORM: WeatherFormState = { lat: "", lon: "", label: "" };

export function toWeatherFormState(weather: WeatherSettingsObject): WeatherFormState {
  return {
    lat: weather.lat === null ? "" : String(weather.lat),
    lon: weather.lon === null ? "" : String(weather.lon),
    label: weather.label ?? "",
  };
}

export function weatherFormProblem(form: WeatherFormState): "partial" | "invalid" | null {
  const lat = form.lat.trim();
  const lon = form.lon.trim();
  if ((lat === "") !== (lon === "")) return "partial";
  if ((lat !== "" && !Number.isFinite(Number(lat))) || (lon !== "" && !Number.isFinite(Number(lon)))) {
    return "invalid";
  }
  return null;
}

export function weatherFormDirty(a: WeatherFormState, b: WeatherFormState): boolean {
  return a.lat !== b.lat || a.lon !== b.lon || a.label !== b.label;
}

/** The `weather` settings object to write. The object is replaced as a whole, so a blank label
 * is left out and thereby cleared.
 */
export function weatherPayload(form: WeatherFormState): Record<string, unknown> {
  const lat = form.lat.trim();
  const lon = form.lon.trim();
  const label = form.label.trim();
  const settings: Record<string, unknown> = {
    lat: lat === "" ? null : Number(lat),
    lon: lon === "" ? null : Number(lon),
  };
  if (label !== "") settings.label = label;
  return settings;
}
```

Component: props `{ value, onChange, disabled = false }`; local state only `locating` and `error` (geolocation). Each `<Input>` has `value={value.lat}`, `onChange={(e) => onChange({ lat: e.target.value })}`, `disabled={disabled}`. Buttons: Locate (`weather-locate`, `disabled={!hasGeolocation() || locating || disabled}`; its handler calls `onChange({ lat, lon })` with `formatGeolocationCoordinate`) and Clear (`weather-clear`, `variant="outline"`, `disabled={disabled || (value.lat === "" && value.lon === "" && value.label === "")}`, `onClick={() => onChange({ lat: "", lon: "", label: "" })}`). Below the inputs: `<p data-testid="weather-hint" className="text-muted-foreground text-control">{t("admin.settings.weatherIncomplete")}</p>` when `weatherFormProblem(value) !== null`. Keep `<ErrorNotice message={error} data-testid="weather-error" />` for geolocation failures and `data-testid="weather-management"` on the AdminPanel. Drop the imports that become unused (`LocalizedApiError`, `responseMessage`, `authFetch`, `EffectiveSettings`, `Button`'s Save usage, `MessageKey`).

- [ ] **Step 4: Run, expect PASS.** `npx vitest run tests/client/weather-management.test.tsx`.

- [ ] **Step 5: Port `network-weather-admin.test.tsx` weather describes.** Read the file's weather part (starts at `describe("WeatherManagement — kiosk density`). Make these edits:
  - Replace the `mockWeatherBackend` helper (only used by the weather describes; verify with grep) and `renderWeather` with a harness: `renderWeather(initial = { lat: "10", lon: "20", label: "" })` rendering a small stateful wrapper around `<WeatherManagement value onChange/>` inside `LanguageProvider` (same pattern as `Harness` above). Keep `HouseholdSettingsProvider` only if the file's other helpers still need it; the weather harness does not.
  - Kiosk density: await `screen.findByTestId("weather-lat-input")`, expect `countControls(container)` to be `5` (3 inputs + Locate + Clear).
  - Deliberate negative test: use `weather-clear` (enabled because the initial form is non-blank) instead of `weather-save`.
  - Census reacts to removal: expect 5, remove `weather-clear`, expect 4.
  - AdminPanel L2 frame test: unchanged apart from using the harness.
  - Delete the two "every error state is announced" tests that exercised load/save failure and the "unchanged behaviour ... PUT on Save" test (moved to Settings tests in Task 4). Replace them with one test: geolocation refusal is announced through `ErrorNotice` (`role="alert"`, `aria-live="assertive"`, `data-testid="weather-error"`).
  - Remove imports left unused (`waitFor`, `FetchCall`, etc.), then `npx eslint tests/client/network-weather-admin.test.tsx`.

- [ ] **Step 6: Delete unused i18n keys** (`weather.management.loading|loadError|save|saving|saveError|clearError`) from both locales in `messages.ts`. First `grep -rn "weather.management.\(loading\|loadError\|save\|saving\|saveError\|clearError\)" src tests` and fix every remaining reference (the Settings tests in Task 4 must not use them).

- [ ] **Step 7: Run** `npx vitest run tests/client/weather-management.test.tsx tests/client/network-weather-admin.test.tsx tests/client/weather-i18n-parity.test.ts` PASS (the `SettingsManagement` still imports the old shape until Task 4: typecheck will fail until then, which is expected; do not commit a red typecheck, so do Task 3 and Task 4 as one commit if preferred, or stub the call site now).

- [ ] **Step 8: Commit** together with Task 4 (`feat(admin): one Save for settings and weather`), or commit Task 3 only after Task 4 Step 5 makes the call site compile.

---

### Task 4: SettingsManagement rework

**Files:**
- Modify: `src/client/admin/SettingsManagement.tsx` (rewrite)
- Modify: `src/client/i18n/messages.ts` (the `// admin-settings-overview` block, both locales)
- Modify: `tests/client/settings-management.test.tsx` (rewrite)

**Interfaces:**
- Consumes: `timeZoneGroups` (Task 2), `WeatherManagement`, `WeatherFormState`, `toWeatherFormState`, `weatherFormProblem`, `weatherFormDirty`, `weatherPayload` (Task 3), `formatUptime` not needed.
- Produces: test ids `settings-management`, `settings-language-en|es`, `settings-week-start-1|0`, `settings-timezone`, `settings-save`, `settings-saved`, `settings-error`, `settings-retry`.

- [ ] **Step 1: Add the i18n block first** (tests depend on it). In `src/client/i18n/messages.ts` insert, right after the line `"admin.notFound.description": ...` of the `en` object and again after the same line in the `es` object:

```ts
    // admin-settings-overview
    "admin.overview.uptime": "Uptime",
    "admin.settings.languageDescription": "The language used across the household screens.",
    "admin.settings.weekStartDescription": "The first day shown in weekly views.",
    "admin.settings.timezoneDescription": "Used for dates, schedules and daily rollovers.",
    "admin.settings.tzGroup.current": "Current setting",
    "admin.settings.tzGroup.utc": "UTC",
    "admin.settings.tzGroup.europe": "Europe",
    "admin.settings.tzGroup.americas": "Americas",
    "admin.settings.tzGroup.asiaPacific": "Asia-Pacific",
    "admin.settings.tzGroup.africaMiddleEast": "Africa & Middle East",
    "admin.settings.saved": "Saved",
    "admin.settings.saving": "Saving…",
    "admin.settings.retry": "Retry",
    "admin.settings.weatherIncomplete": "Enter both latitude and longitude, or clear both.",
    "admin.settings.scopeNote":
      "Save applies to language, week start, time zone and weather. Day periods are saved on their own.",
```

and the Spanish equivalents from the spec's table (`Tiempo en marcha`, `El idioma de todas las pantallas del hogar.`, `El primer día que se muestra en las vistas semanales.`, `Se usa para fechas, horarios y cambios de día.`, `Valor actual`, `UTC`, `Europa`, `América`, `Asia-Pacífico`, `África y Oriente Medio`, `Guardado`, `Guardando…`, `Reintentar`, `Introduce latitud y longitud, o borra ambas.`, `Guardar aplica al idioma, el inicio de semana, la zona horaria y el tiempo. Los periodos del día se guardan por separado.`). Keep the same key order in both locales. If Task 1 or 3 already created the block, add the missing keys to it instead of creating a second one.

- [ ] **Step 2: Write the failing tests.** Rewrite `tests/client/settings-management.test.tsx`. Keep the header, the `household` mock, the `DayPeriodsManagement` stub, `jsonResponse`, `renderSettings`, and the native-`<input>` Select mock, extended with the group parts; do NOT stub `WeatherManagement` any more (it renders for real; the plugin catalog provider is absent so `PluginContribution` shows its children). Extend the mock's return with:

```tsx
    SelectGroup: ({ children }: Props) => <ul>{children}</ul>,
    SelectLabel: ({ children }: Props) => <li data-group-label="">{children}</li>,
```

Fixtures:

```tsx
const SETTINGS: EffectiveSettings = {
  locale: { timezone: "Europe/Madrid", language: "en", weekStartDay: 1 },
  weather: { lat: 40.4168, lon: -3.7038, label: "Madrid" },
};
const NO_WEATHER: EffectiveSettings = { locale: SETTINGS.locale };

/** The bodies of the PUTs made so far, in order. */
function puts(mock: ReturnType<typeof vi.mocked<typeof fetch>>) {
  return mock.mock.calls
    .filter(([, init]) => init?.method === "PUT")
    .map(([, init]) => JSON.parse(String(init!.body)) as { object: string; settings: unknown });
}
```

Tests (write each fully; the pattern for each is the same as the existing ones):

1. `shows the stored values as pills and a time zone, with nothing to save yet`: radio `English` has `aria-checked="true"`, `Español` false, `Monday` true; `getByLabelText("Time zone")` has value `Europe/Madrid`; `settings-save` disabled; the three description lines are present (`messages.en["admin.settings.languageDescription"]` etc.).
2. `offers UTC, the curated groups and a stored zone outside the list, each once`: GET returns tz `Etc/GMT+3`; collect `[data-option]` values: contains `UTC`, `Europe/Madrid`, `Etc/GMT+3`; each appears once; a `[data-group-label]` with text `Current setting` exists.
3. `saves a pill change as one locale object`: click `settings-language-es` and `settings-week-start-0`; click Save; `puts` equals `[{object:"locale", settings:{timezone:"Europe/Madrid", language:"es", weekStartDay:0}}]`; `retry` called once; `settings-saved` visible; Save disabled.
4. `saves only the weather when only the weather changed`: change `weather-lat-input` to `41`; Save; `puts` is exactly one `{object:"weather", settings:{lat:41, lon:-3.7038, label:"Madrid"}}`; retry called once.
5. `saves locale then weather on one click`: change week start and `weather-label-input` to `Home`; Save; `puts().map(p => p.object)` equals `["locale","weather"]`; retry called once; the weather PUT mock returns `{...SETTINGS, weather:{lat:40.4168,lon:-3.7038,label:"Home"}}`.
6. `keeps the weather edit and still reloads the app when the second request is refused`: GET returns SETTINGS; PUT for object `locale` returns 200 with the new locale, PUT for `weather` returns 400; change week start and lat; Save; error `settings-error` shows `messages.en["admin.settings.saveError"]`; `settings-save` is enabled (weather still dirty); `weather-lat-input` keeps the edit; the Monday/Sunday pill for the saved locale reflects Sunday; `retry` called once; `settings-saved` absent.
7. `announces a refused save in its own words` and `falls back when the save never reaches the server` (keep the two existing tests, using the week start pill instead of the select).
8. `Clear stages a weather clear that Save writes`: click `weather-clear`; no PUT yet; Save; `puts` equals `[{object:"weather", settings:{lat:null, lon:null}}]`.
9. `blocks Save and says why while only one coordinate is filled`: clear `weather-lon-input`; `settings-save` disabled; `weather-hint` visible; no PUT.
10. `leaves weather out when the plugin is inactive`: GET returns `NO_WEATHER`; `weather-management` absent; change language; Save; the only PUT is the locale one.
11. `hides "Saved" by itself`: after a successful save, `await waitFor(() => expect(screen.queryByTestId("settings-saved")).not.toBeInTheDocument(), { timeout: 5000 })` (real 3 s timer; set the test timeout to 10_000).
12. `editing again clears "Saved"`: after a save, change a pill; `settings-saved` is gone immediately.
13. `announces a failed load and retries`: first GET returns 500, second 200 SETTINGS; `settings-error` shows `loadError`; `settings-save` absent; click `settings-retry`; the form appears (`settings-save` present) and the error is gone.
14. `hosts the day periods on the same page` (existing, stub id `day-periods-stub`).

- [ ] **Step 3: Run, expect FAIL.** `npx vitest run tests/client/settings-management.test.tsx`.

- [ ] **Step 4: Rewrite `SettingsManagement.tsx`.** Skeleton (fill in markup following the existing file's classes and the conventions of `MembersManagement.tsx`):

```tsx
const SAVED_VISIBLE_MS = 3000;

interface SettingsFormState {
  locale: LocaleObject;
  weather: WeatherFormState | null; // null: the weather plugin contributes no settings
}

function fromSettings(data: EffectiveSettings): SettingsFormState {
  return { locale: data.locale, weather: data.weather ? toWeatherFormState(data.weather) : null };
}

/** A single-choice row drawn as pills. Local to this page (brief: no new shared primitive). */
function ChoicePills<T extends string>({
  labelId, label, description, value, options, onChange, disabled,
}: {
  labelId: string; label: string; description: string; value: T;
  options: { value: T; label: string; testId: string }[];
  onChange: (value: T) => void; disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span id={labelId} className="text-control font-semibold">{label}</span>
      <p className="text-muted-foreground text-control">{description}</p>
      <div role="radiogroup" aria-labelledby={labelId} className="flex flex-wrap gap-2">
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <Button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              variant={selected ? "default" : "outline"}
              disabled={disabled}
              data-testid={option.testId}
              onClick={() => onChange(option.value)}
            >
              {option.label}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
```

Component logic:

- State: `form`, `persisted` (`SettingsFormState | null`), `saving`, `saved`, `error`, `loadFailed`, plus `attempt` (number) to retrigger loading. `useEffect([attempt])` does the single `authFetch("/api/settings", {credentials:"include"})` read like today and sets `form`/`persisted` from `fromSettings`; on failure sets `loadFailed`. The Retry button sets `loadFailed(false)`, `error(null)`, bumps `attempt`.
- `changeLocale(patch)` and `changeWeather(patch)` update `form` with functional setState and `setSaved(false)`.
- `useEffect` on `saved`: when true, `setTimeout(() => setSaved(false), SAVED_VISIBLE_MS)` with cleanup.
- Derived: `localeDirty` (any of language/timezone/weekStartDay differ), `weatherDirty` (both weather slices non-null and `weatherFormDirty`), `problem = form?.weather ? weatherFormProblem(form.weather) : null`, `canSave = !saving && (localeDirty || weatherDirty) && problem === null`.
- `putObject(object: "locale" | "weather", settings: unknown): Promise<EffectiveSettings>`: same fetch as the current `save()`; on `!response.ok` throw `new LocalizedApiError(await responseMessage(response, t("admin.settings.saveError")))`.
- `save()`:

```tsx
async function save() {
  if (!form || !persisted || !canSave) return;
  setSaving(true);
  setError(null);
  let wrote = false;
  try {
    if (localeDirty) {
      const data = await putObject("locale", form.locale);
      wrote = true;
      setPersisted((p) => p && { ...p, locale: data.locale });
      setForm((f) => f && { ...f, locale: data.locale });
    }
    if (weatherDirty && form.weather) {
      const data = await putObject("weather", weatherPayload(form.weather));
      wrote = true;
      const next = data.weather ? toWeatherFormState(data.weather) : form.weather;
      setPersisted((p) => p && { ...p, weather: next });
      setForm((f) => f && { ...f, weather: next });
    }
    setSaved(true);
  } catch (cause) {
    setError(cause instanceof LocalizedApiError ? cause.message : t("admin.settings.saveError"));
  } finally {
    setSaving(false);
    if (wrote) household?.retry();
  }
}
```

- Render: root `<div className="flex flex-col gap-8" data-testid="settings-management">`. `AdminPanel` (title/description as today) containing the ChoicePills for language (options `English`/`Español`, test ids `settings-language-en|es`) and week start (`t("admin.settings.monday")` value `"1"`, `sunday` value `"0"`; use string values and convert with `Number`), then the time zone `Select`:

```tsx
<Select value={form.locale.timezone} onValueChange={(timezone) => changeLocale({ timezone })}>
  <Field label={t("admin.settings.timezone")} className="w-72">
    <SelectTrigger data-testid="settings-timezone"><SelectValue /></SelectTrigger>
  </Field>
  <SelectContent>
    {timeZoneGroups(form.locale.timezone).map((group) => (
      <SelectGroup key={group.id}>
        <SelectLabel>{t(`admin.settings.tzGroup.${group.id}` as MessageKey)}</SelectLabel>
        {group.options.map((option) => (
          <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
        ))}
      </SelectGroup>
    ))}
  </SelectContent>
</Select>
<p className="text-muted-foreground text-control">{t("admin.settings.timezoneDescription")}</p>
```

  Memoize `timeZoneGroups` on `form.locale.timezone` is NOT required (`useMemo` is fine, but the current zone changing must regenerate the groups; do not memoize on `persisted`). Note: a user who picks a listed zone after starting from an unlisted one loses the "current" group on re-render; that is acceptable, but to keep the original reachable until Save, compute groups from `persisted.locale.timezone`, not the form value. Do that (`timeZoneGroups(persisted.locale.timezone)`), and add a test asserting the original unlisted zone is still offered after choosing another (extend test 2).
- Below the AdminPanel: `<PluginContribution pluginId="weather" group="admin" contributionId="weather">{form.weather && <WeatherManagement value={form.weather} onChange={changeWeather} disabled={saving} />}</PluginContribution>`.
- Save row: `ErrorNotice` (`settings-error`) for `loadFailed ? loadError : error`; when `loadFailed` render `<Button type="button" variant="outline" data-testid="settings-retry">` with `t("admin.settings.retry")` instead of the form. Otherwise: `<Button data-testid="settings-save" disabled={!canSave}>` showing `t("admin.settings.saving")` while saving else `t("admin.settings.save")`; next to it `{saved && <span role="status" data-testid="settings-saved" className="text-success text-control">{t("admin.settings.saved")}</span>}`; then `<p className="text-muted-foreground text-control">{t("admin.settings.scopeNote")}</p>`.
- Finally `<DayPeriodsManagement />`.
- Imports: add `SelectGroup`, `SelectLabel`; remove `useMemo` if unused; `import { timeZoneGroups } from "./timezones"`; `import type { MessageKey } from "@/i18n/messages"`.

- [ ] **Step 5: Run** `npx vitest run tests/client/settings-management.test.tsx tests/client/weather-management.test.tsx tests/client/network-weather-admin.test.tsx tests/client/admin-gate-panel-reset.test.tsx tests/client/plugin-contributions.test.tsx` PASS; then `npm run typecheck && npm run lint`.

- [ ] **Step 6: i18n parity.** `npx vitest run tests/client/admin-nav-i18n-parity.test.ts tests/client/weather-i18n-parity.test.ts` PASS; `grep -c "admin-settings-overview" src/client/i18n/messages.ts` equals 2.

- [ ] **Step 7: Commit** `feat(admin): rework Settings with pills, curated time zones and one Save`.

---

### Task 5: E2E

**Files:**
- Modify: `tests/e2e/weather.spec.ts` (helper `saveWeatherLocation`, ~lines 205-225)
- Create: `tests/e2e/admin-settings.spec.ts`

- [ ] **Step 1: Adapt the weather helper.** Replace the body after `waitForResponse` setup:

```ts
  if (location === null) {
    await page.getByTestId("weather-clear").click();
  } else {
    await page.getByTestId("weather-lat-input").fill(String(location.lat));
    await page.getByTestId("weather-lon-input").fill(String(location.lon));
  }
  await page.getByTestId("settings-save").click();
```

Clear now needs a prior location (otherwise Save is disabled and no PUT happens); the spec only clears after saving a location, but check the call site (`grep -n "saveWeatherLocation(page, null)" tests/e2e/weather.spec.ts`) and, if a null call can run against an already-blank location, skip the helper's response wait for that case and assert the pill instead.

- [ ] **Step 2: Write `tests/e2e/admin-settings.spec.ts`.** Prelude copied from `tests/e2e/day-periods.spec.ts` lines 20-41 (access gate, provision, `unlockAdmin`, wait for `admin-overview`). Test body:

```ts
test("settings: pill change saves in one click and survives a reload; overview shows uptime", async ({ page }) => {
  // prelude
  await expect(page.getByTestId("admin-overview-uptime")).toHaveText(/\d/);

  const before = (await (await page.request.get("/api/settings")).json()) as {
    locale: { timezone: string; language: string; weekStartDay: number };
  };
  const target = before.locale.weekStartDay === 1 ? 0 : 1;
  try {
    await openAdminSection(page, "admin-nav-settings");
    await page.getByTestId(`settings-week-start-${target}`).click();
    const put = page.waitForResponse(
      (res) => res.url().includes("/api/settings") && res.request().method() === "PUT"
    );
    await page.getByTestId("settings-save").click();
    expect((await put).status()).toBe(200);
    await expect(page.getByTestId("settings-saved")).toBeVisible();
    await expect(page.getByTestId("settings-saved")).toBeHidden({ timeout: 6000 });

    const after = (await (await page.request.get("/api/settings")).json()) as typeof before;
    expect(after.locale.weekStartDay).toBe(target);
    expect(after.locale.timezone).toBe(before.locale.timezone);

    await page.reload();
    await unlockAdmin(page, ADMIN_PIN);
    await openAdminSection(page, "admin-nav-settings");
    await expect(page.getByTestId(`settings-week-start-${target}`)).toHaveAttribute("aria-checked", "true");
  } finally {
    await page.request.put("/api/settings", { data: { object: "locale", settings: before.locale } });
  }
});
```

Use the same imports/constants as `day-periods.spec.ts` (`openAdminSection`, `unlockAdmin`, tokens). The test restores week start in `finally`, so other specs (timezone defaults pins `Europe/Madrid`) are unaffected; it never touches time zone or language.

- [ ] **Step 3: Run e2e.** `PORT=43208 npx playwright test tests/e2e/admin-settings.spec.ts tests/e2e/weather.spec.ts tests/e2e/day-periods.spec.ts tests/e2e/admin-unlock-resilience.spec.ts tests/e2e/admin-household-timezone-defaults.spec.ts tests/e2e/plugin-lifecycle.spec.ts tests/e2e/accessible-names-audit.spec.ts --workers=3` all PASS. If a spec fails because of a testid you removed (`weather-save`), fix the spec, not the page.
- [ ] **Step 4: Commit** `test(e2e): cover the single settings Save and overview uptime`.

---

### Task 6: Docs

**Files:**
- Modify: `docs/features/weather.md` (the admin location behaviour)
- Modify: `docs/ui/household-contract.md` (item 13 and the overview paragraph; keep edits to those lines)

- [ ] **Step 1:** In `docs/features/weather.md`, near FR-002 (set or cleared as a unit) add one sentence to the behaviour section or after FR-002: "The admin Settings page edits the location together with the locale under one Save; Clear location empties the fields and is persisted by Save." Do not renumber FRs.
- [ ] **Step 2:** In `docs/ui/household-contract.md` item 13 append: ", with one Save for language, week start, time zone and weather" (day periods keep their own save). Ensure the overview paragraph mentions uptime (done in Task 1; verify).
- [ ] **Step 3:** `npm run format:check` PASS (run `npx prettier --write` on changed files if not).
- [ ] **Step 4: Commit** `docs: settings and overview behaviour`.

---

### Final Task: Verify, resync, commit and report

- [ ] **Step 1:** `git status` must be clean (everything committed, including the copied spec and plan).
- [ ] **Step 2:** `npm run check:standard`. If `check:preflight`/`check:test-cohorts:standard` reports that `tests/fixtures/assembly-cohort.json` is out of date (new test files `settings-timezones.test.ts`, renamed/added tests), run the full vitest list/run the tooling asks for (`npm run test:cohorts:vitest:list`, `npm run test:cohorts:vitest`) and regenerate the fixture with the exact command named in the tool's error message (see `tools/verify-test-cohorts.mjs --help`), then commit `chore: resync assembly cohort` and re-run `check:standard` from the clean tree. The API section of the fixture lists `/api/telemetry/system-status`; the path does not change, so only test names/files should differ.
- [ ] **Step 3:** Re-run the e2e command from Task 5 Step 3 (`PORT=43208`) once more from the final tree.
- [ ] **Step 4:** Commit on the worktree branch (`feat/admin-settings-overview`) and report: branch name, commit list, `check:standard` result, e2e result, anything skipped. Do not merge or push unless told to. Remember: the spec and plan are copied into the branch; the main checkout copies stay untracked.
