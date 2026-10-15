# Admin Routines & Chores Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `/admin/routines` as the reference app's master/detail page (grouped list, week grid, dialogs, drag-to-reorder) while keeping our streak-warning confirmations, and let a routine move to another day period, with routines listed by period start time then name.

**Architecture:** A thin orchestrator (`src/client/admin/RoutinesManagement.tsx`) loads data, owns selection and performs every mutation; focused presentational components live in `src/client/routines/admin/` (mirroring `src/client/calendar/admin/`). The server change is confined to `editRoutine` and `listRoutines` in `src/server/modules/routines/index.ts`; no migration.

**Tech Stack:** React 19, TypeScript 5.7, Tailwind 4 tokens, Radix (via `src/client/components/ui/*` only), `@dnd-kit/core` 6.3.1 + `@dnd-kit/sortable` 10.0.0, Fastify 5, better-sqlite3, Vitest 5 (jsdom + node projects), Playwright 1.63.

**Spec:** `docs/superpowers/specs/2026-10-15-admin-routines-design.md` (read it first; its "Decisions / Assumptions" are binding).

## Global Constraints

- Work in your own git worktree/branch `feat/admin-routines` created from `main`. The spec and this plan are UNTRACKED files in the main checkout `<maintainer-workspace>`; copy both into the same relative paths in your worktree and commit them with the work.
- Never touch the reference app `<marplanner-v1>` (read-only) or its database.
- Page heading must equal the sidebar label: "Routines & Chores" (en) / "Rutinas y tareas" (es).
- Reuse `src/client/components/ui/*` (Button, Dialog, Input, Label, Select) and the shared composites (`AdminPanel`, `ConfirmDialog`, `ErrorNotice`, `WeekdayPicker`, `EmojiPicker` at `@/chores/EmojiPicker`). Do NOT add a shared primitive. No raw `<button>/<input>/<select>/<textarea>` (lint rule `ui-policy/raw-controls`). No height/font-size classes on Buttons/Inputs (`ui-policy/sizing`). Inline `style` only for token forwarding with the exact per-line disable comment used in this plan (`ui-policy/debt`).
- No `window.confirm`. Every streak-affecting action (routine delete, chore delete, changing/reactivating an existing assignment, deactivating an assignment, moving a routine to another period) goes through `ConfirmDialog` with `routines.action.streakWarning` text.
- i18n: new keys only in ONE contiguous block per locale, starting with the comment `// admin-routines`, inserted directly after the `"admin.notFound.description"` line (en ≈ line 263, es ≈ line 1549) of `src/client/i18n/messages.ts`. Do not delete existing `routines.*` keys.
- Shared hot files (other workers edit them in parallel): `src/client/i18n/messages.ts`, `src/client/admin/AdminRoutes.tsx` (do NOT touch), `src/shared/index.ts`, `tests/fixtures/assembly-cohort.json`, `docs/ui/household-contract.md`. Keep edits minimal and localized.
- Technical text (code, comments, commit messages) in English. Commit messages: conventional style, e.g. `feat(routines): ...`.
- e2e port for this work: `PORT=43201`. Always `--workers=3`.
- `npm run check:standard` must pass from a clean, committed tree before you report.

## Review Focus

1. Switching routines while the previous routine's chores are still loading must never show the old routine's chores under the new header (stale response). Test: Task 4 "ignores a stale detail response".
2. Pressing Enter twice quickly in the chore dialog must create one chore, not two. Test: Task 4 "Enter twice creates the chore once".
3. A very long routine name with no spaces must wrap in the list and the detail header, never scroll the page sideways. Test: Task 7 e2e overflow assertion.
4. A failed reorder must put the chores back in the order the server has, not leave the optimistic order on screen. Test: Task 4 "a failed reorder restores the order".
5. A deactivated assignment must not appear in the week grid and must open with no days ticked (re-saving it is a reactivation and must confirm). Tests: Task 4 "week grid shows only active assignments" and "a deactivated assignment starts empty".

---

### Task 0: Worktree and baseline

**Files:** none changed.

- [ ] **Step 1:** Create a worktree and branch from `main` with the `superpowers:using-git-worktrees` skill. Branch: `feat/admin-routines`. If every git command is refused in your environment, do not work around it: do the work, skip commit steps, and in the final report list every changed/added/deleted file instead.
- [ ] **Step 2:** Copy the two untracked docs into the worktree (same relative paths):

```bash
MAIN=<maintainer-workspace>
cp "$MAIN/docs/superpowers/specs/2026-10-15-admin-routines-design.md" docs/superpowers/specs/
cp "$MAIN/docs/superpowers/plans/2026-10-15-admin-routines.md" docs/superpowers/plans/
```

- [ ] **Step 3:** Install and confirm a green baseline for the files this plan touches:

```bash
npm ci
npx vitest run tests/client/routines.test.tsx tests/boundary/routines-crud.test.ts tests/boundary/seed-routines-reminders.test.ts tests/integration/seed-routines-reminders.test.ts tests/client/routines-i18n-parity.test.ts
```

Expected: all PASS.

- [ ] **Step 4:** Commit the docs: `git add docs/superpowers && git commit -m "docs(routines): add admin routines design and plan"`.

---

### Task 1: Server — move a routine between day periods; list by period start then name

**Files:**

- Modify: `src/server/modules/routines/index.ts` (`editRoutine` ≈ lines 165-224, `listRoutines` ≈ lines 593-606)
- Modify: `src/shared/index.ts` (`RoutineEditInput` ≈ lines 292-298)
- Modify: `tests/boundary/routines-crud.test.ts` (header comment line 14; test at ≈ lines 284-317)
- Modify: `docs/api/chores/openapi.yaml`, `docs/features/routines-chores.md`, `docs/quality/api-contract-audit.md` (line ≈ 50)

**Interfaces:**

- Produces: `PATCH /api/routines/:id` accepts optional `dayPeriodId: string` (existing day period id) → 200 `Routine`; invalid → 400 `{ error: "validation_error" }` and no write. `GET /api/routines` order: period `start_minutes` ASC, `name COLLATE NOCASE` ASC, `created_at` ASC. Shared `RoutineEditInput` gains `dayPeriodId?: string`.

- [ ] **Step 1: Write the failing tests.** In `tests/boundary/routines-crud.test.ts`, change header line 14 to ` * Rule 2 — a routine may move to another existing day period (FR-015); unknown periods are rejected`. Replace the whole test `it("PATCH /api/routines/:id ignores dayPeriodId — stored value NEVER changes (Rule 2)", ...)` with these three tests (same helpers as the rest of the file):

```ts
it("PATCH /api/routines/:id moves the routine to another day period (FR-015)", async () => {
  seedDayPeriods();
  const { deviceKey } = seedKeys();
  const { buildApp } = await import("../../src/server/app.ts");
  const app = await buildApp();
  try {
    const cookies = { mp_device_key: deviceKey };
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/routines",
        cookies,
        payload: { name: "Movable", dayPeriodId: "morning" },
      })
    ).json();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/routines/${created.id}`,
      cookies,
      payload: { dayPeriodId: "night" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ...created, dayPeriodId: "night" });

    const reread = await app.inject({ method: "GET", url: `/api/routines/${created.id}`, cookies });
    expect(reread.json().dayPeriodId).toBe("night");
  } finally {
    await app.close();
  }
});

it("PATCH /api/routines/:id rejects an unknown, blank or non-string dayPeriodId without changing the routine (FR-015)", async () => {
  seedDayPeriods();
  const { deviceKey } = seedKeys();
  const { buildApp } = await import("../../src/server/app.ts");
  const app = await buildApp();
  try {
    const cookies = { mp_device_key: deviceKey };
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/routines",
        cookies,
        payload: { name: "Stays put", dayPeriodId: "morning" },
      })
    ).json();

    for (const dayPeriodId of ["lunchtime", "   ", 7]) {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/routines/${created.id}`,
        cookies,
        payload: { name: "Renamed", dayPeriodId },
      });
      expect(res.statusCode, String(dayPeriodId)).toBe(400);
      expect(res.json()).toMatchObject({ error: "validation_error", message: expect.any(String) });
    }

    const reread = await app.inject({ method: "GET", url: `/api/routines/${created.id}`, cookies });
    expect(reread.json()).toEqual(created);
  } finally {
    await app.close();
  }
});

it("GET /api/routines lists active routines by day-period start, then name (FR-016)", async () => {
  seedDayPeriods();
  const { deviceKey } = seedKeys();
  const { buildApp } = await import("../../src/server/app.ts");
  const app = await buildApp();
  try {
    const cookies = { mp_device_key: deviceKey };
    for (const [name, dayPeriodId] of [
      ["zeta", "evening"],
      ["Bravo", "morning"],
      ["Night owl", "night"],
      ["alpha", "morning"],
      ["Lunch", "afternoon"],
    ]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/routines",
        cookies,
        payload: { name, dayPeriodId },
      });
      expect(res.statusCode).toBe(201);
    }
    const list = (await app.inject({ method: "GET", url: "/api/routines", cookies })).json();
    expect(list.map((r: { name: string }) => r.name)).toEqual([
      "alpha",
      "Bravo",
      "Lunch",
      "zeta",
      "Night owl",
    ]);
  } finally {
    await app.close();
  }
});
```

- [ ] **Step 2: Run to verify they fail.** `npx vitest run tests/boundary/routines-crud.test.ts` → the three new tests FAIL (period not moved, 200 instead of 400, creation order instead of period order).

- [ ] **Step 3: Implement.** In `src/server/modules/routines/index.ts`:

Replace the `editRoutine` doc comment with:

```ts
/** Edit a routine's name, active flag and/or day period.
 * A dayPeriodId must be a non-blank string naming an existing day period (FR-015);
 * every field is validated before anything is written.
 */
```

Replace the comment line `// Only write name and active — dayPeriodId is NEVER written (Rule 2)` with `// Validate every supplied field first; the UPDATE runs only after all pass.` and add this block right after the `active` block (before `// If nothing to update, return current state`):

```ts
if ("dayPeriodId" in typed && typed.dayPeriodId !== undefined) {
  if (typeof typed.dayPeriodId !== "string" || typed.dayPeriodId.trim().length === 0) {
    throw new RoutineValidationError("dayPeriodId must be a non-blank string");
  }
  const dayPeriodId = typed.dayPeriodId.trim();
  validateDayPeriodId(dayPeriodId);
  updates.push("day_period_id = ?");
  params.push(dayPeriodId);
}
```

Replace `listRoutines` with:

```ts
/** List active routines, ordered by their day period's start time, then name (FR-016).
 * LEFT JOIN so the ordering join can never drop a routine.
 */
export function listRoutines(): Routine[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT r.id, r.name, r.day_period_id, r.active
         FROM routines r
         LEFT JOIN day_periods dp ON dp.id = r.day_period_id
        WHERE r.active = 1
        ORDER BY dp.start_minutes IS NULL, dp.start_minutes ASC,
                 r.name COLLATE NOCASE ASC, r.created_at ASC`
    )
    .all() as Array<{ id: string; name: string; day_period_id: string; active: number }>;

  return rows.map(rowToRoutine);
}
```

(`DayPeriodNotFoundError` from `validateDayPeriodId` is already mapped to 400 `validation_error` by `handleRoutineError` in `src/server/routes/routines.ts`.)

In `src/shared/index.ts` replace the `RoutineEditInput` block with:

```ts
/** RoutineEditInput — edit payload: name, active flag and/or day period (FR-015).
 * (no `required` list — all fields optional).
 */
export interface RoutineEditInput {
  name?: string;
  active?: boolean;
  dayPeriodId?: string;
}
```

- [ ] **Step 4: Run to verify they pass.** `npx vitest run tests/boundary/routines-crud.test.ts tests/boundary/routines-assignments.test.ts tests/boundary/routines-board.test.ts` → all PASS.

- [ ] **Step 5: Contract and docs.** In `docs/api/chores/openapi.yaml`:
  - `Routine.properties.dayPeriodId.description`: `immutable after creation (FR-017).` → `Day period the routine belongs to; PATCH may move it (FR-015).`
  - `RoutineInput.description`: → `Create payload.`
  - `RoutineEditInput.description`: → `Edit payload — any of name, active and dayPeriodId (FR-015).`
  - `RoutineEditInput.properties.dayPeriodId`: replace its single `description:` line with:

```yaml
dayPeriodId:
  type: string
  minLength: 1
  description: Moves the routine to another existing day period; blank or unknown values are rejected (FR-015).
```

- `GET /api/routines` summary → `List active routines, ordered by day-period start time, then name (FR-016).`
- `POST /api/routines` summary → `Create a routine attached to one day period.`
- `PATCH /api/routines/{id}` summary → `Edit a routine's name, active flag and/or day period (FR-015).`; its `"400"` description → `validation (blank name, non-boolean active, blank or unknown dayPeriodId)`.

In `docs/features/routines-chores.md` add after FR-014:

```markdown
- **FR-015**: Given a routine edit that names a `dayPeriodId`, when it is applied, then the id MUST be a non-blank string naming an existing day period or the whole edit MUST be rejected (400) with nothing written; when accepted, the routine moves to that period and the board shows it there immediately. Admins MUST be warned that moving a routine changes the live streak before they confirm (FR-009).

- **FR-016**: Given the admin routine list, when it is read, then active routines MUST be ordered by their day period's start time, then by name (case-insensitive).
```

and change the Key Entities line to `- **Routine**: a named active/inactive template attached to exactly one day period, which an admin may change (FR-015).`

In `docs/quality/api-contract-audit.md` replace `Routine edits continue to accept and ignore an immutable dayPeriodId.` with `Routine edits may move a routine to another existing day period (FR-015).`

- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat(routines): let a routine move to another day period and list routines by period start"`

---

