# Admin Reminders and Messages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the Reminders admin page to the reference's list plus "Add rule" dialog layout, let `PATCH /api/reminders/:id` change `targetingMode`, and add Retry to the Messages admin page.

**Architecture:** Server: `editReminder` accepts `targetingMode` and `assignments`, validates everything first, then writes the rule row and assignments in one transaction (assignment validation and writing are split out of `replaceAssignments`). Client: `RemindersManagement.tsx` becomes a page (list, add/edit `Dialog`, one `ConfirmDialog`) with silent refreshes; `DailyMessagesManagement.tsx` gains a Retry path.

**Tech Stack:** TypeScript, Fastify + better-sqlite3 (server), React + Radix Dialog + Tailwind tokens (client), vitest (+ Testing Library), Playwright, OpenAPI YAML.

**Spec:** `docs/superpowers/specs/2026-10-15-admin-reminders-messages-design.md` (read it first; this plan implements it).

## Global Constraints

- Work only on a worktree branch. The spec and this plan live UNTRACKED in the main checkout `<maintainer-workspace>/docs/superpowers/{specs,plans}/`; Task 0 copies them into the branch.
- Do not add a new shared primitive (no Sheet). Use `Dialog`, `Button`, `Input`, `ConfirmDialog`, `ErrorNotice`, `AdminPanel`, `RadioField`, `CheckboxField`, `WeekdayPicker`, `NATIVE_SELECT_CLASSES` as they exist.
- All user-facing strings go through `src/client/i18n/messages.ts`, en and es. NEW keys: one contiguous block per locale headed by the comment `// admin-reminders-messages`, appended at the very end of the `en` object and of the `es` object (right before each closing `},`). Parallel workers edit this file; keep edits to that block plus the two title values.
- Shared files other workers touch (keep edits minimal and localized): `src/client/i18n/messages.ts`, `src/client/admin/AdminRoutes.tsx` (do not touch), `src/shared/index.ts`, `tests/fixtures/assembly-cohort.json`, `docs/ui/household-contract.md`.
- Technical output (code, comments, commit messages, docs) is in English.
- Do NOT use the real reference DB. `<marplanner-v1>` is read-only.
- Verification gate (Task 9): `npm run check:standard` passes from a clean committed tree, and the affected e2e specs pass with `PORT=43204 npx playwright test <specs> --workers=3`.
- Kiosk density: every control must stay token-sized (use `Button`/`Input`, never raw controls); icon-only buttons need an `aria-label` (`check:accessible-names`).

## Review Focus

1. A rejected PATCH (bad assignment member, missing `weekdays`, bad mode) persists nothing: rule row and assignment rows are unchanged (Task 2 tests).
2. Switching All to Specific to All to Specific keeps one row per member and reactivates it (no duplicate-key crash on `reminders_assignments_unique_reminder_member`) (Task 2 test).
3. A specific rule whose assigned member was archived can still be re-saved through the dialog payload (existing assignment is kept, archived member not re-validated) (Task 2 test).
4. A silent refresh after toggle/save/delete must not unmount an open dry-run panel or dialog (Task 5 test).
5. A failed first load shows Retry, and Retry recovers (Tasks 5 and 6 tests).

---

## File Structure

- Modify `src/server/modules/reminders/index.ts`: `planAssignmentSet` (new, internal), `replaceAssignments` (refactor, same behaviour), `editReminder` (accept `targetingMode`, `assignments`).
- Modify `src/shared/index.ts`: `ReminderEditInput` gains `targetingMode?`, `assignments?`.
- Modify `tests/boundary/reminders-crud.test.ts`: replace the immutable-targetingMode test, rename the assignments test, add switching tests.
- Modify `docs/api/reminders/openapi.yaml`, `docs/api/calendar-reminders/openapi.yaml`, `docs/features/reminders.md`.
- Modify `src/client/i18n/messages.ts`; modify `tests/client/reminders-i18n-parity.test.ts`, `tests/client/daily-messages-i18n-parity.test.ts`, `tests/client/day-periods-messages-admin.test.tsx`.
- Rewrite the page part of `src/client/admin/RemindersManagement.tsx`; rewrite the affected parts of `tests/client/reminders.test.tsx`.
- Modify `src/client/admin/DailyMessagesManagement.tsx`, `tests/client/daily-messages-management.test.tsx`.
- Modify e2e: `tests/e2e/reminders.spec.ts`, `tests/e2e/reminders-calendar-gated.spec.ts`, `tests/e2e/admin-household-timezone-defaults.spec.ts`, `tests/e2e/admin-unlock-resilience.spec.ts`.
- Modify `docs/ui/household-contract.md`; resync `tests/fixtures/assembly-cohort.json`.

---

### Task 0: Worktree setup and baseline

**Files:** copy the spec and plan into the branch.

- [ ] **Step 1: Create the branch worktree** (use the `superpowers:using-git-worktrees` skill or `git worktree add ../marplanner-project-reminders -b feat/admin-reminders-messages`), `cd` into it, run `npm ci` if `node_modules` is absent.
- [ ] **Step 2: Copy the untracked docs into the branch**

```bash
mkdir -p docs/superpowers/specs docs/superpowers/plans
cp <maintainer-workspace>/docs/superpowers/specs/2026-10-15-admin-reminders-messages-design.md docs/superpowers/specs/
cp <maintainer-workspace>/docs/superpowers/plans/2026-10-15-admin-reminders-messages.md docs/superpowers/plans/
```

- [ ] **Step 3: Baseline.** Run `npx vitest run tests/boundary/reminders-crud.test.ts tests/client/reminders.test.tsx tests/client/daily-messages-management.test.tsx`. Expected: all PASS.
- [ ] **Step 4: Commit** `git add docs/superpowers && git commit -m "docs: add the reminders and messages admin spec and plan"`.

---

### Task 1: Server tests for editing targetingMode (RED)

**Files:** Modify `tests/boundary/reminders-crud.test.ts`.

**Interfaces:** consumes the existing helpers in that file: `seedKeys()`, `seedMember(role?)`, `createApplyToAllReminder(app, deviceKey, overrides?)`, `useIsolatedDb()`. Produces nothing used later except the behaviour Task 2 implements.

- [ ] **Step 1: Add imports/helpers.** The file already imports `getDb`. After the existing `createApplyToAllReminder` helper (line ~55) add:

```ts
  async function withApp(
    run: (app: import("fastify").FastifyInstance, deviceKey: string) => Promise<void>
  ) {
    const { deviceKey } = seedKeys();
    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      await run(app, deviceKey);
    } finally {
      await app.close();
    }
  }

  async function patchReminder(
    app: import("fastify").FastifyInstance,
    deviceKey: string,
    id: string,
    payload: unknown
  ) {
    return app.inject({
      method: "PATCH",
      url: `/api/reminders/${id}`,
      cookies: { mp_device_key: deviceKey },
      payload: payload as Record<string, unknown>,
    });
  }

  async function readReminder(
    app: import("fastify").FastifyInstance,
    deviceKey: string,
    id: string
  ) {
    const res = await app.inject({
      method: "GET",
      url: `/api/reminders/${id}`,
      cookies: { mp_device_key: deviceKey },
    });
    return JSON.parse(res.body);
  }

  async function createSpecificReminder(
    app: import("fastify").FastifyInstance,
    deviceKey: string,
    memberId: string
  ) {
    const res = await app.inject({
      method: "POST",
      url: "/api/reminders",
      cookies: { mp_device_key: deviceKey },
      payload: {
        kind: "scheduled",
        targetingMode: "specific",
        text: "coges el bus",
        assignments: [{ memberId, weekdays: ["mon"] }],
      },
    });
    expect(res.statusCode).toBe(201);
    return JSON.parse(res.body);
  }

  async function createCalendarGated(
    app: import("fastify").FastifyInstance,
    deviceKey: string,
    overrides: Record<string, unknown> = {}
  ) {
    const res = await app.inject({
      method: "POST",
      url: "/api/reminders",
      cookies: { mp_device_key: deviceKey },
      payload: {
        kind: "calendar_gated",
        targetingMode: "apply_to_all",
        text: "trae las espinilleras",
        query: "futbol",
        ...overrides,
      },
    });
    expect(res.statusCode).toBe(201);
    return JSON.parse(res.body);
  }

  function assignmentRows(reminderId: string) {
    return getDb()
      .prepare(
        "SELECT member_id AS memberId, active FROM reminder_assignment WHERE reminder_id = ? ORDER BY member_id"
      )
      .all(reminderId) as Array<{ memberId: string; active: number }>;
  }
```

- [ ] **Step 2: Replace the immutable-targetingMode test.** Delete the test at line 219 (`PATCH ... with targetingMode in body → 400 (immutable, FR-013)`) and, in its place, add:

```ts
  it("PATCH /api/reminders/:id with an invalid targetingMode value → 400, nothing persisted", async () => {
    await withApp(async (app, deviceKey) => {
      const created = JSON.parse((await createApplyToAllReminder(app, deviceKey)).body);
      const res = await patchReminder(app, deviceKey, created.id, { targetingMode: "by_role" });
      expect(res.statusCode).toBe(400);
      expect(await readReminder(app, deviceKey, created.id)).toEqual(created);
    });
  });
```

Rename the test at line 275 to `PATCH /api/reminders/:id with assignments on an apply_to_all rule that stays apply_to_all → 400, nothing persisted` (body unchanged).

- [ ] **Step 3: Add the switching tests** inside the same `describe`, before its closing `});`:

