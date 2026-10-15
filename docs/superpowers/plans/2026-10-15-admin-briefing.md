# Admin Daily Briefing Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **For the executing agent:** work in your own git worktree on its own branch, never in the main
> checkout. The spec and this plan live UNTRACKED in the main checkout
> (`<maintainer-workspace>`); Task 0 copies them in. Use TDD (write the failing test,
> watch it fail, implement, watch it pass). The reference app `<marplanner-v1>` is
> READ-ONLY (look, never edit, never use its DB). Do not ask the owner questions; the decisions
> are in the spec (section 3). If something in this plan contradicts the code you find, trust the
> code, make the smallest change that meets the spec, and list the deviation in your final report.

**Goal:** Bring `/admin/daily-briefing` to parity with the reference admin: per-member weekday
pause, per-member history, regenerate any date, view PNG, print on demand through our server
queue, honest image states (incl. 202 still rendering), "settings changed" notice, coloured
member pills, Retry on errors — keeping all our extras.

**Architecture:** Server: a new `schedule.ts` in the daily-briefing plugin stores a nullable
weekday list on `daily_briefing_optin` (migration 0005) and gates generation, retry, catch-up
and the auto-print trigger; `index.ts` gains an in-flight generation registry (202), a history
read and a manual print that only calls host-api printing functions; routes expose them. Client:
the 1493-line page keeps its tabs (local state, no URL sub-routes) and Blocks workspace, gains a
pause row + notice + Retry, and delegates the Preview tab to three new components under
`src/client/daily-briefing/admin/`.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, React 19 + Tailwind v4, vitest +
@testing-library/react, Playwright. Node 24.21.0, npm 11.

**Spec:** `docs/superpowers/specs/2026-10-15-admin-briefing-design.md` (read it first; decisions D1–D19).

## Global Constraints

- Code, identifiers, comments, commit messages: English. UI strings: `src/client/i18n/messages.ts`, en AND es.
- New i18n keys go in ONE contiguous block per locale, headed `// admin-briefing`, inserted right after `"admin.notFound.description"` (en ≈ line 263, es ≈ line 1549). Keys use the `dailyBriefing.admin.` prefix (the parity test `tests/client/daily-briefing-i18n-parity.test.ts` then covers them).
- Do NOT touch `src/server/modules/printing/**`, `src/client/admin/AdminRoutes.tsx`, `src/client/shell/routes.ts`, `src/shared/index.ts`, `src/server/host-api/index.ts`. No URL sub-routes (spec D19).
- Do NOT add a new shared primitive. The only shared-component change allowed is the additive `disabledDays` prop on `src/client/components/WeekdayPicker.tsx`.
- No inline `style=` attributes and no raw palette classes like `bg-amber-50` (they raise `check:ui-debt`); use semantic tokens (`bg-accent`, `text-success`, `bg-destructive/10`, `text-muted-foreground`) and the static `bg-member-<key>-500` map.
- Server plugin files under `src/server/modules/daily-briefing/` may import only `../../host-api`, their own subtree and `../../../shared/*` (lint zone).
- Shared hot files (`messages.ts`, `tests/fixtures/assembly-cohort.json`, `docs/ui/household-contract.md`): keep edits minimal and localized; other workers edit them in parallel.
- Manual print record key format (cross-worker contract with the Printer page): `daily-briefing:<memberId>:manual:<date>`.
- E2E port for this work: `PORT=43202`.

## Review Focus

1. A paused member whose morning chores are complete must not be auto-printed and must not spam `raster-missing` logs (trigger gate) — Task 3 test.
2. Printing a PAST date's briefing must still be claimable (target date = household today, not the briefing date) — Task 4 test asserts `target_date`.
3. Clicking Print twice after a successful print reprints (supersede), but clicking twice while a job is pending does NOT queue two jobs — Task 4 tests.
4. Regenerate on "today" must keep sending only `{memberId}` (the e2e pins it); a past date sends `{memberId, date}` — Task 7 test.
5. A stored PNG must win over "rendering" during a regeneration (no image flicker to the rendering state) — Task 5 test.

---

## File map

| File                                                                                                                                                | Change                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `drizzle/0005_daily_briefing_schedule.sql`                                                                                                          | create — `ALTER TABLE daily_briefing_optin ADD weekdays text`                                                                        |
| `src/server/db/schema.ts`                                                                                                                           | `dailyBriefingOptins` + `weekdays` column (last)                                                                                     |
| `src/server/db/weekday-integrity.ts`                                                                                                                | check the new column                                                                                                                 |
| `src/shared/dailyBriefing.ts`                                                                                                                       | new DTO types                                                                                                                        |
| `src/server/modules/daily-briefing/errors.ts`                                                                                                       | 4 new error classes                                                                                                                  |
| `src/server/modules/daily-briefing/schedule.ts`                                                                                                     | create — schedule read/write/predicate                                                                                               |
| `src/server/modules/daily-briefing/index.ts`                                                                                                        | pause check, Generate-all skip, in-flight registry, `readBriefingPng.generating`, `listBriefingHistory`, `printBriefing`, re-exports |
| `src/server/modules/daily-briefing/job.ts`                                                                                                          | `isMissed` + retry pass skip paused; export `regenerateFailedBriefings`                                                              |
| `src/server/modules/daily-briefing/trigger.ts`                                                                                                      | skip paused members                                                                                                                  |
| `src/server/modules/daily-briefing/settings.ts`                                                                                                     | `memberSchedules` in the aggregate view                                                                                              |
| `src/server/routes/daily-briefing.ts`                                                                                                               | 3 new routes, generate skipped, preview 202, error mapping                                                                           |
| `docs/features/daily-briefing.md`, `docs/api/daily-briefing/openapi.yaml`, `docs/api/briefing-render/openapi.yaml`, `docs/ui/household-contract.md` | docs                                                                                                                                 |
| `src/client/components/WeekdayPicker.tsx`                                                                                                           | `disabledDays` prop                                                                                                                  |
| `src/client/daily-briefing/admin/BriefingMemberPills.tsx`                                                                                           | create                                                                                                                               |
| `src/client/daily-briefing/admin/BriefingImage.tsx`                                                                                                 | create                                                                                                                               |
| `src/client/daily-briefing/admin/BriefingWorkspace.tsx`                                                                                             | create                                                                                                                               |
| `src/client/admin/DailyBriefingManagement.tsx`                                                                                                      | rework (see Task 8)                                                                                                                  |
| `src/client/i18n/messages.ts`                                                                                                                       | `// admin-briefing` blocks                                                                                                           |
| Tests                                                                                                                                               | new: `tests/boundary/daily-briefing-admin-parity.test.ts`, `tests/client/daily-briefing-workspace.test.tsx`; updated: see tasks      |
| `tests/fixtures/assembly-cohort.json`                                                                                                               | routes, test cases, coverage floors                                                                                                  |

---

## Task 0: Worktree setup

- [ ] **Step 1:** In your worktree root, copy the untracked docs in:

```bash
mkdir -p docs/superpowers/specs docs/superpowers/plans
cp <maintainer-workspace>/docs/superpowers/specs/2026-10-15-admin-briefing-design.md docs/superpowers/specs/
cp <maintainer-workspace>/docs/superpowers/plans/2026-10-15-admin-briefing.md docs/superpowers/plans/
```