### Task 2: Seed — afternoon routine, more chores, per-assignment weekdays

**Files:**

- Modify: `seeds/seed-040-routines.ts`
- Modify: `tests/boundary/seed-routines-reminders.test.ts` (≈ lines 40-53), `tests/integration/seed-routines-reminders.test.ts` (≈ lines 41-54)

- [ ] **Step 1: Write the failing tests.** In `tests/boundary/seed-routines-reminders.test.ts` replace the `expect(listRoutines()).toEqual([...])` block with:

```ts
expect(listRoutines()).toEqual([
  {
    id: "demo:routine:morning-launch",
    name: "Morning launch",
    dayPeriodId: "morning",
    active: true,
  },
  {
    id: "demo:routine:after-school",
    name: "After school",
    dayPeriodId: "afternoon",
    active: true,
  },
  {
    id: "demo:routine:evening-reset",
    name: "Evening reset",
    dayPeriodId: "evening",
    active: true,
  },
]);
expect(listRoutineAssignments("demo:routine:after-school")).toEqual([
  {
    id: "demo:routine-assignment:after-school:lisa",
    memberId: "demo:member:lisa",
    weekdays: ["mon", "tue", "wed", "thu"],
    active: true,
  },
  {
    id: "demo:routine-assignment:after-school:bart",
    memberId: "demo:member:bart",
    weekdays: ["mon", "wed", "fri"],
    active: true,
  },
]);
```

In `tests/integration/seed-routines-reminders.test.ts` replace the `expect(JSON.parse(routines.body)).toEqual([...])` array with the same three routine objects (same order).

- [ ] **Step 2: Run to verify they fail.** `npx vitest run tests/boundary/seed-routines-reminders.test.ts tests/integration/seed-routines-reminders.test.ts` → FAIL (after-school missing).

- [ ] **Step 3: Implement.** In `seeds/seed-040-routines.ts`:
  - Rename `const WEEKDAYS = [...]` to `const MON_TO_FRI = ["mon", "tue", "wed", "thu", "fri"] as const;`.
  - Add to `ROUTINES` (between morning and evening): `{ id: "demo:routine:after-school", name: "After school", dayPeriodId: "afternoon" },`
  - Append to `CHORES`:

```ts
  {
    id: "demo:chore:evening-reset:shower",
    routineId: "demo:routine:evening-reset",
    name: "Take a shower",
    icon: "🚿",
    sortOrder: 2,
  },
  {
    id: "demo:chore:after-school:snack",
    routineId: "demo:routine:after-school",
    name: "Have a snack",
    icon: "🍎",
    sortOrder: 0,
  },
  {
    id: "demo:chore:after-school:homework",
    routineId: "demo:routine:after-school",
    name: "Homework",
    icon: "📚",
    sortOrder: 1,
  },
  {
    id: "demo:chore:after-school:water-plants",
    routineId: "demo:routine:after-school",
    name: "Water the plants",
    icon: "🪴",
    sortOrder: 2,
  },
```

- Give every existing `ASSIGNMENTS` entry `weekdays: MON_TO_FRI,` and append:

```ts
  {
    id: "demo:routine-assignment:after-school:lisa",
    routineId: "demo:routine:after-school",
    memberId: "demo:member:lisa",
    weekdays: ["mon", "tue", "wed", "thu"],
  },
  {
    id: "demo:routine-assignment:after-school:bart",
    routineId: "demo:routine:after-school",
    memberId: "demo:member:bart",
    weekdays: ["mon", "wed", "fri"],
  },
```

- Delete the line `const weekdays = JSON.stringify(validateWeekdays(WEEKDAYS));` and in the assignment loop pass `JSON.stringify(validateWeekdays(assignment.weekdays))` instead of `weekdays`.

All four emojis are already in `src/client/chores/emoji-catalog.ts`, so `npm run check:noto-emojis` stays green.

- [ ] **Step 4: Run to verify they pass.** Same command as Step 2 → PASS. Also `npx tsc -b` → no errors.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(seeds): add an afternoon routine and per-assignment weekdays to the demo routines"`

---

### Task 3: Strings — page title and the `// admin-routines` block

**Files:**

- Modify: `src/client/i18n/messages.ts`
- Modify: `tests/client/routines-i18n-parity.test.ts` (lines 47 and 110)

- [ ] **Step 1: Write the failing test.** In `tests/client/routines-i18n-parity.test.ts` change line 47 to `expect(messages.en["routines.management.title"]).toBe("Routines & Chores");` and line 110 to `expect(messages.es["routines.management.title"]).toBe("Rutinas y tareas");`, and add at the end of the same `it(...)` body:

```ts
expect(messages.en["routines.admin.selectPrompt"]).toBe("Select a routine to manage its chores");
expect(messages.es["routines.admin.selectPrompt"]).toBe(
  "Selecciona una rutina para gestionar sus tareas"
);
expect(messages.en["routines.management.title"]).toBe(messages.en["admin.sidebar.routines"]);
expect(messages.es["routines.management.title"]).toBe(messages.es["admin.sidebar.routines"]);
```

- [ ] **Step 2: Run to verify it fails.** `npx vitest run tests/client/routines-i18n-parity.test.ts` → FAIL.
- [ ] **Step 3: Implement.** In `messages.ts` set en `"routines.management.title": "Routines & Chores"` and es `"routines.management.title": "Rutinas y tareas"`. Insert directly after the en line `"admin.notFound.description": "Open a known admin destination to continue.",`:

```ts
    // admin-routines
    "routines.admin.new": "New routine",
    "routines.admin.selectPrompt": "Select a routine to manage its chores",
    "routines.admin.editRoutine": "Edit routine",
    "routines.admin.assign": "Assign",
    "routines.admin.deleteRoutine": "Delete routine",
    "routines.admin.manageAssignments": "Manage assignments",
    "routines.admin.noChores": "No chores yet. Add one above.",
    "routines.admin.routineFormDescription": "Name the routine and choose when in the day it happens.",
    "routines.admin.nameLabel": "Name",
    "routines.admin.dayPeriodLabel": "Day period",
    "routines.admin.saveChanges": "Save changes",
    "routines.admin.movePeriodTitle": "Move this routine to another day period?",
    "routines.admin.movePeriodConfirm": "Move",
    "routines.admin.editChore": "Edit chore",
    "routines.admin.choreFormDescription": "Pick an icon and name the chore.",
    "routines.admin.choreNameLabel": "Chore",
    "routines.admin.saveChore": "Save chore",
    "routines.admin.editChoreAria": "Edit {name}",
    "routines.admin.deleteChoreAria": "Delete {name}",
    "routines.admin.dragChore": "Reorder {name}",
    "routines.admin.dragInstructions":
      "Press space to pick up a chore, use the arrow keys to move it, then press space to drop it or escape to cancel.",
    "routines.admin.dragStarted": "Picked up {name}.",
    "routines.admin.dragOver": "{name} is over position {position}.",
    "routines.admin.dragEnded": "{name} dropped.",
    "routines.admin.dragCancelled": "Reordering cancelled.",
    "routines.admin.assignTitle": "Assign routine",
    "routines.admin.assignDescription": "Choose the weekdays each child does this routine.",
    "routines.admin.noChildren": "There are no children to assign yet. Add one in Members.",
    "routines.admin.retry": "Retry",
    "routines.admin.detailError": "Failed to load this routine's chores and assignments.",
    "routines.admin.saveError": "The routine could not be saved.",
    "routines.admin.choreSaveError": "The chore could not be saved.",
```

and directly after the es line `"admin.notFound.description": "Abre un destino de administración conocido para continuar.",`:

```ts
    // admin-routines
    "routines.admin.new": "Nueva rutina",
    "routines.admin.selectPrompt": "Selecciona una rutina para gestionar sus tareas",
    "routines.admin.editRoutine": "Editar rutina",
    "routines.admin.assign": "Asignar",
    "routines.admin.deleteRoutine": "Eliminar rutina",
    "routines.admin.manageAssignments": "Gestionar asignaciones",
    "routines.admin.noChores": "Aún no hay tareas. Añade una arriba.",
    "routines.admin.routineFormDescription":
      "Pon nombre a la rutina y elige en qué momento del día ocurre.",
    "routines.admin.nameLabel": "Nombre",
    "routines.admin.dayPeriodLabel": "Período del día",
    "routines.admin.saveChanges": "Guardar cambios",
    "routines.admin.movePeriodTitle": "¿Mover esta rutina a otro período del día?",
    "routines.admin.movePeriodConfirm": "Mover",
    "routines.admin.editChore": "Editar tarea",
    "routines.admin.choreFormDescription": "Elige un icono y pon nombre a la tarea.",
    "routines.admin.choreNameLabel": "Tarea",
    "routines.admin.saveChore": "Guardar tarea",
    "routines.admin.editChoreAria": "Editar {name}",
    "routines.admin.deleteChoreAria": "Eliminar {name}",
    "routines.admin.dragChore": "Reordenar {name}",
    "routines.admin.dragInstructions":
      "Pulsa espacio para coger una tarea, muévela con las flechas y pulsa espacio para soltarla o escape para cancelar.",
    "routines.admin.dragStarted": "Has cogido {name}.",
    "routines.admin.dragOver": "{name} está sobre la posición {position}.",
    "routines.admin.dragEnded": "Has soltado {name}.",
    "routines.admin.dragCancelled": "Reordenación cancelada.",
    "routines.admin.assignTitle": "Asignar rutina",
    "routines.admin.assignDescription": "Elige qué días hace cada niño esta rutina.",
    "routines.admin.noChildren": "Aún no hay niños a los que asignar. Añade uno en Miembros.",
    "routines.admin.retry": "Reintentar",
    "routines.admin.detailError": "No se pudieron cargar las tareas y asignaciones de esta rutina.",
    "routines.admin.saveError": "No se pudo guardar la rutina.",
    "routines.admin.choreSaveError": "No se pudo guardar la tarea.",
```

- [ ] **Step 4: Run.** `npx vitest run tests/client/routines-i18n-parity.test.ts` → PASS. `npx prettier --write src/client/i18n/messages.ts` (keeps the line wrapping prettier wants).
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(routines): name the page Routines & Chores and add the admin routine strings"`

---

### Task 4: Rebuild the page (master/detail, dialogs, drag reorder, assignments)

**Files:**

- Create: `src/client/routines/admin/routineOrder.ts`, `MemberChip.tsx`, `RoutineList.tsx`, `RoutineWeekGrid.tsx`, `SortableChoreRow.tsx`, `RoutineDetail.tsx`, `RoutineFormDialog.tsx`, `ChoreFormDialog.tsx`, `AssignmentDialog.tsx` (all under `src/client/routines/admin/`)
- Rewrite: `src/client/admin/RoutinesManagement.tsx`
- Delete: `src/client/admin/ChoreOrderControls.tsx`, `tests/client/chore-order-controls.test.tsx`
- Create: `tests/client/routines-admin-order.test.ts`
- Rewrite: `tests/client/routines.test.tsx`

**Interfaces (produced here, used by later tasks/tests):**

- `groupRoutinesByPeriod(routines: readonly Routine[], dayPeriods: readonly DayPeriodDTO[]): RoutineGroup[]`, `interface RoutineGroup { period: DayPeriodDTO; routines: Routine[] }`
- `moveChore(chores: readonly Chore[], activeId: string, overId: string): Chore[] | null`
- `WEEKDAY_LABEL_KEYS: Record<Weekday, MessageKey>`, `weekdayLabels(t): WeekdayLabels` (exported from `RoutineWeekGrid.tsx`)
- Test ids: `routines-management` (page root), `routines-new`, `routines-retry`, `routines-empty`, `routines-select-prompt`, `routine-list-item-<id>` (`aria-current="true"` when selected), `routine-detail` (`data-routine-id`), `routine-detail-retry`, `routine-edit`, `routine-assign`, `routine-add-chore`, `routine-delete`, `routine-delete-confirm-<id>`/`routine-delete-cancel-<id>`, `routine-week-grid`, `routine-week-day-<mon..sun>`, `routine-chores-empty`, `chore-<id>`, `chore-drag-<id>`, `chore-edit-<id>`, `chore-delete-<id>`, `routine-<routineId>-chore-delete-confirm`/`-cancel`, `routine-form-dialog`, `routine-form-name`, `routine-form-period`, `routine-form-submit`, `routine-period-confirm`/`-cancel`, `chore-form-dialog`, `chore-form-name`, `chore-form-submit`, `assignment-dialog`, `routine-assignment-<memberId>`, `routines-weekday-<memberId>-<day>`, `routines-assignment-<memberId>-save`, `routines-assignment-<memberId>-deactivate`, `routines-assignment-<memberId>-save-confirm`/`-save-cancel`, `routines-assignment-<memberId>-deactivate-confirm`/`-deactivate-cancel`.