```ts
  // ── PATCH targetingMode switching (spec: Admin Reminders and Messages) ──────

  it("PATCH apply_to_all → specific with assignments → 200, weekdays cleared, emits only for the assigned member", async () => {
    await withApp(async (app, deviceKey) => {
      const memberA = seedMember();
      const memberB = seedMember();
      const created = JSON.parse((await createApplyToAllReminder(app, deviceKey)).body);

      const res = await patchReminder(app, deviceKey, created.id, {
        text: "coges el bus",
        targetingMode: "specific",
        assignments: [{ memberId: memberA, weekdays: ["mon"] }],
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.targetingMode).toBe("specific");
      expect(body.weekdays).toBeNull();
      expect(body.text).toBe("coges el bus");
      expect(body.assignments).toHaveLength(1);
      expect(body.assignments[0]).toMatchObject({ memberId: memberA, weekdays: ["mon"] });

      // 2026-01-05 is a Monday.
      const emits = async (memberId: string) => {
        const e = await app.inject({
          method: "GET",
          url: `/api/reminders/emissions?memberId=${memberId}&date=2026-01-05`,
          cookies: { mp_device_key: deviceKey },
        });
        return (JSON.parse(e.body) as Array<{ id: string }>).map((x) => x.id);
      };
      expect(await emits(memberA)).toContain(created.id);
      expect(await emits(memberB)).not.toContain(created.id);
    });
  });

  it("PATCH apply_to_all → specific without assignments → 400, nothing persisted", async () => {
    await withApp(async (app, deviceKey) => {
      const created = JSON.parse((await createApplyToAllReminder(app, deviceKey)).body);
      const res = await patchReminder(app, deviceKey, created.id, { targetingMode: "specific" });
      expect(res.statusCode).toBe(400);
      expect(await readReminder(app, deviceKey, created.id)).toEqual(created);
    });
  });

  it("PATCH apply_to_all → specific that also sends rule-level weekdays → 400, nothing persisted", async () => {
    await withApp(async (app, deviceKey) => {
      const memberA = seedMember();
      const created = JSON.parse((await createApplyToAllReminder(app, deviceKey)).body);
      const res = await patchReminder(app, deviceKey, created.id, {
        targetingMode: "specific",
        weekdays: ["mon"],
        assignments: [{ memberId: memberA, weekdays: ["mon"] }],
      });
      expect(res.statusCode).toBe(400);
      expect(await readReminder(app, deviceKey, created.id)).toEqual(created);
    });
  });

  it("PATCH apply_to_all → specific with an unknown member → 400 and the rule is left apply_to_all (atomic)", async () => {
    await withApp(async (app, deviceKey) => {
      const created = JSON.parse((await createApplyToAllReminder(app, deviceKey)).body);
      const res = await patchReminder(app, deviceKey, created.id, {
        text: "changed text",
        targetingMode: "specific",
        assignments: [{ memberId: "no-such-member", weekdays: ["mon"] }],
      });
      expect(res.statusCode).toBe(400);
      expect(await readReminder(app, deviceKey, created.id)).toEqual(created);
      expect(assignmentRows(created.id)).toEqual([]);
    });
  });

  it("PATCH specific → apply_to_all with weekdays → 200, assignments deactivated not deleted", async () => {
    await withApp(async (app, deviceKey) => {
      const memberA = seedMember();
      const created = await createSpecificReminder(app, deviceKey, memberA);
      const res = await patchReminder(app, deviceKey, created.id, {
        targetingMode: "apply_to_all",
        weekdays: ["tue", "thu"],
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.targetingMode).toBe("apply_to_all");
      expect(body.weekdays).toEqual(["tue", "thu"]);
      expect(body.assignments).toEqual([]);
      expect(assignmentRows(created.id)).toEqual([{ memberId: memberA, active: 0 }]);
    });
  });

  it("PATCH specific → apply_to_all without weekdays → 400, nothing persisted", async () => {
    await withApp(async (app, deviceKey) => {
      const memberA = seedMember();
      const created = await createSpecificReminder(app, deviceKey, memberA);
      const res = await patchReminder(app, deviceKey, created.id, {
        targetingMode: "apply_to_all",
      });
      expect(res.statusCode).toBe(400);
      expect(await readReminder(app, deviceKey, created.id)).toEqual(created);
    });
  });

  it("switching specific → apply_to_all → specific reuses and reactivates the member's row", async () => {
    await withApp(async (app, deviceKey) => {
      const memberA = seedMember();
      const created = await createSpecificReminder(app, deviceKey, memberA);
      expect(
        (
          await patchReminder(app, deviceKey, created.id, {
            targetingMode: "apply_to_all",
            weekdays: ["mon"],
          })
        ).statusCode
      ).toBe(200);
      const back = await patchReminder(app, deviceKey, created.id, {
        targetingMode: "specific",
        assignments: [{ memberId: memberA, weekdays: ["fri"] }],
      });
      expect(back.statusCode).toBe(200);
      const body = JSON.parse(back.body);
      expect(body.weekdays).toBeNull();
      expect(body.assignments).toHaveLength(1);
      expect(body.assignments[0]).toMatchObject({ memberId: memberA, weekdays: ["fri"] });
      expect(assignmentRows(created.id)).toEqual([{ memberId: memberA, active: 1 }]);
    });
  });

  it("PATCH on a specific rule with assignments replaces the set and edits text in one request", async () => {
    await withApp(async (app, deviceKey) => {
      const memberA = seedMember();
      const memberB = seedMember();
      const created = await createSpecificReminder(app, deviceKey, memberA);
      const res = await patchReminder(app, deviceKey, created.id, {
        text: "nuevo texto",
        targetingMode: "specific",
        assignments: [{ memberId: memberB, weekdays: ["wed"] }],
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.text).toBe("nuevo texto");
      expect(body.assignments).toHaveLength(1);
      expect(body.assignments[0]).toMatchObject({ memberId: memberB, weekdays: ["wed"] });
      expect(assignmentRows(created.id)).toEqual(
        [
          { memberId: memberA, active: 0 },
          { memberId: memberB, active: 1 },
        ].sort((a, b) => a.memberId.localeCompare(b.memberId))
      );
    });
  });

  it("PATCH re-saving a specific rule keeps an assigned member who has since been archived", async () => {
    await withApp(async (app, deviceKey) => {
      const memberA = seedMember();
      const created = await createSpecificReminder(app, deviceKey, memberA);
      getDb().prepare("UPDATE members SET lifecycle = 'archived' WHERE id = ?").run(memberA);
      const res = await patchReminder(app, deviceKey, created.id, {
        text: "sigue igual",
        targetingMode: "specific",
        assignments: [{ memberId: memberA, weekdays: ["mon", "tue"] }],
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).assignments[0]).toMatchObject({
        memberId: memberA,
        weekdays: ["mon", "tue"],
      });
    });
  });

  it("PATCH calendar_gated apply_to_all → specific with membership assignments → 200", async () => {
    await withApp(async (app, deviceKey) => {
      const memberA = seedMember();
      const created = await createCalendarGated(app, deviceKey);
      const res = await patchReminder(app, deviceKey, created.id, {
        targetingMode: "specific",
        assignments: [{ memberId: memberA, weekdays: [] }],
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.targetingMode).toBe("specific");
      expect(body.weekdays).toBeNull();
      expect(body.query).toBe("futbol");
      expect(body.assignments).toHaveLength(1);
      expect(body.assignments[0].memberId).toBe(memberA);
    });
  });

  it("PATCH calendar_gated → specific with per-assignment weekdays → 400, nothing persisted", async () => {
    await withApp(async (app, deviceKey) => {
      const memberA = seedMember();
      const created = await createCalendarGated(app, deviceKey);
      const res = await patchReminder(app, deviceKey, created.id, {
        targetingMode: "specific",
        assignments: [{ memberId: memberA, weekdays: ["mon"] }],
      });
      expect(res.statusCode).toBe(400);
      expect(await readReminder(app, deviceKey, created.id)).toEqual(created);
    });
  });

  it("PATCH calendar_gated specific → apply_to_all needs no extra fields and deactivates the memberships", async () => {
    await withApp(async (app, deviceKey) => {
      const memberA = seedMember();
      const created = await createCalendarGated(app, deviceKey, {
        targetingMode: "specific",
        assignments: [{ memberId: memberA }],
      });
      const res = await patchReminder(app, deviceKey, created.id, {
        targetingMode: "apply_to_all",
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.targetingMode).toBe("apply_to_all");
      expect(body.assignments).toEqual([]);
      expect(assignmentRows(created.id)).toEqual([{ memberId: memberA, active: 0 }]);
    });
  });
```

- [ ] **Step 4: Run RED.** `npx vitest run tests/boundary/reminders-crud.test.ts`. Expected: the new switching tests and the invalid-targetingMode test FAIL (today any `targetingMode` key is a 400 or assignments are unsupported); previously-passing tests still PASS. If any new test passes already, stop and read why before continuing.
- [ ] **Step 5: Commit** `git add tests/boundary/reminders-crud.test.ts && git commit -m "test(reminders): pin editing targetingMode through PATCH"`.

---

### Task 2: Server implementation (GREEN)

**Files:** Modify `src/server/modules/reminders/index.ts`, `src/shared/index.ts`.

**Interfaces:**
- Produces `planAssignmentSet(reminderId: string, kind: string, assignments: unknown): { write: (now: number) => void }` (module-internal; throws `ReminderValidationError`, writes nothing until `write` is called inside a transaction).
- `editReminder(id: string, patch: unknown): Reminder` signature unchanged. `replaceAssignments(reminderId: string, input: unknown): ReminderAssignment[]` signature and behaviour unchanged.
- `ReminderEditInput` (shared) gains `targetingMode?: TargetingMode; assignments?: ReminderAssignmentInput[];`.

- [ ] **Step 1: Shared type.** In `src/shared/index.ts`, extend `ReminderEditInput` (line ~440) and its doc comment:

```ts
/** ReminderEditInput — edit payload. Scheduled fields (text/active/weekdays) coexist
 * with calendar_gated query/queryFields edits; omitting queryFields on PATCH preserves the
 * stored value. `targetingMode` may switch apply_to_all <-> specific: switching to specific
 * requires `assignments`, switching a scheduled rule to apply_to_all requires `weekdays`.
 * `assignments` (full-set replace) is accepted only when the resulting mode is specific.
 * `kind` is immutable and is not part of this payload.
 */
export interface ReminderEditInput {
  text?: string;
  weekdays?: Weekday[];
  query?: string;
  queryFields?: ReminderQueryField[];
  active?: boolean;
  targetingMode?: TargetingMode;
  assignments?: ReminderAssignmentInput[];
}
```

- [ ] **Step 2: Extract `planAssignmentSet`.** In `src/server/modules/reminders/index.ts`, directly above `replaceAssignments` (line ~715) add:

```ts
/** Validate a desired full assignment set for a rule and return the writer that applies it.
 * Validation (and every read it needs) happens here and throws `ReminderValidationError`; the
 * returned `write(now)` only performs the upserts/deactivations and MUST be called inside a
 * `db.transaction` so the caller can combine it with other writes atomically. Kind-aware:
 * calendar_gated validates the membership-only shape, scheduled the weekday-bearing one.
 * Active-member status is required only for members not already holding an ACTIVE row here.
 */
function planAssignmentSet(
  reminderId: string,
  kind: string,
  assignments: unknown
): { write: (now: number) => void } {
  const db = getDb();
  const existingRows = db
    .prepare("SELECT id, member_id, active FROM reminder_assignment WHERE reminder_id = ?")
    .all(reminderId) as Array<{ id: string; member_id: string; active: number }>;
  const existingActiveMemberIds = new Set(
    existingRows.filter((row) => row.active === 1).map((row) => row.member_id)
  );

  const parsedAssignments: { memberId: string; weekdays: Weekday[] }[] =
    kind === "calendar_gated"
      ? validateCalendarGatedAssignmentSetForReplace(assignments, existingActiveMemberIds).map(
          ({ memberId }) => ({ memberId, weekdays: [] as Weekday[] })
        )
      : validateAssignmentSetForReplace(assignments, existingActiveMemberIds);

  const desiredMemberIds = new Set(parsedAssignments.map((a) => a.memberId));

  return {
    write(now: number) {
      const existingByMember = new Map(existingRows.map((row) => [row.member_id, row]));

      for (const { memberId, weekdays } of parsedAssignments) {
        const existing = existingByMember.get(memberId);
        if (existing) {
          db.prepare(
            "UPDATE reminder_assignment SET weekdays = ?, active = 1, updated_at = ? WHERE id = ?"
          ).run(JSON.stringify(weekdays), now, existing.id);
        } else {
          db.prepare(
            "INSERT INTO reminder_assignment (id, reminder_id, member_id, weekdays, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)"
          ).run(randomUUID(), reminderId, memberId, JSON.stringify(weekdays), now, now);
        }
      }

      for (const row of existingRows) {
        if (row.active === 1 && !desiredMemberIds.has(row.member_id)) {
          db.prepare("UPDATE reminder_assignment SET active = 0, updated_at = ? WHERE id = ?").run(
            now,
            row.id
          );
        }
      }
    },
  };
}
```

- [ ] **Step 3: Shrink `replaceAssignments`.** Keep its doc comment, the reminder lookup, the `targeting_mode !== "specific"` check, the body-object check and the unknown-key check. Replace everything from `const { assignments } = input as ...` to the end of the function with:

```ts
  const { assignments } = input as { assignments?: unknown };

  const plan = planAssignmentSet(reminderId, reminderRow.kind, assignments);
  db.transaction(() => plan.write(Date.now()))();

  return listActiveAssignments(reminderId);
```

- [ ] **Step 4: Rewrite `editReminder`.** Replace `EDITABLE_REMINDER_KEYS`, the doc comment and the function (lines 552-678) with:

```ts
const EDITABLE_REMINDER_KEYS = new Set([
  "text",
  "weekdays",
  "active",
  "query",
  "queryFields",
  "targetingMode",
  "assignments",
]);

/** Edit a reminder's text / active / weekdays / query+queryFields / targetingMode / assignments.
 * `kind` is immutable after creation (FR-013) — its presence in the patch, even unchanged, is
 * rejected 400. `targetingMode` may switch `apply_to_all` <-> `specific` (FR-019): switching to
 * `specific` requires `assignments`; switching a `scheduled` rule to `apply_to_all` requires
 * `weekdays`; a `calendar_gated` rule switching to `apply_to_all` needs nothing extra. Switching
 * to `apply_to_all` deactivates (never deletes) the rule's active assignments. `assignments` is
 * a full-set replace and is accepted only when the RESULTING mode is `specific`; `weekdays` only
 * when the resulting mode is `apply_to_all` on a `scheduled` rule. Everything is validated before
 * any write, and the rule row plus the assignment writes commit in ONE transaction (FR-008,
 * FR-015). Mirrors `ReminderEditInput`'s `additionalProperties: false`: any other key, an empty
 * object, or a non-object/array body is 400. `query`/`queryFields` are rejected 400 on a
 * `scheduled` row; omitting `queryFields` while editing `query` PRESERVES the stored value.
 */
export function editReminder(id: string, patch: unknown): Reminder {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new ReminderValidationError("Patch body must be a JSON object");
  }

  if ("kind" in patch) {
    throw new ReminderValidationError("kind is immutable after creation (FR-013)");
  }

  const patchKeys = Object.keys(patch);
  const unknownKeys = patchKeys.filter((key) => !EDITABLE_REMINDER_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new ReminderValidationError(
      `Unsupported field(s) in patch body: ${unknownKeys.join(", ")}`
    );
  }
  if (patchKeys.length === 0) {
    throw new ReminderValidationError(
      "Patch body must include at least one of: text, weekdays, active, query, queryFields, targetingMode, assignments"
    );
  }

  const db = getDb();
  const row = db
    .prepare(
      "SELECT id, kind, targeting_mode, text, weekdays, query, query_fields, active FROM reminder WHERE id = ?"
    )
    .get(id) as ReminderRow | undefined;

  if (!row) {
    throw new ReminderNotFoundError(id);
  }

  const { text, weekdays, active, query, queryFields, targetingMode, assignments } = patch as {
    text?: unknown;
    weekdays?: unknown;
    active?: unknown;
    query?: unknown;
    queryFields?: unknown;
    targetingMode?: unknown;
    assignments?: unknown;
  };

  if (
    targetingMode !== undefined &&
    targetingMode !== "apply_to_all" &&
    targetingMode !== "specific"
  ) {
    throw new ReminderValidationError('targetingMode must be "apply_to_all" or "specific"');
  }
  const nextMode = (targetingMode ?? row.targeting_mode) as "apply_to_all" | "specific";
  const switching = nextMode !== row.targeting_mode;

  if (weekdays !== undefined && row.kind === "calendar_gated") {
    throw new ReminderValidationError(
      "weekdays cannot be edited on a calendar_gated rule (membership-only targeting, INV-01/INV-09)"
    );
  }

  if (weekdays !== undefined && nextMode !== "apply_to_all") {
    throw new ReminderValidationError(
      "weekdays can only be set on an apply_to_all rule (per-member weekdays live on assignments for specific)"
    );
  }

  if (assignments !== undefined && nextMode !== "specific") {
    throw new ReminderValidationError(
      "assignments is only accepted when the rule's targetingMode is specific (INV-09)"
    );
  }

  if (
    switching &&
    nextMode === "apply_to_all" &&
    row.kind === "scheduled" &&
    weekdays === undefined
  ) {
    throw new ReminderValidationError(
      "weekdays is required when switching a scheduled rule to apply_to_all"
    );
  }

  if (switching && nextMode === "specific" && assignments === undefined) {
    throw new ReminderValidationError(
      "assignments is required when switching a rule to targetingMode: specific"
    );
  }

  if ((query !== undefined || queryFields !== undefined) && row.kind !== "calendar_gated") {
    throw new ReminderValidationError(
      "query/queryFields can only be edited on a calendar_gated rule"
    );
  }

  const updates: string[] = [];
  const params: unknown[] = [];

  if (text !== undefined) {
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new ReminderValidationError("text must not be blank");
    }
    updates.push("text = ?");
    params.push(text.trim());
  }

  if (weekdays !== undefined) {
    const parsedWeekdays = validateWeekdays(weekdays);
    updates.push("weekdays = ?");
    params.push(JSON.stringify(parsedWeekdays));
  }

  if (query !== undefined) {
    if (typeof query !== "string" || query.trim().length === 0) {
      throw new ReminderValidationError("query must not be blank");
    }
    updates.push("query = ?");
    params.push(query.trim());
  }

  if (queryFields !== undefined) {
    const parsedQueryFields = validateQueryFields(queryFields);
    updates.push("query_fields = ?");
    params.push(JSON.stringify(parsedQueryFields));
  }

  if (active !== undefined) {
    if (typeof active !== "boolean") {
      throw new ReminderValidationError("active must be a boolean");
    }
    updates.push("active = ?");
    params.push(active ? 1 : 0);
  }

  if (switching) {
    updates.push("targeting_mode = ?");
    params.push(nextMode);
    if (nextMode === "specific" && row.kind === "scheduled") {
      // The discriminant CHECK requires NULL rule-level weekdays on a scheduled specific rule.
      updates.push("weekdays = NULL");
    }
  }

  const plan =
    assignments !== undefined ? planAssignmentSet(id, row.kind, assignments) : null;

  if (updates.length === 0 && plan === null) {
    return rowToReminder(row, listActiveAssignments(id));
  }

  const now = Date.now();
  db.transaction(() => {
    updates.push("updated_at = ?");
    params.push(now);
    params.push(id);
    db.prepare(`UPDATE reminder SET ${updates.join(", ")} WHERE id = ?`).run(...params);

    if (plan) {
      plan.write(now);
    } else if (switching && nextMode === "apply_to_all") {
      db.prepare(
        "UPDATE reminder_assignment SET active = 0, updated_at = ? WHERE reminder_id = ? AND active = 1"
      ).run(now, id);
    }
  })();

  return getReminder(id);
}
```

Note: `UPDATE reminder SET weekdays = ?, ..., weekdays = NULL` cannot happen together because `weekdays !== undefined` is rejected when `nextMode` is specific, so the column is never set twice.

- [ ] **Step 5: Run GREEN.** `npx vitest run tests/boundary/reminders-crud.test.ts tests/boundary/reminders-assignments.test.ts tests/boundary/reminders-discriminant.test.ts tests/boundary/reminders-calendar-gated-discriminant.test.ts tests/boundary/reminders-member-lifecycle.test.ts tests/boundary/reminders-emission.test.ts`. Expected: all PASS. If an older test asserted the removed message text ("immutable", "weekdays can only be edited"), grep for it and update the expectation only if it pinned the old wording, never the status code.
- [ ] **Step 6: Typecheck.** `npm run typecheck`. Expected: clean (the client still compiles; it does not send the new keys yet).
- [ ] **Step 7: Commit** `git add -A && git commit -m "feat(reminders): allow editing targetingMode and assignments through PATCH"`.

---

### Task 3: Contract docs

**Files:** Modify `docs/api/reminders/openapi.yaml`, `docs/api/calendar-reminders/openapi.yaml`, `docs/features/reminders.md`.

- [ ] **Step 1: `docs/api/reminders/openapi.yaml`.** Replace the `ReminderEditInput` schema (line ~370) with:

```yaml
    ReminderEditInput:
      type: object
      additionalProperties: false
      description: >-
        Partial edit; kind is immutable. targetingMode may switch between apply_to_all and specific.
        Switching to specific requires assignments; switching a scheduled rule to apply_to_all requires
        weekdays; a calendar_gated rule switching to apply_to_all needs nothing extra. Weekdays are
        valid only when the resulting mode is apply_to_all on a scheduled rule; assignments only when
        the resulting mode is specific (full-set replace). Query fields only on stored calendar_gated
        rules. These state-dependent constraints are enforced by the service; a rejected edit
        persists nothing. Switching to apply_to_all deactivates (never deletes) the rule's active
        assignments.
      properties:
        text:
          type: string
          minLength: 1
          pattern: \S
        weekdays:
          type: array
          items:
            $ref: "#/components/schemas/Weekday"
          minItems: 1
        active:
          type: boolean
        targetingMode:
          type: string
          enum:
            - apply_to_all
            - specific
        assignments:
          type: array
          minItems: 1
          items:
            oneOf:
              - $ref: "#/components/schemas/ReminderAssignmentInput"
              - $ref: "#/components/schemas/CalendarGatedAssignmentInput"
          description: full desired set; accepted only when the resulting targetingMode is specific.
        query:
          type: string
          minLength: 1
          pattern: \S
        queryFields:
          $ref: "#/components/schemas/QueryFields"
      minProperties: 1
      not:
        allOf:
          - required:
              - weekdays
          - anyOf:
              - required:
                  - query
              - required:
                  - queryFields
```

In the same file: in the `Reminder` schema change the `targetingMode` property description from `immutable after creation (FR-013).` to `editable through PATCH (FR-019); kind is immutable.`; change the PATCH `summary` (line ~506) to `Edit text/active/weekdays/query and switch targetingMode (assignments for specific). kind immutable (FR-013).`; change the PATCH 400 description to `kind in body, invalid targetingMode, missing weekdays/assignments for the switch, or invalid field`.

- [ ] **Step 2: `docs/api/calendar-reminders/openapi.yaml`.** In the `ReminderEditInput` description (line ~193) replace `kind and targetingMode remain immutable (FR-013).` with `kind remains immutable (FR-013); targetingMode and assignments are editable (FR-019), see docs/api/reminders/openapi.yaml.` Add the same two properties to its `properties:` block:

```yaml
        targetingMode:
          type: string
          enum:
            - apply_to_all
            - specific
          description: switching to specific requires assignments (membership only for calendar_gated).
        assignments:
          type: array
          minItems: 1
          items:
            $ref: "#/components/schemas/CalendarGatedAssignmentInput"
          description: calendar_gated membership set; accepted only when the resulting targetingMode is specific.
```

In its PATCH summary (line ~299) replace `kind and targetingMode remain immutable (FR-013).` with `kind remains immutable (FR-013); targetingMode is editable (FR-019).` (If `CalendarGatedAssignmentInput` is not defined in this file, reference it by copying the object schema from `docs/api/reminders/openapi.yaml` lines 59-71.)

- [ ] **Step 3: `docs/features/reminders.md`.** Add after FR-018:

```markdown
- **FR-019**: Given an existing rule, when its targeting is edited, then `targetingMode` MUST be switchable between `apply_to_all` and `specific` in one request that also carries what the new mode needs (`assignments` for `specific`, `weekdays` for a `scheduled` rule moving to `apply_to_all`), the rule row and its assignments MUST commit atomically, a rejected edit MUST persist nothing, switching to `apply_to_all` MUST deactivate rather than delete the rule's assignments, and `kind` MUST stay immutable. Contract: REMINDERS-INV-02, REMINDERS-INV-08, REMINDERS-INV-09.
```

and add to Edge Cases: `- Switching a rule between all members and specific members never leaves a half-written rule: validation precedes the single transaction.`

- [ ] **Step 4: Verify.** `npm run check:openapi && npm run check:openapi-shapes && npx prettier --check docs/api docs/features`. Expected: PASS (run `npx prettier --write` on the YAML/MD you touched if only formatting fails).
- [ ] **Step 5: Commit** `git add -A && git commit -m "docs(reminders): document editing targetingMode (FR-019)"`.

---

### Task 4: i18n keys and title changes

**Files:** Modify `src/client/i18n/messages.ts`, `tests/client/reminders-i18n-parity.test.ts`, `tests/client/daily-messages-i18n-parity.test.ts`, `tests/client/day-periods-messages-admin.test.tsx`.

- [ ] **Step 1: Tests first (RED).**
  - `tests/client/reminders-i18n-parity.test.ts`: line 66 expect `"Reminders"` (was `"Reminders Management"`); line 110 expect `"Recordatorios"`. Do NOT touch the `admin.nav.remindersManagement` expectations (lines 65 and 109). Add inside that same `it`:

```ts
    expect(messages.en["reminders.action.addRule"]).toBe("Add rule");
    expect(messages.en["reminders.management.retry"]).toBe("Retry");
    expect(messages.en["reminders.status.off"]).toBe("Off");
    expect(messages.es["reminders.action.addRule"]).toBe("Añadir regla");
    expect(messages.es["reminders.management.retry"]).toBe("Reintentar");
    expect(messages.es["reminders.status.off"]).toBe("Apagado");
```

  - `tests/client/daily-messages-i18n-parity.test.ts`: line 67 expect `"Messages"`; line 96 expect `"Mensajes"`; add `expect(messages.en["dailyMessages.management.retry"]).toBe("Retry");` and `expect(messages.es["dailyMessages.management.retry"]).toBe("Reintentar");` next to them.
  - `tests/client/day-periods-messages-admin.test.tsx` lines 249-251: change all three occurrences of `"Daily Messages Management"` to `"Messages"`.
- [ ] **Step 2: Run RED.** `npx vitest run tests/client/reminders-i18n-parity.test.ts tests/client/daily-messages-i18n-parity.test.ts tests/client/day-periods-messages-admin.test.tsx`. Expected: FAIL on the new expectations.
- [ ] **Step 3: Edit `messages.ts`.**
  - `"reminders.management.title"`: en `"Reminders"` (line ~617), es `"Recordatorios"` (line ~1911).
  - `"dailyMessages.management.title"`: en `"Messages"` (line ~797), es `"Mensajes"` (line ~2096).
  - Append at the end of the `en` object (after its last key, before `},` at line ~1286):

```ts
    // admin-reminders-messages
    "reminders.action.addRule": "Add rule",
    "reminders.management.editTitle": "Edit reminder",
    "reminders.management.saveError": "Failed to save the reminder.",
    "reminders.management.actionError": "Failed to update the reminder.",
    "reminders.management.retry": "Retry",
    "reminders.management.targetingLabel": "Applies to",
    "reminders.status.off": "Off",
    "dailyMessages.management.retry": "Retry",
    "dailyMessages.management.deleteError": "Failed to delete the message.",
```

  - Append at the end of the `es` object (before `},` at line ~2553):

```ts
    // admin-reminders-messages
    "reminders.action.addRule": "Añadir regla",
    "reminders.management.editTitle": "Editar recordatorio",
    "reminders.management.saveError": "Error al guardar el recordatorio.",
    "reminders.management.actionError": "Error al actualizar el recordatorio.",
    "reminders.management.retry": "Reintentar",
    "reminders.management.targetingLabel": "Se aplica a",
    "reminders.status.off": "Apagado",
    "dailyMessages.management.retry": "Reintentar",
    "dailyMessages.management.deleteError": "Error al eliminar el mensaje.",
```

  Before appending, re-read the tail of each locale: other workers' blocks may already sit there; put yours after them, keep the file's en/es key sets identical (the parity test enforces it).
- [ ] **Step 4: Run GREEN.** Same vitest command. Expected: PASS except any test still asserting the old titles (fix per grep: `grep -rn "Daily Messages Management\|Reminders Management\|Gestión de Mensajes\|Gestión de Recordatorios" tests src` and update only title expectations, not `admin.nav.*`; `tests/client/reminders.test.tsx` is rewritten in Task 5).
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(i18n): retitle the reminders and messages pages and add their dialog keys"`.

---

### Task 5: Reminders page UI (tests first, then implementation)

**Files:** Modify `tests/client/reminders.test.tsx`, `src/client/admin/RemindersManagement.tsx`.

**Interfaces:** consumes `ReminderEditInput` (Task 2) and the keys from Task 4. Test ids produced (used by Task 7 e2e): `reminders-add-rule`, `reminders-retry`, `reminder-form-dialog`, `reminder-save`, `reminder-<id>` (row), `reminder-edit-<id>`, `reminder-delete-<id>`, `reminder-toggle-<id>`, `reminder-delete-confirm-<id>`, `reminder-delete-cancel-<id>`. Exports kept: `WEEKDAY_LABEL_KEYS`, `QUERY_FIELD_LABEL_KEYS`, `DRY_RUN_REASON_LABEL_KEYS`, `RemindersManagement`.

#### 5a. Rewrite the client tests (RED)

- [ ] **Step 1: Edit `tests/client/reminders.test.tsx`.** Keep the file header imports, the `MEMBER`, `REMINDER_SCHEDULED`, `REMINDER_CALENDAR_GATED` fixtures, `json`, `renderSurface`, `CENSUS_CONTROL_SELECTOR`, `countInteractiveControls`, `afterEach`, the label-map `describe`s (`label maps are transcribed correctly`). Update the file's top doc comment to describe the list plus dialog layout. Make these changes:

1. Add a second member and a fixture to the top:

```tsx
const MEMBER_B = { ...MEMBER, id: "m2", displayName: "Bea" };

const REMINDER_SPECIFIC = {
  id: "r3",
  kind: "scheduled",
  targetingMode: "specific",
  text: "Pack the gym bag",
  weekdays: null,
  query: null,
  queryFields: null,
  active: true,
  assignments: [
    { id: "a2", memberId: "m1", weekdays: ["mon", "wed"], active: true },
    { id: "a3", memberId: "m2", weekdays: ["fri"], active: true },
  ],
};
```

2. In `mockBackend`, add `members: () => Response` to the overrides type; `/api/members` returns `overrides.members ? overrides.members() : json([MEMBER])`. Make every successful mutating branch (POST/PATCH/DELETE) return `json(null, ...)` as today. Keep the unexpected-fetch throw.

3. Replace the `landmark` test:

```tsx
describe("RemindersManagement — the panel is a real landmark (FR-009 L2-adoption clause)", () => {
  it("exposes an AdminPanel region AND heading named like the sidebar label, with a single such heading", async () => {
    mockBackend();
    renderSurface();
    await screen.findByText("Take out the trash");

    const region = await screen.findByRole("region", { name: "Reminders" });
    expect(within(region).getByRole("heading", { name: "Reminders" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { name: "Reminders" })).toHaveLength(1);
  });
});
```

4. Replace the first density test with (numbers are the EXPECTED values from the control inventory below; run it, and if a number differs find the control that explains the difference before changing the expectation, then record the inventory in the comment):

```tsx
  it("meets kiosk density with the list, the dry-run panel, the add dialog and the edit dialog open", async () => {
    mockBackend();
    const uninject = await injectDensityStyles({
      extraCandidates: ["size-[var(--control-height)]"],
    });
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      renderSurface();
      await screen.findByText("Take out the trash");
      await screen.findByText("Vet appointment prep");

      // Phase 1 — list only. Page: Add rule (1). Row r1: Deactivate, Edit, Delete (3).
      // Row r2 (calendar_gated): Deactivate, Dry-run, Edit, Delete (4). Total 8.
      expect(countInteractiveControls(document.body)).toBe(8);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();

      // Phase 2 — r2's dry-run panel open: member select, date input, Run (+3) = 11.
      const cgRow = await screen.findByTestId("reminder-r2");
      fireEvent.click(within(cgRow).getByRole("button", { name: "Dry-run" }));
      await screen.findByText("Dry-run / explain");
      expect(countInteractiveControls(document.body)).toBe(11);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();

      // Phase 3 — add dialog (scheduled, all members): close X (1), kind radios (2), text (1),
      // targeting radios (2), seven weekday checkboxes (7), Cancel (1), Create (1) = +15 = 26.
      fireEvent.click(screen.getByTestId("reminders-add-rule"));
      await screen.findByTestId("reminder-form-dialog");
      expect(countInteractiveControls(document.body)).toBe(26);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("meets kiosk density with the edit dialog open on a specific rule (member matrix)", async () => {
    mockBackend({ reminders: () => json([REMINDER_SPECIFIC]), members: () => json([MEMBER, MEMBER_B]) });
    const uninject = await injectDensityStyles({
      extraCandidates: ["size-[var(--control-height)]"],
    });
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      renderSurface();
      await screen.findByText("Pack the gym bag");
      fireEvent.click(screen.getByTestId("reminder-edit-r3"));
      await screen.findByTestId("reminder-form-dialog");
      // Dialog: close X (1), text (1), targeting radios (2), matrix 2 members x 7 days (14),
      // Cancel (1), Save (1) = 20; page behind it: Add rule, Deactivate, Edit, Delete = 4. Total 24.
      expect(countInteractiveControls(document.body)).toBe(24);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });
```

   Keep the delete-ConfirmDialog density test but change `within(card).getByRole("button", { name: "Delete" })` to `within(card).getByRole("button", { name: /^Delete/ })`. Keep the DELIBERATE NEGATIVE test but find the button with `await screen.findByTestId("reminders-add-rule")` (set `style.height="10px"`, `fontSize="8px"` on it; the assertions stay).

5. Replace the `error states` describe with:

```tsx
describe("RemindersManagement — error states are announced (SC-011) and recoverable", () => {
  it("announces a data-load failure through ErrorNotice's live region and offers Retry that recovers", async () => {
    let fail = true;
    const mockFetch = mockBackend({
      reminders: () => (fail ? json(null, 500) : json([REMINDER_SCHEDULED])),
    });
    renderSurface();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to load reminders.");
    expect(alert).toHaveAttribute("aria-live", "assertive");
    expect(screen.queryByTestId("reminders-add-rule")).not.toBeInTheDocument();

    fail = false;
    fireEvent.click(screen.getByTestId("reminders-retry"));
    expect(await screen.findByText("Take out the trash")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      (mockFetch.mock.calls as FetchCall[]).filter(
        ([u, init]) => String(u) === "/api/reminders" && (init?.method ?? "GET") === "GET"
      ).length
    ).toBeGreaterThanOrEqual(2);
  });

  it("keeps the add dialog open and announces a create failure inside it", async () => {
    const mockFetch = mockBackend();
    renderSurface();
    await screen.findByText("Take out the trash");

    fireEvent.click(screen.getByTestId("reminders-add-rule"));
    const dialog = await screen.findByTestId("reminder-form-dialog");
    mockFetch.mockImplementation((input: string | URL, init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      if (url === "/api/reminders" && init?.method === "POST") return Promise.resolve(json(null, 500));
      throw new Error(`unexpected fetch after override: ${url}`);
    });

    fireEvent.change(within(dialog).getByPlaceholderText("Reminder text"), {
      target: { value: "New reminder" },
    });
    fireEvent.click(within(dialog).getByLabelText("Mon"));
    fireEvent.click(within(dialog).getByTestId("reminder-save"));

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("Failed to save the reminder.");
    expect(alert).toHaveAttribute("aria-live", "assertive");
    expect(screen.getByTestId("reminder-form-dialog")).toBeInTheDocument();
  });

  it("announces a dry-run failure through ErrorNotice's live region", async () => {
    const mockFetch = mockBackend();
    renderSurface();

    const row = await screen.findByTestId("reminder-r2");
    fireEvent.click(within(row).getByRole("button", { name: "Dry-run" }));
    await screen.findByText("Dry-run / explain");

    mockFetch.mockImplementation((input: string | URL, init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      if (/\/api\/reminders\/[^/]+\/dry-run$/.test(url) && init?.method === "POST") {
        return Promise.resolve(json(null, 500));
      }
      throw new Error(`unexpected fetch after override: ${url}`);
    });

    fireEvent.change(within(row).getByRole("combobox"), { target: { value: "m1" } });
    fireEvent.click(within(row).getByRole("button", { name: "Run" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to run dry-run.");
    expect(alert).toHaveAttribute("aria-live", "assertive");
  });

  it("announces a toggle failure at page level", async () => {
    const mockFetch = mockBackend();
    renderSurface();
    const row = await screen.findByTestId("reminder-r1");
    mockFetch.mockImplementation((input: string | URL, init?: Parameters<typeof fetch>[1]) => {
      if (String(input) === "/api/reminders/r1" && init?.method === "PATCH") {
        return Promise.resolve(json(null, 500));
      }
      throw new Error(`unexpected fetch after override: ${String(input)}`);
    });
    fireEvent.click(within(row).getByTestId("reminder-toggle-r1"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to update the reminder.");
  });
});
```