- [ ] **Step 2:** Install and sanity-check (the worktree's `node_modules` may be an empty symlink; install your own):

```bash
cp <maintainer-workspace>/.env.local . 2>/dev/null || true
fnm exec --using=24.21.0 npm ci
npx vitest run tests/boundary/daily-briefing-preview.test.ts tests/client/daily-briefing-management.test.tsx
```

Expected: both files PASS before you change anything.

- [ ] **Step 3:** If `git` commands are refused in your worktree (known for isolated agent worktrees), keep working; at each "Commit" step skip the commit, and at the end follow Task 12's fallback.

---

## Task 1: Schedule storage (migration, schema, integrity, shared types)

**Files:**

- Create: `drizzle/0005_daily_briefing_schedule.sql`
- Modify: `src/server/db/schema.ts` (`dailyBriefingOptins`, ≈ line 688)
- Modify: `src/server/db/weekday-integrity.ts`
- Modify: `src/shared/dailyBriefing.ts`
- Test: `tests/boundary/database-baseline.test.ts`, `tests/integration/database-baseline.test.ts`, `tests/integration/plugin-compatibility.test.ts`, `tests/boundary/weekday-integrity.test.ts`

**Interfaces:**

- Produces: column `daily_briefing_optin.weekdays TEXT NULL` (JSON array of weekday codes, canonical order; NULL = every day); shared types below.

- [ ] **Step 1: Update the migration-list tests first (they fail until the file exists)**

`tests/boundary/database-baseline.test.ts`: add `const DAILY_BRIEFING_SCHEDULE_MIGRATION = "0005_daily_briefing_schedule.sql";` after `MEMBER_PALETTE_MIGRATION`, and append `DAILY_BRIEFING_SCHEDULE_MIGRATION,` after `MEMBER_PALETTE_MIGRATION,` in the `expect(migrationFiles).toEqual([...])` list.

`tests/integration/database-baseline.test.ts`: add

```ts
const DAILY_BRIEFING_SCHEDULE_MIGRATION = join(
  PROJECT_ROOT,
  "drizzle",
  "0005_daily_briefing_schedule.sql"
);
```

after `MEMBER_PALETTE_MIGRATION`; append it to the `instantiateCatalog([...])` file list (after `MEMBER_PALETTE_MIGRATION`), and append `{ fileName: "0005_daily_briefing_schedule.sql" },` after the `0004_member_palette.sql` entry of the applied-migrations list (≈ line 224).

`tests/integration/plugin-compatibility.test.ts`: add `const DAILY_BRIEFING_SCHEDULE_FILE = "0005_daily_briefing_schedule.sql";` after `MEMBER_PALETTE_FILE`, and after `recordMigration(db, MEMBER_PALETTE_FILE);` add:

```ts
applyRealMigration(db, DAILY_BRIEFING_SCHEDULE_FILE);
recordMigration(db, DAILY_BRIEFING_SCHEDULE_FILE);
```

`tests/boundary/weekday-integrity.test.ts`: in the test "identifies corrupt persisted weekday rows in every domain without rewriting data", add `["daily_briefing_optin", "weekdays"],` to the `for (const [table, column] of [...])` list, right after the `daily_briefing_member_block_settings` entry. (The public seed opts members in, so a row exists; if `row` is undefined there, insert one opt-in row for an existing member before the loop instead of skipping.)

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/boundary/database-baseline.test.ts tests/integration/database-baseline.test.ts tests/integration/plugin-compatibility.test.ts tests/boundary/weekday-integrity.test.ts`
Expected: FAIL (missing migration file / missing column).

- [ ] **Step 3: Create the migration**

`drizzle/0005_daily_briefing_schedule.sql`:

```sql
-- Per-member weekday pause for the daily briefing. NULL means every day; otherwise a JSON array
-- of canonical weekday codes (mon..sun) on which the member's briefing is generated and printed.
ALTER TABLE `daily_briefing_optin` ADD `weekdays` text;
```

- [ ] **Step 4: Schema** — in `src/server/db/schema.ts`, `dailyBriefingOptins`, add the column LAST (after `updatedAt`) so Drizzle's generated column order matches the ALTER:

```ts
    updatedAt: integer("updated_at").notNull(),
    /** Weekday pause schedule (JSON weekday codes, canonical order); NULL = every day. */
    weekdays: text("weekdays"),
```

Also extend the doc comment above the table with one sentence: "`weekdays` is the per-member pause schedule (drizzle/0005)."

- [ ] **Step 5: Integrity** — `src/server/db/weekday-integrity.ts`: add `["daily_briefing_optin", "weekdays", true],` after the block-settings entry, and change the id expression to:

```ts
const id =
  table === "daily_briefing_member_block_settings"
    ? "member_id || ':' || block_type"
    : table === "daily_briefing_optin"
      ? "member_id"
      : "id";
```

- [ ] **Step 6: Shared types** — append to `src/shared/dailyBriefing.ts` (add `import type { WeekdayCode } from "./weekdays.js";` at the top of the file):

```ts
/** BriefingSchedule — a member's weekday pause schedule: the weekdays (canonical mon..sun order)
 * on which their briefing is generated and auto-printed. An empty array pauses every day. */
export interface BriefingSchedule {
  memberId: string;
  weekdays: WeekdayCode[];
}

/** One row of a member's briefing history (newest first). */
export interface BriefingHistoryEntry {
  id: string;
  date: string;
  status: BriefingStatus;
  updatedAt: number;
}

/** `GET /api/daily-briefing/history/:memberId` — `today` is the household business date. */
export interface BriefingHistoryResponse {
  today: string;
  entries: BriefingHistoryEntry[];
}

/** `POST /api/daily-briefing/generate` answer when the member is paused on that weekday. */
export interface GenerateSkippedResponse {
  skipped: true;
  reason: "paused";
  memberId: string;
  date: string;
}

/** `POST /api/daily-briefing/:memberId/:date/print` — `enqueued: false` means a job for this
 * briefing is already waiting in the queue and was reused. */
export interface BriefingPrintResponse {
  jobId: string;
  enqueued: boolean;
}

/** `GET .../preview.png` 202 body while a generation for that member/date is in flight. */
export interface BriefingPreviewRendering {
  status: "rendering";
}
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/boundary/database-baseline.test.ts tests/integration/database-baseline.test.ts tests/integration/plugin-compatibility.test.ts tests/boundary/weekday-integrity.test.ts`
Expected: PASS. If the catalog comparison in `tests/integration/database-baseline.test.ts` reports a definition mismatch for `daily_briefing_optin`, compare the two normalized SQL strings it prints: the column must be the last column, before the CHECK constraint, in both.

- [ ] **Step 8: Commit**

```bash
git add drizzle/0005_daily_briefing_schedule.sql src/server/db/schema.ts src/server/db/weekday-integrity.ts src/shared/dailyBriefing.ts tests/boundary/database-baseline.test.ts tests/integration/database-baseline.test.ts tests/integration/plugin-compatibility.test.ts tests/boundary/weekday-integrity.test.ts
git commit -m "feat(daily-briefing): store a per-member weekday pause schedule"
```

---

## Task 2: Schedule module, errors, settings view, schedule route

**Files:**

- Modify: `src/server/modules/daily-briefing/errors.ts`
- Create: `src/server/modules/daily-briefing/schedule.ts`
- Modify: `src/server/modules/daily-briefing/settings.ts` (`DailyBriefingSettingsView`, `readAllSettings`, bottom of file)
- Modify: `src/server/routes/daily-briefing.ts`
- Create test: `tests/boundary/daily-briefing-admin-parity.test.ts`
- Modify test: `tests/boundary/daily-briefing-settings.test.ts` (≈ line 55 `toEqual`)

**Interfaces:**

- Consumes: Task 1 column + `BriefingSchedule`.
- Produces (exact):
  - `errors.ts`: `class DailyBriefingPausedError extends Error { readonly memberId: string; readonly date: string }`, `class DailyBriefingNotFoundError extends Error`, `class DailyBriefingPrintUnavailableError extends Error`, `class DailyBriefingRasterMissingError extends Error`.
  - `schedule.ts`: `readMemberWeekdays(memberId: string): WeekdayCode[]`, `listMemberSchedules(): BriefingSchedule[]`, `setMemberSchedule(memberId: string, weekdays: unknown): BriefingSchedule`, `isBriefingScheduledOn(memberId: string, date: string): boolean`.
  - `DailyBriefingSettingsView.memberSchedules: BriefingSchedule[]`.
  - Route `PUT /api/daily-briefing/schedule/:memberId` body `{weekdays: WeekdayCode[]}` → 200 `BriefingSchedule`; 400 `validation_error`.

- [ ] **Step 1: Write the failing tests** — create `tests/boundary/daily-briefing-admin-parity.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { __setPrintingPluginActiveForTests } from "../../src/server/modules/printing/index";
import {
  isBriefingScheduledOn,
  readMemberWeekdays,
  setMemberSchedule,
} from "../../src/server/modules/daily-briefing/schedule";
import { useIsolatedDb } from "../helpers/db";
import { seedMember } from "../helpers/daily-briefing-seed";

/** Admin parity (docs/superpowers/specs/2026-10-15-admin-briefing-design.md): weekday pause
 * schedule, skip semantics, history, manual print through the queue, 202 while rendering. */
describe("daily-briefing admin parity", () => {
  useIsolatedDb();

  let app: FastifyInstance;
  let deviceKey: string;

  beforeEach(async () => {
    const now = Date.now();
    deviceKey = `mpk-${now}-${Math.random().toString(36).slice(2)}`;
    getDb()
      .prepare(
        "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
      )
      .run(`device-${now}`, hashKey(deviceKey), now);
    const { buildApp } = await import("../../src/server/app.ts");
    app = await buildApp();
  });

  afterEach(async () => {
    __setPrintingPluginActiveForTests(undefined);
    await app?.close();
  });

  function auth() {
    return { mp_device_key: deviceKey };
  }

  describe("weekday pause schedule", () => {
    it("defaults to every day and stores a canonical, de-duplicated list", () => {
      seedMember("m-sched");
      expect(readMemberWeekdays("m-sched")).toEqual([
        "mon",
        "tue",
        "wed",
        "thu",
        "fri",
        "sat",
        "sun",
      ]);
      expect(setMemberSchedule("m-sched", ["sun", "mon", "mon"])).toEqual({
        memberId: "m-sched",
        weekdays: ["mon", "sun"],
      });
      expect(readMemberWeekdays("m-sched")).toEqual(["mon", "sun"]);
      // 2026-09-07 is a Monday, 2026-09-08 a Tuesday.
      expect(isBriefingScheduledOn("m-sched", "2026-09-07")).toBe(true);
      expect(isBriefingScheduledOn("m-sched", "2026-09-08")).toBe(false);
    });

    it("allows pausing every day, and creates an opted-out row for a member with no opt-in", () => {
      seedMember("m-new", { optedIn: false });
      expect(setMemberSchedule("m-new", [])).toEqual({ memberId: "m-new", weekdays: [] });
      const row = getDb()
        .prepare("SELECT enabled, weekdays FROM daily_briefing_optin WHERE member_id = ?")
        .get("m-new");
      expect(row).toEqual({ enabled: 0, weekdays: "[]" });
    });

    it("keeps the opt-in flag when the schedule changes and vice versa", () => {
      seedMember("m-keep");
      setMemberSchedule("m-keep", ["fri"]);
      const row = getDb()
        .prepare("SELECT enabled, weekdays FROM daily_briefing_optin WHERE member_id = ?")
        .get("m-keep");
      expect(row).toEqual({ enabled: 1, weekdays: '["fri"]' });
    });

    it("PUT /schedule/:memberId saves and GET /settings returns memberSchedules", async () => {
      seedMember("m-route");
      const put = await app.inject({
        method: "PUT",
        url: "/api/daily-briefing/schedule/m-route",
        cookies: auth(),
        payload: { weekdays: ["wed", "mon"] },
      });
      expect(put.statusCode).toBe(200);
      expect(put.json()).toEqual({ memberId: "m-route", weekdays: ["mon", "wed"] });

      const get = await app.inject({
        method: "GET",
        url: "/api/daily-briefing/settings",
        cookies: auth(),
      });
      expect(get.json().memberSchedules).toEqual([
        { memberId: "m-route", weekdays: ["mon", "wed"] },
      ]);
    });

    it("PUT /schedule rejects bad weekdays, unknown keys, missing weekdays and inactive members", async () => {
      seedMember("m-bad");
      seedMember("m-archived", { active: false });
      for (const [memberId, payload] of [
        ["m-bad", { weekdays: ["monday"] }],
        ["m-bad", { weekdays: "mon" }],
        ["m-bad", {}],
        ["m-bad", { weekdays: ["mon"], extra: true }],
        ["m-archived", { weekdays: ["mon"] }],
      ] as const) {
        const res = await app.inject({
          method: "PUT",
          url: `/api/daily-briefing/schedule/${memberId}`,
          cookies: auth(),
          payload,
        });
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
        expect(res.json()).toMatchObject({ error: "validation_error" });
      }
      expect(readMemberWeekdays("m-bad")).toHaveLength(7);
    });
  });
});
```

In `tests/boundary/daily-briefing-settings.test.ts` (≈ line 55) add `memberSchedules: [],` to the `toEqual({...})` of the first GET test.

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/boundary/daily-briefing-admin-parity.test.ts tests/boundary/daily-briefing-settings.test.ts`
Expected: FAIL — `schedule.ts` does not exist.

- [ ] **Step 3: Errors** — append to `src/server/modules/daily-briefing/errors.ts`:

```ts
/** The member's briefing is paused on this weekday (spec D4). Deliberately NOT a validation
 * error: the generate route answers 200 `{skipped: true}`, and batch callers skip it. */
export class DailyBriefingPausedError extends Error {
  constructor(
    readonly memberId: string,
    readonly date: string
  ) {
    super(`Daily briefing for member "${memberId}" is paused on ${date}`);
    this.name = "DailyBriefingPausedError";
  }
}

/** No briefing row exists for the requested member/date (404). */
export class DailyBriefingNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DailyBriefingNotFoundError";
  }
}

/** Printing plugin inactive — nothing can be queued (409 `plugin_inactive`). */
export class DailyBriefingPrintUnavailableError extends Error {
  constructor() {
    super("The Printing plugin is inactive");
    this.name = "DailyBriefingPrintUnavailableError";
  }
}

/** The briefing exists but has no stored printable raster (409 `printable_raster_missing`). */
export class DailyBriefingRasterMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DailyBriefingRasterMissingError";
  }
}
```

- [ ] **Step 4: Schedule module** — create `src/server/modules/daily-briefing/schedule.ts`:

```ts
/** Per-member weekday pause schedule (admin parity, spec D1–D4). Stored as the nullable
 * `daily_briefing_optin.weekdays` JSON column (drizzle/0005): NULL means every day. Imports only
 * the host-api barrel, this plugin's own errors, and shared weekday helpers (lint zone).
 * Writes never touch `daily_briefing` — a schedule change never regenerates anything.
 */
import { assertActiveMember, getDb, readHouseholdTimezone, weekdayOf } from "../../host-api";
import { CANONICAL_WEEKDAY_ORDER, validateWeekdays } from "../../../shared/weekdays";
import type { WeekdayCode } from "../../../shared/weekdays";
import type { BriefingSchedule } from "../../../shared";
import { DailyBriefingValidationError } from "./errors";

function canonical(days: readonly WeekdayCode[]): WeekdayCode[] {
  const seen = new Set(days);
  return CANONICAL_WEEKDAY_ORDER.filter((day) => seen.has(day));
}

/** Stored values were validated on write and are re-checked at boot (weekday-integrity.ts). */
function parseStored(raw: string): WeekdayCode[] {
  return canonical(validateWeekdays(JSON.parse(raw)));
}

/** The weekdays on which `memberId`'s briefing runs; every day when no schedule is stored. */
export function readMemberWeekdays(memberId: string): WeekdayCode[] {
  const row = getDb()
    .prepare("SELECT weekdays FROM daily_briefing_optin WHERE member_id = ?")
    .get(memberId) as { weekdays: string | null } | undefined;
  return row?.weekdays ? parseStored(row.weekdays) : [...CANONICAL_WEEKDAY_ORDER];
}

/** Every stored schedule (members without one run every day and are omitted). */
export function listMemberSchedules(): BriefingSchedule[] {
  const rows = getDb()
    .prepare(
      "SELECT member_id, weekdays FROM daily_briefing_optin WHERE weekdays IS NOT NULL ORDER BY member_id ASC"
    )
    .all() as Array<{ member_id: string; weekdays: string }>;
  return rows.map((row) => ({ memberId: row.member_id, weekdays: parseStored(row.weekdays) }));
}

/** Validate and store a member's schedule. A member with no opt-in row gets one with
 * `enabled = 0` (absent and 0 both mean "not opted in"); an existing row keeps its flag. */
export function setMemberSchedule(memberId: string, weekdays: unknown): BriefingSchedule {
  const days = canonical(validateWeekdays(weekdays, DailyBriefingValidationError));
  try {
    assertActiveMember(memberId);
  } catch {
    throw new DailyBriefingValidationError(`Member "${memberId}" is not active`);
  }
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO daily_briefing_optin (member_id, enabled, weekdays, created_at, updated_at)
       VALUES (?, 0, ?, ?, ?)
       ON CONFLICT(member_id) DO UPDATE SET weekdays = excluded.weekdays, updated_at = excluded.updated_at`
    )
    .run(memberId, JSON.stringify(days), now, now);
  return { memberId, weekdays: days };
}