- [ ] **Step 1: Write the failing helper test** `tests/client/routines-admin-order.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Chore, DayPeriodDTO, Routine } from "../../src/shared";
import { groupRoutinesByPeriod, moveChore } from "@/routines/admin/routineOrder";

const PERIODS: DayPeriodDTO[] = [
  { id: "evening", labelKey: "dayPeriod.evening", start: "17:00", sortOrder: 2 },
  { id: "morning", labelKey: "dayPeriod.morning", start: "06:00", sortOrder: 0 },
  { id: "afternoon", labelKey: "dayPeriod.afternoon", start: "12:00", sortOrder: 1 },
];
const routine = (id: string, dayPeriodId: string): Routine => ({
  id,
  name: id,
  dayPeriodId,
  active: true,
});
const chore = (id: string, sortOrder: number): Chore => ({
  id,
  routineId: "r",
  name: id,
  icon: null,
  sortOrder,
  active: true,
});

describe("groupRoutinesByPeriod", () => {
  it("orders groups by period start, keeps arrival order inside a group and drops empty periods", () => {
    const groups = groupRoutinesByPeriod(
      [routine("b", "evening"), routine("z", "morning"), routine("a", "morning")],
      PERIODS
    );
    expect(groups.map((g) => [g.period.id, g.routines.map((r) => r.id)])).toEqual([
      ["morning", ["z", "a"]],
      ["evening", ["b"]],
    ]);
  });

  it("returns no groups without routines", () => {
    expect(groupRoutinesByPeriod([], PERIODS)).toEqual([]);
  });
});

describe("moveChore", () => {
  const chores = [chore("a", 0), chore("b", 1), chore("c", 2)];

  it("moves a chore onto another's slot and renumbers sortOrder", () => {
    expect(moveChore(chores, "a", "c")?.map((c) => [c.id, c.sortOrder])).toEqual([
      ["b", 0],
      ["c", 1],
      ["a", 2],
    ]);
  });

  it("returns null when nothing moves or an id is unknown", () => {
    expect(moveChore(chores, "a", "a")).toBeNull();
    expect(moveChore(chores, "x", "a")).toBeNull();
    expect(moveChore(chores, "a", "x")).toBeNull();
  });
});
```

- [ ] **Step 2:** `npx vitest run tests/client/routines-admin-order.test.ts` → FAIL (module not found).

- [ ] **Step 3: Create `src/client/routines/admin/routineOrder.ts`:**

```ts
import { arrayMove } from "@dnd-kit/sortable";
import type { Chore, DayPeriodDTO, Routine } from "../../../shared";

export interface RoutineGroup {
  period: DayPeriodDTO;
  routines: Routine[];
}

/** Groups routines under their day period. Periods follow their start time; routines keep the
 * order they arrived in (the server already sorts by period start, then name). Periods with no
 * routines are left out. */
export function groupRoutinesByPeriod(
  routines: readonly Routine[],
  dayPeriods: readonly DayPeriodDTO[]
): RoutineGroup[] {
  return [...dayPeriods]
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((period) => ({
      period,
      routines: routines.filter((routine) => routine.dayPeriodId === period.id),
    }))
    .filter((group) => group.routines.length > 0);
}

/** Moves one chore onto another's slot and renumbers `sortOrder`. Null when nothing moves. */
export function moveChore(
  chores: readonly Chore[],
  activeId: string,
  overId: string
): Chore[] | null {
  const from = chores.findIndex((chore) => chore.id === activeId);
  const to = chores.findIndex((chore) => chore.id === overId);
  if (from < 0 || to < 0 || from === to) return null;
  return arrayMove([...chores], from, to).map((chore, sortOrder) => ({ ...chore, sortOrder }));
}
```

- [ ] **Step 4:** `npx vitest run tests/client/routines-admin-order.test.ts` → PASS. Commit: `git add -A && git commit -m "feat(routines): add routine grouping and chore move helpers"`.

- [ ] **Step 5: Write the failing page test.** Replace the whole of `tests/client/routines.test.tsx` with:

```tsx
/** RoutinesManagement — master/detail admin page for routines, chores and weekday assignments.
 * Pins: grouping/selection, Retry on load errors, routine and chore dialogs, the streak-warning
 * confirmations (routine/chore delete, period move, existing assignment change, deactivate),
 * keyboard drag reorder, Spanish labels and kiosk density.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RoutinesManagement } from "@/admin/RoutinesManagement";
import { LanguageProvider } from "@/i18n";
import { DensityViolationError, assertKioskDensityCompliant } from "./helpers/density";
import { injectDensityStyles } from "./helpers/densityStyles";

// Radix Select scrolls the chosen option into view; jsdom has no scrollIntoView
// (same file-local stub as members-admin.test.tsx).
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? ((() => {}) as never);

type Json = Record<string, unknown>;
interface Call {
  url: string;
  method: string;
  body: unknown;
}

const MORNING = { id: "morning", labelKey: "dayPeriod.morning", start: "06:00", sortOrder: 0 };
const AFTERNOON = {
  id: "afternoon",
  labelKey: "dayPeriod.afternoon",
  start: "12:00",
  sortOrder: 1,
};
const EVENING = { id: "evening", labelKey: "dayPeriod.evening", start: "17:00", sortOrder: 2 };
const ROUTINE = { id: "r1", name: "Morning Routine", dayPeriodId: "morning", active: true };
const ROUTINE_EVENING = { id: "r2", name: "Evening Routine", dayPeriodId: "evening", active: true };
const CHORES = [
  { id: "c1", routineId: "r1", name: "Brush teeth", icon: "🪥", sortOrder: 0, active: true },
  { id: "c2", routineId: "r1", name: "Make bed", icon: null, sortOrder: 1, active: true },
  { id: "c3", routineId: "r1", name: "Pack bag", icon: "🎒", sortOrder: 2, active: true },
];
const EVENING_CHORE = {
  id: "c9",
  routineId: "r2",
  name: "Set table",
  icon: null,
  sortOrder: 0,
  active: true,
};
const member = (id: string, displayName: string, role: string, colorKey: string) => ({
  id,
  displayName,
  role,
  colorKey,
  lifecycle: "active",
  createdAt: 0,
  updatedAt: 0,
});
const CHILD = member("m1", "Ari", "child", "red");
const CHILD_2 = member("m2", "Bo", "child", "teal");
const PARENT = member("p1", "Pat", "parent", "blue");

interface Backend {
  routines?: Json[];
  dayPeriods?: Json[];
  chores?: Json[];
  choresFor?: (routineId: string) => Promise<Json[]>;
  assignments?: Json[];
  members?: Json[];
  language?: string;
  /** Return true to answer that request with a 500. */
  fail?: (url: string, method: string) => boolean;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function mockBackend(backend: Backend = {}): Call[] {
  const calls: Call[] = [];
  let routines: Json[] = [...(backend.routines ?? [ROUTINE, ROUTINE_EVENING])];
  const mockFetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (backend.fail?.(url, method)) return json({ error: "internal_error", message: "x" }, 500);
    if (url.includes("/api/settings")) {
      return json({ locale: { timezone: "UTC", language: backend.language ?? "en" } });
    }
    if (url === "/api/day-periods")
      return json(backend.dayPeriods ?? [MORNING, AFTERNOON, EVENING]);
    if (url === "/api/members") return json(backend.members ?? [CHILD, PARENT]);
    if (url === "/api/routines" && method === "GET") return json(routines);
    if (url === "/api/routines" && method === "POST") {
      const created = { id: "r-new", active: true, ...(body as Json) };
      routines = [...routines, created];
      return json(created, 201);
    }
    const routineMatch = url.match(/^\/api\/routines\/([^/]+)$/);
    if (routineMatch && method === "PATCH") {
      routines = routines.map((r) => (r.id === routineMatch[1] ? { ...r, ...(body as Json) } : r));
      return json(routines.find((r) => r.id === routineMatch[1]));
    }
    if (routineMatch && method === "DELETE") {
      routines = routines.filter((r) => r.id !== routineMatch[1]);
      return new Response(null, { status: 204 });
    }
    const choresMatch = url.match(/^\/api\/routines\/([^/]+)\/chores$/);
    if (choresMatch && method === "GET") {
      return json(
        backend.choresFor ? await backend.choresFor(choresMatch[1]) : (backend.chores ?? CHORES)
      );
    }
    if (choresMatch && method === "POST") {
      return json(
        { id: "c-new", routineId: choresMatch[1], sortOrder: 3, active: true, ...(body as Json) },
        201
      );
    }
    if (/\/chores\/order$/.test(url) && method === "PUT") {
      const ids = (body as { choreIds: string[] }).choreIds;
      return json(ids.map((id, sortOrder) => ({ ...CHORES.find((c) => c.id === id), sortOrder })));
    }
    if (/^\/api\/chores\/[^/]+$/.test(url) && method === "PATCH")
      return json({ ...CHORES[0], ...(body as Json) });
    if (/^\/api\/chores\/[^/]+$/.test(url) && method === "DELETE")
      return new Response(null, { status: 204 });
    if (/\/assignments$/.test(url) && method === "GET") return json(backend.assignments ?? []);
    const assignmentMatch = url.match(/\/assignments\/([^/]+)$/);
    if (assignmentMatch && method === "PUT") {
      return json({ id: "a-new", memberId: assignmentMatch[1], ...(body as Json) });
    }
    if (assignmentMatch && method === "DELETE") {
      return json({ id: "a1", memberId: assignmentMatch[1], weekdays: ["mon"], active: false });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", mockFetch);
  return calls;
}

const callsTo = (calls: Call[], method: string, url: string) =>
  calls.filter((call) => call.method === method && call.url === url);

function renderPage() {
  return render(
    <LanguageProvider>
      <RoutinesManagement />
    </LanguageProvider>
  );
}

async function selectRoutine(id = "r1") {
  fireEvent.click(await screen.findByTestId(`routine-list-item-${id}`));
  return screen.findByTestId("routine-detail");
}

async function chooseOption(comboboxName: string, optionText: string) {
  fireEvent.click(screen.getByRole("combobox", { name: comboboxName }));
  const options = await screen.findAllByRole("option");
  fireEvent.click(options.find((option) => option.textContent === optionText)!);
}

function choreOrder(): string[] {
  return screen.getAllByTestId(/^chore-c\d+$/).map((row) => row.dataset.testid ?? "");
}

async function keyboardDragFirstChoreDown() {
  const handle = screen.getByRole("button", { name: "Reorder Brush teeth" });
  screen.getAllByTestId(/^chore-c\d+$/).forEach((row, index) => {
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: index * 60,
      top: index * 60,
      left: 0,
      bottom: index * 60 + 50,
      right: 200,
      width: 200,
      height: 50,
      toJSON: () => ({}),
    });
  });
  handle.focus();
  await act(async () => {
    fireEvent.keyDown(handle, { key: "Space", code: "Space", keyCode: 32 });
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    fireEvent.keyDown(handle, { key: "ArrowDown", code: "ArrowDown", keyCode: 40 });
  });
  await act(async () => {
    fireEvent.keyDown(handle, { key: "Space", code: "Space", keyCode: 32 });
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  cleanup();
  document.documentElement.removeAttribute("data-density");
});

describe("RoutinesManagement — list and selection", () => {
  it("groups routines by day period in start order, names the page like the sidebar and asks for a selection", async () => {
    mockBackend({ routines: [ROUTINE_EVENING, ROUTINE] });
    renderPage();

    await screen.findByTestId("routine-list-item-r1");
    expect(screen.getAllByTestId(/^routine-list-item-/).map((item) => item.dataset.testid)).toEqual(
      ["routine-list-item-r1", "routine-list-item-r2"]
    );
    expect(screen.getAllByRole("heading", { level: 4 }).map((h) => h.textContent)).toEqual([
      "Morning",
      "Evening",
    ]);
    expect(screen.getByTestId("routines-select-prompt")).toHaveTextContent(
      "Select a routine to manage its chores"
    );
    expect(screen.getByRole("region", { name: "Routines & Chores" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: "Routines & Chores" })
    ).toBeInTheDocument();
  });

  it("shows the empty message without routines", async () => {
    mockBackend({ routines: [] });
    renderPage();
    expect(await screen.findByTestId("routines-empty")).toHaveTextContent("No routines found.");
  });

  it("announces a load failure and Retry loads again", async () => {
    let failOnce = true;
    mockBackend({
      fail: (url, method) => {
        if (url === "/api/routines" && method === "GET" && failOnce) {
          failOnce = false;
          return true;
        }
        return false;
      },
    });
    renderPage();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to load data.");
    expect(alert).toHaveAttribute("aria-live", "assertive");
    fireEvent.click(screen.getByTestId("routines-retry"));
    expect(await screen.findByTestId("routine-list-item-r1")).toBeInTheDocument();
  });

  it("shows the selected routine's header and chores in order, with the vendored Noto icon", async () => {
    mockBackend();
    renderPage();
    const detail = await selectRoutine("r1");

    expect(within(detail).getByRole("heading", { name: "Morning Routine" })).toBeInTheDocument();
    expect(detail).toHaveTextContent("Morning");
    await waitFor(() => expect(choreOrder()).toEqual(["chore-c1", "chore-c2", "chore-c3"]));
    expect(screen.getByTestId("routine-list-item-r1")).toHaveAttribute("aria-current", "true");
    expect(screen.getByTestId("routine-list-item-r2")).not.toHaveAttribute("aria-current");
    expect(screen.getByTestId("chore-c1").querySelector("img")).toHaveAttribute(
      "src",
      expect.stringContaining("emoji_u1faa5")
    );
  });

  it("shows the empty chore message for a routine without chores", async () => {
    mockBackend({ chores: [] });
    renderPage();
    const detail = await selectRoutine("r1");
    expect(within(detail).getByTestId("routine-chores-empty")).toHaveTextContent(
      "No chores yet. Add one above."
    );
  });

  it("announces a detail load failure and Retry loads it again", async () => {
    let failOnce = true;
    mockBackend({
      fail: (url) => {
        if (url === "/api/routines/r1/chores" && failOnce) {
          failOnce = false;
          return true;
        }
        return false;
      },
    });
    renderPage();
    fireEvent.click(await screen.findByTestId("routine-list-item-r1"));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Failed to load this routine's chores and assignments."
    );
    fireEvent.click(screen.getByTestId("routine-detail-retry"));
    expect(await screen.findByTestId("routine-detail")).toBeInTheDocument();
  });

  it("ignores a stale detail response after switching routines", async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    mockBackend({
      choresFor: async (routineId) => {
        if (routineId === "r1") {
          await gate;
          return CHORES;
        }
        return [EVENING_CHORE];
      },
    });
    renderPage();
    fireEvent.click(await screen.findByTestId("routine-list-item-r1"));
    const detail = await selectRoutine("r2");
    expect(await within(detail).findByText("Set table")).toBeInTheDocument();

    await act(async () => {
      releaseFirst();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByTestId("routine-detail")).toHaveAttribute("data-routine-id", "r2");
    expect(screen.queryByText("Brush teeth")).not.toBeInTheDocument();
  });

  it("week grid shows only active assignments, per weekday, and opens the assignment dialog", async () => {
    mockBackend({
      members: [CHILD, CHILD_2, PARENT],
      assignments: [
        { id: "a1", memberId: "m1", weekdays: ["mon", "wed"], active: true },
        { id: "a2", memberId: "m2", weekdays: ["mon"], active: false },
      ],
    });
    renderPage();
    await selectRoutine("r1");

    expect(screen.getByTestId("routine-week-day-mon")).toHaveTextContent("Ari");
    expect(screen.getByTestId("routine-week-day-mon")).not.toHaveTextContent("Bo");
    expect(screen.getByTestId("routine-week-day-tue")).not.toHaveTextContent("Ari");
    expect(screen.getByTestId("routine-week-day-wed")).toHaveTextContent("Ari");

    fireEvent.click(screen.getByRole("button", { name: "Manage assignments" }));
    expect(await screen.findByTestId("assignment-dialog")).toBeInTheDocument();
  });
});

describe("RoutinesManagement — routine dialog", () => {
  it("creates a routine: first period by default, submit disabled until named, new routine selected", async () => {
    const calls = mockBackend();
    renderPage();
    fireEvent.click(await screen.findByTestId("routines-new"));
    const dialog = await screen.findByTestId("routine-form-dialog");

    expect(within(dialog).getByTestId("routine-form-submit")).toBeDisabled();
    expect(within(dialog).getByRole("combobox", { name: "Day period" })).toHaveTextContent(
      "Morning"
    );
    fireEvent.change(within(dialog).getByTestId("routine-form-name"), {
      target: { value: "  Homework  " },
    });
    fireEvent.click(within(dialog).getByTestId("routine-form-submit"));

    await waitFor(() =>
      expect(callsTo(calls, "POST", "/api/routines")[0]?.body).toEqual({
        name: "Homework",
        dayPeriodId: "morning",
      })
    );
    const detail = await screen.findByTestId("routine-detail");
    expect(detail).toHaveAttribute("data-routine-id", "r-new");
    expect(screen.queryByTestId("routine-form-dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("routine-list-item-r-new")).toHaveAttribute("aria-current", "true");
  });

  it("renames a routine without a confirmation", async () => {
    const calls = mockBackend();
    renderPage();
    await selectRoutine("r1");
    fireEvent.click(screen.getByTestId("routine-edit"));
    const dialog = await screen.findByTestId("routine-form-dialog");
    fireEvent.change(within(dialog).getByTestId("routine-form-name"), {
      target: { value: "Sunrise" },
    });
    fireEvent.click(within(dialog).getByTestId("routine-form-submit"));

    await waitFor(() =>
      expect(callsTo(calls, "PATCH", "/api/routines/r1")[0]?.body).toEqual({
        name: "Sunrise",
        dayPeriodId: "morning",
      })
    );
    expect(screen.queryByTestId("routine-period-confirm")).not.toBeInTheDocument();
    expect(await screen.findByTestId("routine-list-item-r1")).toHaveTextContent("Sunrise");
  });

  it("moving a routine to another period asks for the streak confirmation first", async () => {
    const calls = mockBackend();
    renderPage();
    await selectRoutine("r1");
    fireEvent.click(screen.getByTestId("routine-edit"));
    await screen.findByTestId("routine-form-dialog");
    await chooseOption("Day period", "Evening");

    fireEvent.click(screen.getByTestId("routine-form-submit"));
    expect(await screen.findByText("This will change the live streak.")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("routine-period-cancel"));
    await waitFor(() =>
      expect(screen.queryByTestId("routine-period-confirm")).not.toBeInTheDocument()
    );
    expect(callsTo(calls, "PATCH", "/api/routines/r1")).toHaveLength(0);

    fireEvent.click(screen.getByTestId("routine-form-submit"));
    fireEvent.click(await screen.findByTestId("routine-period-confirm"));
    await waitFor(() =>
      expect(callsTo(calls, "PATCH", "/api/routines/r1")[0]?.body).toEqual({
        name: "Morning Routine",
        dayPeriodId: "evening",
      })
    );
    await waitFor(() => expect(screen.getByTestId("routine-detail")).toHaveTextContent("Evening"));
  });

  it("keeps the dialog open and announces a failed save", async () => {
    mockBackend({ fail: (url, method) => url === "/api/routines" && method === "POST" });
    renderPage();
    fireEvent.click(await screen.findByTestId("routines-new"));
    const dialog = await screen.findByTestId("routine-form-dialog");
    fireEvent.change(within(dialog).getByTestId("routine-form-name"), {
      target: { value: "Homework" },
    });
    fireEvent.click(within(dialog).getByTestId("routine-form-submit"));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "The routine could not be saved."
    );
    expect(screen.getByTestId("routine-form-dialog")).toBeInTheDocument();
  });

  it("deletes a routine only after confirmation and clears the selection", async () => {
    const calls = mockBackend();
    renderPage();
    await selectRoutine("r1");

    fireEvent.click(screen.getByTestId("routine-delete"));
    expect(await screen.findByText(/This will change the live streak\./)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("routine-delete-cancel-r1"));
    await waitFor(() =>
      expect(screen.queryByTestId("routine-delete-confirm-r1")).not.toBeInTheDocument()
    );
    expect(callsTo(calls, "DELETE", "/api/routines/r1")).toHaveLength(0);

    fireEvent.click(screen.getByTestId("routine-delete"));
    fireEvent.click(await screen.findByTestId("routine-delete-confirm-r1"));
    await waitFor(() => expect(callsTo(calls, "DELETE", "/api/routines/r1")).toHaveLength(1));
    expect(await screen.findByTestId("routines-select-prompt")).toBeInTheDocument();
    expect(screen.queryByTestId("routine-list-item-r1")).not.toBeInTheDocument();
  });
});

describe("RoutinesManagement — chores", () => {
  it("adds a chore from the dialog: blank disables submit, Enter submits with the icon", async () => {
    const calls = mockBackend();
    renderPage();
    await selectRoutine("r1");
    fireEvent.click(screen.getByTestId("routine-add-chore"));
    const dialog = await screen.findByTestId("chore-form-dialog");

    expect(within(dialog).getByTestId("chore-form-submit")).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Select chore icon" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Select Backpack" }));
    const input = within(dialog).getByTestId("chore-form-name");
    fireEvent.change(input, { target: { value: "Pack lunch" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    await waitFor(() =>
      expect(callsTo(calls, "POST", "/api/routines/r1/chores")[0]?.body).toEqual({
        name: "Pack lunch",
        icon: "🎒",
      })
    );
    await waitFor(() => expect(screen.queryByTestId("chore-form-dialog")).not.toBeInTheDocument());
  });

  it("Enter twice creates the chore once", async () => {
    const calls = mockBackend();
    renderPage();
    await selectRoutine("r1");
    fireEvent.click(screen.getByTestId("routine-add-chore"));
    const input = within(await screen.findByTestId("chore-form-dialog")).getByTestId(
      "chore-form-name"
    );
    fireEvent.change(input, { target: { value: "Pack lunch" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    await waitFor(() => expect(screen.queryByTestId("chore-form-dialog")).not.toBeInTheDocument());
    expect(callsTo(calls, "POST", "/api/routines/r1/chores")).toHaveLength(1);
  });

  it("edits a chore and clears its icon", async () => {
    const calls = mockBackend();
    renderPage();
    await selectRoutine("r1");
    fireEvent.click(await screen.findByRole("button", { name: "Edit Brush teeth" }));
    const dialog = await screen.findByTestId("chore-form-dialog");

    expect(within(dialog).getByTestId("chore-form-name")).toHaveValue("Brush teeth");
    fireEvent.click(within(dialog).getByRole("button", { name: "Selected icon: 🪥. Change icon" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear icon" }));
    fireEvent.click(within(dialog).getByTestId("chore-form-submit"));

    await waitFor(() =>
      expect(callsTo(calls, "PATCH", "/api/chores/c1")[0]?.body).toEqual({
        name: "Brush teeth",
        icon: null,
      })
    );
  });

  it("announces a failed chore save inside the dialog", async () => {
    mockBackend({ fail: (url, method) => url === "/api/routines/r1/chores" && method === "POST" });
    renderPage();
    await selectRoutine("r1");
    fireEvent.click(screen.getByTestId("routine-add-chore"));
    const dialog = await screen.findByTestId("chore-form-dialog");
    fireEvent.change(within(dialog).getByTestId("chore-form-name"), {
      target: { value: "New chore" },
    });
    fireEvent.click(within(dialog).getByTestId("chore-form-submit"));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "The chore could not be saved."
    );
  });

  it("deletes a chore only after confirmation", async () => {
    const calls = mockBackend();
    renderPage();
    await selectRoutine("r1");

    fireEvent.click(await screen.findByRole("button", { name: "Delete Brush teeth" }));
    fireEvent.click(await screen.findByTestId("routine-r1-chore-delete-cancel"));
    await waitFor(() =>
      expect(screen.queryByTestId("routine-r1-chore-delete-confirm")).not.toBeInTheDocument()
    );
    expect(callsTo(calls, "DELETE", "/api/chores/c1")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Delete Brush teeth" }));
    fireEvent.click(await screen.findByTestId("routine-r1-chore-delete-confirm"));
    await waitFor(() => expect(callsTo(calls, "DELETE", "/api/chores/c1")).toHaveLength(1));
  });

  it("keyboard drag persists the complete new order", async () => {
    const calls = mockBackend();
    renderPage();
    await selectRoutine("r1");
    await screen.findByTestId("chore-c3");

    await keyboardDragFirstChoreDown();

    await waitFor(() =>
      expect(callsTo(calls, "PUT", "/api/routines/r1/chores/order")[0]?.body).toEqual({
        choreIds: ["c2", "c1", "c3"],
      })
    );
    await waitFor(() => expect(choreOrder()).toEqual(["chore-c2", "chore-c1", "chore-c3"]));
  });

  it("a failed reorder restores the order and announces it", async () => {
    mockBackend({ fail: (url) => url === "/api/routines/r1/chores/order" });
    renderPage();
    await selectRoutine("r1");
    await screen.findByTestId("chore-c3");

    await keyboardDragFirstChoreDown();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Failed to save the new order. Please try again."
    );
    await waitFor(() => expect(choreOrder()).toEqual(["chore-c1", "chore-c2", "chore-c3"]));
  });
});

describe("RoutinesManagement — assignments", () => {
  async function openAssignments() {
    await selectRoutine("r1");
    fireEvent.click(screen.getByTestId("routine-assign"));
    return screen.findByTestId("assignment-dialog");
  }

  it("lists children only, and a brand-new assignment saves without confirmation", async () => {
    const calls = mockBackend();
    renderPage();
    const dialog = await openAssignments();

    expect(within(dialog).queryByText("Pat")).not.toBeInTheDocument();
    const row = within(dialog).getByTestId("routine-assignment-m1");
    fireEvent.click(within(row).getByRole("checkbox", { name: "Mon" }));
    fireEvent.click(within(row).getByRole("button", { name: "Save Assignment" }));

    await waitFor(() =>
      expect(callsTo(calls, "PUT", "/api/routines/r1/assignments/m1")[0]?.body).toEqual({
        weekdays: ["mon"],
        active: true,
      })
    );
    expect(screen.queryByTestId("routines-assignment-m1-save-confirm")).not.toBeInTheDocument();
  });

  it("changing an existing assignment asks for the streak confirmation", async () => {
    const calls = mockBackend({
      assignments: [{ id: "a1", memberId: "m1", weekdays: ["mon"], active: true }],
    });
    renderPage();
    const row = within(await openAssignments()).getByTestId("routine-assignment-m1");

    expect(within(row).getByRole("button", { name: "Save Assignment" })).toBeDisabled();
    fireEvent.click(within(row).getByRole("checkbox", { name: "Tue" }));
    fireEvent.click(within(row).getByRole("button", { name: "Save Assignment" }));
    fireEvent.click(await screen.findByTestId("routines-assignment-m1-save-cancel"));
    expect(callsTo(calls, "PUT", "/api/routines/r1/assignments/m1")).toHaveLength(0);

    fireEvent.click(within(row).getByRole("button", { name: "Save Assignment" }));
    fireEvent.click(await screen.findByTestId("routines-assignment-m1-save-confirm"));
    await waitFor(() =>
      expect(callsTo(calls, "PUT", "/api/routines/r1/assignments/m1")[0]?.body).toEqual({
        weekdays: ["mon", "tue"],
        active: true,
      })
    );
  });

  it("deactivates only after confirmation", async () => {
    const calls = mockBackend({
      assignments: [{ id: "a1", memberId: "m1", weekdays: ["mon"], active: true }],
    });
    renderPage();
    const row = within(await openAssignments()).getByTestId("routine-assignment-m1");

    fireEvent.click(within(row).getByRole("button", { name: "Deactivate" }));
    fireEvent.click(await screen.findByTestId("routines-assignment-m1-deactivate-cancel"));
    expect(callsTo(calls, "DELETE", "/api/routines/r1/assignments/m1")).toHaveLength(0);

    fireEvent.click(within(row).getByRole("button", { name: "Deactivate" }));
    fireEvent.click(await screen.findByTestId("routines-assignment-m1-deactivate-confirm"));
    await waitFor(() =>
      expect(callsTo(calls, "DELETE", "/api/routines/r1/assignments/m1")).toHaveLength(1)
    );
  });

  it("a deactivated assignment starts empty and re-saving it asks for confirmation", async () => {
    mockBackend({
      assignments: [{ id: "a1", memberId: "m1", weekdays: ["mon"], active: false }],
    });
    renderPage();
    const row = within(await openAssignments()).getByTestId("routine-assignment-m1");

    expect(within(row).getByRole("checkbox", { name: "Mon" })).not.toBeChecked();
    expect(within(row).queryByRole("button", { name: "Deactivate" })).not.toBeInTheDocument();
    fireEvent.click(within(row).getByRole("checkbox", { name: "Wed" }));
    fireEvent.click(within(row).getByRole("button", { name: "Save Assignment" }));
    expect(await screen.findByTestId("routines-assignment-m1-save-confirm")).toBeInTheDocument();
  });

  it("announces a failed assignment save inside the dialog", async () => {
    mockBackend({ fail: (url, method) => /\/assignments\/m1$/.test(url) && method === "PUT" });
    renderPage();
    const dialog = await openAssignments();
    const row = within(dialog).getByTestId("routine-assignment-m1");
    fireEvent.click(within(row).getByRole("checkbox", { name: "Mon" }));
    fireEvent.click(within(row).getByRole("button", { name: "Save Assignment" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Failed to update assignment."
    );
  });

  it("explains how to add a child when there is none", async () => {
    mockBackend({ members: [PARENT] });
    renderPage();
    expect(await openAssignments()).toHaveTextContent(
      "There are no children to assign yet. Add one in Members."
    );
  });
});

describe("RoutinesManagement — Spanish labels", () => {
  it("renders period groups, the page name, weekday labels and period options in Spanish", async () => {
    mockBackend({ language: "es", routines: [ROUTINE, ROUTINE_EVENING] });
    renderPage();

    expect(await screen.findByRole("heading", { level: 4, name: "Mañana" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 4, name: "Tarde" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Rutinas y tareas" })).toBeInTheDocument();

    await selectRoutine("r1");
    fireEvent.click(screen.getByTestId("routine-assign"));
    const row = await screen.findByTestId("routine-assignment-m1");
    expect(
      within(row)
        .getAllByRole("checkbox")
        .map((checkbox) => checkbox.closest("label")?.textContent?.trim())
    ).toEqual(["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"]);
  });

  it("lists each period under its own Spanish label in the routine dialog", async () => {
    mockBackend({ language: "es" });
    renderPage();
    await screen.findByRole("heading", { level: 4, name: "Mañana" });
    fireEvent.click(screen.getByTestId("routines-new"));
    await screen.findByTestId("routine-form-dialog");

    fireEvent.click(screen.getByRole("combobox", { name: "Período del día" }));
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["Mañana", "Mediodía", "Tarde"]);
  });
});

describe("RoutinesManagement — kiosk density (SC-001, SC-002, SC-003)", () => {
  it("meets kiosk density with a routine selected and with the assignment dialog open", async () => {
    mockBackend({
      assignments: [{ id: "a1", memberId: "m1", weekdays: ["mon"], active: true }],
    });
    const uninject = await injectDensityStyles({
      extraCandidates: ["size-[var(--control-height)]"],
    });
    document.documentElement.setAttribute("data-density", "kiosk");
    try {
      renderPage();
      await selectRoutine("r1");
      await screen.findByTestId("chore-c3");
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();

      fireEvent.click(screen.getByTestId("routine-assign"));
      await screen.findByTestId("routine-assignment-m1");
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("DELIBERATE NEGATIVE — forcing the New routine button below the kiosk minimum fails", async () => {
    mockBackend();
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");
    try {
      const { container } = renderPage();
      const button = await screen.findByTestId("routines-new");
      button.style.height = "10px";
      button.style.fontSize = "8px";

      let thrown: unknown;
      try {
        assertKioskDensityCompliant(container);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(DensityViolationError);
      expect((thrown as DensityViolationError).message).toMatch(
        /height 10px is below the kiosk minimum 48px/
      );

      button.style.height = "";
      button.style.fontSize = "";
      expect(() => assertKioskDensityCompliant(container)).not.toThrow();
    } finally {
      uninject();
    }
  });
});
```