6. Replace the delete test's button lookups with `within(card).getByRole("button", { name: /^Delete/ })`; keep its structure and the testids `reminder-delete-cancel-r1` / `reminder-delete-confirm-r1`.

7. Add new describes:

```tsx
describe("RemindersManagement — rows name their members and days", () => {
  it("summarises all-members, specific and calendar-gated rules", async () => {
    mockBackend({
      reminders: () => json([REMINDER_SCHEDULED, REMINDER_SPECIFIC, REMINDER_CALENDAR_GATED]),
      members: () => json([MEMBER, MEMBER_B]),
    });
    renderSurface();
    await screen.findByText("Pack the gym bag");

    expect(within(screen.getByTestId("reminder-r1")).getByText("All members · Mon")).toBeInTheDocument();
    expect(
      within(screen.getByTestId("reminder-r3")).getByText("Ari: Mon, Wed · Bea: Fri")
    ).toBeInTheDocument();
    expect(within(screen.getByTestId("reminder-r2")).getByText("Match text: vet · Ari")).toBeInTheDocument();
    expect(within(screen.getByTestId("reminder-r1")).getByText("Active")).toBeInTheDocument();
  });

  it("shows Off for an inactive rule", async () => {
    mockBackend({ reminders: () => json([{ ...REMINDER_SCHEDULED, active: false }]) });
    renderSurface();
    expect(await screen.findByText("Off")).toBeInTheDocument();
  });
});

describe("RemindersManagement — the add/edit dialog", () => {
  it("creates a specific scheduled rule from the matrix", async () => {
    const mockFetch = mockBackend();
    renderSurface();
    await screen.findByText("Take out the trash");

    fireEvent.click(screen.getByTestId("reminders-add-rule"));
    const dialog = await screen.findByTestId("reminder-form-dialog");
    fireEvent.change(within(dialog).getByPlaceholderText("Reminder text"), {
      target: { value: "Bus day" },
    });
    fireEvent.click(within(dialog).getByLabelText("Specific members"));
    expect(within(dialog).getByTestId("reminder-save")).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Ari — Mon" }));
    fireEvent.click(within(dialog).getByTestId("reminder-save"));

    await waitFor(() => {
      const post = (mockFetch.mock.calls as FetchCall[]).find(
        ([u, init]) => String(u) === "/api/reminders" && init?.method === "POST"
      );
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post![1]!.body))).toEqual({
        kind: "scheduled",
        targetingMode: "specific",
        text: "Bus day",
        assignments: [{ memberId: "m1", weekdays: ["mon"] }],
      });
    });
    await waitFor(() => expect(screen.queryByTestId("reminder-form-dialog")).not.toBeInTheDocument());
  });

  it("Enter in the text field submits a valid form", async () => {
    const mockFetch = mockBackend();
    renderSurface();
    await screen.findByText("Take out the trash");
    fireEvent.click(screen.getByTestId("reminders-add-rule"));
    const dialog = await screen.findByTestId("reminder-form-dialog");
    const input = within(dialog).getByPlaceholderText("Reminder text");
    fireEvent.change(input, { target: { value: "Enter submit" } });
    fireEvent.click(within(dialog).getByLabelText("Tue"));
    fireEvent.submit(input.closest("form")!);
    await waitFor(() =>
      expect(
        (mockFetch.mock.calls as FetchCall[]).some(
          ([u, init]) => String(u) === "/api/reminders" && init?.method === "POST"
        )
      ).toBe(true)
    );
  });

  it("edits an all-members rule into a specific one (PATCH carries targetingMode and assignments)", async () => {
    const mockFetch = mockBackend();
    renderSurface();
    await screen.findByText("Take out the trash");

    fireEvent.click(screen.getByTestId("reminder-edit-r1"));
    const dialog = await screen.findByTestId("reminder-form-dialog");
    expect(within(dialog).queryByLabelText("Calendar-gated")).not.toBeInTheDocument(); // kind is fixed
    expect(within(dialog).getByPlaceholderText("Reminder text")).toHaveValue("Take out the trash");

    fireEvent.click(within(dialog).getByLabelText("Specific members"));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Ari — Tue" }));
    fireEvent.click(within(dialog).getByTestId("reminder-save"));

    await waitFor(() => {
      const patch = (mockFetch.mock.calls as FetchCall[]).find(
        ([u, init]) => String(u) === "/api/reminders/r1" && init?.method === "PATCH"
      );
      expect(patch).toBeTruthy();
      expect(JSON.parse(String(patch![1]!.body))).toEqual({
        text: "Take out the trash",
        targetingMode: "specific",
        assignments: [{ memberId: "m1", weekdays: ["tue"] }],
      });
    });
  });

  it("edits a specific calendar-gated rule back to all members (no assignments sent)", async () => {
    const mockFetch = mockBackend();
    renderSurface();
    await screen.findByText("Vet appointment prep");
    fireEvent.click(screen.getByTestId("reminder-edit-r2"));
    const dialog = await screen.findByTestId("reminder-form-dialog");
    fireEvent.click(within(dialog).getByLabelText("All members"));
    fireEvent.click(within(dialog).getByTestId("reminder-save"));
    await waitFor(() => {
      const patch = (mockFetch.mock.calls as FetchCall[]).find(
        ([u, init]) => String(u) === "/api/reminders/r2" && init?.method === "PATCH"
      );
      expect(patch).toBeTruthy();
      expect(JSON.parse(String(patch![1]!.body))).toEqual({
        text: "Vet appointment prep",
        targetingMode: "apply_to_all",
        query: "vet",
        queryFields: ["title", "description"],
      });
    });
  });

  it("a successful toggle refreshes silently: an open dry-run panel stays mounted", async () => {
    mockBackend();
    renderSurface();
    const row = await screen.findByTestId("reminder-r2");
    fireEvent.click(within(row).getByRole("button", { name: "Dry-run" }));
    await screen.findByText("Dry-run / explain");

    fireEvent.click(within(row).getByTestId("reminder-toggle-r2"));
    await waitFor(() => expect(screen.getByTestId("reminder-r2")).toBeInTheDocument());
    // the page never swapped to its loading panel, so the panel is still there
    expect(screen.getByText("Dry-run / explain")).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });
});
```

8. Keep the Spanish weekday test but open the dialog first: after `await screen.findByText("Take out the trash");` add `fireEvent.click(screen.getByTestId("reminders-add-rule")); await screen.findByTestId("reminder-form-dialog");`, then `screen.getByRole("group", { name: "Días de la semana" })`. In the canonical-order test: open the dialog the same way, then use `within(dialog)` for `getByPlaceholderText`, `getByLabelText("Wed")`, `getByLabelText("Mon")`, and click `reminder-save` (instead of `Create Reminder`).

9. Remove the now-obsolete tests: the "Assignments"/matrix-validation test, the old create-failure test and the old density phases.

- [ ] **Step 2: Also update `tests/client/admin-household-timezone-defaults.test.tsx`?** It clicks the "Dry-run" button and reads the "Date" label; both are preserved, so no change is needed. Run it after Step 4 to confirm.
- [ ] **Step 3: Run RED.** `npx vitest run tests/client/reminders.test.tsx`. Expected: FAIL (no `reminders-add-rule` etc.).

#### 5b. Implement

- [ ] **Step 4: Rewrite `src/client/admin/RemindersManagement.tsx`.** Keep verbatim: lines 56-105 (the three exported label maps, `weekdayLabels`, `QUERY_FIELDS`, `DEFAULT_QUERY_FIELDS`, `draftToAssignments`, `membershipToAssignments`) and the last three components `QueryFieldsPicker`, `MembershipChecklist`, `AssignmentMatrixGrid` (lines 912-1027). Replace the header imports, the top doc comment and lines 107-910 as follows.

Imports (replace lines 1-34):

```tsx
import { useState, useEffect, useRef } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { authFetch } from "@/lib/credential";
import { useHouseholdSettings } from "@/lib/householdSettings";
import { todayInHouseholdTimezone } from "@/lib/household-date";
import {
  Reminder,
  ReminderInput,
  ReminderEditInput,
  ReminderAssignmentInput,
  ReminderKind,
  ReminderQueryField,
  DryRunResult,
  DryRunReason,
  TargetingMode,
  Member,
  Weekday,
} from "../../shared";
import type { MessageKey } from "@/i18n/messages";
import { useTranslation } from "@/i18n";
import { AdminPanel } from "@/components/AdminPanel";
import { ErrorNotice } from "@/components/ErrorNotice";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  WeekdayPicker,
  CANONICAL_WEEKDAY_ORDER,
  type WeekdayLabels,
} from "@/components/WeekdayPicker";
import { CheckboxField } from "@/components/CheckboxField";
import { RadioField } from "@/components/RadioField";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { NATIVE_SELECT_CLASSES, BARE_CHECKBOX_INPUT_CLASSES } from "@/lib/recipes";
```

Top doc comment: replace with a short one: `RemindersManagement — the reminders admin page: a list of rules, one add/edit Dialog (scheduled all/specific with the member x weekday matrix, calendar_gated with query and members), a per-row dry-run panel for calendar_gated rules, and a themed delete ConfirmDialog. Only the first load and an explicit Retry show the loading state; later refreshes are silent so open dialogs and panels survive.`

Replace lines 107-910 with:

```tsx
type FormState = { kind: "create" } | { kind: "edit"; reminder: Reminder } | null;

type Translate = (key: MessageKey) => string;

export function RemindersManagement() {
  const { t } = useTranslation();
  // The household timezone comes from the shared `useHouseholdSettings` context. The first load
  // stays gated behind it so the dry-run date default (`householdToday`) is set before any row
  // mounts and captures it.
  const { timezone: householdTimezone } = useHouseholdSettings();

  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [allMembers, setAllMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [householdToday, setHouseholdToday] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(null);
  const [deleteTarget, setDeleteTarget] = useState<Reminder | null>(null);

  const activeMembers = allMembers.filter((m) => m.lifecycle === "active");
  const memberNames = new Map(allMembers.map((m) => [m.id, m.displayName]));

  useEffect(() => {
    if (householdTimezone === null) return;
    setHouseholdToday(todayInHouseholdTimezone(householdTimezone));
    void loadData();
  }, [householdTimezone]);

  async function fetchAll(): Promise<void> {
    const [remindersRes, membersRes] = await Promise.all([
      authFetch("/api/reminders", { credentials: "include" }),
      authFetch("/api/members", { credentials: "include" }),
    ]);
    if (!remindersRes.ok) throw new Error("Failed to load reminders");
    if (!membersRes.ok) throw new Error("Failed to load members");
    const [remindersData, membersData] = (await Promise.all([
      remindersRes.json(),
      membersRes.json(),
    ])) as [Reminder[], Member[]];
    setReminders(remindersData);
    setAllMembers(membersData);
  }

  /** First load and Retry: shows the loading state. */
  async function loadData() {
    setLoading(true);
    setLoadFailed(false);
    setError(null);
    try {
      await fetchAll();
    } catch {
      setLoadFailed(true);
      setError(t("reminders.management.error"));
    } finally {
      setLoading(false);
    }
  }

  /** After a mutation: no loading state, so an open dialog or dry-run panel is never unmounted. */
  async function refresh() {
    try {
      await fetchAll();
    } catch {
      setLoadFailed(true);
      setError(t("reminders.management.error"));
    }
  }

  async function send(
    url: string,
    method: "POST" | "PATCH" | "DELETE",
    body?: unknown
  ): Promise<boolean> {
    try {
      const res = await authFetch(url, {
        method,
        credentials: "include",
        ...(body !== undefined
          ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
          : {}),
      });
      if (!res.ok) return false;
    } catch {
      return false;
    }
    await refresh();
    return true;
  }

  async function saveReminder(
    target: Reminder | null,
    body: ReminderInput | ReminderEditInput
  ): Promise<boolean> {
    return target
      ? send(`/api/reminders/${target.id}`, "PATCH", body)
      : send("/api/reminders", "POST", body);
  }

  async function toggleActive(reminder: Reminder) {
    setError(null);
    const ok = await send(`/api/reminders/${reminder.id}`, "PATCH", { active: !reminder.active });
    if (!ok) setError(t("reminders.management.actionError"));
  }

  /** Confirmation lives in the ConfirmDialog below; this deletes unconditionally (FR-005). */
  async function deleteReminder(reminder: Reminder) {
    setError(null);
    const ok = await send(`/api/reminders/${reminder.id}`, "DELETE");
    if (!ok) setError(t("reminders.management.actionError"));
  }

  async function dryRunReminder(
    reminderId: string,
    memberId: string,
    date: string
  ): Promise<DryRunResult> {
    const res = await authFetch(`/api/reminders/${reminderId}/dry-run`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberId, date }),
    });
    if (!res.ok) throw new Error("Dry-run failed");
    return (await res.json()) as DryRunResult;
  }

  if (loading) {
    return (
      <AdminPanel title={t("reminders.management.title")}>
        <p>{t("reminders.management.loading")}</p>
      </AdminPanel>
    );
  }

  return (
    <>
      <AdminPanel
        title={t("reminders.management.title")}
        description={t("reminders.management.description")}
        actions={
          loadFailed ? undefined : (
            <Button
              type="button"
              data-testid="reminders-add-rule"
              onClick={() => setForm({ kind: "create" })}
            >
              <Plus aria-hidden="true" />
              {t("reminders.action.addRule")}
            </Button>
          )
        }
      >
        <ErrorNotice message={error} />

        {loadFailed && (
          <Button
            type="button"
            variant="outline"
            className="self-start"
            data-testid="reminders-retry"
            onClick={() => void loadData()}
          >
            {t("reminders.management.retry")}
          </Button>
        )}

        {!loadFailed && reminders.length === 0 && (
          <p className="text-muted-foreground">{t("reminders.management.noReminders")}</p>
        )}

        {reminders.length > 0 && (
          <ul
            aria-label={t("reminders.management.list")}
            className="m-0 flex list-none flex-col divide-y rounded-lg border p-0"
          >
            {reminders.map((reminder) => (
              <ReminderRow
                key={reminder.id}
                reminder={reminder}
                t={t}
                memberNames={memberNames}
                activeMembers={activeMembers}
                householdToday={householdToday}
                onEdit={() => setForm({ kind: "edit", reminder })}
                onDelete={() => setDeleteTarget(reminder)}
                onToggleActive={() => void toggleActive(reminder)}
                onDryRun={(memberId, date) => dryRunReminder(reminder.id, memberId, date)}
              />
            ))}
          </ul>
        )}
      </AdminPanel>

      {form && (
        <ReminderFormDialog
          key={form.kind === "edit" ? form.reminder.id : "create"}
          t={t}
          reminder={form.kind === "edit" ? form.reminder : null}
          activeMembers={activeMembers}
          onSubmit={(body) => saveReminder(form.kind === "edit" ? form.reminder : null, body)}
          onClose={() => setForm(null)}
        />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t("reminders.action.delete")}
        description={t("reminders.action.deleteConfirm")}
        confirmLabel={t("reminders.action.delete")}
        cancelLabel={t("reminders.action.cancel")}
        onConfirm={() => {
          if (deleteTarget) void deleteReminder(deleteTarget);
        }}
        confirmTestId={deleteTarget ? `reminder-delete-confirm-${deleteTarget.id}` : undefined}
        cancelTestId={deleteTarget ? `reminder-delete-cancel-${deleteTarget.id}` : undefined}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Sub-components */
/* ------------------------------------------------------------------ */

function weekdayList(t: Translate, days: Weekday[]): string {
  return days.map((day) => t(WEEKDAY_LABEL_KEYS[day])).join(", ");
}

/** The muted "who and when" line of a row. */
function summarize(reminder: Reminder, t: Translate, memberNames: Map<string, string>): string {
  const everyone = t("reminders.management.targetingApplyToAll");
  const names = reminder.assignments.flatMap((a) => {
    const name = memberNames.get(a.memberId);
    return name ? [name] : [];
  });
  if (reminder.kind === "calendar_gated") {
    const who = reminder.targetingMode === "apply_to_all" ? everyone : names.join(", ");
    return `${t("reminders.calendarGated.queryLabel")}: ${reminder.query ?? ""} · ${who}`;
  }
  if (reminder.targetingMode === "apply_to_all") {
    return `${everyone} · ${weekdayList(t, reminder.weekdays ?? [])}`;
  }
  return reminder.assignments
    .flatMap((a) => {
      const name = memberNames.get(a.memberId);
      return name ? [`${name}: ${weekdayList(t, a.weekdays)}`] : [];
    })
    .join(" · ");
}

interface ReminderRowProps {
  reminder: Reminder;
  t: Translate;
  memberNames: Map<string, string>;
  activeMembers: Member[];
  householdToday: string;
  onEdit: () => void;
  onDelete: () => void;
  onToggleActive: () => void;
  onDryRun: (memberId: string, date: string) => Promise<DryRunResult>;
}

function ReminderRow({
  reminder,
  t,
  memberNames,
  activeMembers,
  householdToday,
  onEdit,
  onDelete,
  onToggleActive,
  onDryRun,
}: ReminderRowProps) {
  const isCalendarGated = reminder.kind === "calendar_gated";
  const [showDryRun, setShowDryRun] = useState(false);

  return (
    <li data-testid={`reminder-${reminder.id}`} className="flex flex-col gap-3 px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 font-medium">
            <span className="truncate">{reminder.text}</span>
            <span className="bg-muted rounded-full px-2.5 py-0.5 text-sm font-medium">
              {isCalendarGated ? t("reminders.kind.calendarGated") : t("reminders.kind.scheduled")}
            </span>
          </p>
          <p className="text-muted-foreground text-control">
            {summarize(reminder, t, memberNames)}
          </p>
        </div>
        <span
          className={cn(
            "rounded-full px-2.5 py-0.5 text-sm font-medium",
            reminder.active ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
          )}
        >
          {reminder.active ? t("reminders.status.active") : t("reminders.status.off")}
        </span>
        {isCalendarGated && (
          <Button type="button" variant="link" onClick={() => setShowDryRun((prev) => !prev)}>
            {showDryRun ? t("reminders.dryRun.close") : t("reminders.dryRun.toggleShow")}
          </Button>
        )}
        <Button
          type="button"
          variant="secondary"
          data-testid={`reminder-toggle-${reminder.id}`}
          onClick={onToggleActive}
        >
          {reminder.active ? t("reminders.action.deactivate") : t("reminders.action.activate")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-testid={`reminder-edit-${reminder.id}`}
          aria-label={`${t("reminders.action.edit")}: ${reminder.text}`}
          onClick={onEdit}
        >
          <Pencil className="size-4" aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-destructive"
          data-testid={`reminder-delete-${reminder.id}`}
          aria-label={`${t("reminders.action.delete")}: ${reminder.text}`}
          onClick={onDelete}
        >
          <Trash2 className="size-4" aria-hidden="true" />
        </Button>
      </div>

      {isCalendarGated && showDryRun && (
        <DryRunPanel
          t={t}
          activeMembers={activeMembers}
          householdToday={householdToday}
          onDryRun={onDryRun}
        />
      )}
    </li>
  );
}

interface DryRunPanelProps {
  t: Translate;
  activeMembers: Member[];
  householdToday: string;
  onDryRun: (memberId: string, date: string) => Promise<DryRunResult>;
}

/** The dry-run / explain panel of a calendar_gated row (behaviour unchanged). */
function DryRunPanel({ t, activeMembers, householdToday, onDryRun }: DryRunPanelProps) {
  const [dryRunMemberId, setDryRunMemberId] = useState("");
  const [dryRunDate, setDryRunDate] = useState(householdToday);
  const [dryRunResult, setDryRunResult] = useState<DryRunResult | null>(null);
  const [dryRunLoading, setDryRunLoading] = useState(false);
  const [dryRunError, setDryRunError] = useState<string | null>(null);
  const dryRunRequestIdRef = useRef(0);

  // The verdict (or error) describes the PREVIOUS member/date once either changes — clear it and
  // invalidate any in-flight request so a slow response for stale inputs can't publish over it.
  useEffect(() => {
    dryRunRequestIdRef.current++;
    setDryRunResult(null);
    setDryRunError(null);
  }, [dryRunMemberId, dryRunDate]);

  const runDryRun = () => {
    if (!dryRunMemberId) return;
    const requestId = ++dryRunRequestIdRef.current;
    setDryRunLoading(true);
    setDryRunError(null);
    void (async () => {
      try {
        const result = await onDryRun(dryRunMemberId, dryRunDate);
        if (requestId !== dryRunRequestIdRef.current) return;
        setDryRunResult(result);
      } catch {
        if (requestId !== dryRunRequestIdRef.current) return;
        setDryRunResult(null);
        setDryRunError(t("reminders.dryRun.error"));
      } finally {
        if (requestId === dryRunRequestIdRef.current) {
          setDryRunLoading(false);
        }
      }
    })();
  };

  return (
    <div className="border-t pt-3">
      <h5 className="text-sm font-semibold mb-2">{t("reminders.dryRun.title")}</h5>
      <div className="flex gap-2 items-center flex-wrap">
        <label className="flex items-center gap-1 text-sm">
          {t("reminders.dryRun.memberLabel")}
          <select
            value={dryRunMemberId}
            onChange={(e) => setDryRunMemberId(e.target.value)}
            className={NATIVE_SELECT_CLASSES}
          >
            <option value="">{t("reminders.dryRun.selectMember")}</option>
            {activeMembers.map((member) => (
              <option key={member.id} value={member.id}>
                {member.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1 text-sm">
          {t("reminders.dryRun.dateLabel")}
          <Input
            type="date"
            value={dryRunDate}
            onChange={(e) => setDryRunDate(e.target.value)}
            className="w-auto"
          />
        </label>
        <Button type="button" onClick={runDryRun} disabled={!dryRunMemberId || dryRunLoading}>
          {dryRunLoading ? t("reminders.dryRun.running") : t("reminders.dryRun.run")}
        </Button>
      </div>
      <ErrorNotice message={dryRunError} className="mt-2" />
      {dryRunResult && (
        <p className="text-sm mt-2">
          <span className="font-semibold">
            {dryRunResult.wouldEmit
              ? t("reminders.dryRun.wouldEmit")
              : t("reminders.dryRun.wouldNotEmit")}
          </span>
          {!dryRunResult.wouldEmit && dryRunResult.reason && (
            <span className="text-muted-foreground">
              {" — "}
              {t(DRY_RUN_REASON_LABEL_KEYS[dryRunResult.reason])}
            </span>
          )}
        </p>
      )}
    </div>
  );
}

interface ReminderFormDialogProps {
  t: Translate;
  /** `null` = create. */
  reminder: Reminder | null;
  activeMembers: Member[];
  /** Resolves `true` when the request succeeded (the page has already refreshed). */
  onSubmit: (body: ReminderInput | ReminderEditInput) => Promise<boolean>;
  onClose: () => void;
}

/** One dialog for create and edit. Mounted only while open (keyed by reminder id), so its drafts
 * start fresh from the rule every time. The weekday, matrix and members drafts are separate state
 * so switching All/Specific back and forth keeps what was entered. */
function ReminderFormDialog({
  t,
  reminder,
  activeMembers,
  onSubmit,
  onClose,
}: ReminderFormDialogProps) {
  const editing = reminder !== null;
  const [kind, setKind] = useState<ReminderKind>(reminder?.kind ?? "scheduled");
  const [text, setText] = useState(reminder?.text ?? "");
  const [targetingMode, setTargetingMode] = useState<TargetingMode>(
    reminder?.targetingMode ?? "apply_to_all"
  );
  const [weekdays, setWeekdays] = useState<Weekday[]>(reminder?.weekdays ?? []);
  const [assignmentDraft, setAssignmentDraft] = useState<Record<string, Weekday[]>>(() =>
    reminder && reminder.kind === "scheduled" && reminder.targetingMode === "specific"
      ? Object.fromEntries(reminder.assignments.map((a) => [a.memberId, a.weekdays]))
      : {}
  );
  const [query, setQuery] = useState(reminder?.query ?? "");
  const [queryFields, setQueryFields] = useState<ReminderQueryField[]>(
    reminder?.queryFields ?? DEFAULT_QUERY_FIELDS
  );
  const [cgMemberIds, setCgMemberIds] = useState<string[]>(() =>
    reminder && reminder.kind === "calendar_gated"
      ? reminder.assignments.map((a) => a.memberId)
      : []
  );
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const toggleAssignmentDay = (memberId: string, day: Weekday) => {
    setAssignmentDraft((prev) => {
      const current = prev[memberId] ?? [];
      const next = current.includes(day) ? current.filter((d) => d !== day) : [...current, day];
      return { ...prev, [memberId]: next };
    });
  };

  const toggleQueryField = (field: ReminderQueryField) => {
    setQueryFields((prev) =>
      prev.includes(field) ? prev.filter((f) => f !== field) : [...prev, field]
    );
  };

  const toggleCgMember = (memberId: string) => {
    setCgMemberIds((prev) =>
      prev.includes(memberId) ? prev.filter((id) => id !== memberId) : [...prev, memberId]
    );
  };

  const assignments = draftToAssignments(assignmentDraft);
  const canSubmit =
    !!text.trim() &&
    (kind === "scheduled"
      ? targetingMode === "apply_to_all"
        ? weekdays.length > 0
        : assignments.length > 0
      : query.trim().length > 0 &&
        queryFields.length > 0 &&
        (targetingMode === "apply_to_all" || cgMemberIds.length > 0));

  const buildBody = (): ReminderInput | ReminderEditInput => {
    const trimmedText = text.trim();
    if (kind === "scheduled") {
      if (targetingMode === "apply_to_all") {
        return editing
          ? { text: trimmedText, targetingMode: "apply_to_all", weekdays }
          : { kind: "scheduled", targetingMode: "apply_to_all", text: trimmedText, weekdays };
      }
      return editing
        ? { text: trimmedText, targetingMode: "specific", assignments }
        : { kind: "scheduled", targetingMode: "specific", text: trimmedText, assignments };
    }
    const trimmedQuery = query.trim();
    if (targetingMode === "apply_to_all") {
      return editing
        ? {
            text: trimmedText,
            targetingMode: "apply_to_all",
            query: trimmedQuery,
            queryFields,
          }
        : {
            kind: "calendar_gated",
            targetingMode: "apply_to_all",
            text: trimmedText,
            query: trimmedQuery,
            queryFields,
          };
    }
    const memberAssignments = membershipToAssignments(cgMemberIds);
    return editing
      ? {
          text: trimmedText,
          targetingMode: "specific",
          query: trimmedQuery,
          queryFields,
          assignments: memberAssignments,
        }
      : {
          kind: "calendar_gated",
          targetingMode: "specific",
          text: trimmedText,
          query: trimmedQuery,
          queryFields,
          assignments: memberAssignments,
        };
  };

  const submit = () => {
    if (!canSubmit || saving) return;
    setSaving(true);
    setFormError(null);
    void (async () => {
      const ok = await onSubmit(buildBody());
      if (ok) {
        onClose();
      } else {
        setFormError(t("reminders.management.saveError"));
        setSaving(false);
      }
    })();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent
        className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-xl"
        closeLabel={t("reminders.action.cancel")}
        data-testid="reminder-form-dialog"
      >
        <DialogHeader>
          <DialogTitle>
            {editing ? t("reminders.management.editTitle") : t("reminders.management.createTitle")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("reminders.management.description")}
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="flex gap-2 items-center flex-wrap">
            <span className="text-muted-foreground text-control">
              {t("reminders.management.kindLabel")}
            </span>
            {editing ? (
              <span className="text-control font-medium">
                {kind === "calendar_gated"
                  ? t("reminders.kind.calendarGated")
                  : t("reminders.kind.scheduled")}
              </span>
            ) : (
              <>
                <RadioField
                  name="reminder-kind"
                  value="scheduled"
                  checked={kind === "scheduled"}
                  onChange={() => setKind("scheduled")}
                  label={t("reminders.kind.scheduled")}
                />
                <RadioField
                  name="reminder-kind"
                  value="calendar_gated"
                  checked={kind === "calendar_gated"}
                  onChange={() => setKind("calendar_gated")}
                  label={t("reminders.kind.calendarGated")}
                />
              </>
            )}
          </div>

          <Input
            type="text"
            placeholder={t("reminders.management.textPlaceholder")}
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label={t("reminders.management.textPlaceholder")}
          />

          <div className="flex gap-2 items-center flex-wrap">
            <span className="text-muted-foreground text-control">
              {t("reminders.management.targetingLabel")}
            </span>
            <RadioField
              name="reminder-targeting-mode"
              value="apply_to_all"
              checked={targetingMode === "apply_to_all"}
              onChange={() => setTargetingMode("apply_to_all")}
              label={t("reminders.management.targetingApplyToAll")}
            />
            <RadioField
              name="reminder-targeting-mode"
              value="specific"
              checked={targetingMode === "specific"}
              onChange={() => setTargetingMode("specific")}
              label={t("reminders.management.targetingSpecific")}
            />
          </div>

          {kind === "scheduled" ? (
            targetingMode === "apply_to_all" ? (
              <WeekdayPicker
                mode="multi"
                value={weekdays}
                onChange={(next) => setWeekdays([...next])}
                labels={weekdayLabels(t)}
                groupLabel={t("reminders.management.weekdaysLabel")}
                testIdPrefix="reminders-weekday-form"
              />
            ) : (
              <div className="overflow-x-auto">
                <AssignmentMatrixGrid
                  t={t}
                  members={activeMembers}
                  weekdaysByMember={assignmentDraft}
                  onToggle={toggleAssignmentDay}
                />
              </div>
            )
          ) : (
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-1 text-sm">
                {t("reminders.calendarGated.queryLabel")}
                <Input
                  type="text"
                  placeholder={t("reminders.calendarGated.queryPlaceholder")}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="w-auto"
                />
              </label>
              <div className="flex gap-2 items-center flex-wrap">
                <span className="text-muted-foreground text-control">
                  {t("reminders.calendarGated.queryFieldsLabel")}
                </span>
                <QueryFieldsPicker t={t} selected={queryFields} onToggle={toggleQueryField} />
              </div>
              {targetingMode === "specific" && (
                <div>
                  <span className="text-muted-foreground text-control">
                    {t("reminders.calendarGated.membershipTitle")}
                  </span>
                  <MembershipChecklist
                    members={activeMembers}
                    emptyMessage={t("reminders.calendarGated.noActiveMembers")}
                    selectedMemberIds={cgMemberIds}
                    onToggle={toggleCgMember}
                  />
                </div>
              )}
            </div>
          )}

          <ErrorNotice message={formError} />

          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              {t("reminders.action.cancel")}
            </Button>
            <Button type="submit" data-testid="reminder-save" disabled={!canSubmit || saving}>
              {editing ? t("reminders.action.save") : t("reminders.action.create")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

Notes for the implementer: (a) the `ReminderInput`/`ReminderEditInput` object literals above type-check because `targetingMode` literals narrow; if TypeScript complains about the union return, annotate each branch with `satisfies ReminderInput` / `satisfies ReminderEditInput`. (b) `weekdayLabels(t)` takes `(key: MessageKey) => string`, which is what `Translate` is. (c) The WeekdayPicker `testIdPrefix` changed from `reminders-weekday-create`/`-edit-<id>` to `reminders-weekday-form`; grep `reminders-weekday` in `tests/` and update any hit. (d) Delete the old `ReminderCreateForm`, `ReminderCard`, unused imports (`ReminderAssignment`, `ReminderAssignmentSetInput`), and the `showMatrix`/matrix code with them; `npm run lint` flags leftovers.

- [ ] **Step 5: Run GREEN and reconcile counts.** `npx vitest run tests/client/reminders.test.tsx tests/client/admin-household-timezone-defaults.test.tsx tests/client/admin-gate-panel-reset.test.tsx`. Expected: PASS. If a density count differs from 8/11/26/24, list the controls in the DOM (`screen.debug`) and decide whether the component or the expectation is wrong; update the inventory comment with the real, explained number.
- [ ] **Step 6: Lint and types.** `npm run typecheck && npm run lint && npx prettier --write src/client/admin/RemindersManagement.tsx tests/client/reminders.test.tsx`. Expected: clean.
- [ ] **Step 7: Commit** `git add -A && git commit -m "feat(admin): rework the reminders page around a list and an add/edit dialog"`.

---

### Task 6: Messages Retry

**Files:** Modify `tests/client/daily-messages-management.test.tsx`, `src/client/admin/DailyMessagesManagement.tsx`.

- [ ] **Step 1: Tests (RED).** Append to the file:

```tsx
describe("DailyMessagesManagement load failures can be retried", () => {
  function stubFetch(handlers: { members: () => Response; messages: () => Response }) {
    const mockFetch = vi.fn((input: string | URL, init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/settings") {
        return Promise.resolve(jsonResponse({ locale: { timezone: "UTC", language: "en" } }));
      }
      if (url === "/api/members" && method === "GET") return Promise.resolve(handlers.members());
      if (url.startsWith("/api/daily-messages?") && method === "GET") {
        return Promise.resolve(handlers.messages());
      }
      throw new Error(`unexpected fetch: ${url} (${method})`);
    });
    vi.stubGlobal("fetch", mockFetch);
    render(
      <HouseholdSettingsProvider>
        <LanguageProvider>
          <DailyMessagesManagement />
        </LanguageProvider>
      </HouseholdSettingsProvider>
    );
    return mockFetch;
  }

  it("offers Retry when the members request fails and recovers on click", async () => {
    let membersFail = true;
    stubFetch({
      members: () => (membersFail ? jsonResponse(null, 500) : jsonResponse([member()])),
      messages: () => jsonResponse([]),
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to load daily messages.");
    expect(screen.queryByTestId("daily-messages-no-members")).not.toBeInTheDocument();

    membersFail = false;
    fireEvent.click(screen.getByTestId("daily-messages-retry"));

    expect(await screen.findAllByTestId(/^daily-messages-day-/)).toHaveLength(14);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByTestId("daily-messages-retry")).not.toBeInTheDocument();
  });

  it("hides the day editor and offers Retry when the messages request fails", async () => {
    let messagesFail = true;
    stubFetch({
      members: () => jsonResponse([member()]),
      messages: () => (messagesFail ? jsonResponse(null, 500) : jsonResponse([message()])),
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to load daily messages.");
    expect(screen.queryAllByTestId(/^daily-messages-day-/)).toHaveLength(0);

    messagesFail = false;
    fireEvent.click(screen.getByTestId("daily-messages-retry"));

    expect(await screen.findAllByTestId(/^daily-messages-day-/)).toHaveLength(14);
    expect(screen.getByTestId("daily-messages-text-2026-01-15")).toHaveValue("Have a great day!");
  });
});
```

Run `npx vitest run tests/client/daily-messages-management.test.tsx`. Expected: the two new tests FAIL.

- [ ] **Step 2: Implement** in `DailyMessagesManagement.tsx`:
  - Add state after `error`: `const [loadFailed, setLoadFailed] = useState<"members" | "messages" | null>(null);` and `const [reloadKey, setReloadKey] = useState(0);`.
  - Members effect: at its start `setLoadFailed(null);`; in its `catch`: `if (!cancelled) { setError(loadErrorMessage); setLoadFailed("members"); }`; add `reloadKey` to the dependency array.
  - Messages effect: at its start (next to `setError(null)`) `setLoadFailed(null);`; in its `catch` when `requestId === loadRequestIdRef.current`: `setError(loadErrorMessage); setLoadFailed("messages");`; add `reloadKey` to the dependency array.
  - `deleteMessage` catch: use `t("dailyMessages.management.deleteError")` instead of `loadErrorMessage`.
  - Render: right after `<ErrorNotice .../>` add

```tsx
      {loadFailed && (
        <Button
          type="button"
          variant="outline"
          className="self-start"
          data-testid="daily-messages-retry"
          onClick={() => setReloadKey((key) => key + 1)}
        >
          {t("dailyMessages.management.retry")}
        </Button>
      )}
```

  Change the body guard `{!loadingMembers && (activeMembers.length === 0 ? ...` to `{!loadingMembers && loadFailed !== "members" && (...)`; and change `{loadingMessages ? (...loading...) : (<ul>...)}` to `{loadingMessages ? (...) : loadFailed === "messages" ? null : (<ul>...)}`.
- [ ] **Step 3: Run GREEN.** `npx vitest run tests/client/daily-messages-management.test.tsx tests/client/admin-household-timezone-defaults.test.tsx tests/client/day-periods-messages-admin.test.tsx`. Expected: PASS.
- [ ] **Step 4: Commit** `git add -A && git commit -m "feat(admin): retry failed loads on the messages page"`.

---

### Task 7: Update the e2e specs and the household contract

**Files:** Modify `tests/e2e/reminders.spec.ts`, `tests/e2e/reminders-calendar-gated.spec.ts`, `tests/e2e/admin-household-timezone-defaults.spec.ts`, `tests/e2e/admin-unlock-resilience.spec.ts`, `docs/ui/household-contract.md`.

- [ ] **Step 1: `admin-unlock-resilience.spec.ts`** lines 104-107: replace the reminders `primary` with `(page) => page.getByTestId("reminders-add-rule")`. (The page loads rules before showing the button; the spec already waits on `primary`.)
- [ ] **Step 2: `admin-household-timezone-defaults.spec.ts`.** Capture the id: `const reminderId = ((await reminderResponse.json()) as { id: string }).id;` right after `expect(reminderResponse.status()).toBe(201);`. Replace the `reminderCard` locator (lines ~83-86) with `const reminderCard = page.getByTestId(\`reminder-${reminderId}\`);`. Rest unchanged.
- [ ] **Step 3: `reminders.spec.ts`.** Update the top comment (the form is now a dialog). After the loading wait (step 6), replace steps 7 and 8 and add a step 8b:

```ts
  const dialog = page.getByTestId("reminder-form-dialog");
  const addRule = page.getByTestId("reminders-add-rule");

  // --- 7) Create an apply_to_all scheduled reminder (US1/AC-03) ---
  const applyToAllText = `Sacar la basura ${rid}`;
  await addRule.click();
  await dialog.getByPlaceholder(m["reminders.management.textPlaceholder"]).fill(applyToAllText);
  // targetingMode defaults to apply_to_all — only the weekday checkbox row needs a toggle.
  await dialog.getByLabel(m[`reminders.weekday.${weekdayAll}` as MessageKey]).check();

  const [applyToAllCreateResp] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith("/api/reminders") && r.request().method() === "POST"
    ),
    dialog.getByTestId("reminder-save").click(),
  ]);
  expect(applyToAllCreateResp.status()).toBe(201);
  const applyToAllReminder = (await applyToAllCreateResp.json()) as Reminder;
  expect(applyToAllReminder.targetingMode).toBe("apply_to_all");
  await expect(dialog).toBeHidden();
  await expect(page.getByText(applyToAllText)).toBeVisible({ timeout: 10_000 });

  // --- 8) Create a specific reminder with per-member assignments via the matrix (US2/INV-09/AC-03) ---
  const specificText = `Coges el bus ${rid}`;
  await addRule.click();
  await dialog.getByPlaceholder(m["reminders.management.textPlaceholder"]).fill(specificText);
  await dialog.getByLabel(m["reminders.management.targetingSpecific"]).check();

  const rowOf = (memberName: string) => dialog.locator("tr").filter({ hasText: memberName });
  await rowOf(memberAName).locator('input[type="checkbox"]').nth(WEEKDAY_ORDER.indexOf(weekdayA)).check();
  await rowOf(memberBName).locator('input[type="checkbox"]').nth(WEEKDAY_ORDER.indexOf(weekdayB)).check();

  const [specificCreateResp] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith("/api/reminders") && r.request().method() === "POST"
    ),
    dialog.getByTestId("reminder-save").click(),
  ]);
  expect(specificCreateResp.status()).toBe(201);
  const specificReminder = (await specificCreateResp.json()) as Reminder;
  expect(specificReminder.targetingMode).toBe("specific");
  await expect(dialog).toBeHidden();
  await expect(page.getByText(specificText)).toBeVisible({ timeout: 10_000 });
```

  Then after the existing step-9 assertions append:

```ts
  // --- 10) Edit the apply_to_all rule into a specific one for member A only (targetingMode edit) ---
  await page.getByTestId(`reminder-edit-${applyToAllReminder.id}`).click();
  await dialog.getByLabel(m["reminders.management.targetingSpecific"]).check();
  await rowOf(memberAName)
    .locator('input[type="checkbox"]')
    .nth(WEEKDAY_ORDER.indexOf(weekdayAll))
    .check();
  const [editResp] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().endsWith(`/api/reminders/${applyToAllReminder.id}`) &&
        r.request().method() === "PATCH"
    ),
    dialog.getByTestId("reminder-save").click(),
  ]);
  expect(editResp.status()).toBe(200);
  expect(((await editResp.json()) as Reminder).targetingMode).toBe("specific");
  await expect(dialog).toBeHidden();
  expect(await emissionIds(memberAId, dateAllYes)).toContain(applyToAllReminder.id);
  expect(await emissionIds(memberBId, dateAllYes)).not.toContain(applyToAllReminder.id);
```

  Keep `emissionIds` defined before this block (it is a function declaration inside the test body; move it above step 10 if needed).
- [ ] **Step 4: `reminders-calendar-gated.spec.ts`.** Replace step 7 through the card lookup in step 8:

```ts
  // --- 7) Author a calendar_gated `specific` reminder in the add dialog ---
  await page.getByTestId("reminders-add-rule").click();
  const createForm = page.getByTestId("reminder-form-dialog");
  await expect(createForm).toBeVisible();

  const reminderText = `Prepara al perro ${rid}`;
  await createForm.getByLabel(m["reminders.kind.calendarGated"]).check();
  await createForm.getByPlaceholder(m["reminders.management.textPlaceholder"]).fill(reminderText);
  await createForm.getByLabel(m["reminders.management.targetingSpecific"]).check();
  await createForm.getByPlaceholder(m["reminders.calendarGated.queryPlaceholder"]).fill(queryText);
  // queryFields defaults to [title, description] — the event title match is sufficient, no toggle needed.
  await createForm.getByLabel(memberName).check();

  const [createResp] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith("/api/reminders") && r.request().method() === "POST"
    ),
    createForm.getByTestId("reminder-save").click(),
  ]);
  expect(createResp.status()).toBe(201);
  const reminder = (await createResp.json()) as Reminder;
  expect(reminder.kind).toBe("calendar_gated");
  expect(reminder.targetingMode).toBe("specific");
  expect(reminder.weekdays).toBeNull();
  await expect(createForm).toBeHidden();
  await expect(page.getByText(reminderText)).toBeVisible({ timeout: 10_000 });

  // --- 8) Run the dry-run/explain view on this rule's row for (member, today) ---
  const card = page.getByTestId(`reminder-${reminder.id}`);
  await expect(card).toBeVisible();
```

  The rest of step 8 (toggle dry-run, select, date, Run, assertions) is unchanged. Update the file header comment's last line (no more create-form testid).
- [ ] **Step 5: Household contract.** In `docs/ui/household-contract.md`, after the Members paragraph in "Administration" add:

```markdown
Reminders are listed at `/admin/reminders`, one row per rule naming who it applies to and on which
days with an Active/Off badge. "Add rule" and the row's edit icon open one dialog; editing can switch
a rule between all members and specific members. Deleting asks for confirmation. A failed load can
be retried; a calendar-gated rule's row opens its dry-run panel. Messages (`/admin/daily-messages`)
keeps its 14-day editor and offers Retry when a load fails.
```

- [ ] **Step 6: Check.** `npx prettier --write tests/e2e/*.ts docs/ui/household-contract.md && npm run typecheck`. Expected: clean.
- [ ] **Step 7: Commit** `git add -A && git commit -m "test(admin): update the e2e specs and contract for the reminders dialog"`.

---

### Task 8: Gate part 1 — check:standard and cohort resync

- [ ] **Step 1: Format everything touched.** `npx prettier --write docs/superpowers docs/api docs/features docs/ui src tests` limited to changed files: `git diff --name-only main... | xargs npx prettier --write`. Commit if anything changed (`git commit -am "style: format"`). The tree must be clean and committed before the next step.
- [ ] **Step 2: Run the gate.** `npm run check:standard 2>&1 | tail -80`. Expected on first run: failures in `check:coverage` / `check:test-cohorts:standard` because `tests/fixtures/assembly-cohort.json` lists vitest case names and per-file coverage floors (renamed/added tests in `reminders-crud`, `reminders`, `daily-messages-management`; coverage totals for `RemindersManagement.tsx`, `reminders/index.ts`, `DailyMessagesManagement.tsx`). Read the verifier output; it prints the differences.
- [ ] **Step 3: Resync `tests/fixtures/assembly-cohort.json`** as the repo tooling describes (`tools/verify-test-cohorts.mjs` and `tools/verify-coverage.mjs` print which entries to add/remove and the measured coverage). Edit only: the vitest case names under `testCohorts.runners` for the three test files above, and the `coveragePolicy.files` entries for the three source files (set each to the measured value; lower a floor only because the file shrank, and say so in the commit message). Do not touch route or e2e entries (no routes or Playwright titles changed). Commit: `git commit -am "test: resync the reviewed inventory for the reminders and messages work"`.
- [ ] **Step 4: Re-run** `npm run check:standard`. Expected: PASS end to end. If `check:accessible-names` fails, add the missing `aria-label` it names. If `check:ui-debt` or lint complains about the new markup, fix the markup (use tokens, not raw colors), never suppress.

### Task 9: Gate part 2 — affected e2e on port 43204

- [ ] **Step 1: Run**

```bash
PORT=43204 npx playwright test tests/e2e/reminders.spec.ts tests/e2e/reminders-calendar-gated.spec.ts tests/e2e/daily-messages.spec.ts tests/e2e/admin-household-timezone-defaults.spec.ts tests/e2e/admin-unlock-resilience.spec.ts tests/e2e/accessible-names-audit.spec.ts --workers=3
```

  Expected: all PASS. (Do not use any other port; other workers use theirs.) If the dialog's Enter/keyboard focus or a locator flakes, fix the locator (prefer test ids) rather than adding sleeps.
- [ ] **Step 2: Manual smoke (optional but recommended).** Seed and run per the project's dev instructions, open `/admin/reminders`: Add rule, edit a rule All to Specific and back, dry-run a calendar-gated rule, delete one; open `/admin/daily-messages` and check Retry by stopping the API momentarily.

### Task 10: Commit on the worktree branch and report

- [ ] **Step 1:** `git status` must be clean; if the spec or plan changed during execution, re-copy them from the main checkout and commit.
- [ ] **Step 2:** Make sure the final commit(s) are on the worktree branch (`feat/admin-reminders-messages`), not `main`.
- [ ] **Step 3: Report** to the requester: branch name and commit list; what changed (server PATCH semantics, dialog UI, Messages Retry, titles); the three density numbers you ended with if they differ from the plan; the cohort-fixture entries you changed; the exact commands and results of `check:standard` and the PORT=43204 e2e run; any deviation from this plan with the reason.