/** True when the member's briefing is not paused on `date`'s weekday. */
export function isBriefingScheduledOn(memberId: string, date: string): boolean {
  return readMemberWeekdays(memberId).includes(weekdayOf(date, readHouseholdTimezone()));
}
```

Note: `row?.weekdays ? ... : ...` treats `""` like NULL; the column is only written by `setMemberSchedule`, which always writes a JSON array.

- [ ] **Step 5: Settings view** — in `src/server/modules/daily-briefing/settings.ts`:
  - add imports `import { listMemberSchedules } from "./schedule";` and `import type { BriefingSchedule } from "../../../shared";` (merge into the existing `../../../shared` type import),
  - add `memberSchedules: BriefingSchedule[];` to `interface DailyBriefingSettingsView`,
  - add `memberSchedules: listMemberSchedules(),` to the object returned by `readAllSettings()`.

- [ ] **Step 6: Route** — in `src/server/routes/daily-briefing.ts`:
  - import `{ setMemberSchedule } from "../modules/daily-briefing/schedule";`
  - add `const ALLOWED_SCHEDULE_KEYS = new Set(["weekdays"]);` next to the other key sets,
  - register after the block-settings route:

```ts
app.put(
  "/api/daily-briefing/schedule/:memberId",
  async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return reply
        .code(400)
        .send({ error: "validation_error", message: "Request body must be an object" });
    }
    const unknownKeys = Object.keys(body).filter((key) => !ALLOWED_SCHEDULE_KEYS.has(key));
    if (unknownKeys.length > 0) {
      return reply.code(400).send({
        error: "validation_error",
        message: `Unsupported field(s) in daily briefing schedule body: ${unknownKeys.join(", ")}`,
      });
    }
    const { weekdays } = body as { weekdays?: unknown };
    const { memberId } = request.params as { memberId: string };
    try {
      return reply.code(200).send(setMemberSchedule(memberId, weekdays));
    } catch (err) {
      return handleDailyBriefingError(err, reply);
    }
  }
);
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/boundary/daily-briefing-admin-parity.test.ts tests/boundary/daily-briefing-settings.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/server/modules/daily-briefing/errors.ts src/server/modules/daily-briefing/schedule.ts src/server/modules/daily-briefing/settings.ts src/server/routes/daily-briefing.ts tests/boundary/daily-briefing-admin-parity.test.ts tests/boundary/daily-briefing-settings.test.ts
git commit -m "feat(daily-briefing): add the weekday pause schedule endpoint"
```

---

## Task 3: Pause semantics (generate, Generate all, retry pass, catch-up, auto-print)

**Files:**

- Modify: `src/server/modules/daily-briefing/index.ts` (`generateBriefing` read transaction ≈ lines 922–948; `generateAllBriefings` ≈ line 1226; re-exports near line 68)
- Modify: `src/server/modules/daily-briefing/job.ts` (`isMissed`, `regenerateFailedBriefings`)
- Modify: `src/server/modules/daily-briefing/trigger.ts` (`evaluateAutoPrintTrigger`)
- Modify: `src/server/routes/daily-briefing.ts` (`POST /generate`)
- Test: `tests/boundary/daily-briefing-admin-parity.test.ts`, `tests/integration/daily-briefing-trigger.test.ts`

**Interfaces:**

- Consumes: `isBriefingScheduledOn` (Task 2), `DailyBriefingPausedError` (Task 2).
- Produces: `generateBriefing` throws `DailyBriefingPausedError` for a paused weekday (no write); `generateAllBriefings` skips paused members; `regenerateFailedBriefings(requestedDate?: string): Promise<void>` is now EXPORTED from `job.ts`; `POST /generate` answers `200 GenerateSkippedResponse`.

- [ ] **Step 1: Failing tests** — add to `tests/boundary/daily-briefing-admin-parity.test.ts` (new imports at the top: `generateAllBriefings`, `generateBriefing` from `../../src/server/modules/daily-briefing/index`; `isMissed`, `regenerateFailedBriefings` from `../../src/server/modules/daily-briefing/job`; `seedBriefingRow`, `findBriefingRow` from `../helpers/daily-briefing-seed`):

```ts
describe("paused weekdays are skipped", () => {
  // 2026-09-07 is a Monday.
  const MONDAY = "2026-09-07";

  beforeEach(() => {
    __setPrintingPluginActiveForTests(false); // no render needed for these assertions
  });

  it("generateBriefing writes nothing and the route answers skipped", async () => {
    seedMember("m-paused");
    setMemberSchedule("m-paused", ["tue"]);
    await expect(generateBriefing("m-paused", MONDAY)).rejects.toMatchObject({
      name: "DailyBriefingPausedError",
      memberId: "m-paused",
      date: MONDAY,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/daily-briefing/generate",
      cookies: auth(),
      payload: { memberId: "m-paused", date: MONDAY },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      skipped: true,
      reason: "paused",
      memberId: "m-paused",
      date: MONDAY,
    });
    expect(findBriefingRow("m-paused", MONDAY)).toBeUndefined();
  });

  it("Generate all skips a paused member but generates the others", async () => {
    seedMember("m-a-paused");
    seedMember("m-b-running");
    setMemberSchedule("m-a-paused", ["tue"]);
    const generated = await generateAllBriefings(MONDAY);
    expect(generated.map((briefing) => briefing.memberId)).toEqual(["m-b-running"]);
    expect(findBriefingRow("m-a-paused", MONDAY)).toBeUndefined();
  });

  it("the retry pass skips a member paused after their row was written", async () => {
    seedMember("m-retry");
    seedBriefingRow("m-retry", MONDAY);
    getDb()
      .prepare("UPDATE daily_briefing SET status = 'failed' WHERE member_id = ? AND date = ?")
      .run("m-retry", MONDAY);
    setMemberSchedule("m-retry", ["tue"]);
    await expect(regenerateFailedBriefings(MONDAY)).resolves.toBeUndefined();
    const row = getDb()
      .prepare("SELECT status FROM daily_briefing WHERE member_id = ? AND date = ?")
      .get("m-retry", MONDAY);
    expect(row).toEqual({ status: "failed" });
  });

  it("catch-up does not count a paused member as missed", () => {
    seedMember("m-catchup");
    expect(isMissed(MONDAY)).toBe(true);
    setMemberSchedule("m-catchup", ["tue"]);
    expect(isMissed(MONDAY)).toBe(false);
  });
});
```

Add to `tests/integration/daily-briefing-trigger.test.ts`, inside the main `describe`, after the "AC-1" test (add `import { setMemberSchedule } from "../../src/server/modules/daily-briefing/schedule";` at the top):

```ts
it("a member paused on today's weekday is not enqueued, and is again once resumed", () => {
  const memberId = "member-paused-today";
  seedMember(memberId);
  enableAutoPrint();
  seedBriefingRowWithRaster(memberId, DATE);
  const [chore] = seedMorningRoutine(memberId, 1, WEEKDAY);
  completeChoreDirect(chore, memberId, DATE);

  setMemberSchedule(memberId, ["mon", "tue", "wed", "fri", "sat", "sun"]); // Thursday off
  evaluateAutoPrintTrigger(NOW);
  expect(countJobsForOutputRef(outputRefFor(memberId))).toBe(0);

  setMemberSchedule(memberId, ["thu"]);
  evaluateAutoPrintTrigger(NOW);
  expect(countJobsForOutputRef(outputRefFor(memberId))).toBe(1);
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/boundary/daily-briefing-admin-parity.test.ts tests/integration/daily-briefing-trigger.test.ts`
Expected: FAIL (no pause checks yet; `regenerateFailedBriefings` not exported).

- [ ] **Step 3: index.ts**
  - Imports: `import { isBriefingScheduledOn } from "./schedule";` and add `DailyBriefingPausedError` to the `./errors` import (there is `import { DailyBriefingValidationError } from "./errors";` at ≈ line 69 — extend it). Also add, next to the existing `export { DailyBriefingValidationError } from "./errors";`:

```ts
export {
  DailyBriefingNotFoundError,
  DailyBriefingPausedError,
  DailyBriefingPrintUnavailableError,
  DailyBriefingRasterMissingError,
} from "./errors";
export { listMemberSchedules, setMemberSchedule } from "./schedule";
```

- In `generateBriefing`, inside the first `db.transaction(() => { ... })`, right after the `if (!isOptedIn(memberId)) { throw ... }` block, add:

```ts
if (!isBriefingScheduledOn(memberId, date)) {
  throw new DailyBriefingPausedError(memberId, date);
}
```

- In `generateAllBriefings`, right after `if (!isActiveMember(memberId)) continue;` add:

```ts
// A member paused on this weekday is skipped like an inactive one (spec D4).
if (!isBriefingScheduledOn(memberId, date)) continue;
```

Leave the existing `catch` untouched: the pre-check runs synchronously right before the call, so a pause cannot land in between.

- [ ] **Step 4: job.ts**
  - `import { isBriefingScheduledOn } from "./schedule";`
  - `isMissed`: inside the `.some(...)` callback, after `if (!isActiveMember(memberId)) return false;` add `if (!isBriefingScheduledOn(memberId, date)) return false;`
  - Change `async function regenerateFailedBriefings(` to `export async function regenerateFailedBriefings(` and, in its loop, after `if (!isActiveMember(memberId)) continue;` add `if (!isBriefingScheduledOn(memberId, date)) continue;`

- [ ] **Step 5: trigger.ts** — `import { isBriefingScheduledOn } from "./schedule";` and in `evaluateAutoPrintTrigger` add one filter after the `isActiveMember` filter:

```ts
    // A member paused on today's weekday has no briefing to print (spec D4).
    .filter((optIn) => isBriefingScheduledOn(optIn.memberId, date))
```

- [ ] **Step 6: Route** — in `POST /api/daily-briefing/generate`, replace the `catch (err) { return handleDailyBriefingError(err, reply); }` with:

```ts
    } catch (err) {
      if (err instanceof DailyBriefingPausedError) {
        return reply.code(200).send({
          skipped: true,
          reason: "paused",
          memberId: err.memberId,
          date: err.date,
        } satisfies GenerateSkippedResponse);
      }
      return handleDailyBriefingError(err, reply);
    }
```

and import `DailyBriefingPausedError` from `../modules/daily-briefing/index` and `GenerateSkippedResponse` from `../../shared`.

- [ ] **Step 7: Run the tests (plus the existing briefing suites that touch these paths)**

Run: `npx vitest run tests/boundary/daily-briefing-admin-parity.test.ts tests/integration/daily-briefing-trigger.test.ts tests/integration/daily-briefing-job.test.ts tests/integration/daily-briefing-scheduled.test.ts tests/boundary/daily-briefing-generate.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/server/modules/daily-briefing/index.ts src/server/modules/daily-briefing/job.ts src/server/modules/daily-briefing/trigger.ts src/server/routes/daily-briefing.ts tests/boundary/daily-briefing-admin-parity.test.ts tests/integration/daily-briefing-trigger.test.ts
git commit -m "feat(daily-briefing): skip paused weekdays in generation, retries, catch-up and auto-print"
```

---

## Task 4: History read and manual print through the queue

**Files:**

- Modify: `src/server/modules/daily-briefing/index.ts`
- Modify: `src/server/routes/daily-briefing.ts`
- Test: `tests/boundary/daily-briefing-admin-parity.test.ts`

**Interfaces:**

- Produces:
  - `export const BRIEFING_HISTORY_LIMIT = 30;`
  - `export function listBriefingHistory(memberId: string): BriefingHistoryResponse`
  - `export function printBriefing(memberId: string, date: string, now: number): BriefingPrintResponse`
  - `GET /api/daily-briefing/history/:memberId` → 200 `BriefingHistoryResponse`
  - `POST /api/daily-briefing/:memberId/:date/print` → 200 `BriefingPrintResponse`; 400 `validation_error`; 404 `not_found`; 409 `plugin_inactive` | `printable_raster_missing`.

- [ ] **Step 1: Failing tests** — add to the parity test file (imports: `todayInHouseholdTz` from `../../src/server/host-api`):

```ts
function insertRow(
  memberId: string,
  date: string,
  opts: { raster?: boolean; status?: string } = {}
) {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO daily_briefing
           (id, member_id, date, status, payload, failed_render_blocks, raster_bits, raster_height,
            png, created_at, updated_at)
         VALUES (?, ?, ?, ?, '{}', '[]', ?, ?, ?, ?, ?)`
    )
    .run(
      `row-${memberId}-${date}`,
      memberId,
      date,
      opts.status ?? "ready",
      opts.raster ? Buffer.from([0]) : null,
      opts.raster ? 1 : null,
      opts.raster ? Buffer.from([0]) : null,
      now,
      now
    );
}

describe("history", () => {
  it("returns the household today and the latest 30 rows newest first", async () => {
    seedMember("m-hist");
    for (let day = 1; day <= 31; day += 1) {
      insertRow("m-hist", `2026-08-${String(day).padStart(2, "0")}`, {
        status: day === 31 ? "partial" : "ready",
      });
    }
    const res = await app.inject({
      method: "GET",
      url: "/api/daily-briefing/history/m-hist",
      cookies: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.today).toBe(todayInHouseholdTz(Date.now()));
    expect(body.entries).toHaveLength(30);
    expect(body.entries[0]).toMatchObject({ date: "2026-08-31", status: "partial" });
    expect(body.entries[29]).toMatchObject({ date: "2026-08-02" });
    expect(typeof body.entries[0].updatedAt).toBe("number");
  });

  it("is an empty, write-free read for an unknown member", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/daily-briefing/history/nobody",
      cookies: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().entries).toEqual([]);
  });
});

describe("manual print", () => {
  function jobsFor(memberId: string) {
    return getDb()
      .prepare(
        `SELECT j.state, j.target_date, j.output_ref, r.record_key
           FROM print_jobs j JOIN print_records r ON r.id = j.record_id
           WHERE j.member_id = ? ORDER BY j.created_at ASC`
      )
      .all(memberId) as Array<{
      state: string;
      target_date: string;
      output_ref: string;
      record_key: string;
    }>;
  }

  async function print(memberId: string, date: string) {
    return app.inject({
      method: "POST",
      url: `/api/daily-briefing/${memberId}/${date}/print`,
      cookies: auth(),
    });
  }

  it("queues a past briefing for TODAY under the manual record key", async () => {
    seedMember("m-print");
    insertRow("m-print", "2026-08-01", { raster: true });
    const res = await print("m-print", "2026-08-01");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enqueued: true, jobId: expect.any(String) });
    expect(jobsFor("m-print")).toEqual([
      {
        state: "pending",
        target_date: todayInHouseholdTz(Date.now()),
        output_ref: "daily-briefing:m-print:2026-08-01",
        record_key: "daily-briefing:m-print:manual:2026-08-01",
      },
    ]);
  });

  it("reuses a job still waiting in the queue", async () => {
    seedMember("m-twice");
    insertRow("m-twice", "2026-08-01", { raster: true });
    const first = (await print("m-twice", "2026-08-01")).json();
    const second = (await print("m-twice", "2026-08-01")).json();
    expect(second).toEqual({ jobId: first.jobId, enqueued: false });
    expect(jobsFor("m-twice")).toHaveLength(1);
  });

  it("re-arms and queues again after a completed print", async () => {
    seedMember("m-reprint");
    insertRow("m-reprint", "2026-08-01", { raster: true });
    const first = (await print("m-reprint", "2026-08-01")).json();
    // Simulate the printer finishing the job.
    const db = getDb();
    db.prepare("UPDATE print_jobs SET state = 'printed', printed_at = ? WHERE id = ?").run(
      Date.now(),
      first.jobId
    );
    db.prepare(
      "UPDATE print_records SET printed_job_id = ? WHERE id = (SELECT record_id FROM print_jobs WHERE id = ?)"
    ).run(first.jobId, first.jobId);

    const second = await print("m-reprint", "2026-08-01");
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ enqueued: true });
    expect(second.json().jobId).not.toBe(first.jobId);
  });

  it("maps every refusal to its error code", async () => {
    seedMember("m-errors");
    insertRow("m-errors", "2026-08-02"); // no raster
    expect((await print("m-errors", "2026-08-03")).statusCode).toBe(404);
    const noRaster = await print("m-errors", "2026-08-02");
    expect(noRaster.statusCode).toBe(409);
    expect(noRaster.json()).toMatchObject({ error: "printable_raster_missing" });
    expect((await print("m-errors", "not-a-date")).json()).toMatchObject({
      error: "validation_error",
    });

    seedMember("m-gone", { active: false });
    insertRow("m-gone", "2026-08-02", { raster: true });
    expect((await print("m-gone", "2026-08-02")).statusCode).toBe(400);

    __setPrintingPluginActiveForTests(false);
    const inactive = await print("m-errors", "2026-08-02");
    expect(inactive.statusCode).toBe(409);
    expect(inactive.json()).toMatchObject({ error: "plugin_inactive" });
  });
});
```

(`'printed'` is a valid `print_jobs.state` per the baseline CHECK constraint.) The reprint branch only depends on `print_records.printed_job_id` being set and `superseded_at` being NULL.

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/boundary/daily-briefing-admin-parity.test.ts -t "history|manual print"`
Expected: FAIL (404 route not found).

- [ ] **Step 3: index.ts** — add `enqueuePrintJob`, `supersedePrintRecord`, `todayInHouseholdTz` to the `../../host-api` import; add `BriefingHistoryResponse`, `BriefingPrintResponse` to the `../../../shared` type import; add the error classes to the `./errors` import. Then add after `readBriefingPng`:

```ts
/** How many history rows the admin list shows (reference parity). */
export const BRIEFING_HISTORY_LIMIT = 30;

/** Admin history: the member's latest briefings, newest date first, plus the household business
 * date the client uses as its default selection. A pure read (FR-010). */
export function listBriefingHistory(memberId: string): BriefingHistoryResponse {
  const rows = getDb()
    .prepare(
      `SELECT id, date, status, updated_at FROM daily_briefing
       WHERE member_id = ? ORDER BY date DESC LIMIT ?`
    )
    .all(memberId, BRIEFING_HISTORY_LIMIT) as Array<{
    id: string;
    date: string;
    status: BriefingStatus;
    updated_at: number;
  }>;
  return {
    today: resolveBusinessDate(undefined),
    entries: rows.map((row) => ({
      id: row.id,
      date: row.date,
      status: row.status,
      updatedAt: row.updated_at,
    })),
  };
}

/** Manual print (spec D6) through Printing's producer seam — never Printing internals. The job
 * targets the household TODAY (claims are day-scoped) under a per-briefing manual record key, so
 * it never touches the automatic print's dedup or this briefing's derived printed-status. A job
 * still waiting is reused; a printed record is superseded so the click prints again. */
export function printBriefing(memberId: string, date: string, now: number): BriefingPrintResponse {
  assertStrictCalendarDate(date);
  if (!isPrintingPluginActive()) throw new DailyBriefingPrintUnavailableError();
  const row = getDb()
    .prepare("SELECT raster_bits FROM daily_briefing WHERE member_id = ? AND date = ?")
    .get(memberId, date) as { raster_bits: Buffer | null } | undefined;
  if (!row) {
    throw new DailyBriefingNotFoundError(`No briefing for member "${memberId}" on ${date}`);
  }
  if (row.raster_bits === null) {
    throw new DailyBriefingRasterMissingError(
      `The briefing for member "${memberId}" on ${date} has no printable raster`
    );
  }
  try {
    assertActiveMember(memberId);
  } catch {
    throw new DailyBriefingValidationError(`Member "${memberId}" is not active`);
  }
  const params = {
    recordKey: `${PRINTABLE_RECORD_KEY_PREFIX}:${memberId}:manual:${date}`,
    targetDate: todayInHouseholdTz(now),
    outputRef: `${PRINTABLE_RECORD_KEY_PREFIX}:${memberId}:${date}`,
    memberId,
  };
  let result = enqueuePrintJob(params, now);
  if (result.alreadyPrinted) {
    supersedePrintRecord(params.recordKey, params.targetDate, now);
    result = enqueuePrintJob(params, now);
  }
  return { jobId: result.jobId, enqueued: result.enqueued };
}
```

(The record key `daily-briefing:<m>:manual:<d>` resolves to this plugin's provider because Printing matches providers by the `daily-briefing:` prefix; the provider parses the dated `outputRef`.)

- [ ] **Step 4: Routes** — import `listBriefingHistory`, `printBriefing`, `DailyBriefingNotFoundError`, `DailyBriefingPrintUnavailableError`, `DailyBriefingRasterMissingError` from `../modules/daily-briefing/index`. Register BEFORE the `GET /api/daily-briefing/:memberId/:date` route (static segments win anyway, this just reads well):

```ts
app.get(
  "/api/daily-briefing/history/:memberId",
  async (request: FastifyRequest, reply: FastifyReply) => {
    const { memberId } = request.params as { memberId: string };
    try {
      return reply.code(200).send(listBriefingHistory(memberId));
    } catch (err) {
      return handleDailyBriefingError(err, reply);
    }
  }
);

// Manual print through the server print queue (spec D6). No request body.
app.post(
  "/api/daily-briefing/:memberId/:date/print",
  async (request: FastifyRequest, reply: FastifyReply) => {
    const { memberId, date } = request.params as { memberId: string; date: string };
    try {
      return reply.code(200).send(printBriefing(memberId, date, Date.now()));
    } catch (err) {
      return handleDailyBriefingError(err, reply);
    }
  }
);
```

In `handleDailyBriefingError`, before the `DailyBriefingValidationError` branch, add:

```ts
if (err instanceof DailyBriefingNotFoundError) {
  return reply.code(404).send({ error: "not_found", message: err.message });
}
if (err instanceof DailyBriefingPrintUnavailableError) {
  return reply.code(409).send({ error: "plugin_inactive", message: err.message });
}
if (err instanceof DailyBriefingRasterMissingError) {
  return reply.code(409).send({ error: "printable_raster_missing", message: err.message });
}
```

- [ ] **Step 5: Auth matrix** — in `tests/boundary/plugin-routes.test.ts` `AUTH_ROUTE_MATRIX`, after `["PUT", "/api/daily-briefing/opt-in/:memberId"],` add:

```ts
  ["PUT", "/api/daily-briefing/schedule/:memberId"],
  ["GET", "/api/daily-briefing/history/:memberId"],
  ["POST", "/api/daily-briefing/:memberId/:date/print"],
```

- [ ] **Step 6: Run**

Run: `npx vitest run tests/boundary/daily-briefing-admin-parity.test.ts tests/boundary/plugin-routes.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server/modules/daily-briefing/index.ts src/server/routes/daily-briefing.ts tests/boundary/daily-briefing-admin-parity.test.ts tests/boundary/plugin-routes.test.ts
git commit -m "feat(daily-briefing): add briefing history and manual print through the queue"
```

---

## Task 5: 202 while a briefing is still rendering

**Files:**

- Modify: `src/server/modules/daily-briefing/index.ts` (`generateBriefing`, `BriefingPngResult`, `readBriefingPng`)
- Modify: `src/server/routes/daily-briefing.ts` (preview route)
- Test: `tests/boundary/daily-briefing-admin-parity.test.ts`, `tests/boundary/daily-briefing-preview.test.ts` (unchanged expectations must still pass)

**Interfaces:**

- Produces: `export function isBriefingGenerating(memberId: string, date: string): boolean`; `BriefingPngResult` gains `generating: boolean`; preview route 202 `{status: "rendering"}`.

- [ ] **Step 1: Failing tests** — add to the parity file (imports: `__setQuoteSourceForTests`, `isBriefingGenerating` from the module index):

```ts
describe("still rendering", () => {
  const DATE = "2026-09-07";
  let release: () => void = () => {};

  beforeEach(() => {
    __setPrintingPluginActiveForTests(false);
    const gate = new Promise<null>((resolve) => {
      release = () => resolve(null);
    });
    // quoteOfDay is an external block: generation awaits this port before it can finish.
    __setQuoteSourceForTests(() => gate);
  });

  afterEach(() => {
    release();
    __setQuoteSourceForTests(undefined);
  });

  async function preview(memberId: string) {
    return app.inject({
      method: "GET",
      url: `/api/daily-briefing/${memberId}/${DATE}/preview.png`,
      cookies: auth(),
    });
  }

  it("answers 202 while a first generation is in flight, then the final state", async () => {
    seedMember("m-render");
    const pending = generateBriefing("m-render", DATE);
    expect(isBriefingGenerating("m-render", DATE)).toBe(true);
    const during = await preview("m-render");
    expect(during.statusCode).toBe(202);
    expect(during.json()).toEqual({ status: "rendering" });

    release();
    await pending;
    expect(isBriefingGenerating("m-render", DATE)).toBe(false);
    expect((await preview("m-render")).statusCode).toBe(409); // Printing off: no raster
  });

  it("stays generating until the last overlapping generation finishes", async () => {
    seedMember("m-overlap");
    const first = generateBriefing("m-overlap", DATE);
    const second = generateBriefing("m-overlap", DATE);
    expect(isBriefingGenerating("m-overlap", DATE)).toBe(true);
    release();
    await Promise.all([first, second]);
    expect(isBriefingGenerating("m-overlap", DATE)).toBe(false);
  });

  it("clears the in-flight mark when generation throws", async () => {
    seedMember("m-throws");
    setMemberSchedule("m-throws", ["tue"]); // Monday paused: throws inside the read transaction
    await expect(generateBriefing("m-throws", DATE)).rejects.toThrow();
    expect(isBriefingGenerating("m-throws", DATE)).toBe(false);
  });

  it("keeps serving a stored PNG while a regeneration is in flight", async () => {
    seedMember("m-stored");
    const { PNG } = await import("pngjs");
    const png = PNG.sync.write(new PNG({ width: 2, height: 2 }));
    getDb()
      .prepare(
        `INSERT INTO daily_briefing (id, member_id, date, status, payload, png, created_at, updated_at)
           VALUES ('stored', 'm-stored', ?, 'ready', '{}', ?, 1, 1)`
      )
      .run(DATE, Buffer.from(png));
    const pending = generateBriefing("m-stored", DATE);
    expect((await preview("m-stored")).statusCode).toBe(200);
    release();
    await pending;
  });
});
```

Note on the last case: once the regeneration completes with Printing off, the stored PNG is replaced by NULL — that is existing behaviour (FR-012) and not asserted here.

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/boundary/daily-briefing-admin-parity.test.ts -t "still rendering"`
Expected: FAIL (`isBriefingGenerating` is not a function).

- [ ] **Step 3: Implement the registry** in `index.ts`, above `generateBriefing`:

```ts
// ── In-flight registry (spec D7) ───────────────────────────────────────────
// `pending` never escapes the write transaction, so the admin preview cannot tell "still
// rendering" from the row. This per-process counter marks (member, date) from the end of the
// read transaction until generateBriefing settles. One process, one scheduler (Constitution III).
const generationsInFlight = new Map<string, number>();

function flightKey(memberId: string, date: string): string {
  return `${memberId}:${date}`;
}

/** True while at least one generation for this member/date is running. */
export function isBriefingGenerating(memberId: string, date: string): boolean {
  return generationsInFlight.has(flightKey(memberId, date));
}
```

In `generateBriefing`, right after `const { member, date, language } = inputs;` insert:

```ts
  const flight = flightKey(memberId, date);
  generationsInFlight.set(flight, (generationsInFlight.get(flight) ?? 0) + 1);
  try {
```

and close it right after the final `return briefing;` of the function:

```ts
  } finally {
    const remaining = (generationsInFlight.get(flight) ?? 1) - 1;
    if (remaining > 0) generationsInFlight.set(flight, remaining);
    else generationsInFlight.delete(flight);
  }
```

(Everything between — cache, finishBlocks, TOCTOU checks, render, write transaction, catch of `LateEligibilityAbortError`, emit, return — moves inside the `try`; re-indent with the formatter.) A throw from the first read transaction (e.g. paused) happens before the counter is set, so nothing is left marked.

- [ ] **Step 4: readBriefingPng + route** — add `generating: boolean;` to `BriefingPngResult` (doc: "a generation for this member/date is in flight"), and return `generating: isBriefingGenerating(memberId, date)` in both returns of `readBriefingPng`. Replace the body of the preview route's `try` with:

```ts
const result = readBriefingPng(memberId, date);
if (result.png) {
  return reply.code(200).header("content-type", "image/png").send(result.png);
}
if (result.generating) {
  return reply.code(202).send({ status: "rendering" } satisfies BriefingPreviewRendering);
}
if (!result.found) {
  return reply.code(404).send({ error: "not_found", message: "No briefing for this member/date" });
}
return reply.code(409).send({
  error: "printable_raster_missing",
  message: "This briefing has no stored printable raster",
});
```

(import type `BriefingPreviewRendering` from `../../shared`).

- [ ] **Step 5: Run**

Run: `npx vitest run tests/boundary/daily-briefing-admin-parity.test.ts tests/boundary/daily-briefing-preview.test.ts tests/integration/daily-briefing-regen.test.ts tests/integration/daily-briefing-generation.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/modules/daily-briefing/index.ts src/server/routes/daily-briefing.ts tests/boundary/daily-briefing-admin-parity.test.ts
git commit -m "feat(daily-briefing): report a briefing that is still rendering with 202"
```

---

## Task 6: Server docs (feature spec + OpenAPI)

**Files:**

- Modify: `docs/features/daily-briefing.md`
- Modify: `docs/api/daily-briefing/openapi.yaml`
- Modify: `docs/api/briefing-render/openapi.yaml`

- [ ] **Step 1: Feature spec** — in `docs/features/daily-briefing.md`:
  - After "User Story 3", add:

```markdown
### User Story 4 — Admin page: pause, history, regenerate, view and print

A parent pauses a member's briefing on chosen weekdays, browses that member's last 30 briefings,
regenerates any date, opens its image, and sends it to the printer queue on demand. A paused
weekday produces no briefing and no automatic print; a manual regenerate on that day reports that
the member is paused instead of generating.
```

- Append to "Functional Requirements" (after FR-022):

```markdown
- **FR-023**: Given a member's weekday schedule, when one of their weekdays is switched off, then scheduled, catch-up, retry and Generate-all generation MUST skip that member on that weekday and the auto-print trigger MUST NOT evaluate them; a member with no stored schedule runs every day. Contract: none (admin parity, 2026-10-15).
- **FR-024**: Given a manual generate for a member paused on that date's weekday, then no row MUST be written and the API MUST answer `200 {skipped: true, reason: "paused", memberId, date}`. Contract: none (admin parity).
- **FR-025**: Given a schedule write, then weekdays MUST be canonical tokens (stored in mon..sun order, duplicates collapsed, an empty list allowed), the member MUST be active, unknown body fields MUST be rejected, and the write MUST NOT regenerate or invalidate any briefing. Contract: none (admin parity).
- **FR-026**: Given a history read for a member, then it MUST return the household business date and at most 30 of the member's briefings, newest date first, without writing. Contract: none (admin parity).
- **FR-027**: Given a manual print of a stored briefing, then Daily Briefing MUST enqueue it through Printing's producer seam under the record key `daily-briefing:<memberId>:manual:<date>` with the household today as target date and the dated output reference, MUST reuse a job still waiting, MUST supersede and re-enqueue a record already printed, MUST NOT change the automatic print's dedup or the briefing's derived printed-status, and MUST refuse with 404 (no briefing), 409 `plugin_inactive`, 409 `printable_raster_missing` or 400 (inactive member, bad date). Contract: none (admin parity).
- **FR-028**: Given a preview read while a generation for that member/date is in flight and no PNG is stored, then it MUST answer `202 {status: "rendering"}`; a stored PNG is served even during a regeneration. Contract: none (admin parity).
```

- In "Key Entities", add: `- **Member schedule**: the weekdays on which a member's briefing runs, stored with the opt-in (NULL = every day); pausing a weekday never deletes existing briefings.`

- [ ] **Step 2: `docs/api/daily-briefing/openapi.yaml`**
  - Under `components.schemas` add:

```yaml
GenerateSkippedResponse:
  type: object
  additionalProperties: false
  required: [skipped, reason, memberId, date]
  properties:
    skipped:
      type: boolean
      const: true
    reason:
      type: string
      enum: [paused]
    memberId:
      type: string
    date:
      type: string
BriefingHistoryEntry:
  type: object
  additionalProperties: false
  required: [id, date, status, updatedAt]
  properties:
    id:
      type: string
    date:
      type: string
    status:
      $ref: "#/components/schemas/BriefingStatus"
    updatedAt:
      type: integer
BriefingHistoryResponse:
  type: object
  additionalProperties: false
  required: [today, entries]
  properties:
    today:
      type: string
      description: household-timezone business date (YYYY-MM-DD).
    entries:
      type: array
      maxItems: 30
      items:
        $ref: "#/components/schemas/BriefingHistoryEntry"
```

- In `POST /api/daily-briefing/generate` → `"200"`, replace the schema with:

```yaml
schema:
  oneOf:
    - $ref: "#/components/schemas/Briefing"
    - $ref: "#/components/schemas/GenerateSkippedResponse"
```

    and change its description to `generated briefing, or skipped because the member is paused on that weekday (FR-024).`

- Add the path (copy the 401/403/429/500 response blocks verbatim from `/api/daily-briefing/opt-in`):

```yaml
/api/daily-briefing/history/{memberId}:
  get:
    summary: List a member's latest briefings, newest first (admin, FR-026).
    parameters:
      - name: memberId
        in: path
        required: true
        schema:
          type: string
    responses:
      "429":
        $ref: "#/components/responses/AuthenticationBackoff"
      "200":
        description: household today plus at most 30 history entries; a pure read.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/BriefingHistoryResponse"
      "401": ... (copy)
      "403": ... (copy)
      "500": ... (copy)
```

- [ ] **Step 3: `docs/api/briefing-render/openapi.yaml`**
  - `DailyBriefingSettingsView`: add `- memberSchedules` to `required` and the property:

```yaml
memberSchedules:
  type: array
  description: stored weekday pause schedules; members without one run every day (FR-023).
  items:
    $ref: "#/components/schemas/BriefingSchedule"
```

- New schemas:

```yaml
Weekday:
  type: string
  enum: [mon, tue, wed, thu, fri, sat, sun]
BriefingSchedule:
  type: object
  additionalProperties: false
  required: [memberId, weekdays]
  properties:
    memberId:
      type: string
    weekdays:
      type: array
      items:
        $ref: "#/components/schemas/Weekday"
BriefingScheduleInput:
  type: object
  additionalProperties: false
  required: [weekdays]
  properties:
    weekdays:
      type: array
      items:
        $ref: "#/components/schemas/Weekday"
BriefingPreviewRendering:
  type: object
  additionalProperties: false
  required: [status]
  properties:
    status:
      type: string
      enum: [rendering]
BriefingPrintResponse:
  type: object
  additionalProperties: false
  required: [jobId, enqueued]
  properties:
    jobId:
      type: string
    enqueued:
      type: boolean
      description: false when a job for this briefing was already waiting and was reused.
PrintingPluginInactiveErrorResponse:
  type: object
  additionalProperties: false
  required: [error, message]
  properties:
    error:
      type: string
      enum: [plugin_inactive]
    message:
      type: string
```

    (If a `Weekday` schema already exists in this file, reuse it instead of adding a second.)

- Preview path: add a `"202"` response:

```yaml
"202":
  description: a generation for this member/date is in flight and no PNG is stored yet (FR-028).
  content:
    application/json:
      schema:
        $ref: "#/components/schemas/BriefingPreviewRendering"
```

- New paths (copy 401/403/429/500 blocks from the block-settings path):

```yaml
/api/daily-briefing/schedule/{memberId}:
  put:
    summary: Set a member's weekday pause schedule (admin, FR-023/FR-025).
    description: Never regenerates or invalidates briefings. An empty list pauses every day.
    parameters:
      - name: memberId
        in: path
        required: true
        schema:
          type: string
    requestBody:
      required: true
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/BriefingScheduleInput"
    responses:
      "200":
        description: the stored schedule, canonical order.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/BriefingSchedule"
      "400":
        description: bad weekday, missing weekdays, unknown field, or inactive member.
        content:
          application/json:
            schema:
              oneOf:
                - $ref: "#/components/schemas/ValidationErrorResponse"
                - $ref: "#/components/schemas/FastifyParseErrorResponse"
      # plus 401/403/429/500 copied
/api/daily-briefing/{memberId}/{date}/print:
  post:
    summary: Send a stored briefing to the printer queue (admin, FR-027).
    parameters:
      - name: memberId
        in: path
        required: true
        schema:
          type: string
      - name: date
        in: path
        required: true
        schema:
          type: string
    responses:
      "200":
        description: queued (or the waiting job reused).
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/BriefingPrintResponse"
      "400":
        description: invalid date or inactive member.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/ValidationErrorResponse"
      "404":
        description: no briefing for this member/date.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/NotFoundErrorResponse"
      "409":
        description: Printing plugin inactive, or the briefing has no printable raster.
        content:
          application/json:
            schema:
              oneOf:
                - $ref: "#/components/schemas/PrintingPluginInactiveErrorResponse"
                - $ref: "#/components/schemas/PrintableRasterMissingErrorResponse"
      # plus 401/403/429/500 copied
```

If `FastifyParseErrorResponse` is not defined in this file, copy its schema from `docs/api/daily-briefing/openapi.yaml`.

- [ ] **Step 4: Verify** — `npm run check:openapi && npm run check:openapi-shapes`. Expected: PASS once the cohort fixture lists the three new routes (Task 11); if `check:openapi` complains ONLY about the cohort `pluginRoutes`, do Task 11 Step 1 now and re-run.

- [ ] **Step 5: Commit**

```bash
git add docs/features/daily-briefing.md docs/api/daily-briefing/openapi.yaml docs/api/briefing-render/openapi.yaml
git commit -m "docs(daily-briefing): document pause schedule, history, manual print and 202"
```

---

## Task 7: Client building blocks (WeekdayPicker prop, pills, image, workspace, i18n)

**Files:**

- Modify: `src/client/components/WeekdayPicker.tsx`
- Create: `src/client/daily-briefing/admin/BriefingMemberPills.tsx`
- Create: `src/client/daily-briefing/admin/BriefingImage.tsx`
- Create: `src/client/daily-briefing/admin/BriefingWorkspace.tsx`
- Modify: `src/client/i18n/messages.ts`
- Test: `tests/client/weekday-picker.test.tsx`, create `tests/client/daily-briefing-workspace.test.tsx`

**Interfaces:**

- Consumes: server API from Tasks 2–5; shared types from Task 1.
- Produces:
  - `WeekdayPicker` multi mode prop `disabledDays?: readonly WeekdayCode[]`.
  - `pillMembers(members: MemberDTO[], optIns: Record<string, boolean>): MemberDTO[]` and `BriefingMemberPills({members, selectedId, onSelect, testIdPrefix, label})`.
  - `BriefingImage({memberId, date, version, status})`.
  - `BriefingWorkspace({members, optIns, active, blocked, onGenerated, onBusyChange})`.

- [ ] **Step 1: i18n block** — in `src/client/i18n/messages.ts`, after `"admin.notFound.description": ...,` in `en` insert:

```ts
    // admin-briefing
    "dailyBriefing.admin.retry": "Retry",
    "dailyBriefing.admin.scheduleDayLabel": "Print",
    "dailyBriefing.admin.scheduleCaption":
      "Untick a day under its name to pause this member's briefing on that weekday.",
    "dailyBriefing.admin.scheduleSaveError": "Failed to save the briefing days.",
    "dailyBriefing.admin.settingsChanged": "Settings changed — regenerate the briefing to apply them.",
    "dailyBriefing.admin.noPillMembers": "No children or opted-in members yet.",
    "dailyBriefing.admin.historyTitle": "History",
    "dailyBriefing.admin.historyEmpty": "No briefing yet — Generate creates today's.",
    "dailyBriefing.admin.historyLoadError": "Failed to load the briefing history.",
    "dailyBriefing.admin.regenerate": "Regenerate",
    "dailyBriefing.admin.needsOptIn": "Turn the briefing on for this member to generate it.",
    "dailyBriefing.admin.viewPng": "View PNG",
    "dailyBriefing.admin.print": "Print",
    "dailyBriefing.admin.printing": "Sending…",
    "dailyBriefing.admin.printUnavailable": "Printing is off. Turn the Printing plugin on to print.",
    "dailyBriefing.admin.printNoRaster": "This briefing has no printable image.",
    "dailyBriefing.admin.printError": "Failed to send the briefing to the printer.",
    "dailyBriefing.admin.printQueued": "Sent to the printer queue.",
    "dailyBriefing.admin.printAlreadyQueued": "Already waiting in the printer queue.",
    "dailyBriefing.admin.pausedNotice":
      "{name} is paused on {date} — switch the day back on in {blocks} to generate.",
    "dailyBriefing.admin.noBriefingForDate": "No briefing for {date}.",
    "dailyBriefing.admin.briefingLoadError": "Failed to load the briefing.",
    "dailyBriefing.admin.payloadTitle": "Payload",
    "dailyBriefing.admin.imageLoading": "Loading image…",
    "dailyBriefing.admin.imageRendering": "Briefing still rendering — try again shortly.",
    "dailyBriefing.admin.imageRenderFailed": "Render failed for this briefing.",
    "dailyBriefing.admin.imageNoRaster":
      "No printable image — Printing was off when this briefing was generated.",
    "dailyBriefing.admin.imageError": "Could not load the image.",
```

and after `"admin.notFound.description": ...,` in `es`:

```ts
    // admin-briefing
    "dailyBriefing.admin.retry": "Reintentar",
    "dailyBriefing.admin.scheduleDayLabel": "Imprimir",
    "dailyBriefing.admin.scheduleCaption":
      "Desmarca un día bajo su nombre para pausar el resumen de este miembro ese día de la semana.",
    "dailyBriefing.admin.scheduleSaveError": "No se pudieron guardar los días del resumen.",
    "dailyBriefing.admin.settingsChanged": "Ajustes cambiados: regenera el resumen para aplicarlos.",
    "dailyBriefing.admin.noPillMembers": "Aún no hay niños ni miembros con el resumen activado.",
    "dailyBriefing.admin.historyTitle": "Historial",
    "dailyBriefing.admin.historyEmpty": "Aún no hay resúmenes: Generar crea el de hoy.",
    "dailyBriefing.admin.historyLoadError": "No se pudo cargar el historial de resúmenes.",
    "dailyBriefing.admin.regenerate": "Regenerar",
    "dailyBriefing.admin.needsOptIn": "Activa el resumen para este miembro para poder generarlo.",
    "dailyBriefing.admin.viewPng": "Ver PNG",
    "dailyBriefing.admin.print": "Imprimir",
    "dailyBriefing.admin.printing": "Enviando…",
    "dailyBriefing.admin.printUnavailable":
      "La impresión está desactivada. Activa el complemento de impresión para imprimir.",
    "dailyBriefing.admin.printNoRaster": "Este resumen no tiene imagen imprimible.",
    "dailyBriefing.admin.printError": "No se pudo enviar el resumen a la impresora.",
    "dailyBriefing.admin.printQueued": "Enviado a la cola de impresión.",
    "dailyBriefing.admin.printAlreadyQueued": "Ya está esperando en la cola de impresión.",
    "dailyBriefing.admin.pausedNotice":
      "{name} está en pausa el {date}: vuelve a activar el día en {blocks} para generarlo.",
    "dailyBriefing.admin.noBriefingForDate": "No hay resumen para el {date}.",
    "dailyBriefing.admin.briefingLoadError": "No se pudo cargar el resumen.",
    "dailyBriefing.admin.payloadTitle": "Contenido",
    "dailyBriefing.admin.imageLoading": "Cargando imagen…",
    "dailyBriefing.admin.imageRendering":
      "El resumen aún se está generando: inténtalo de nuevo en un momento.",
    "dailyBriefing.admin.imageRenderFailed": "Falló el renderizado de este resumen.",
    "dailyBriefing.admin.imageNoRaster":
      "Sin imagen imprimible: la impresión estaba desactivada cuando se generó este resumen.",
    "dailyBriefing.admin.imageError": "No se pudo cargar la imagen.",
```

- [ ] **Step 2: WeekdayPicker failing test** — add to `tests/client/weekday-picker.test.tsx` (follow the file's existing render/import style):

```tsx
it("disables only the listed days in multi mode", () => {
  render(
    <WeekdayPicker
      value={["mon", "tue"]}
      onChange={() => {}}
      labels={{
        mon: "Mon",
        tue: "Tue",
        wed: "Wed",
        thu: "Thu",
        fri: "Fri",
        sat: "Sat",
        sun: "Sun",
      }}
      groupLabel="Days"
      disabledDays={["tue", "sun"]}
      testIdPrefix="picker"
    />
  );
  expect(screen.getByTestId("picker-tue")).toBeDisabled();
  expect(screen.getByTestId("picker-sun")).toBeDisabled();
  expect(screen.getByTestId("picker-mon")).toBeEnabled();
  expect(screen.getByTestId("picker-tue")).toBeChecked();
});
```

Run: `npx vitest run tests/client/weekday-picker.test.tsx` — Expected: FAIL (TS/prop ignored → `picker-tue` enabled).

- [ ] **Step 3: WeekdayPicker** — in `WeekdayPickerMultiProps` add:

```ts
  /** Days rendered disabled (still showing their value) — e.g. weekdays a parent setting has
   * switched off. Multi mode only. */
  disabledDays?: readonly WeekdayCode[];
```

In the multi branch: `const { value, onChange, disabledDays } = props;` and on each `CheckboxField` use `disabled={disabled || disabledDays?.includes(day)}`. Re-run the test: PASS. Run `npm run check:ui-catalog` (should still pass; the catalog lists exports, not props).

- [ ] **Step 4: Pills** — create `src/client/daily-briefing/admin/BriefingMemberPills.tsx`:

```tsx
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { MemberColorKey, MemberDTO } from "../../../shared";

/** Static class map so Tailwind sees every class and no inline style is needed
 * (the `TodayAgenda.tsx` precedent). */
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

export function BriefingMemberPills({
  members,
  selectedId,
  onSelect,
  testIdPrefix,
  label,
}: BriefingMemberPillsProps) {
  return (
    <div role="tablist" aria-label={label} className="flex flex-wrap gap-2">
      {members.map((member) => {
        const selected = member.id === selectedId;
        return (
          <Button
            key={member.id}
            type="button"
            role="tab"
            variant={selected ? "default" : "outline"}
            aria-selected={selected}
            data-testid={`${testIdPrefix}-${member.id}`}
            onClick={() => onSelect(member.id)}
            className="rounded-full"
          >
            <span
              aria-hidden="true"
              className={cn(
                "size-3 shrink-0 rounded-full border border-background",
                MEMBER_DOT_CLASS[member.colorKey]
              )}
            />
            {member.displayName}
          </Button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 5: Workspace failing tests** — create `tests/client/daily-briefing-workspace.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BriefingWorkspace } from "@/daily-briefing/admin/BriefingWorkspace";
import { LanguageProvider } from "@/i18n";
import type { Briefing, MemberDTO } from "../../src/shared";

type FetchCall = Parameters<typeof globalThis.fetch>;

const ben: MemberDTO = {
  id: "member-ben",
  displayName: "Ben",
  colorKey: "teal",
  role: "child",
  lifecycle: "active",
  createdAt: 1,
  updatedAt: 1,
  birthDate: null,
};
const cleo: MemberDTO = { ...ben, id: "member-cleo", displayName: "Cleo", colorKey: "pink" };

const TODAY = "2026-10-15";
const PAST = "2026-10-14";

function briefing(date: string, status: Briefing["status"] = "ready"): Briefing {
  return {
    id: `b-${date}`,
    memberId: "member-ben",
    date,
    status,
    payload: {
      schemaVersion: 2,
      member: { id: "member-ben", displayName: "Ben" },
      date,
      blocks: [],
    },
    createdAt: 1,
    updatedAt: 2,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

interface Backend {
  printingActive?: boolean;
  historyFails?: boolean;
  previewStatus?: Record<string, number>;
  generate?: (body: Record<string, unknown>) => Response;
  print?: () => Response;
}

function mockBackend(backend: Backend = {}) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  let historyFailures = backend.historyFails ? 1 : 0;
  const fetchMock = vi.fn(async (...args: FetchCall) => {
    const [input, init] = args;
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === "/api/settings") return json({ locale: { timezone: "UTC", language: "en" } });
    if (url === "/api/printing/status") return json({ active: backend.printingActive ?? true });
    if (url.startsWith("/api/daily-briefing/history/")) {
      if (historyFailures > 0) {
        historyFailures -= 1;
        return json({ error: "internal_error", message: "x" }, 500);
      }
      return json({
        today: TODAY,
        entries: url.endsWith("member-ben")
          ? [
              { id: "b1", date: TODAY, status: "ready", updatedAt: 2 },
              { id: "b0", date: PAST, status: "render-failed", updatedAt: 1 },
            ]
          : [],
      });
    }
    const preview = url.match(/^\/api\/daily-briefing\/[^/]+\/(\d{4}-\d{2}-\d{2})\/preview\.png/);
    if (preview) {
      const status = backend.previewStatus?.[preview[1]] ?? 200;
      return status === 200
        ? new Response(new Blob([new Uint8Array([137, 80, 78, 71])]), { status })
        : json(status === 202 ? { status: "rendering" } : { error: "x", message: "x" }, status);
    }
    if (url === "/api/daily-briefing/generate" && method === "POST") {
      return backend.generate?.(JSON.parse(String(init?.body))) ?? json(briefing(TODAY));
    }
    const print = url.match(/^\/api\/daily-briefing\/[^/]+\/[^/]+\/print$/);
    if (print && method === "POST")
      return backend.print?.() ?? json({ jobId: "j1", enqueued: true });
    const read = url.match(/^\/api\/daily-briefing\/member-(ben|cleo)\/(\d{4}-\d{2}-\d{2})$/);
    if (read) {
      return read[1] === "ben"
        ? json({ generated: true, briefing: briefing(read[2]), printedStatus: "none" })
        : json({ generated: false });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

function renderWorkspace(props: Partial<Parameters<typeof BriefingWorkspace>[0]> = {}) {
  const onGenerated = vi.fn();
  render(
    <LanguageProvider>
      <BriefingWorkspace
        members={[ben, cleo]}
        optIns={{ "member-ben": true }}
        active
        blocked={false}
        onGenerated={onGenerated}
        onBusyChange={() => {}}
        {...props}
      />
    </LanguageProvider>
  );
  return { onGenerated };
}

describe("BriefingWorkspace", () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:briefing");
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("shows the first member's history, today's payload and image", async () => {
    mockBackend();
    renderWorkspace();
    expect(await screen.findByTestId(`daily-briefing-history-entry-${TODAY}`)).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByTestId(`daily-briefing-history-entry-${PAST}`)).toHaveTextContent(
      "Render failed"
    );
    expect(await screen.findByTestId("daily-briefing-generated-payload")).toHaveTextContent(
      `"date": "${TODAY}"`
    );
    expect(screen.getByTestId("daily-briefing-status")).toHaveTextContent("Ready");
    expect(await screen.findByTestId("daily-briefing-admin-preview-image")).toHaveAttribute(
      "src",
      "blob:briefing"
    );
    expect(screen.getByTestId("daily-briefing-generate")).toHaveTextContent("Regenerate");
  });

  it("selecting a past entry loads it; a 409 on a render-failed briefing says so", async () => {
    mockBackend({ previewStatus: { [PAST]: 409 } });
    renderWorkspace();
    fireEvent.click(await screen.findByTestId(`daily-briefing-history-entry-${PAST}`));
    await waitFor(() =>
      expect(screen.getByTestId("daily-briefing-generated-payload")).toHaveTextContent(
        `"date": "${PAST}"`
      )
    );
    const state = await screen.findByTestId("daily-briefing-image-state");
    await waitFor(() => expect(state).toHaveAttribute("data-state", "noRaster"));
    expect(state).toHaveTextContent("Render failed for this briefing.");
  });

  it("regenerates today with only memberId, and a past date with the date", async () => {
    const calls = mockBackend({
      generate: (body) => json(briefing((body.date as string | undefined) ?? TODAY)),
    });
    const { onGenerated } = renderWorkspace();
    await screen.findByTestId(`daily-briefing-history-entry-${TODAY}`);
    fireEvent.click(screen.getByTestId("daily-briefing-generate"));
    await waitFor(() => expect(onGenerated).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId(`daily-briefing-history-entry-${PAST}`));
    fireEvent.click(screen.getByTestId("daily-briefing-generate"));
    await waitFor(() => expect(onGenerated).toHaveBeenCalledTimes(2));
    expect(
      calls.filter((call) => call.url === "/api/daily-briefing/generate").map((c) => c.body)
    ).toEqual([{ memberId: "member-ben" }, { memberId: "member-ben", date: PAST }]);
  });

  it("reports a paused day instead of generating", async () => {
    mockBackend({
      generate: () =>
        json({ skipped: true, reason: "paused", memberId: "member-ben", date: TODAY }),
    });
    const { onGenerated } = renderWorkspace();
    await screen.findByTestId(`daily-briefing-history-entry-${TODAY}`);
    fireEvent.click(screen.getByTestId("daily-briefing-generate"));
    expect(await screen.findByTestId("daily-briefing-paused-notice")).toHaveTextContent(
      `Ben is paused on ${TODAY}`
    );
    expect(onGenerated).not.toHaveBeenCalled();
  });

  it("prints through the queue and says so; Print is disabled when Printing is off", async () => {
    const calls = mockBackend();
    renderWorkspace();
    await screen.findByTestId("daily-briefing-generated-payload");
    await waitFor(() => expect(screen.getByTestId("daily-briefing-print")).toBeEnabled());
    fireEvent.click(screen.getByTestId("daily-briefing-print"));
    expect(await screen.findByTestId("daily-briefing-print-notice")).toHaveTextContent(
      "Sent to the printer queue."
    );
    expect(calls.some((c) => c.url === `/api/daily-briefing/member-ben/${TODAY}/print`)).toBe(true);

    cleanup();
    mockBackend({ printingActive: false });
    renderWorkspace();
    await screen.findByTestId("daily-briefing-generated-payload");
    expect(screen.getByTestId("daily-briefing-print")).toBeDisabled();
    expect(screen.getByTestId("daily-briefing-print-unavailable")).toBeVisible();
  });

  it("shows still-rendering with a Retry that refetches", async () => {
    mockBackend({ previewStatus: { [TODAY]: 202 } });
    renderWorkspace();
    const state = await screen.findByTestId("daily-briefing-image-state");
    await waitFor(() => expect(state).toHaveAttribute("data-state", "rendering"));
    const fetchMock = vi.mocked(globalThis.fetch);
    const before = fetchMock.mock.calls.filter(([u]) => String(u).includes("preview.png")).length;
    fireEvent.click(screen.getByTestId("daily-briefing-image-retry"));
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("preview.png")).length).toBe(
        before + 1
      )
    );
  });

  it("offers Retry when the history fails to load", async () => {
    mockBackend({ historyFails: true });
    renderWorkspace();
    expect(await screen.findByTestId("daily-briefing-history-error")).toBeVisible();
    fireEvent.click(screen.getByTestId("daily-briefing-history-retry"));
    expect(await screen.findByTestId(`daily-briefing-history-entry-${TODAY}`)).toBeVisible();
  });

  it("disables Generate for a member without the briefing turned on", async () => {
    mockBackend();
    renderWorkspace();
    fireEvent.click(await screen.findByTestId("daily-briefing-preview-member-member-cleo"));
    expect(await screen.findByTestId("daily-briefing-needs-opt-in")).toBeVisible();
    expect(screen.getByTestId("daily-briefing-generate")).toBeDisabled();
    expect(await screen.findByTestId("daily-briefing-history-empty")).toBeVisible();
  });

  it("Show loads any typed date and refetches the image", async () => {
    mockBackend();
    renderWorkspace();
    await screen.findByTestId(`daily-briefing-history-entry-${TODAY}`);
    fireEvent.change(screen.getByTestId("daily-briefing-admin-preview-date"), {
      target: { value: "2026-09-07" },
    });
    fireEvent.click(screen.getByTestId("daily-briefing-admin-preview-show"));
    await waitFor(() =>
      expect(
        vi
          .mocked(globalThis.fetch)
          .mock.calls.some(([u]) =>
            /^\/api\/daily-briefing\/member-ben\/2026-09-07\/preview\.png\?v=/.test(String(u))
          )
      ).toBe(true)
    );
  });

  it("fetches nothing while the tab is hidden", () => {
    const calls = mockBackend();
    renderWorkspace({ active: false });
    expect(calls.filter((c) => c.url.startsWith("/api/daily-briefing"))).toEqual([]);
  });
});
```

Run: `npx vitest run tests/client/daily-briefing-workspace.test.tsx` — Expected: FAIL (module not found).

- [ ] **Step 6: BriefingImage** — create `src/client/daily-briefing/admin/BriefingImage.tsx`:

```tsx
import { useEffect, useState } from "react";
import { useT } from "@/i18n";
import { authFetch } from "@/lib/credential";
import { Button } from "@/components/ui/button";
import { ErrorNotice } from "@/components/ErrorNotice";
import type { BriefingStatus } from "../../../shared";

type ImageState =
  | { kind: "loading" }
  | { kind: "ready"; url: string }
  | { kind: "rendering" }
  | { kind: "missing" }
  | { kind: "noRaster" }
  | { kind: "failed" };

interface BriefingImageProps {
  memberId: string;
  date: string;
  /** Bumped by the caller to force a refetch (Show, after a regenerate). */
  version: number;
  /** The briefing's status when known — words the "no printable image" state. */
  status?: BriefingStatus;
}

const FRAME =
  "flex min-h-48 w-64 max-w-full flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-4 text-center text-sm text-muted-foreground";

/** Stored render with honest states (spec D7/D11): the status code decides what is shown. */
export function BriefingImage({ memberId, date, version, status }: BriefingImageProps) {
  const t = useT();
  const [state, setState] = useState<ImageState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setState({ kind: "loading" });
    void (async () => {
      try {
        const response = await authFetch(
          `/api/daily-briefing/${memberId}/${date}/preview.png?v=${version}.${attempt}`,
          { credentials: "include" }
        );
        if (cancelled) return;
        if (response.status === 200) {
          const blob = await response.blob();
          if (cancelled) return;
          objectUrl = URL.createObjectURL(blob);
          setState({ kind: "ready", url: objectUrl });
        } else if (response.status === 202) setState({ kind: "rendering" });
        else if (response.status === 404) setState({ kind: "missing" });
        else if (response.status === 409) setState({ kind: "noRaster" });
        else setState({ kind: "failed" });
      } catch {
        if (!cancelled) setState({ kind: "failed" });
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [memberId, date, version, attempt]);

  if (state.kind === "ready") {
    return (
      <img
        data-testid="daily-briefing-admin-preview-image"
        src={state.url}
        alt={t("dailyBriefing.admin.previewImageAlt")}
        className="w-64 max-w-full shrink-0 rounded-lg border"
      />
    );
  }

  const retry = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-testid="daily-briefing-image-retry"
      onClick={() => setAttempt((value) => value + 1)}
    >
      {t("dailyBriefing.admin.retry")}
    </Button>
  );

  return (
    <div data-testid="daily-briefing-image-state" data-state={state.kind} className={FRAME}>
      {state.kind === "loading" && <p role="status">{t("dailyBriefing.admin.imageLoading")}</p>}
      {state.kind === "rendering" && (
        <>
          <p role="status">{t("dailyBriefing.admin.imageRendering")}</p>
          {retry}
        </>
      )}
      {state.kind === "missing" && (
        <p>{t("dailyBriefing.admin.noBriefingForDate").replace("{date}", date)}</p>
      )}
      {state.kind === "noRaster" &&
        (status === "render-failed" ? (
          <ErrorNotice message={t("dailyBriefing.admin.imageRenderFailed")} politeness="polite" />
        ) : (
          <p>{t("dailyBriefing.admin.imageNoRaster")}</p>
        ))}
      {state.kind === "failed" && (
        <>
          <ErrorNotice message={t("dailyBriefing.admin.imageError")} politeness="polite" />
          {retry}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 7: BriefingWorkspace** — create `src/client/daily-briefing/admin/BriefingWorkspace.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { useT } from "@/i18n";
import { authFetch } from "@/lib/credential";
import { appUrl } from "@/lib/base-path";
import { LocalizedApiError, responseMessage } from "@/lib/api-error";
import { cn } from "@/lib/utils";
import { NATIVE_SELECT_CLASSES } from "@/lib/recipes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorNotice } from "@/components/ErrorNotice";
import { usePrintingPluginActive } from "@/printing/pluginStatus";
import { BriefingImage } from "./BriefingImage";
import { BriefingMemberPills } from "./BriefingMemberPills";
import type {
  Briefing,
  BriefingHistoryResponse,
  BriefingPrintResponse,
  BriefingReadResult,
  BriefingStatus,
  GenerateSkippedResponse,
  MemberDTO,
} from "../../../shared";

const STATUS_BADGE_CLASS: Record<BriefingStatus, string> = {
  ready: "bg-success/15 text-success",
  partial: "bg-muted text-muted-foreground",
  pending: "bg-muted text-muted-foreground",
  failed: "bg-destructive/10 text-destructive",
  "render-failed": "bg-destructive/10 text-destructive",
};

export interface BriefingWorkspaceProps {
  /** Pill members (children + opted-in adults), already filtered by the page. */
  members: MemberDTO[];
  optIns: Record<string, boolean>;
  /** The Preview / Generate tab is visible — nothing is fetched while hidden (spec D16). */
  active: boolean;
  /** Generate all is running or an opt-in write is pending. */
  blocked: boolean;
  onGenerated: (briefing: Briefing) => void;
  onBusyChange: (busy: boolean) => void;
}

type Notice = { testId: string; text: string };

/** Reference `BriefingHistory` port: member pills, history, regenerate/view/print, payload, image. */
export function BriefingWorkspace({
  members,
  optIns,
  active,
  blocked,
  onGenerated,
  onBusyChange,
}: BriefingWorkspaceProps) {
  const t = useT();
  const printingActive = usePrintingPluginActive();
  const [memberId, setMemberId] = useState("");
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [dateInput, setDateInput] = useState("");
  const [history, setHistory] = useState<BriefingHistoryResponse | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [read, setRead] = useState<BriefingReadResult | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const currentMember = useRef("");
  currentMember.current = memberId;

  useEffect(() => {
    if (members.some((member) => member.id === memberId)) return;
    selectMember(members[0]?.id ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run only when the member list changes
  }, [members]);

  const activeDate = selectedDate ?? history?.today ?? null;

  async function loadHistory(forMember: string) {
    setHistoryError(null);
    try {
      const response = await authFetch(`/api/daily-briefing/history/${forMember}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("history");
      const data = (await response.json()) as BriefingHistoryResponse;
      if (currentMember.current === forMember) setHistory(data);
    } catch {
      if (currentMember.current === forMember) {
        setHistoryError(t("dailyBriefing.admin.historyLoadError"));
      }
    }
  }

  async function loadRead(forMember: string, date: string) {
    setReadError(null);
    try {
      const response = await authFetch(`/api/daily-briefing/${forMember}/${date}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("read");
      const data = (await response.json()) as BriefingReadResult;
      if (currentMember.current === forMember) setRead(data);
    } catch {
      if (currentMember.current === forMember)
        setReadError(t("dailyBriefing.admin.briefingLoadError"));
    }
  }

  useEffect(() => {
    if (active && memberId) void loadHistory(memberId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loaders read live state
  }, [active, memberId]);

  useEffect(() => {
    if (active && memberId && activeDate) void loadRead(memberId, activeDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loaders read live state
  }, [active, memberId, activeDate, version]);

  function selectMember(id: string) {
    setMemberId(id);
    setSelectedDate(null);
    setDateInput("");
    setHistory(null);
    setRead(null);
    setNotice(null);
    setActionError(null);
  }

  function selectDate(date: string) {
    setSelectedDate(date);
    setDateInput(date);
    setRead(null);
    setNotice(null);
  }

  function showTypedDate() {
    const date = dateInput || activeDate;
    if (!date) return;
    selectDate(date);
    setVersion((value) => value + 1);
  }

  const optedIn = Boolean(memberId && optIns[memberId]);
  const generated = read?.generated === true ? read.briefing : null;

  async function generate() {
    if (!optedIn || blocked || generating) return;
    const forMember = memberId;
    setGenerating(true);
    onBusyChange(true);
    setActionError(null);
    setNotice(null);
    try {
      // Spec D10: "today" lets the server resolve the household date.
      const body =
        selectedDate && selectedDate !== history?.today
          ? { memberId: forMember, date: selectedDate }
          : { memberId: forMember };
      const response = await authFetch("/api/daily-briefing/generate", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new LocalizedApiError(
          await responseMessage(response, t("dailyBriefing.management.generateError"))
        );
      }
      const result = (await response.json()) as Briefing | GenerateSkippedResponse;
      if (currentMember.current !== forMember) return;
      if ("skipped" in result) {
        const name = members.find((m) => m.id === result.memberId)?.displayName ?? result.memberId;
        setNotice({
          testId: "daily-briefing-paused-notice",
          text: t("dailyBriefing.admin.pausedNotice")
            .replace("{name}", name)
            .replace("{date}", result.date)
            .replace("{blocks}", t("dailyBriefing.admin.memberBlockSettingsTitle")),
        });
        return;
      }
      if (result.date !== activeDate) selectDate(result.date);
      setVersion((value) => value + 1);
      void loadHistory(forMember);
      onGenerated(result);
    } catch (cause) {
      setActionError(
        cause instanceof LocalizedApiError
          ? cause.message
          : t("dailyBriefing.management.generateError")
      );
    } finally {
      setGenerating(false);
      onBusyChange(false);
    }
  }

  async function print() {
    if (!memberId || !activeDate || printing) return;
    setPrinting(true);
    setActionError(null);
    setNotice(null);
    try {
      const response = await authFetch(`/api/daily-briefing/${memberId}/${activeDate}/print`, {
        method: "POST",
        credentials: "include",
      });
      if (!response.ok) {
        throw new LocalizedApiError(
          await responseMessage(response, t("dailyBriefing.admin.printError"), {
            plugin_inactive: t("dailyBriefing.admin.printUnavailable"),
            printable_raster_missing: t("dailyBriefing.admin.printNoRaster"),
            not_found: t("dailyBriefing.admin.noBriefingForDate").replace("{date}", activeDate),
          })
        );
      }
      const result = (await response.json()) as BriefingPrintResponse;
      setNotice({
        testId: "daily-briefing-print-notice",
        text: t(
          result.enqueued
            ? "dailyBriefing.admin.printQueued"
            : "dailyBriefing.admin.printAlreadyQueued"
        ),
      });
    } catch (cause) {
      setActionError(
        cause instanceof LocalizedApiError ? cause.message : t("dailyBriefing.admin.printError")
      );
    } finally {
      setPrinting(false);
    }
  }

  if (members.length === 0) {
    return (
      <p className="text-muted-foreground text-control">{t("dailyBriefing.admin.noPillMembers")}</p>
    );
  }

  return (
    <div className="flex flex-col gap-6 xl:flex-row" data-testid="daily-briefing-workspace">
      <div className="flex w-full flex-col gap-4 xl:w-64 xl:shrink-0">
        <BriefingMemberPills
          members={members}
          selectedId={memberId}
          onSelect={selectMember}
          testIdPrefix="daily-briefing-preview-member"
          label={t("dailyBriefing.management.selectMember")}
        />
        <label className="sr-only">
          {t("dailyBriefing.management.selectMember")}
          <select
            value={memberId}
            data-testid="daily-briefing-member-select"
            onChange={(event) => selectMember(event.target.value)}
            className={NATIVE_SELECT_CLASSES}
          >
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.displayName}
              </option>
            ))}
          </select>
        </label>

        <section className="flex flex-col gap-2">
          <h4 className="font-semibold">{t("dailyBriefing.admin.historyTitle")}</h4>
          {historyError ? (
            <div className="flex flex-col items-start gap-2">
              <ErrorNotice message={historyError} data-testid="daily-briefing-history-error" />
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="daily-briefing-history-retry"
                onClick={() => void loadHistory(memberId)}
              >
                {t("dailyBriefing.admin.retry")}
              </Button>
            </div>
          ) : history && history.entries.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="daily-briefing-history-empty">
              {t("dailyBriefing.admin.historyEmpty")}
            </p>
          ) : (
            <ul className="flex flex-col gap-1" data-testid="daily-briefing-history-list">
              {history?.entries.map((entry) => (
                <li key={entry.id}>
                  <Button
                    type="button"
                    variant={entry.date === activeDate ? "secondary" : "ghost"}
                    aria-pressed={entry.date === activeDate}
                    data-testid={`daily-briefing-history-entry-${entry.date}`}
                    onClick={() => selectDate(entry.date)}
                    className="w-full justify-between"
                  >
                    <span className="font-mono">{entry.date}</span>
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-xs",
                        STATUS_BADGE_CLASS[entry.status]
                      )}
                    >
                      {t(`dailyBriefing.status.${entry.status}`)}
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="flex flex-wrap items-end gap-2">
          <Label className="flex flex-col items-start gap-1">
            {t("dailyBriefing.admin.previewDateLabel")}
            <Input
              type="date"
              data-testid="daily-briefing-admin-preview-date"
              value={dateInput || activeDate || ""}
              onChange={(event) => setDateInput(event.target.value)}
              className="w-40"
            />
          </Label>
          <Button
            type="button"
            variant="outline"
            data-testid="daily-briefing-admin-preview-show"
            disabled={!memberId || !(dateInput || activeDate)}
            onClick={showTypedDate}
          >
            {t("dailyBriefing.admin.previewShowButton")}
          </Button>
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            data-testid="daily-briefing-generate"
            disabled={!optedIn || blocked || generating}
            onClick={() => void generate()}
          >
            {generating
              ? t("dailyBriefing.management.generating")
              : generated
                ? t("dailyBriefing.admin.regenerate")
                : t("dailyBriefing.management.generate")}
          </Button>
          {generated && activeDate ? (
            <Button asChild variant="outline">
              <a
                data-testid="daily-briefing-view-png"
                href={appUrl(`/api/daily-briefing/${memberId}/${activeDate}/preview.png`)}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("dailyBriefing.admin.viewPng")}
              </a>
            </Button>
          ) : (
            <Button type="button" variant="outline" disabled data-testid="daily-briefing-view-png">
              {t("dailyBriefing.admin.viewPng")}
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            data-testid="daily-briefing-print"
            disabled={!printingActive || !generated || printing}
            onClick={() => void print()}
          >
            {printing ? t("dailyBriefing.admin.printing") : t("dailyBriefing.admin.print")}
          </Button>
        </div>
        {memberId && !optedIn && (
          <p className="text-sm text-muted-foreground" data-testid="daily-briefing-needs-opt-in">
            {t("dailyBriefing.admin.needsOptIn")}
          </p>
        )}
        {!printingActive && (
          <p
            className="text-sm text-muted-foreground"
            data-testid="daily-briefing-print-unavailable"
          >
            {t("dailyBriefing.admin.printUnavailable")}
          </p>
        )}
        {notice && (
          <p role="status" aria-live="polite" data-testid={notice.testId} className="text-control">
            {notice.text}
          </p>
        )}
        <ErrorNotice message={actionError} data-testid="daily-briefing-action-error" />

        <div className="flex min-w-0 flex-col gap-4 xl:flex-row">
          <div className="min-w-0 flex-1">
            {readError ? (
              <div className="flex flex-col items-start gap-2">
                <ErrorNotice message={readError} />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="daily-briefing-read-retry"
                  onClick={() => activeDate && void loadRead(memberId, activeDate)}
                >
                  {t("dailyBriefing.admin.retry")}
                </Button>
              </div>
            ) : generated ? (
              <div className="flex flex-col gap-2">
                <p className="text-sm" data-testid="daily-briefing-status" aria-live="polite">
                  {t("dailyBriefing.management.status")}:{" "}
                  {t(`dailyBriefing.status.${generated.status}`)}
                </p>
                <h4 className="font-semibold">{t("dailyBriefing.admin.payloadTitle")}</h4>
                <pre
                  data-testid="daily-briefing-generated-payload"
                  className="max-h-96 overflow-auto rounded-lg border bg-muted p-4 text-xs whitespace-pre-wrap break-all"
                >
                  {JSON.stringify(generated.payload, null, 2)}
                </pre>
              </div>
            ) : read && activeDate ? (
              <p className="text-sm text-muted-foreground" data-testid="daily-briefing-no-briefing">
                {t("dailyBriefing.admin.noBriefingForDate").replace("{date}", activeDate)}
              </p>
            ) : null}
          </div>
          {active && memberId && activeDate && (
            <BriefingImage
              memberId={memberId}
              date={activeDate}
              version={version}
              status={generated?.status}
            />
          )}
        </div>
      </div>
    </div>
  );
}
```

Notes for the implementer:

- If ESLint reports the `react-hooks/exhaustive-deps` disable comments as unknown rules (the repo may not load that plugin), delete those comment lines; `quality/justified-disable` may also require a justification format — follow what lint says.
- The `selectMember` call inside the first effect runs before `selectMember` is declared in source order; that is fine at runtime (function declarations are hoisted) but if lint flags `no-use-before-define`, move the effect below `selectMember`.
- If `bg-success/15` / `text-success` do not render (check `--color-success` in `src/client/styles/globals.css`), use `bg-accent text-accent-foreground` for `ready`.
- `t(\`dailyBriefing.status.${...}\`)` is the same template-key pattern the page already uses.

- [ ] **Step 8: Run**

Run: `npx vitest run tests/client/daily-briefing-workspace.test.tsx tests/client/weekday-picker.test.tsx tests/client/daily-briefing-i18n-parity.test.ts`
Expected: PASS. Then `npx tsc -p tsconfig.client.json --noEmit` (or `npm run typecheck`) and `npx eslint src/client/daily-briefing/admin src/client/components/WeekdayPicker.tsx`.

- [ ] **Step 9: Commit**

```bash
git add src/client/components/WeekdayPicker.tsx src/client/daily-briefing/admin src/client/i18n/messages.ts tests/client/weekday-picker.test.tsx tests/client/daily-briefing-workspace.test.tsx
git commit -m "feat(admin): add the briefing workspace, image states and member pills"
```

---

## Task 8: Rework `DailyBriefingManagement.tsx`

**Files:**

- Modify: `src/client/admin/DailyBriefingManagement.tsx`
- Test: `tests/client/daily-briefing-management.test.tsx`, `tests/client/daily-briefing-admin.test.tsx`, `tests/client/announcements-briefing-admin.test.tsx` (Daily Briefing cases only), plus any other client test the run turns red (`tests/client/admin-gate-panel-reset.test.tsx`, `tests/client/admin-routes.test.tsx`, `tests/client/daily-briefing-admin-mirror-fence.test.tsx`).

**Interfaces:**

- Consumes: `BriefingWorkspace`, `BriefingMemberPills`, `pillMembers` (Task 7), `PUT /api/daily-briefing/schedule/:memberId` and `memberSchedules` (Task 2).

- [ ] **Step 1: Write the new failing tests** — add to `tests/client/daily-briefing-management.test.tsx` (reuse its `activeMembers`, `jsonResponse`, `renderManagement`; give both fixture members a `colorKey`, e.g. `"blue"` and `"teal"`):

```tsx
it("pauses a weekday for the selected member, disables that column and shows the notice", async () => {
  let scheduleBody: unknown;
  vi.mocked(globalThis.fetch).mockImplementation(async (...args: FetchCall) => {
    const [input, init] = args;
    const url = String(input);
    if (url === "/api/settings")
      return jsonResponse({ locale: { timezone: "UTC", language: "en" } });
    if (url === "/api/members") return jsonResponse(activeMembers);
    if (url === "/api/daily-briefing/opt-in") {
      return jsonResponse([{ memberId: "member-ada", enabled: true }]);
    }
    if (url === "/api/daily-briefing/settings") {
      return jsonResponse({
        generationTime: "06:00",
        autoPrintTrigger: null,
        blockOrder: [],
        memberBlockSettings: [],
        memberSchedules: [
          { memberId: "member-ada", weekdays: ["mon", "tue", "wed", "thu", "fri"] },
        ],
      });
    }
    if (url === "/api/daily-briefing/schedule/member-ada" && init?.method === "PUT") {
      scheduleBody = JSON.parse(String(init.body));
      return jsonResponse({ memberId: "member-ada", ...(scheduleBody as object) });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  renderManagement();

  const sunday = await screen.findByTestId("daily-briefing-schedule-day-sun");
  expect(sunday).not.toBeChecked();
  expect(screen.getByTestId("daily-briefing-admin-block-weekday-weather-sun")).toBeDisabled();
  expect(screen.getByTestId("daily-briefing-admin-block-weekday-weather-mon")).toBeEnabled();

  fireEvent.click(screen.getByTestId("daily-briefing-schedule-day-mon"));
  await waitFor(() => expect(scheduleBody).toEqual({ weekdays: ["tue", "wed", "thu", "fri"] }));
  expect(await screen.findByTestId("daily-briefing-settings-changed")).toBeVisible();
  expect(screen.getByTestId("daily-briefing-admin-block-weekday-weather-mon")).toBeDisabled();
});

it("offers Retry when members fail to load, and when settings fail to load", async () => {
  let membersFail = true;
  let settingsFail = true;
  vi.mocked(globalThis.fetch).mockImplementation(async (...args: FetchCall) => {
    const url = String(args[0]);
    if (url === "/api/settings")
      return jsonResponse({ locale: { timezone: "UTC", language: "en" } });
    if (url === "/api/members") {
      if (membersFail) return new Response("{}", { status: 500 });
      return jsonResponse(activeMembers);
    }
    if (url === "/api/daily-briefing/opt-in") return jsonResponse([]);
    if (url === "/api/daily-briefing/settings") {
      if (settingsFail) return new Response("{}", { status: 500 });
      return jsonResponse({
        generationTime: "06:00",
        autoPrintTrigger: null,
        blockOrder: [],
        memberBlockSettings: [],
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  renderManagement();

  membersFail = false;
  fireEvent.click(await screen.findByTestId("daily-briefing-retry"));
  expect(await screen.findByTestId("daily-briefing-block-member-member-ben")).toBeVisible();

  settingsFail = false;
  fireEvent.click(screen.getByTestId("daily-briefing-settings-retry"));
  expect(await screen.findByTestId("daily-briefing-block-matrix")).toBeVisible();
});

it("titles the page with its sidebar label", async () => {
  vi.mocked(globalThis.fetch).mockImplementation(async (...args: FetchCall) => {
    const url = String(args[0]);
    if (url === "/api/settings")
      return jsonResponse({ locale: { timezone: "UTC", language: "en" } });
    if (url === "/api/members") return jsonResponse(activeMembers);
    if (url === "/api/daily-briefing/opt-in") return jsonResponse([]);
    if (url === "/api/daily-briefing/settings") {
      return jsonResponse({
        generationTime: "06:00",
        autoPrintTrigger: null,
        blockOrder: [],
        memberBlockSettings: [],
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  renderManagement();
  expect(await screen.findByRole("heading", { name: "Briefing", exact: true })).toBeVisible();
});
```

(The weather row's weekday test ids come from `testIdPrefix={\`daily-briefing-admin-block-weekday-${blockType}\`}`; `weather` is always in the effective matrix.)

Run: `npx vitest run tests/client/daily-briefing-management.test.tsx` — Expected: the three new cases FAIL.

- [ ] **Step 2: Implement** in `src/client/admin/DailyBriefingManagement.tsx` (keep everything not listed):
  1. **Imports:** add `BriefingWorkspace` from `@/daily-briefing/admin/BriefingWorkspace`, `BriefingMemberPills, pillMembers` from `@/daily-briefing/admin/BriefingMemberPills`, and the `BriefingSchedule` type from `../../shared`. Remove imports that become unused (`appUrl`, `Input` if no longer used — the generation-time input still uses `Input`; keep what compiles clean).
  2. **Header comment:** replace the "No destructive confirmation…" paragraph's mention of the preview with one line: "The Preview / Generate tab delegates to `daily-briefing/admin/BriefingWorkspace` (admin parity 2026-10-15)."
  3. **Title (spec D9):** in both `AdminPanel` usages and the tablist `aria-label`, use `t("admin.sidebar.briefing")` instead of `t("dailyBriefing.management.title")`.
  4. **State removed:** `selectedMemberId`, `generatedBriefing`, `generating`, `previewMemberId`, `previewDate`, `previewRequest`, `previewError`, the `todayIsoDate` and `PreviewRequest` helpers, `showPreview`, `generate`, `selectMember`. In `setOptIn`, delete the lines that touched those (`generationRequestId.current += 1` stays only if `generateAll` still uses it — it does; keep `setOptIns`, `setMemberStatuses` cleanup).
  5. **State added:**

```ts
const [membersLoadFailed, setMembersLoadFailed] = useState(false);
const [workspaceBusy, setWorkspaceBusy] = useState(false);
const [settingsChanged, setSettingsChanged] = useState(false);
const [memberSchedules, setMemberSchedules] = useState<Record<string, WeekdayCode[]>>({});
const [scheduleSaving, setScheduleSaving] = useState(false);
const [scheduleError, setScheduleError] = useState<string | null>(null);
```

6. **loadMembers:** set `setMembersLoadFailed(false)` at start and `true` in the catch; replace the default selection lines with

```ts
const firstPillMemberId = pillMembers(nextActiveMembers, nextOptIns)[0]?.id ?? "";
setBlockSettingsMemberId((current) => current || firstPillMemberId);
```

7. **loadAdminSettings:** after setting `memberBlockSettings`, add

```ts
setMemberSchedules(
  Object.fromEntries(
    (Array.isArray(data.memberSchedules) ? data.memberSchedules : []).map(
      (schedule: BriefingSchedule) => [schedule.memberId, schedule.weekdays]
    )
  )
);
```

     and add `memberSchedules?: BriefingSchedule[]` to the local `DailyBriefingSettingsView` interface (optional: the client tolerates older/mocked payloads).

8. **Settings-changed notice:** call `setSettingsChanged(true)` after the successful `setBlockOrder(data.blockOrder)` in `saveBlockOrder`, after the successful list update in `saveMemberBlockSettings`, and in `toggleScheduleDay` below. Add `setSettingsChanged(false)` wherever the Blocks member changes (pill `onSelect` and the sr-only select `onChange`). 9. **Schedule toggle:**

```ts
const blockMemberSchedule: readonly Weekday[] =
  memberSchedules[blockSettingsMemberId] ?? CANONICAL_WEEKDAY_ORDER;

async function toggleScheduleDay(day: Weekday) {
  const memberId = blockSettingsMemberId;
  if (!memberId) return;
  const current = new Set(memberSchedules[memberId] ?? CANONICAL_WEEKDAY_ORDER);
  if (current.has(day)) current.delete(day);
  else current.add(day);
  const weekdays = CANONICAL_WEEKDAY_ORDER.filter((d) => current.has(d));
  setScheduleSaving(true);
  setScheduleError(null);
  try {
    const response = await authFetch(`/api/daily-briefing/schedule/${memberId}`, {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ weekdays }),
    });
    if (!response.ok) {
      throw new LocalizedApiError(
        await responseMessage(response, t("dailyBriefing.admin.scheduleSaveError"))
      );
    }
    const saved = (await response.json()) as BriefingSchedule;
    setMemberSchedules((previous) => ({ ...previous, [saved.memberId]: saved.weekdays }));
    setSettingsChanged(true);
  } catch (cause) {
    setScheduleError(
      cause instanceof LocalizedApiError
        ? cause.message
        : t("dailyBriefing.admin.scheduleSaveError")
    );
  } finally {
    setScheduleSaving(false);
  }
}
```

10. **Derived lists:** `const briefingMembers = pillMembers(activeMembers, optIns);` and keep `blockSettingsMemberId` valid with an effect: if it is not in `briefingMembers`, set it to `briefingMembers[0]?.id ?? ""`.
11. **Members load error + Retry:** below `<ErrorNotice message={error} />` render

```tsx
{
  membersLoadFailed && (
    <Button
      type="button"
      variant="outline"
      data-testid="daily-briefing-retry"
      onClick={() => void loadMembers()}
    >
      {t("dailyBriefing.admin.retry")}
    </Button>
  );
}
```

12. **Settings load error + Retry:** in the "settings" card, after its `ErrorNotice`, render when `!settingsLoading && !settingsLoaded`:

```tsx
<Button
  type="button"
  variant="outline"
  data-testid="daily-briefing-settings-retry"
  onClick={() => void loadAdminSettings()}
>
  {t("dailyBriefing.admin.retry")}
</Button>
```

13. **Blocks workspace:** - Replace the `activeMembers.map(... daily-briefing-block-member-...)` button row with

```tsx
<BriefingMemberPills
  members={briefingMembers}
  selectedId={blockSettingsMemberId}
  onSelect={(id) => {
    setBlockSettingsMemberId(id);
    setSettingsChanged(false);
  }}
  testIdPrefix="daily-briefing-block-member"
  label={t("dailyBriefing.admin.memberBlockSelectMember")}
/>
```

       and make the sr-only `daily-briefing-admin-block-settings-member-select` list `briefingMembers` (its `onChange` also clears `settingsChanged`).
     - Right under the pills:

```tsx
{
  settingsChanged && (
    <p
      role="status"
      aria-live="polite"
      data-testid="daily-briefing-settings-changed"
      className="rounded-lg border bg-accent px-4 py-3 text-control text-accent-foreground"
    >
      {t("dailyBriefing.admin.settingsChanged")}
    </p>
  );
}
```

     - In the block-settings card, above the table: `<p className="text-sm text-muted-foreground">{t("dailyBriefing.admin.scheduleCaption")}</p>` and `<ErrorNotice message={scheduleError} data-testid="daily-briefing-schedule-error" />`.
     - In each weekday `<th>` (keep the existing `data-testid` and label), add under the label:

```tsx
<CheckboxField
  data-testid={`daily-briefing-schedule-day-${day}`}
  checked={blockMemberSchedule.includes(day)}
  disabled={scheduleSaving || !settingsLoaded}
  onChange={() => void toggleScheduleDay(day)}
  label={t("dailyBriefing.admin.scheduleDayLabel")}
  aria-label={`${weekdayLabels(t)[day]}: ${t("dailyBriefing.admin.scheduleDayLabel")}`}
  className="justify-center"
/>
```

       and wrap label + checkbox in `<div className="flex flex-col items-center gap-1">`.
     - On each row's `WeekdayPicker` add `disabledDays={CANONICAL_WEEKDAY_ORDER.filter((d) => !blockMemberSchedule.includes(d))}`.

14. **Preview workspace:** keep the opt-in card but remove the per-member pill `Button` from each opt-in row (leave the member name as plain text: `<span className="font-medium">{member.displayName}</span>` before the `CheckboxField`). Replace the whole "generate" card's single-member part (hidden select, Generate button, `generatedBriefing` block) with only the Generate-all button, info line and statuses (keep their test ids; Generate all's `disabled` gains `|| workspaceBusy`). Replace the old `<Card ... data-testid="daily-briefing-admin-preview">` with, inside the preview workspace div after the generate card:

```tsx
<BriefingWorkspace
  members={briefingMembers}
  optIns={optIns}
  active={workspace === "preview"}
  blocked={generatingAll || hasPendingOptInUpdates}
  onBusyChange={setWorkspaceBusy}
  onGenerated={(briefing) => {
    setMemberStatuses((previous) => ({ ...previous, [briefing.memberId]: briefing.status }));
    setSettingsChanged(false);
    setGenerateAllInfo(null);
  }}
/>
```

       The "no opted-in members" message under the generate card stays only around the Generate-all button.

- [ ] **Step 3: Update existing client tests** (run them, fix what the rework legitimately changed — never weaken an assertion about server writes):
  - Every strict fetch mock that clicks the Preview tab must also answer `/api/printing/status` → `{active: true}`, `/api/daily-briefing/history/<id>` → `{today: "2026-10-15", entries: []}`, `/api/daily-briefing/<id>/<date>` → `{generated: false}`, and any `.../preview.png` → `new Response("{}", {status: 404})`. Put this in one helper per file (`workspaceResponse(url): Response | undefined`) called before the `throw`.
  - `tests/client/daily-briefing-admin.test.tsx`: change the fixture member Ada to `role: "child"` (pills now show children + opted-in adults) and add `colorKey: "blue"`. Rewrite "preview shows an <img> whose src targets the endpoint for the selected member/date" as: click the Preview tab, change `daily-briefing-admin-preview-date` to `2026-09-07`, click `daily-briefing-admin-preview-show`, and assert that `fetch` was called with a URL matching `/^\/api\/daily-briefing\/member-ada\/2026-09-07\/preview\.png\?v=/`; then add the `mp-base-path` meta, click Show again and assert a call matching `/^\/family\/planner\/api\/daily-briefing\/member-ada\/2026-09-07\/preview\.png\?v=/`. Stub `URL.createObjectURL`/`revokeObjectURL` in that test. Remove its use of `daily-briefing-admin-preview-member-select` (gone, spec D18).
  - `tests/client/daily-briefing-management.test.tsx`: the "restores the v1-like Blocks and Preview / Generate workspaces" case still expects `daily-briefing-preview-member-*`, `daily-briefing-generate` and `daily-briefing-admin-preview-show` after switching tabs (they now live in the workspace; wait with `findByTestId`). Cases that generated a single member through `daily-briefing-member-select` + `daily-briefing-generate` keep working; if one asserted the old `daily-briefing-status` text right after generating, wait for the read refetch (mock `/api/daily-briefing/<id>/<date>` to return the generated briefing).
  - `tests/client/announcements-briefing-admin.test.tsx`: ONLY the Daily Briefing cases — the region/heading name becomes `"Briefing"`. (Another worker edits the Time Announcements cases of this file; keep your diff to these lines.)
  - Any other test pinning `"Daily Briefing"` as this page's heading: switch to the sidebar label.

- [ ] **Step 4: Run all affected client tests**

Run: `npx vitest run tests/client/daily-briefing-management.test.tsx tests/client/daily-briefing-admin.test.tsx tests/client/announcements-briefing-admin.test.tsx tests/client/daily-briefing-admin-mirror-fence.test.tsx tests/client/admin-gate-panel-reset.test.tsx tests/client/admin-routes.test.tsx tests/client/daily-briefing-workspace.test.tsx tests/client/daily-briefing-i18n-parity.test.ts`
Expected: PASS. Then `npm run typecheck && npm run lint`.

- [ ] **Step 5: Unused keys** — if lint or a test flags now-unused message keys (`dailyBriefing.admin.previewSelectMember`, `dailyBriefing.admin.previewSelectMemberPlaceholder`, `dailyBriefing.admin.previewError`, `dailyBriefing.admin.previewTitle`, `dailyBriefing.management.generateTitle`, `dailyBriefing.management.selectMemberPlaceholder`), delete them from BOTH locales; otherwise leave them (smaller diff in a shared file).

- [ ] **Step 6: Commit**

```bash
git add src/client/admin/DailyBriefingManagement.tsx tests/client
git commit -m "feat(admin): daily briefing page parity (pause days, workspace, notice, retry)"
```

---

## Task 9: UI contract doc

**Files:** Modify `docs/ui/household-contract.md` (line 64).

- [ ] **Step 1:** Replace line 64 `7. \`/admin/daily-briefing\` — briefing configuration/generation/preview` with:

```markdown
7. `/admin/daily-briefing` — Briefing: Blocks tab (member pills, per-weekday pause switches over the block matrix, block order, generation time and auto-print binding, "settings changed" notice) and Preview / Generate tab (opt-in, Generate all, member pills, 30-day history, regenerate, view PNG, print to the queue, payload, image states); tabs are local state, no sub-paths
```

- [ ] **Step 2: Commit** — `git add docs/ui/household-contract.md && git commit -m "docs(ui): describe the daily briefing admin page"`

---

## Task 10: E2E

**Files:** Modify `tests/e2e/daily-briefing.spec.ts`.

- [ ] **Step 1: Heading** — lines ≈ 368 and ≈ 810: replace `m["dailyBriefing.management.title"]` with `m["admin.sidebar.briefing"]`.

- [ ] **Step 2: History + pause round trip** — in the first admin test ("admin opt-in -> Generate -> complete ordered catalogue and raster preview"), after the final `expect.poll(...naturalWidth...)` block, append:

```ts
// History lists the briefing just generated for the selected member.
await expect(
  management.getByTestId(`daily-briefing-history-entry-${householdToday}`)
).toBeVisible();

// Pause today's weekday for secondMember: a regenerate is skipped, then resume.
const todayCode = weekdayCode(householdToday);
async function toggleToday(): Promise<void> {
  await management.getByTestId("daily-briefing-tab-blocks").click();
  await management.getByTestId(`daily-briefing-block-member-${secondMember.id}`).click();
  const scheduleResponse = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/daily-briefing/schedule/${secondMember.id}`) &&
      response.request().method() === "PUT"
  );
  await management.getByTestId(`daily-briefing-schedule-day-${todayCode}`).click();
  expect((await scheduleResponse).status()).toBe(200);
}
await toggleToday();
await expect(management.getByTestId("daily-briefing-settings-changed")).toBeVisible();
await management.getByTestId("daily-briefing-tab-preview").click();
await management.getByTestId(`daily-briefing-preview-member-${secondMember.id}`).click();
const skippedResponse = page.waitForResponse(
  (response) =>
    response.url().includes("/api/daily-briefing/generate") &&
    response.request().method() === "POST"
);
await management.getByTestId("daily-briefing-generate").click();
expect(await (await skippedResponse).json()).toMatchObject({ skipped: true, reason: "paused" });
await expect(management.getByTestId("daily-briefing-paused-notice")).toBeVisible();
await toggleToday(); // resume, so later specs sharing the data dir are unaffected
```

(`weekdayCode` is defined near the top of the spec; `householdToday`, `secondMember`, `management`, `page`, `m` are already in scope.)

- [ ] **Step 3:** Do not run e2e yet; Task 11 runs it after the build.

- [ ] **Step 4: Commit** — `git add tests/e2e/daily-briefing.spec.ts && git commit -m "test(e2e): cover briefing history and the weekday pause"`

---

## Task 11: Cohort fixture, coverage floors, verification gate

**Files:** `tests/fixtures/assembly-cohort.json` (and any baseline the gate names).

- [ ] **Step 1: Routes** — in `pluginRoutes` (sorted by method, then path, like its neighbours) add:

```json
    { "method": "GET", "path": "/api/daily-briefing/history/{memberId}" },
    { "method": "POST", "path": "/api/daily-briefing/{memberId}/{date}/print" },
    { "method": "PUT", "path": "/api/daily-briefing/schedule/{memberId}" }
```

(use the file's existing multi-line formatting; GET entries sit after `/api/daily-briefing/settings` GET, the POST after `/api/daily-briefing/generate-all`, the PUT after `/api/daily-briefing/opt-in/{memberId}` PUT — keep the order the tool expects; `npm run check:openapi` tells you if it is wrong).

- [ ] **Step 2: Test cases** — produce the observed lists:

```bash
npm run test:cohorts:stamp            # prints the candidate id; export MP_CANDIDATE_ID=<that id>
npm run test:cohorts:vitest:list
npm run test:cohorts:vitest
```

Update `testCohorts.runners.vitest.files` from `.quality/vitest-list.json` for exactly the test files you created or changed: `tests/boundary/daily-briefing-admin-parity.test.ts` (new), `tests/client/daily-briefing-workspace.test.tsx` (new), `tests/integration/daily-briefing-trigger.test.ts`, `tests/client/weekday-picker.test.tsx`, `tests/client/daily-briefing-management.test.tsx`, `tests/client/daily-briefing-admin.test.tsx`, `tests/client/announcements-briefing-admin.test.tsx` (only if a case name changed). Then run
`node tools/verify-test-cohorts.mjs --expected tests/fixtures/assembly-cohort.json --raw-dir .quality --candidate "$MP_CANDIDATE_ID" --runners node,vitest` and fix every reported difference. Playwright case names did not change (the e2e additions live inside an existing test).

- [ ] **Step 3: Coverage floors** — `npm run check:coverage` reports per-file failures. Add entries under `coveragePolicy.files` for the new sources (`src/server/modules/daily-briefing/schedule.ts` layer `server`; `src/client/daily-briefing/admin/BriefingImage.tsx`, `BriefingMemberPills.tsx`, `BriefingWorkspace.tsx` layer `client`) with `minimumTotals` = observed totals and `minimumRates` = observed rates. For changed files (`index.ts`, `job.ts`, `trigger.ts` — trigger requires 100%, `settings.ts`, `routes/daily-briefing.ts`, `errors.ts`, `DailyBriefingManagement.tsx`, `WeekdayPicker.tsx`), set totals to the observed counts; keep rates ≥ the previous rates — if a rate falls, add the missing test rather than lowering the floor. Touch only these entries.

- [ ] **Step 4: Commit everything, then run the standard gate from the clean tree**

```bash
git add tests/fixtures/assembly-cohort.json
git commit -m "chore: resync assembly cohort for the daily briefing admin parity"
git status --short   # must be empty
npm run check:standard
```

Expected: PASS. Common fixes: `npx prettier --write <touched files>` for `format:check`; `check:accessible-names` (every icon-less button already has text; the pause checkboxes carry `aria-label`); `check:ui-debt` must not rise (no inline styles, no raw palette classes — fix the code, never edit the baselines); `check:openapi` (route ↔ contract ↔ cohort). Amend or add commits for fixes and re-run until green from a clean tree.

- [ ] **Step 5: Affected e2e on the assigned port** (the build from `check:standard` is fresh):

```bash
PORT=43202 npx playwright test tests/e2e/daily-briefing.spec.ts tests/e2e/admin-unlock-resilience.spec.ts tests/e2e/accessible-names-audit.spec.ts tests/e2e/plugin-lifecycle-visual.spec.ts tests/e2e/printing.spec.ts --workers=3
```

Expected: all PASS. If `plugin-lifecycle-visual.spec.ts` compares screenshots of this page, update its baseline only if the change is the intended new layout, and say so in the report.

---

## Task 12: Commit on the worktree branch and report

- [ ] Make sure the spec and plan (Task 0 copies) are committed on the branch: `git add docs/superpowers/specs/2026-10-15-admin-briefing-design.md docs/superpowers/plans/2026-10-15-admin-briefing.md && git commit -m "docs: add the daily briefing admin parity spec and plan"` (skip if already committed).
- [ ] `git log --oneline main..HEAD` and `git status --short` (must be clean).
- [ ] Fallback if git is refused in your worktree: leave all changes in place uncommitted, list every file you created or modified with absolute paths (new files separately, since they are untracked), and say that `check:standard` could not run from a committed tree if that was the case; the orchestrator collects the work by patch.
- [ ] Report: branch name and HEAD SHA; the exact gate commands and their results (`npm run check:standard`, the `PORT=43202` Playwright run with pass counts); coverage floors and cohort entries you changed; any deviation from the spec/plan (with the reason); and a note for the Printer page worker: manual briefing prints use record key `daily-briefing:<memberId>:manual:<date>`.