- [ ] **Step 6:** `npx vitest run tests/client/routines.test.tsx` → FAIL (new test ids/components missing).

- [ ] **Step 7: Create `src/client/routines/admin/MemberChip.tsx`:**

```tsx
import type { CSSProperties } from "react";
import type { Member } from "../../../shared";
import { cn } from "@/lib/utils";

/** A member's name on their own colour, as on the Members page. */
export function MemberChip({
  member,
  className,
}: {
  member: Pick<Member, "displayName" | "colorKey">;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "text-member-avatar-foreground max-w-full truncate rounded-full bg-[var(--member-color)] px-2 py-0.5 text-sm font-semibold",
        className
      )}
      // eslint-disable-next-line ui-policy/debt -- Closed member keys select generated semantic token custom properties only.
      style={{ "--member-color": `var(--color-member-${member.colorKey}-500)` } as CSSProperties}
    >
      {member.displayName}
    </span>
  );
}
```

- [ ] **Step 8: Create `src/client/routines/admin/RoutineList.tsx`:**

```tsx
import { Plus } from "lucide-react";
import type { DayPeriodDTO, Routine } from "../../../shared";
import { useT } from "@/i18n";
import { Button } from "@/components/ui/button";
import { DAY_PERIOD_LABEL_KEYS } from "@/lib/day-period-labels";
import { groupRoutinesByPeriod } from "./routineOrder";

export interface RoutineListProps {
  routines: Routine[];
  dayPeriods: DayPeriodDTO[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}

/** Master list: routines grouped by day period, in period start order. */
export function RoutineList({
  routines,
  dayPeriods,
  selectedId,
  onSelect,
  onNew,
}: RoutineListProps) {
  const t = useT();
  const groups = groupRoutinesByPeriod(routines, dayPeriods);

  return (
    <nav
      aria-labelledby="routine-list-heading"
      className="bg-card flex min-w-0 flex-col gap-4 rounded-3xl border p-4 shadow-sm"
      data-testid="routine-list"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="routine-list-heading" className="text-lg font-semibold">
          {t("routines.management.routines")}
        </h3>
        <Button size="sm" onClick={onNew} data-testid="routines-new">
          <Plus aria-hidden="true" />
          {t("routines.admin.new")}
        </Button>
      </div>
      {groups.length === 0 ? (
        <p className="text-muted-foreground text-control" data-testid="routines-empty">
          {t("routines.management.noRoutines")}
        </p>
      ) : (
        groups.map(({ period, routines: items }) => (
          <section
            key={period.id}
            aria-labelledby={`routine-group-${period.id}`}
            className="flex flex-col gap-1"
          >
            <h4
              id={`routine-group-${period.id}`}
              className="text-muted-foreground text-sm font-semibold uppercase tracking-wide"
            >
              {t(DAY_PERIOD_LABEL_KEYS[period.id])}
            </h4>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {items.map((routine) => {
                const selected = routine.id === selectedId;
                return (
                  <li key={routine.id}>
                    <Button
                      type="button"
                      variant={selected ? "default" : "ghost"}
                      wrap
                      aria-current={selected ? "true" : undefined}
                      className="w-full justify-start"
                      data-testid={`routine-list-item-${routine.id}`}
                      onClick={() => onSelect(routine.id)}
                    >
                      {routine.name}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </nav>
  );
}
```

- [ ] **Step 9: Create `src/client/routines/admin/RoutineWeekGrid.tsx`:**

```tsx
import type { Assignment, Member, Weekday } from "../../../shared";
import type { MessageKey } from "@/i18n/messages";
import { useT } from "@/i18n";
import { Button } from "@/components/ui/button";
import { CANONICAL_WEEKDAY_ORDER, type WeekdayLabels } from "@/components/WeekdayPicker";
import { MemberChip } from "./MemberChip";

export const WEEKDAY_LABEL_KEYS: Record<Weekday, MessageKey> = {
  mon: "routines.assignments.weekday.mon",
  tue: "routines.assignments.weekday.tue",
  wed: "routines.assignments.weekday.wed",
  thu: "routines.assignments.weekday.thu",
  fri: "routines.assignments.weekday.fri",
  sat: "routines.assignments.weekday.sat",
  sun: "routines.assignments.weekday.sun",
};

/** `WeekdayPicker` labels from this surface's own `routines.assignments.weekday.*` keys. */
export function weekdayLabels(t: (key: MessageKey) => string): WeekdayLabels {
  return {
    mon: t(WEEKDAY_LABEL_KEYS.mon),
    tue: t(WEEKDAY_LABEL_KEYS.tue),
    wed: t(WEEKDAY_LABEL_KEYS.wed),
    thu: t(WEEKDAY_LABEL_KEYS.thu),
    fri: t(WEEKDAY_LABEL_KEYS.fri),
    sat: t(WEEKDAY_LABEL_KEYS.sat),
    sun: t(WEEKDAY_LABEL_KEYS.sun),
  };
}

/** Seven columns of the children actively assigned on each weekday. The whole grid opens the
 * assignment dialog, where the same information is editable. */
export function RoutineWeekGrid({
  assignments,
  members,
  onOpen,
}: {
  assignments: Assignment[];
  members: Member[];
  onOpen: () => void;
}) {
  const t = useT();
  const byId = new Map(members.map((member) => [member.id, member]));
  const active = assignments.filter((assignment) => assignment.active);

  return (
    <Button
      type="button"
      variant="ghost"
      wrap
      className="w-full rounded-2xl border p-2"
      aria-label={t("routines.admin.manageAssignments")}
      data-testid="routine-week-grid"
      onClick={onOpen}
    >
      <span className="grid w-full grid-cols-7 gap-1">
        {CANONICAL_WEEKDAY_ORDER.map((day) => (
          <span
            key={day}
            className="flex min-w-0 flex-col items-center gap-1"
            data-testid={`routine-week-day-${day}`}
          >
            <span className="text-muted-foreground text-sm font-bold uppercase">
              {t(WEEKDAY_LABEL_KEYS[day])}
            </span>
            {active
              .filter((assignment) => assignment.weekdays.includes(day))
              .map((assignment) => byId.get(assignment.memberId))
              .filter((member): member is Member => member !== undefined)
              .map((member) => (
                <MemberChip key={member.id} member={member} className="w-full text-center" />
              ))}
          </span>
        ))}
      </span>
    </Button>
  );
}
```

- [ ] **Step 10: Create `src/client/routines/admin/SortableChoreRow.tsx`:**

```tsx
import type { CSSProperties } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Pencil, Trash2 } from "lucide-react";
import type { Chore } from "../../../shared";
import type { MessageKey } from "@/i18n/messages";
import { useT } from "@/i18n";
import { Button } from "@/components/ui/button";
import { NotoEmoji } from "@/chores/noto-emoji";

export function SortableChoreRow({
  chore,
  busy,
  onEdit,
  onDelete,
}: {
  chore: Chore;
  busy: boolean;
  onEdit: (chore: Chore) => void;
  onDelete: (chore: Chore) => void;
}) {
  const t = useT();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: chore.id,
  });
  const named = (key: MessageKey) => t(key).replace("{name}", chore.name);

  return (
    <li
      ref={setNodeRef}
      data-testid={`chore-${chore.id}`}
      // eslint-disable-next-line ui-policy/debt -- DnD frame values only forward CSS custom properties; token classes own presentation.
      style={
        {
          "--drag-transform": CSS.Transform.toString(transform) ?? "none",
          "--drag-transition": transition ?? "none",
        } as CSSProperties
      }
      className={`bg-card flex items-center gap-2 rounded-2xl border py-2 pr-2 pl-1 shadow-sm [transform:var(--drag-transform)] [transition:var(--drag-transition)] ${isDragging ? "opacity-70" : ""}`}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="shrink-0 cursor-grab touch-none active:cursor-grabbing"
        aria-label={named("routines.admin.dragChore")}
        disabled={busy}
        data-testid={`chore-drag-${chore.id}`}
        {...attributes}
        {...listeners}
      >
        <GripVertical aria-hidden="true" className="size-4" />
      </Button>
      <NotoEmoji emoji={chore.icon ?? "📋"} size={24} />
      <span className="min-w-0 flex-1 font-medium break-words">{chore.name}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="shrink-0"
        aria-label={named("routines.admin.editChoreAria")}
        title={named("routines.admin.editChoreAria")}
        disabled={busy}
        data-testid={`chore-edit-${chore.id}`}
        onClick={() => onEdit(chore)}
      >
        <Pencil aria-hidden="true" className="size-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="text-destructive shrink-0"
        aria-label={named("routines.admin.deleteChoreAria")}
        title={named("routines.admin.deleteChoreAria")}
        disabled={busy}
        data-testid={`chore-delete-${chore.id}`}
        onClick={() => onDelete(chore)}
      >
        <Trash2 aria-hidden="true" className="size-4" />
      </Button>
    </li>
  );
}
```

- [ ] **Step 11: Create `src/client/routines/admin/RoutineDetail.tsx`:**

```tsx
import { useState } from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { Pencil, Plus, Trash2, Users } from "lucide-react";
import type { Assignment, Chore, Member, Routine } from "../../../shared";
import { useT } from "@/i18n";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { RoutineWeekGrid } from "./RoutineWeekGrid";
import { SortableChoreRow } from "./SortableChoreRow";
import { moveChore } from "./routineOrder";

export interface RoutineDetailProps {
  routine: Routine;
  periodLabel: string;
  chores: Chore[];
  assignments: Assignment[];
  members: Member[];
  busy: boolean;
  onEdit: () => void;
  onAssign: () => void;
  onAddChore: () => void;
  onEditChore: (chore: Chore) => void;
  /** Called after the user confirmed the streak warning. */
  onDelete: () => void;
  /** Called after the user confirmed the streak warning. */
  onDeleteChore: (chore: Chore) => void;
  onReorder: (next: Chore[]) => void;
}

export function RoutineDetail({
  routine,
  periodLabel,
  chores,
  assignments,
  members,
  busy,
  onEdit,
  onAssign,
  onAddChore,
  onEditChore,
  onDelete,
  onDeleteChore,
  onReorder,
}: RoutineDetailProps) {
  const t = useT();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [choreToDelete, setChoreToDelete] = useState<Chore | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(TouchSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const nameOf = (id: UniqueIdentifier) =>
    chores.find((chore) => chore.id === String(id))?.name ?? "";

  function handleDragEnd(event: DragEndEvent) {
    if (!event.over || busy) return;
    const next = moveChore(chores, String(event.active.id), String(event.over.id));
    if (next) onReorder(next);
  }

  return (
    <section
      aria-labelledby="routine-detail-heading"
      className="bg-card flex min-w-0 flex-col gap-4 rounded-3xl border p-4 shadow-sm"
      data-testid="routine-detail"
      data-routine-id={routine.id}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id="routine-detail-heading" className="text-xl font-semibold break-words">
            {routine.name}
          </h3>
          <p className="text-muted-foreground text-control">{periodLabel}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={onEdit} data-testid="routine-edit">
            <Pencil aria-hidden="true" />
            {t("routines.admin.editRoutine")}
          </Button>
          <Button variant="outline" size="sm" onClick={onAssign} data-testid="routine-assign">
            <Users aria-hidden="true" />
            {t("routines.admin.assign")}
          </Button>
          <Button size="sm" onClick={onAddChore} data-testid="routine-add-chore">
            <Plus aria-hidden="true" />
            {t("routines.action.createChore")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive"
            onClick={() => setConfirmDelete(true)}
            data-testid="routine-delete"
          >
            <Trash2 aria-hidden="true" />
            {t("routines.admin.deleteRoutine")}
          </Button>
        </div>
      </div>

      <RoutineWeekGrid assignments={assignments} members={members} onOpen={onAssign} />

      {chores.length === 0 ? (
        <p className="text-muted-foreground text-control" data-testid="routine-chores-empty">
          {t("routines.admin.noChores")}
        </p>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
          accessibility={{
            screenReaderInstructions: { draggable: t("routines.admin.dragInstructions") },
            announcements: {
              onDragStart: ({ active }) =>
                t("routines.admin.dragStarted").replace("{name}", nameOf(active.id)),
              onDragOver: ({ active, over }) =>
                over
                  ? t("routines.admin.dragOver")
                      .replace("{name}", nameOf(active.id))
                      .replace(
                        "{position}",
                        String(chores.findIndex((chore) => chore.id === String(over.id)) + 1)
                      )
                  : "",
              onDragEnd: ({ active }) =>
                t("routines.admin.dragEnded").replace("{name}", nameOf(active.id)),
              onDragCancel: () => t("routines.admin.dragCancelled"),
            },
          }}
        >
          <SortableContext
            items={chores.map((chore) => chore.id)}
            strategy={verticalListSortingStrategy}
          >
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {chores.map((chore) => (
                <SortableChoreRow
                  key={chore.id}
                  chore={chore}
                  busy={busy}
                  onEdit={onEditChore}
                  onDelete={setChoreToDelete}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t("routines.admin.deleteRoutine")}
        description={`${t("routines.action.deleteConfirm")} ${t("routines.action.streakWarning")}`}
        confirmLabel={t("routines.action.delete")}
        cancelLabel={t("routines.action.cancel")}
        onConfirm={onDelete}
        confirmTestId={`routine-delete-confirm-${routine.id}`}
        cancelTestId={`routine-delete-cancel-${routine.id}`}
      />
      <ConfirmDialog
        open={choreToDelete !== null}
        onOpenChange={(open) => {
          if (!open) setChoreToDelete(null);
        }}
        title={t("routines.action.delete")}
        description={`${t("routines.chores.deleteConfirm")} ${t("routines.action.streakWarning")}`}
        confirmLabel={t("routines.action.delete")}
        cancelLabel={t("routines.action.cancel")}
        onConfirm={() => {
          if (choreToDelete) onDeleteChore(choreToDelete);
        }}
        confirmTestId={`routine-${routine.id}-chore-delete-confirm`}
        cancelTestId={`routine-${routine.id}-chore-delete-cancel`}
      />
    </section>
  );
}
```

- [ ] **Step 12: Create `src/client/routines/admin/RoutineFormDialog.tsx`:**

```tsx
import { useEffect, useState } from "react";
import type { DayPeriodDTO, Routine, RoutineInput } from "../../../shared";
import { useT } from "@/i18n";
import { DAY_PERIOD_LABEL_KEYS } from "@/lib/day-period-labels";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface RoutineFormDialogProps {
  open: boolean;
  /** The routine being edited; null creates a new one. */
  routine: Routine | null;
  dayPeriods: DayPeriodDTO[];
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (input: RoutineInput) => void;
}

export function RoutineFormDialog({
  open,
  routine,
  dayPeriods,
  saving,
  error,
  onClose,
  onSubmit,
}: RoutineFormDialogProps) {
  const t = useT();
  const ordered = [...dayPeriods].sort((a, b) => a.start.localeCompare(b.start));
  const firstPeriodId = ordered[0]?.id ?? "";
  const [name, setName] = useState("");
  const [dayPeriodId, setDayPeriodId] = useState("");
  const [confirmMove, setConfirmMove] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(routine?.name ?? "");
    setDayPeriodId(routine?.dayPeriodId ?? firstPeriodId);
    setConfirmMove(false);
  }, [open, routine, firstPeriodId]);

  const input: RoutineInput = { name: name.trim(), dayPeriodId };
  const valid = input.name.length > 0 && dayPeriodId !== "";

  function submit() {
    if (!valid || saving) return;
    // Moving a routine changes the live streak (FR-009/FR-015): confirm first.
    if (routine && dayPeriodId !== routine.dayPeriodId) setConfirmMove(true);
    else onSubmit(input);
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next && !saving) onClose();
        }}
      >
        <DialogContent closeLabel={t("routines.action.cancel")} data-testid="routine-form-dialog">
          <DialogHeader>
            <DialogTitle>
              {routine ? t("routines.admin.editRoutine") : t("routines.admin.new")}
            </DialogTitle>
            <DialogDescription>{t("routines.admin.routineFormDescription")}</DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="routine-form-name">{t("routines.admin.nameLabel")}</Label>
              <Input
                id="routine-form-name"
                data-testid="routine-form-name"
                value={name}
                placeholder={t("routines.management.createNamePlaceholder")}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="routine-form-period">{t("routines.admin.dayPeriodLabel")}</Label>
              <Select value={dayPeriodId} onValueChange={setDayPeriodId}>
                <SelectTrigger
                  id="routine-form-period"
                  aria-label={t("routines.admin.dayPeriodLabel")}
                  data-testid="routine-form-period"
                >
                  <SelectValue placeholder={t("routines.management.selectDayPeriod")} />
                </SelectTrigger>
                <SelectContent>
                  {ordered.map((period) => (
                    <SelectItem key={period.id} value={period.id}>
                      {t(DAY_PERIOD_LABEL_KEYS[period.id])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <ErrorNotice message={error} />
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
                {t("routines.action.cancel")}
              </Button>
              <Button type="submit" disabled={saving || !valid} data-testid="routine-form-submit">
                {routine ? t("routines.admin.saveChanges") : t("routines.action.create")}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirmMove}
        onOpenChange={setConfirmMove}
        title={t("routines.admin.movePeriodTitle")}
        description={t("routines.action.streakWarning")}
        confirmLabel={t("routines.admin.movePeriodConfirm")}
        cancelLabel={t("routines.action.cancel")}
        destructive={false}
        onConfirm={() => onSubmit(input)}
        confirmTestId="routine-period-confirm"
        cancelTestId="routine-period-cancel"
      />
    </>
  );
}
```

- [ ] **Step 13: Create `src/client/routines/admin/ChoreFormDialog.tsx`.** The emoji picker sits outside the `<form>` so Enter in its search box cannot submit; Enter in the name field submits through an explicit key handler (jsdom has no implicit form submission).

```tsx
import { useEffect, useState } from "react";
import type { Chore, ChoreInput } from "../../../shared";
import { useT } from "@/i18n";
import { EmojiPicker } from "@/chores/EmojiPicker";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface ChoreFormDialogProps {
  open: boolean;
  /** The chore being edited; null adds a new one. */
  chore: Chore | null;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (input: ChoreInput) => void;
}

export function ChoreFormDialog({
  open,
  chore,
  saving,
  error,
  onClose,
  onSubmit,
}: ChoreFormDialogProps) {
  const t = useT();
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(chore?.name ?? "");
    setIcon(chore?.icon ?? null);
  }, [open, chore]);

  const trimmed = name.trim();
  function submit() {
    if (!trimmed || saving) return;
    onSubmit({ name: trimmed, icon });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !saving) onClose();
      }}
    >
      <DialogContent closeLabel={t("routines.action.cancel")} data-testid="chore-form-dialog">
        <DialogHeader>
          <DialogTitle>
            {chore ? t("routines.admin.editChore") : t("routines.action.createChore")}
          </DialogTitle>
          <DialogDescription>{t("routines.admin.choreFormDescription")}</DialogDescription>
        </DialogHeader>
        <div className="flex items-end gap-3">
          <EmojiPicker value={icon} onChange={setIcon} />
          <form
            id="chore-form"
            className="flex min-w-0 flex-1 flex-col gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <Label htmlFor="chore-form-name">{t("routines.admin.choreNameLabel")}</Label>
            <Input
              id="chore-form-name"
              data-testid="chore-form-name"
              value={name}
              placeholder={t("routines.chores.placeholder")}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                submit();
              }}
            />
          </form>
        </div>
        <ErrorNotice message={error} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
            {t("routines.action.cancel")}
          </Button>
          <Button
            type="submit"
            form="chore-form"
            disabled={saving || !trimmed}
            data-testid="chore-form-submit"
          >
            {chore ? t("routines.admin.saveChore") : t("routines.action.createChore")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 14: Create `src/client/routines/admin/AssignmentDialog.tsx`:**

```tsx
import { useState } from "react";
import type { Assignment, Member, Weekday } from "../../../shared";
import { useT } from "@/i18n";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorNotice } from "@/components/ErrorNotice";
import { WeekdayPicker } from "@/components/WeekdayPicker";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MemberChip } from "./MemberChip";
import { weekdayLabels } from "./RoutineWeekGrid";

export interface AssignmentDialogProps {
  open: boolean;
  /** Active children, the only members a routine can be assigned to. */
  childMembers: Member[];
  assignments: Assignment[];
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (memberId: string, weekdays: Weekday[]) => void;
  onDeactivate: (memberId: string) => void;
}

export function AssignmentDialog({
  open,
  childMembers,
  assignments,
  busy,
  error,
  onClose,
  onSave,
  onDeactivate,
}: AssignmentDialogProps) {
  const t = useT();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-xl"
        closeLabel={t("routines.action.cancel")}
        data-testid="assignment-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t("routines.admin.assignTitle")}</DialogTitle>
          <DialogDescription>{t("routines.admin.assignDescription")}</DialogDescription>
        </DialogHeader>
        <ErrorNotice message={error} />
        {childMembers.length === 0 ? (
          <p className="text-muted-foreground text-control">{t("routines.admin.noChildren")}</p>
        ) : (
          <div className="flex flex-col gap-3">
            {childMembers.map((child) => {
              const assignment = assignments.find((a) => a.memberId === child.id);
              return (
                <AssignmentRow
                  // Remount when the saved state changes so the draft starts from it again.
                  key={`${child.id}:${assignment?.active ? assignment.weekdays.join(",") : "-"}`}
                  child={child}
                  assignment={assignment}
                  busy={busy}
                  onSave={(weekdays) => onSave(child.id, weekdays)}
                  onDeactivate={() => onDeactivate(child.id)}
                />
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AssignmentRow({
  child,
  assignment,
  busy,
  onSave,
  onDeactivate,
}: {
  child: Member;
  assignment: Assignment | undefined;
  busy: boolean;
  onSave: (weekdays: Weekday[]) => void;
  onDeactivate: () => void;
}) {
  const t = useT();
  const saved: Weekday[] = assignment?.active ? assignment.weekdays : [];
  const [weekdays, setWeekdays] = useState<Weekday[]>(saved);
  const [confirm, setConfirm] = useState<"save" | "deactivate" | null>(null);
  const unchanged = weekdays.length === saved.length && saved.every((d) => weekdays.includes(d));

  function requestSave() {
    // Any existing row (active or deactivated) carries streak history (FR-009); a brand-new
    // assignment has none, so it saves at once.
    if (assignment !== undefined) setConfirm("save");
    else onSave(weekdays);
  }

  return (
    <div
      className="flex flex-col gap-3 rounded-2xl border p-3"
      data-testid={`routine-assignment-${child.id}`}
    >
      <MemberChip member={child} className="self-start text-base" />
      <WeekdayPicker
        mode="multi"
        value={weekdays}
        onChange={(next) => setWeekdays([...next])}
        labels={weekdayLabels(t)}
        groupLabel={`${t("routines.assignments.weekdaysLabel")} — ${child.displayName}`}
        testIdPrefix={`routines-weekday-${child.id}`}
        disabled={busy}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          onClick={requestSave}
          disabled={busy || weekdays.length === 0 || unchanged}
          data-testid={`routines-assignment-${child.id}-save`}
        >
          {t("routines.assignments.save")}
        </Button>
        {assignment?.active && (
          <Button
            type="button"
            variant="secondary"
            onClick={() => setConfirm("deactivate")}
            disabled={busy}
            data-testid={`routines-assignment-${child.id}-deactivate`}
          >
            {t("routines.assignments.deactivate")}
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={confirm === "save"}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={t("routines.assignments.save")}
        description={t("routines.action.streakWarning")}
        confirmLabel={t("routines.assignments.save")}
        cancelLabel={t("routines.action.cancel")}
        destructive={false}
        onConfirm={() => onSave(weekdays)}
        confirmTestId={`routines-assignment-${child.id}-save-confirm`}
        cancelTestId={`routines-assignment-${child.id}-save-cancel`}
      />
      <ConfirmDialog
        open={confirm === "deactivate"}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={t("routines.assignments.deactivate")}
        description={`${t("routines.assignments.deactivateConfirm")} ${t("routines.action.streakWarning")}`}
        confirmLabel={t("routines.assignments.deactivate")}
        cancelLabel={t("routines.action.cancel")}
        onConfirm={onDeactivate}
        confirmTestId={`routines-assignment-${child.id}-deactivate-confirm`}
        cancelTestId={`routines-assignment-${child.id}-deactivate-cancel`}
      />
    </div>
  );
}
```

- [ ] **Step 15: Rewrite `src/client/admin/RoutinesManagement.tsx` (whole file):**

```tsx
import { useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/credential";
import {
  Role,
  type Assignment,
  type Chore,
  type ChoreInput,
  type DayPeriodDTO,
  type Member,
  type Routine,
  type RoutineInput,
  type Weekday,
} from "../../shared";
import { useT } from "@/i18n";
import { DAY_PERIOD_LABEL_KEYS } from "@/lib/day-period-labels";
import { AdminPanel } from "@/components/AdminPanel";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Button } from "@/components/ui/button";
import { AssignmentDialog } from "@/routines/admin/AssignmentDialog";
import { ChoreFormDialog } from "@/routines/admin/ChoreFormDialog";
import { RoutineDetail } from "@/routines/admin/RoutineDetail";
import { RoutineFormDialog } from "@/routines/admin/RoutineFormDialog";
import { RoutineList } from "@/routines/admin/RoutineList";

/* ------------------------------------------------------------------ */
/* RoutinesManagement — master/detail admin page for routines, chores */
/* and weekday assignments. Loads data, owns the selection and runs   */
/* every mutation; the panes and dialogs in src/client/routines/admin */
/* only render. Every streak-affecting action is confirmed in those   */
/* components through ConfirmDialog before it reaches this file.      */
/* ------------------------------------------------------------------ */

type DetailState =
  | { status: "idle" | "loading" | "error" }
  | { status: "ready"; chores: Chore[]; assignments: Assignment[] };

async function getJson<T>(url: string): Promise<T> {
  const response = await authFetch(url, { credentials: "include" });
  if (!response.ok) throw new Error(`GET ${url}: ${response.status}`);
  return (await response.json()) as T;
}

async function send(url: string, method: string, body?: unknown): Promise<Response> {
  const response = await authFetch(url, {
    method,
    credentials: "include",
    ...(body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${url}: ${response.status}`);
  return response;
}

export function RoutinesManagement() {
  const t = useT();
  const [dayPeriods, setDayPeriods] = useState<DayPeriodDTO[]>([]);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const [detail, setDetail] = useState<DetailState>({ status: "idle" });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [routineForm, setRoutineForm] = useState<{ routine: Routine | null } | null>(null);
  const [choreForm, setChoreForm] = useState<{ chore: Chore | null } | null>(null);
  const [assignOpen, setAssignOpen] = useState(false);

  async function loadBase() {
    setLoading(true);
    setLoadError(false);
    try {
      const [periods, list, people] = await Promise.all([
        getJson<DayPeriodDTO[]>("/api/day-periods"),
        getJson<Routine[]>("/api/routines"),
        getJson<Member[]>("/api/members"),
      ]);
      setDayPeriods(periods);
      setRoutines(list);
      setMembers(people);
      setSelectedId((current) => (current && list.some((r) => r.id === current) ? current : null));
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  async function refreshRoutines() {
    const list = await getJson<Routine[]>("/api/routines");
    setRoutines(list);
    setSelectedId((current) => (current && list.some((r) => r.id === current) ? current : null));
  }

  /** Loads the selected routine's chores and assignments. A response for a routine that is no
   * longer selected is dropped. `quiet` keeps the current detail on screen while refreshing. */
  async function loadDetail(routineId: string, quiet = false) {
    if (!quiet) setDetail({ status: "loading" });
    try {
      const [chores, assignments] = await Promise.all([
        getJson<Chore[]>(`/api/routines/${routineId}/chores`),
        getJson<Assignment[]>(`/api/routines/${routineId}/assignments`),
      ]);
      if (selectedRef.current === routineId) setDetail({ status: "ready", chores, assignments });
    } catch {
      if (selectedRef.current === routineId) setDetail({ status: "error" });
    }
  }

  useEffect(() => {
    void loadBase();
  }, []);

  useEffect(() => {
    selectedRef.current = selectedId;
    if (selectedId) void loadDetail(selectedId);
    else setDetail({ status: "idle" });
  }, [selectedId]);

  /** Runs one write with the page busy; `fail` reports the error where the user is looking. */
  async function mutate(work: () => Promise<void>, fail: () => void) {
    setBusy(true);
    setActionError(null);
    try {
      await work();
    } catch {
      fail();
    } finally {
      setBusy(false);
    }
  }

  const selected = routines.find((routine) => routine.id === selectedId) ?? null;
  const childMembers = members.filter((m) => m.role === Role.child);
  const periodLabel = (id: string) => {
    const period = dayPeriods.find((p) => p.id === id);
    return period ? t(DAY_PERIOD_LABEL_KEYS[period.id]) : "";
  };

  function saveRoutine(input: RoutineInput) {
    const editing = routineForm?.routine ?? null;
    setFormError(null);
    void mutate(
      async () => {
        const response = editing
          ? await send(`/api/routines/${editing.id}`, "PATCH", input)
          : await send("/api/routines", "POST", input);
        const saved = (await response.json()) as Routine;
        setRoutineForm(null);
        await refreshRoutines();
        setSelectedId(saved.id);
      },
      () => setFormError(t("routines.admin.saveError"))
    );
  }

  function deleteRoutine(routineId: string) {
    void mutate(
      async () => {
        await send(`/api/routines/${routineId}`, "DELETE");
        setSelectedId(null);
        await refreshRoutines();
      },
      () => setActionError(t("routines.management.error"))
    );
  }

  function saveChore(input: ChoreInput) {
    if (!selected) return;
    const routineId = selected.id;
    const editing = choreForm?.chore ?? null;
    setFormError(null);
    void mutate(
      async () => {
        if (editing) await send(`/api/chores/${editing.id}`, "PATCH", input);
        else await send(`/api/routines/${routineId}/chores`, "POST", input);
        setChoreForm(null);
        await loadDetail(routineId, true);
      },
      () => setFormError(t("routines.admin.choreSaveError"))
    );
  }

  function deleteChore(chore: Chore) {
    void mutate(
      async () => {
        await send(`/api/chores/${chore.id}`, "DELETE");
        await loadDetail(chore.routineId, true);
      },
      () => setActionError(t("routines.chores.error"))
    );
  }

  function reorderChores(next: Chore[]) {
    if (!selected || detail.status !== "ready" || busy) return;
    const routineId = selected.id;
    const previous = detail.chores;
    setDetail({ ...detail, chores: next });
    void mutate(
      async () => {
        const response = await send(`/api/routines/${routineId}/chores/order`, "PUT", {
          choreIds: next.map((chore) => chore.id),
        });
        const saved = (await response.json()) as Chore[];
        setDetail((current) =>
          current.status === "ready" && selectedRef.current === routineId
            ? { ...current, chores: saved }
            : current
        );
      },
      () => {
        setDetail((current) =>
          current.status === "ready" ? { ...current, chores: previous } : current
        );
        setActionError(t("routines.chores.reorderError"));
        void loadDetail(routineId, true);
      }
    );
  }

  function saveAssignment(memberId: string, weekdays: Weekday[]) {
    if (!selected) return;
    const routineId = selected.id;
    void mutate(
      async () => {
        await send(`/api/routines/${routineId}/assignments/${memberId}`, "PUT", {
          weekdays,
          active: true,
        });
        await loadDetail(routineId, true);
      },
      () => setActionError(t("routines.assignments.error"))
    );
  }

  function deactivateAssignment(memberId: string) {
    if (!selected) return;
    const routineId = selected.id;
    void mutate(
      async () => {
        await send(`/api/routines/${routineId}/assignments/${memberId}`, "DELETE");
        await loadDetail(routineId, true);
      },
      () => setActionError(t("routines.assignments.error"))
    );
  }

  return (
    <AdminPanel
      title={t("routines.management.title")}
      description={t("routines.management.description")}
      className="w-full"
      data-testid="routines-management"
    >
      {loading ? (
        <p role="status" className="text-muted-foreground text-control">
          {t("routines.management.loading")}
        </p>
      ) : loadError ? (
        <div className="flex flex-col items-start gap-2">
          <ErrorNotice message={t("routines.management.error")} />
          <Button variant="outline" onClick={() => void loadBase()} data-testid="routines-retry">
            {t("routines.admin.retry")}
          </Button>
        </div>
      ) : (
        <>
          {/* While the assignment dialog is open the page behind it is inert; its errors show inside it. */}
          {!assignOpen && <ErrorNotice message={actionError} />}
          <div className="grid items-start gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
            <RoutineList
              routines={routines}
              dayPeriods={dayPeriods}
              selectedId={selectedId}
              onSelect={(id) => {
                setActionError(null);
                setSelectedId(id);
              }}
              onNew={() => {
                setFormError(null);
                setRoutineForm({ routine: null });
              }}
            />
            {selected === null ? (
              <p
                className="bg-card text-muted-foreground text-control rounded-3xl border p-6 text-center"
                data-testid="routines-select-prompt"
              >
                {t("routines.admin.selectPrompt")}
              </p>
            ) : detail.status === "ready" ? (
              <RoutineDetail
                routine={selected}
                periodLabel={periodLabel(selected.dayPeriodId)}
                chores={detail.chores}
                assignments={detail.assignments}
                members={childMembers}
                busy={busy}
                onEdit={() => {
                  setFormError(null);
                  setRoutineForm({ routine: selected });
                }}
                onAssign={() => {
                  setActionError(null);
                  setAssignOpen(true);
                }}
                onAddChore={() => {
                  setFormError(null);
                  setChoreForm({ chore: null });
                }}
                onEditChore={(chore) => {
                  setFormError(null);
                  setChoreForm({ chore });
                }}
                onDelete={() => deleteRoutine(selected.id)}
                onDeleteChore={deleteChore}
                onReorder={reorderChores}
              />
            ) : detail.status === "error" ? (
              <div className="bg-card flex flex-col items-start gap-2 rounded-3xl border p-4">
                <ErrorNotice message={t("routines.admin.detailError")} />
                <Button
                  variant="outline"
                  onClick={() => void loadDetail(selected.id)}
                  data-testid="routine-detail-retry"
                >
                  {t("routines.admin.retry")}
                </Button>
              </div>
            ) : (
              <p role="status" className="text-muted-foreground text-control">
                {t("routines.management.loading")}
              </p>
            )}
          </div>
        </>
      )}

      <RoutineFormDialog
        open={routineForm !== null}
        routine={routineForm?.routine ?? null}
        dayPeriods={dayPeriods}
        saving={busy}
        error={formError}
        onClose={() => setRoutineForm(null)}
        onSubmit={saveRoutine}
      />
      <ChoreFormDialog
        open={choreForm !== null}
        chore={choreForm?.chore ?? null}
        saving={busy}
        error={formError}
        onClose={() => setChoreForm(null)}
        onSubmit={saveChore}
      />
      <AssignmentDialog
        open={assignOpen && detail.status === "ready"}
        childMembers={childMembers}
        assignments={detail.status === "ready" ? detail.assignments : []}
        busy={busy}
        error={actionError}
        onClose={() => {
          setAssignOpen(false);
          setActionError(null);
        }}
        onSave={saveAssignment}
        onDeactivate={deactivateAssignment}
      />
    </AdminPanel>
  );
}
```

- [ ] **Step 16: Delete the up/down reorder control.** `git rm src/client/admin/ChoreOrderControls.tsx tests/client/chore-order-controls.test.tsx` (nothing else imports it: `grep -rn ChoreOrderControls src tests` must return only the cohort fixture, fixed in Task 8).

- [ ] **Step 17: Run the page tests.** `npx vitest run tests/client/routines.test.tsx tests/client/routines-admin-order.test.ts` → all PASS. Debug failures with the `superpowers:systematic-debugging` skill; do not weaken assertions. Known jsdom pitfalls: Radix Select needs the `scrollIntoView` stub already in the file; the keyboard drag needs the `getBoundingClientRect` mocks (copied from `tests/client/calendar-management.test.tsx` ≈ line 366).

- [ ] **Step 18: Static checks.** `npx tsc -b && npm run lint && npx prettier --write src/client/routines src/client/admin/RoutinesManagement.tsx tests/client/routines.test.tsx tests/client/routines-admin-order.test.ts && npm run check:ui-debt && npm run check:accessible-names`. Fix any finding at its source (e.g. give a flagged control an accessible name); never add a lint exception-list entry.

- [ ] **Step 19: Commit.** `git add -A && git commit -m "feat(routines): rebuild the routines admin as a master/detail page with dialogs and drag reorder"`

---

### Task 5: Keep the other admin tests pointing at the page

**Files:**

- Modify: `tests/client/admin-gate-panel-reset.test.tsx` (routines entry ≈ lines 70-74)
- Modify: `tests/e2e/admin-unlock-resilience.spec.ts` (routines entry ≈ lines 98-102)

- [ ] **Step 1:** In `admin-gate-panel-reset.test.tsx` replace the routines entry with:

```ts
  {
    nav: "admin-nav-routines-management",
    path: "/admin/routines",
    testId: "routines-management",
  },
```

- [ ] **Step 2:** In `admin-unlock-resilience.spec.ts` replace the routines destination with:

```ts
  {
    path: "/admin/routines",
    primary: (page: Page) => page.getByTestId("routines-new"),
  },
```

- [ ] **Step 3:** `npx vitest run tests/client/admin-gate-panel-reset.test.tsx tests/client/admin-routes.test.tsx tests/client/shell-routes.test.tsx` → PASS. `npx tsc -b` → clean.
- [ ] **Step 4: Commit.** `git add -A && git commit -m "test(admin): find the routines page by its test id"`

---

### Task 6: UI contract

**Files:** Modify `docs/ui/household-contract.md` (after the Members paragraph ending "…comes back with the first free one.", ≈ line 54).

- [ ] **Step 1:** Insert this paragraph (blank line before and after):

```markdown
Routines and chores are managed from `/admin/routines`: a list of routines grouped by day period,
in start-time order, beside the selected routine's detail — a weekday grid of the children it is
assigned to, its chores (drag to reorder, also with the keyboard) and actions to edit, assign, add a
chore or delete. Routines, chores and assignments are edited in dialogs. Deleting a routine or a
chore, changing, reactivating or deactivating an existing assignment, and moving a routine to
another day period ask for confirmation, because each changes the live streak.
```

- [ ] **Step 2:** `npx prettier --check docs/ui/household-contract.md` → clean. Commit: `git add -A && git commit -m "docs(ui): describe the routines admin page"`

---

### Task 7: End-to-end spec

**Files:** Create `tests/e2e/admin-routines.spec.ts`.

- [ ] **Step 1: Write the spec:**

```ts
import { test, expect } from "@playwright/test";
import { openAdminSection } from "./admin-nav";
import { unlockAdmin } from "./admin-unlock";
import { messages, resolveLang } from "../../src/client/i18n/messages";

/** Routines admin: create a routine with a long unbroken name (must wrap, not scroll), add a chore
 * with Enter, assign a child on Monday (shown in the week grid), then move the routine to the
 * evening period through the streak confirmation. Unique names per run: the e2e server keeps a
 * shared DATA_DIR across specs. */

const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN ?? "mpg-e2e-access-token";
const BOOTSTRAP_KEY = process.env.MP_BOOTSTRAP_KEY ?? "mpk-e2e-bootstrap-key";
const ADMIN_PIN = process.env.ADMIN_PIN ?? "1234";

test("routines admin: create, add a chore, assign a child and move to another period", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const rid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  await page.goto("/");
  await expect(page.getByTestId("access-gate-form")).toBeVisible();
  await page.getByTestId("access-gate-form").locator('input[name="token"]').fill(ACCESS_TOKEN);
  await page.getByRole("button", { name: "Enter" }).click();
  await expect(page.getByRole("button", { name: "Provision Device" })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByLabel("Bootstrap key").fill(BOOTSTRAP_KEY);
  await page.getByRole("button", { name: "Provision Device" }).click();
  await expect(page.getByTestId("home-surface")).toBeVisible({ timeout: 15_000 });

  const settingsResp = await page.request.get("/api/settings");
  expect(settingsResp.status()).toBe(200);
  const settings = (await settingsResp.json()) as { locale?: { language?: string } };
  const m = messages[resolveLang(settings.locale?.language)];

  const childName = `RoutinesKid-${rid}`;
  const memberResp = await page.request.post("/api/members", {
    data: { displayName: childName, role: "child" },
  });
  expect(memberResp.status()).toBe(201);
  const memberId = ((await memberResp.json()) as { id: string }).id;

  await unlockAdmin(page, ADMIN_PIN);
  await expect(page.getByTestId("admin-overview")).toBeVisible({ timeout: 10_000 });
  await openAdminSection(page, "admin-nav-routines-management");
  await expect(
    page.getByRole("heading", { name: m["routines.management.title"], exact: true })
  ).toBeVisible({ timeout: 10_000 });

  // Create — a long name without spaces must wrap instead of widening the page.
  const routineName = `Routine-${rid}-${"x".repeat(80)}`;
  await page.getByTestId("routines-new").click();
  const form = page.getByTestId("routine-form-dialog");
  await form.getByTestId("routine-form-name").fill(routineName);
  await form.getByTestId("routine-form-submit").click();
  await expect(form).toBeHidden();
  const detail = page.getByTestId("routine-detail");
  await expect(detail.getByRole("heading", { name: routineName })).toBeVisible();
  const routineId = await detail.getAttribute("data-routine-id");
  expect(routineId).toBeTruthy();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      )
    )
    .toBeLessThanOrEqual(0);

  // Chore — Enter submits.
  await detail.getByTestId("routine-add-chore").click();
  const choreDialog = page.getByTestId("chore-form-dialog");
  await choreDialog.getByTestId("chore-form-name").fill("Feed the cat");
  await choreDialog.getByTestId("chore-form-name").press("Enter");
  await expect(choreDialog).toBeHidden();
  await expect(detail.getByText("Feed the cat")).toBeVisible();

  // Assign the child on Monday — a new assignment saves without confirmation.
  await detail.getByTestId("routine-assign").click();
  const assign = page.getByTestId("assignment-dialog");
  const row = assign.getByTestId(`routine-assignment-${memberId}`);
  await row.getByTestId(`routines-weekday-${memberId}-mon`).check();
  await row.getByTestId(`routines-assignment-${memberId}-save`).click();
  await expect(row.getByTestId(`routines-assignment-${memberId}-deactivate`)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(assign).toBeHidden();
  await expect(detail.getByTestId("routine-week-day-mon")).toContainText(childName);

  // Move to the evening period — confirmed with the streak warning.
  await detail.getByTestId("routine-edit").click();
  await form.getByTestId("routine-form-period").click();
  await page.getByRole("option", { name: m["dayPeriod.evening"], exact: true }).click();
  await form.getByTestId("routine-form-submit").click();
  await page.getByTestId("routine-period-confirm").click();
  await expect(form).toBeHidden();
  await expect(detail).toContainText(m["dayPeriod.evening"]);
  const reread = await page.request.get(`/api/routines/${routineId}`);
  expect(((await reread.json()) as { dayPeriodId: string }).dayPeriodId).toBe("evening");

  await page.request.delete(`/api/routines/${routineId}`);
  await page.request.post(`/api/members/${memberId}/archive`);
});
```

- [ ] **Step 2: Run the affected e2e specs** (builds and starts the server itself):

```bash
PORT=43201 npx playwright test tests/e2e/admin-routines.spec.ts tests/e2e/admin-unlock-resilience.spec.ts tests/e2e/chores-board.spec.ts tests/e2e/household-dashboard.spec.ts --workers=3
```

Expected: all PASS. If a step fails, look at the trace (`npx playwright show-trace`) and fix the product or the selector, not the assertion.

- [ ] **Step 3: Commit.** `git add -A && git commit -m "test(e2e): cover the routines admin flow"`

---

### Task 8: Resync the reviewed inventory (coverage policy and test cohorts)

`tests/fixtures/assembly-cohort.json` lists every production file with minimum coverage totals/rates (`coveragePolicy.files`) and every test case per runner (`testCohorts.runners.{node,vitest,playwright}.files`). This branch deletes one production file, adds nine, deletes one test file, adds one, renames/adds cases and adds one e2e spec, so the fixture must be resynced. Precedent: commit `844eed79` ("drop removed files, add new ones at their measured values, lower a reviewed minimum only where the measured value fell below it").

**Files:** Modify `tests/fixtures/assembly-cohort.json`. Helper scripts go in your scratchpad directory (NOT in the repo).

- [ ] **Step 1: Full Vitest run with coverage and JSON results** (from the worktree root):

```bash
mkdir -p .quality
npx vitest run tests/client tests/boundary tests/integration --coverage --reporter=json --outputFile=.quality/vitest-results.json
```

Expected: success. (`.quality/` and `coverage/` are ignored build outputs.)

- [ ] **Step 2: Write `$SCRATCH/resync-cohort.mjs`** (`$SCRATCH` = your scratchpad):

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
  Object.keys(cases)
    .sort()
    .map((file) => [file, cases[file]])
);

const raw = JSON.parse(fs.readFileSync("coverage/coverage-final.json", "utf8"));
const policy = fixture.coveragePolicy.files;
for (const file of Object.keys(policy)) {
  if (!fs.existsSync(file)) delete policy[file];
}
const floor2 = (covered, total) =>
  total === 0 ? 100 : Math.floor((10000 * covered) / total) / 100;
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
  Object.keys(policy)
    .sort()
    .map((file) => [file, policy[file]])
);
fs.writeFileSync(fixturePath, JSON.stringify(fixture, null, 2) + "\n");
```

- [ ] **Step 3: Run it** for every production file this branch added or changed:

```bash
node "$SCRATCH/resync-cohort.mjs" \
  src/client/admin/RoutinesManagement.tsx \
  src/client/routines/admin/routineOrder.ts \
  src/client/routines/admin/MemberChip.tsx \
  src/client/routines/admin/RoutineList.tsx \
  src/client/routines/admin/RoutineWeekGrid.tsx \
  src/client/routines/admin/SortableChoreRow.tsx \
  src/client/routines/admin/RoutineDetail.tsx \
  src/client/routines/admin/RoutineFormDialog.tsx \
  src/client/routines/admin/ChoreFormDialog.tsx \
  src/client/routines/admin/AssignmentDialog.tsx \
  src/server/modules/routines/index.ts
```

Read the printed rates. If any new file has a low rate (below ≈ 80% lines), add tests to `tests/client/routines.test.tsx` for the uncovered branches and redo Steps 1-3 — the client layer must stay above 87/85/83/78 (lines/statements/functions/branches) in aggregate. Confirm `src/client/admin/ChoreOrderControls.tsx` is gone from `coveragePolicy.files` and `tests/client/chore-order-controls.test.tsx` from the vitest cohort.

- [ ] **Step 4: Playwright cohort for the new spec.**

```bash
PORT=43201 npx playwright test tests/e2e/admin-routines.spec.ts --list --reporter=json > "$SCRATCH/pw-list.json"
node -e '
const fs=require("fs"),path=require("path");
const list=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const fx="tests/fixtures/assembly-cohort.json";const j=JSON.parse(fs.readFileSync(fx,"utf8"));
const ids={};
const walk=(s)=>{for(const spec of s.specs??[]){const raw=spec.file??s.file;const f=path.relative(process.cwd(),path.isAbsolute(raw)?raw:path.resolve(list.config.rootDir,raw)).split(path.sep).join("/");(ids[f]??=[]).push(spec.id);}for(const c of s.suites??[])walk(c);};
list.suites.forEach(walk);
const files={...j.testCohorts.runners.playwright.files,...ids};
j.testCohorts.runners.playwright.files=Object.fromEntries(Object.keys(files).sort().map(k=>[k,files[k]]));
fs.writeFileSync(fx,JSON.stringify(j,null,2)+"\n");console.log(ids);
' "$SCRATCH/pw-list.json"
```

Expected output: `{ 'tests/e2e/admin-routines.spec.ts': [ '<one id>' ] }`.

- [ ] **Step 5:** `npx prettier --write tests/fixtures/assembly-cohort.json`, review `git diff --stat tests/fixtures/assembly-cohort.json` (only routines-related entries should change), then commit: `git add tests/fixtures/assembly-cohort.json && git commit -m "test: resync the reviewed inventory for the routines admin rework"`.

---

### Task 9: Verification gate, commit and report

- [ ] **Step 1: Clean tree.** `git status --porcelain` must print nothing (the gate hashes git-tracked files and rejects untracked ones; scratch scripts live outside the repo).
- [ ] **Step 2: Standard gate.** If the worktree is clean, run there; otherwise (or if `check:preflight` complains about the checkout) use a detached clean copy:

```bash
git worktree add --detach "$SCRATCH/verify" HEAD
cd "$SCRATCH/verify" && ln -s "<your worktree>/node_modules" node_modules
export MP_CANDIDATE_ID=$(node tools/candidate-identity.mjs)
npm run check:standard
```

Expected: exit 0. If `check:coverage` or `check:test-cohorts:standard` fails, fix the fixture in your worktree with Task 8 (re-run its Steps 1-5 there), commit, and re-run the gate on the new HEAD (remove and recreate the verify worktree: `git worktree remove --force "$SCRATCH/verify"`). If `check:openapi-shapes` flags `RoutineEditInput`, align `docs/api/chores/openapi.yaml` with `src/shared/index.ts` (both must list `name`, `active`, `dayPeriodId`, none required).

- [ ] **Step 3: Affected e2e, final run** (from your worktree):

```bash
PORT=43201 npx playwright test tests/e2e/admin-routines.spec.ts tests/e2e/admin-unlock-resilience.spec.ts tests/e2e/chores-board.spec.ts tests/e2e/household-dashboard.spec.ts --workers=3
```

Expected: all PASS.

- [ ] **Step 4: Commit on the worktree branch and report.** Commit anything left (`git add -A && git commit -m "chore(routines): final verification fixes"` only if there are changes). Do not merge or push. Report: branch name, worktree path, `git log --oneline main..HEAD`, the `check:standard` result (last lines), the e2e result, the coverage rates printed in Task 8 Step 3, and anything you skipped or decided differently from the spec (with the reason). The spec and plan are committed in the branch; the copies in the main checkout stay untracked.
