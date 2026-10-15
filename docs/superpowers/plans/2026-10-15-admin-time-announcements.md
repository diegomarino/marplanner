# Admin Time announcements parity Implementation Plan

> For agentic workers: use superpowers:executing-plans (or subagent-driven-development). Steps use
> checkbox (`- [ ]`) syntax. Do the steps in order; follow TDD (red, then green).

**Goal:** Rework `/admin/time-announcements` to the reference app's interaction pattern: "+ Create"
button opening a Dialog (also used for edit), cards with big time, 7 weekday circles, dimmed
inactive rules with an "Inactive" tag, icon edit/delete buttons, selected-voice line, ConfirmDialog
delete (no `window.confirm`), spinner while loading, Retry on load error. Keep the
Activate/Deactivate button and the rules-changed event. UI-only: no server, shared, OpenAPI or schema
change.

**Spec:** `docs/superpowers/specs/2026-10-15-admin-time-announcements-design.md` (read it first).

**Tech:** React + Vite client (`src/client`, alias `@` = `src/client`), vitest + jsdom
(`tests/client`), Playwright (`tests/e2e`), node >= repo requirement, `npm`.

---

## Task 0: Worktree setup (executor only)

The spec and this plan are UNTRACKED files in the main checkout
(`/Users/diego/Dev/marplanner-project`). They are not in your worktree.

- [ ] Work in your own worktree/branch (e.g. `feat/admin-time-announcements`) of
      `/Users/diego/Dev/marplanner-project`. Copy both documents into it:

```bash
MAIN=/Users/diego/Dev/marplanner-project
mkdir -p docs/superpowers/specs docs/superpowers/plans
cp "$MAIN/docs/superpowers/specs/2026-10-15-admin-time-announcements-design.md" docs/superpowers/specs/
cp "$MAIN/docs/superpowers/plans/2026-10-15-admin-time-announcements.md" docs/superpowers/plans/
```

- [ ] Install dependencies in the worktree (`node_modules` is not shared): `npm ci`.
- [ ] If git commands are refused in your environment (isolated agents sometimes cannot run git),
      do not stall: finish the work, skip commits, and report the changed files so the parent can
      collect a patch. Otherwise commit as described in the last task.
- [ ] Baseline: `npx vitest run tests/client/time-announcements-management.test.tsx tests/client/announcements-briefing-admin.test.tsx tests/client/time-announcements-speech.test.ts tests/client/time-announcements-i18n-parity.test.ts`
      Expect all PASS before you change anything.

## File map

| File                                                  | Action                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `src/client/time-announcements/speech.ts`             | add exported `voiceNameFor(lang)`                                                           |
| `tests/client/time-announcements-speech.test.ts`      | add tests for `voiceNameFor`                                                                |
| `src/client/i18n/messages.ts`                         | edit 2 title values; add `// admin-time-announcements` block at the end of `en` and of `es` |
| `src/client/admin/TimeAnnouncementsManagement.tsx`    | rewrite (dialog, cards, ConfirmDialog, retry, spinner)                                      |
| `tests/client/time-announcements-management.test.tsx` | update + add tests                                                                          |
| `tests/client/announcements-briefing-admin.test.tsx`  | update title, density census, dialog-first flows, header comment                            |
| `tests/e2e/time-announcements-admin.spec.ts`          | new: admin-UI CRUD e2e (runs by default)                                                    |
| `tests/fixtures/assembly-cohort.json`                 | resync case names + coverage floors                                                         |
| `docs/features/time-announcements.md`                 | add FR-020 and a user-story line                                                            |
| `docs/ui/household-contract.md`                       | one-line description for `/admin/time-announcements`                                        |

`tests/e2e/admin-unlock-resilience.spec.ts` needs NO change: it keys on
`time-announcements-create`, which stays on the header "+ Create" button.

---

## Task 1: `voiceNameFor` in speech.ts (TDD)

**Files:** `src/client/time-announcements/speech.ts`, `tests/client/time-announcements-speech.test.ts`

The speech tests re-import the module per case via `freshSpeech()` and install a fake synth with
`installFakeSynth({ voices: [{ lang }] })` (read lines 1-85 of the test file). A fake voice there is
just `{ lang }`; extend with `name` in the new tests.

- [ ] **Step 1: failing tests.** Append inside the existing top-level `describe` of
      `tests/client/time-announcements-speech.test.ts`:

```ts
it("voiceNameFor returns the name of the voice speak() would pick for the language", async () => {
  installFakeSynth({
    voices: [
      { lang: "de-DE", name: "Anna" },
      { lang: "es-ES", name: "Monica" },
    ] as Array<{ lang: string }>,
  });
  const { voiceNameFor } = await freshSpeech();
  expect(voiceNameFor("es")).toBe("Monica");
});

it("voiceNameFor is null when no voice matches, the API is absent, or getVoices throws", async () => {
  installFakeSynth({ voices: [{ lang: "de-DE" }] });
  let speech = await freshSpeech();
  expect(speech.voiceNameFor("en")).toBeNull();

  installFakeSynth({ throwOnGetVoices: true });
  speech = await freshSpeech();
  expect(speech.voiceNameFor("en")).toBeNull();

  vi.unstubAllGlobals();
  speech = await freshSpeech();
  expect(speech.voiceNameFor("en")).toBeNull();
});
```

If the file's `afterEach` already unstubs globals, keep the manual `vi.unstubAllGlobals()` anyway
(it is what makes the "API absent" case real). Run
`npx vitest run tests/client/time-announcements-speech.test.ts` and confirm the new tests FAIL
(`voiceNameFor is not a function`).

- [ ] **Step 2: implement.** In `src/client/time-announcements/speech.ts`, directly after
      `pickVoice`, add:

```ts
/** Name of the voice `speak`/`testVoice` would use for `lang`, or `null` when none matches (the
 * default voice is used then) or the API is unavailable. Read-only and never throws: the admin
 * panel shows it next to Test voice. Chromium loads voices lazily, so callers re-read it. */
export function voiceNameFor(lang: Language): string | null {
  const synth = getSynth();
  if (!synth) return null;
  return pickVoice(synth, UTTERANCE_LANG[lang])?.name ?? null;
}
```

`pickVoice` already try/catches `getVoices()`. Run the speech test file: PASS.

## Task 2: i18n keys

**File:** `src/client/i18n/messages.ts` (shared with parallel workers: keep edits minimal).

- [ ] **Step 1: title parity with the sidebar label** (brief rule 2). Edit in place:
      `"timeAnnouncements.management.title"` en `"Time Announcements"` -> `"Time announcements"`;
      es `"Anuncios Horarios"` -> `"Anuncios horarios"`. (Do NOT touch `admin.nav.timeAnnouncements`.)
- [ ] **Step 2: new keys.** At the END of the `en` object (just before its closing `},` that precedes
      `es: {`; at the time of writing it ends after `"shell.density.disable"`), append:

```ts
    // admin-time-announcements
    "timeAnnouncements.management.dialogEditTitle": "Edit announcement",
    "timeAnnouncements.management.dialogDescription":
      "Pick the time and the weekdays the kiosk should announce it.",
    "timeAnnouncements.management.saving": "Saving…",
    "timeAnnouncements.management.retry": "Retry",
    "timeAnnouncements.management.voiceLabel": "Voice",
    "timeAnnouncements.management.noVoice": "No voice available for this language",
    "timeAnnouncements.management.deleteTitle": "Delete announcement",
    "timeAnnouncements.weekdayInitial.mon": "M",
    "timeAnnouncements.weekdayInitial.tue": "T",
    "timeAnnouncements.weekdayInitial.wed": "W",
    "timeAnnouncements.weekdayInitial.thu": "T",
    "timeAnnouncements.weekdayInitial.fri": "F",
    "timeAnnouncements.weekdayInitial.sat": "S",
    "timeAnnouncements.weekdayInitial.sun": "S",
```

and at the END of the `es` object (just before the closing `},` preceding `} as const;`):

```ts
    // admin-time-announcements
    "timeAnnouncements.management.dialogEditTitle": "Editar anuncio",
    "timeAnnouncements.management.dialogDescription":
      "Elige la hora y los días de la semana en que el kiosco debe anunciarla.",
    "timeAnnouncements.management.saving": "Guardando…",
    "timeAnnouncements.management.retry": "Reintentar",
    "timeAnnouncements.management.voiceLabel": "Voz",
    "timeAnnouncements.management.noVoice": "No hay voz disponible para este idioma",
    "timeAnnouncements.management.deleteTitle": "Eliminar anuncio",
    "timeAnnouncements.weekdayInitial.mon": "L",
    "timeAnnouncements.weekdayInitial.tue": "M",
    "timeAnnouncements.weekdayInitial.wed": "X",
    "timeAnnouncements.weekdayInitial.thu": "J",
    "timeAnnouncements.weekdayInitial.fri": "V",
    "timeAnnouncements.weekdayInitial.sat": "S",
    "timeAnnouncements.weekdayInitial.sun": "D",
```

Reused existing keys (do not duplicate): `.title`, `.description`, `.loading`, `.loadError`,
`.noRules`, `.createTitle` (dialog title when creating), `.timeLabel`, `.weekdaysLabel`,
`.activeLabel`, `.create`, `.creating`, `.createError`, `.testVoice`, `.edit`, `.save`, `.cancel`,
`.editError`, `.activate`, `.deactivate`, `.delete`, `.deleteConfirm`, `.deleteError`,
`.statusInactive`, `timeAnnouncements.weekday.*`. Leave the now-unused `.list`/`.statusActive`.

- [ ] **Step 3:** `npx vitest run tests/client/time-announcements-i18n-parity.test.ts` PASS (en/es
      parity). Do not run typecheck yet (the component does not use the keys until Task 3).

## Task 3: Tests first for the component (red)

**File:** `tests/client/time-announcements-management.test.tsx`. Read the whole file once. Make
these changes; the component is rewritten in Task 4, so the file will be RED until then.

Shared change: extend the speech mock so the new import resolves:

```ts
vi.mock("@/time-announcements/speech", () => ({
  testVoice: vi.fn(),
  voiceNameFor: vi.fn(() => null),
}));
```

and `import { testVoice, voiceNameFor } from "@/time-announcements/speech";`. Add
`vi.mocked(voiceNameFor).mockReset().mockReturnValue(null)` in `beforeEach`.

Add a helper used by most tests:

```ts
function openCreateDialog() {
  fireEvent.click(screen.getByTestId("time-announcements-create"));
  return screen.getByTestId("time-announcements-form-dialog");
}
```

Per existing test:

1. "lists ALL rules..." keep as is (row text "07:00", "Inactive", server order). Also assert the
   evening row is dimmed-tag only: `expect(morningRow).not.toHaveTextContent("Inactive")`.
2. "renders the empty state" keep.
3. "creates a rule via POST...": click `time-announcements-create` (opens dialog), assert the time
   input value is `"07:00"` (default), do NOT change the time, click weekdays mon and tue
   (`time-announcements-weekday-mon/-tue`), click `time-announcements-submit`. Keep the POST
   assertion (body `{"time":"07:00","weekDays":["mon","tue"],"isActive":true}`), then
   `await waitFor(() => expect(screen.queryByTestId("time-announcements-form-dialog")).not.toBeInTheDocument())`,
   find the rule row, and keep `changedListener` called once.
4. Rename "the Create button stays disabled until a time and at least one weekday are set" to "the
   dialog submit stays disabled until a time and at least one weekday are set": open the dialog;
   submit disabled (default 07:00 but no weekday); click mon -> enabled; clear the time
   (`fireEvent.change(input, { target: { value: "" } })`) -> disabled again.
5. "edits a rule via PATCH...": click `time-announcements-edit-rule-morning` (opens the dialog);
   assert the time input has `"07:00"` and `time-announcements-weekday-mon` is checked; change time
   to 08:00; click tue, wed, thu, fri (unchecks them; ids `time-announcements-weekday-<day>`); click
   `time-announcements-active-checkbox`; click `time-announcements-submit`; keep the PATCH assertion
   (`{"time":"08:00","weekDays":["mon"],"isActive":false}`) and the final row assertions.
6. "toggles active ..." unchanged.
7. "deletes a rule via DELETE after confirmation": drop the `window.confirm` spy entirely. Click
   `time-announcements-delete-rule-morning`; expect `screen.getByRole("alertdialog")` OR
   `getByRole("dialog", { name: "Delete announcement" })` (check which role `ConfirmDialog` renders
   via `ui/dialog.tsx`; use whichever it is), assert it contains "Delete this time announcement
   rule?", click `time-announcements-delete-confirm`, wait for the row to disappear, assert a DELETE
   to `/api/time-announcements/rule-morning` was made. Assert `window.confirm` was never called:
   `const confirmSpy = vi.spyOn(window, "confirm")` ... `expect(confirmSpy).not.toHaveBeenCalled()`.
8. "does NOT delete when the confirm dialog is dismissed": click delete, then click the dialog's
   "Cancel" button (`screen.getByRole("button", { name: "Cancel" })` scoped with `within` the
   confirm dialog), assert no DELETE call and the row is still present.
9. 409 overlap and 400 validation tests: open the dialog first, submit via
   `time-announcements-submit`, assert the message in `time-announcements-form-error` (NOT
   `time-announcements-error`), and additionally assert the dialog is still open and the weekday
   selection survived (`time-announcements-weekday-mon` still checked).
10. "Test-voice speaks the UNSAVED form time...": open the dialog, change time to 17:45, click
    `time-announcements-test-voice` with no weekday selected; same `testVoice` and "no write"
    assertions as today.
11. The parametrised `it.each(["en","es"])` "localizes browser exceptions on rule creation": after
    `findByRole("button", { name: language === "es" ? "Crear" : "Create" })` click that button
    (opens the dialog; `getByTestId("time-announcements-create")` is equivalent), set
    time 07:00, click mon, click `time-announcements-submit`, assert the message in
    `time-announcements-form-error` and that it does not contain "private diagnostics".

New tests (add to the main `describe`):

- "shows a spinner while loading": mock fetch with a never-resolving GET for
  `/api/time-announcements`; render; expect `screen.getByRole("status")` to have text
  "Loading time announcements…".
- "a failed load shows the error and a Retry that reloads": first GET -> 500, second GET -> `[RULE_MORNING]`;
  render; `await screen.findByTestId("time-announcements-error")`; expect NO
  `time-announcements-create` button; click `time-announcements-retry`; expect the morning row
  and the Create button to appear and the error to be gone.
- "Cancel closes the dialog without any write": open dialog, click its Cancel button
  (`time-announcements-cancel`), dialog gone, no non-GET fetch call.
- "shows the selected voice name, or a no-voice hint": `vi.mocked(voiceNameFor).mockReturnValue("Monica")`;
  open the dialog; expect `time-announcements-voice` to have text "Voice: Monica"; then
  `mockReturnValue(null)` and reopen (close with Cancel first) -> "No voice available for this language".
  (`voiceNameFor` is called with the household lang: assert `toHaveBeenCalledWith("en")`.)
- "inactive rules are dimmed and tagged": evening row (`RULE_EVENING_INACTIVE`) contains "Inactive"
  and its time element has class `opacity-60`: query `within(row).getByText("20:00")` and
  `expect(el.className).toContain("opacity-60")`; the morning time element does not.
- "weekday circles show initials and on/off state": morning row has 7 circles
  (`within(row).getAllByTestId(/^time-announcements-day-/)` -> 7), with
  `data-on="true"` for mon..fri and `"false"` for sat/sun; the sr-only text lists "Mon, Tue, Wed, Thu, Fri".
- "closing is blocked while a save is in flight": make the POST never resolve, submit, press Escape;
  the dialog stays open (`time-announcements-form-dialog` still present).

Run `npx vitest run tests/client/time-announcements-management.test.tsx`: expect widespread FAIL
(red). That is the baseline for Task 4.

## Task 4: Rewrite the component (green)

**File:** `src/client/admin/TimeAnnouncementsManagement.tsx` (replace the whole file; keep the
exported `WEEKDAY_LABEL_KEYS`, which `announcements-briefing-admin.test.tsx` imports). Replace the
long header comment with a short accurate one (the old ConfirmDialog non-adoption note is now wrong
and must go).

```tsx
import { useEffect, useState } from "react";
import { Loader2, Pencil, Plus, Trash2, Volume2 } from "lucide-react";
import { LocalizedApiError, responseMessage as readResponseMessage } from "@/lib/api-error";
import { authFetch } from "@/lib/credential";
import { useT } from "@/i18n";
import { useHouseholdSettings } from "@/lib/householdSettings";
import { resolveLang, type MessageKey } from "@/i18n/messages";
import { testVoice, voiceNameFor } from "@/time-announcements/speech";
import { RULES_CHANGED_EVENT } from "@/time-announcements/events";
import { cn } from "@/lib/utils";
import { AdminPanel } from "@/components/AdminPanel";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorNotice } from "@/components/ErrorNotice";
import { CheckboxField } from "@/components/CheckboxField";
import {
  CANONICAL_WEEKDAY_ORDER,
  WeekdayPicker,
  type WeekdayLabels,
} from "@/components/WeekdayPicker";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { TimeAnnouncementRule, TimeAnnouncementRuleInput, WeekdayCode } from "../../shared";

/* TimeAnnouncementsManagement: list of announcement rules as cards, one Dialog for create and
 * edit, ConfirmDialog for delete. The server returns rules ordered by time (FR-006), so the
 * list is not re-sorted. Test voice speaks the UNSAVED form time locally (no write, FR-014). */

export const WEEKDAY_LABEL_KEYS: Record<WeekdayCode, MessageKey> = {
  mon: "timeAnnouncements.weekday.mon",
  tue: "timeAnnouncements.weekday.tue",
  wed: "timeAnnouncements.weekday.wed",
  thu: "timeAnnouncements.weekday.thu",
  fri: "timeAnnouncements.weekday.fri",
  sat: "timeAnnouncements.weekday.sat",
  sun: "timeAnnouncements.weekday.sun",
};

const WEEKDAY_INITIAL_KEYS: Record<WeekdayCode, MessageKey> = {
  mon: "timeAnnouncements.weekdayInitial.mon",
  tue: "timeAnnouncements.weekdayInitial.tue",
  wed: "timeAnnouncements.weekdayInitial.wed",
  thu: "timeAnnouncements.weekdayInitial.thu",
  fri: "timeAnnouncements.weekdayInitial.fri",
  sat: "timeAnnouncements.weekdayInitial.sat",
  sun: "timeAnnouncements.weekdayInitial.sun",
};

function weekdayLabels(t: (key: MessageKey) => string): WeekdayLabels {
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

interface RuleFormState {
  time: string;
  weekDays: WeekdayCode[];
  isActive: boolean;
}

const DEFAULT_TIME = "07:00";
const EMPTY_FORM: RuleFormState = { time: DEFAULT_TIME, weekDays: [], isActive: true };

export function TimeAnnouncementsManagement() {
  const t = useT();
  const responseMessage = (response: Response, fallback: string) =>
    readResponseMessage(response, fallback, {
      active_overlap: t("timeAnnouncements.management.activeOverlap"),
      validation_error: t("timeAnnouncements.management.invalidRule"),
    });
  const { language } = useHouseholdSettings();
  const lang = resolveLang(language ?? undefined);

  const [rules, setRules] = useState<TimeAnnouncementRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Dialog: closed = `formOpen` false; `editing` null means create.
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<TimeAnnouncementRule | null>(null);
  const [form, setForm] = useState<RuleFormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [voiceName, setVoiceName] = useState<string | null>(null);

  const [deleteId, setDeleteId] = useState<string | null>(null);

  useEffect(() => {
    void loadRules(true);
  }, []);

  // Chromium loads voices asynchronously: re-read the voice name while the dialog is open.
  useEffect(() => {
    if (!formOpen) return;
    const update = () => setVoiceName(voiceNameFor(lang));
    update();
    const id = window.setInterval(update, 500);
    return () => window.clearInterval(id);
  }, [formOpen, lang]);

  /** `showSpinner` is true only for the first load and Retry; reloads after a write refresh in place. */
  async function loadRules(showSpinner: boolean) {
    if (showSpinner) setLoading(true);
    setError(null);
    setLoadFailed(false);
    try {
      const response = await authFetch("/api/time-announcements", { credentials: "include" });
      if (!response.ok) throw new Error("load failed");
      const data = (await response.json()) as TimeAnnouncementRule[];
      setRules(Array.isArray(data) ? data : []);
    } catch {
      setLoadFailed(true);
      setError(t("timeAnnouncements.management.loadError"));
    } finally {
      setLoading(false);
    }
  }

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setFormOpen(true);
  }

  function openEdit(rule: TimeAnnouncementRule) {
    setEditing(rule);
    setForm({ time: rule.time, weekDays: [...rule.weekDays], isActive: rule.isActive });
    setFormError(null);
    setFormOpen(true);
  }

  function closeForm() {
    if (saving) return;
    setFormOpen(false);
  }

  const canSubmit = form.time !== "" && form.weekDays.length > 0 && !saving;

  async function submitForm() {
    if (!canSubmit) return;
    const rule = editing;
    const failure = t(
      rule ? "timeAnnouncements.management.editError" : "timeAnnouncements.management.createError"
    );
    setSaving(true);
    setFormError(null);
    try {
      const input: TimeAnnouncementRuleInput = {
        time: form.time,
        weekDays: form.weekDays,
        isActive: form.isActive,
      };
      const response = await authFetch(
        rule ? `/api/time-announcements/${rule.id}` : "/api/time-announcements",
        {
          method: rule ? "PATCH" : "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }
      );
      if (!response.ok) throw new LocalizedApiError(await responseMessage(response, failure));
      setSaving(false);
      setFormOpen(false);
      await loadRules(false);
      window.dispatchEvent(new CustomEvent(RULES_CHANGED_EVENT));
    } catch (cause) {
      setFormError(cause instanceof LocalizedApiError ? cause.message : failure);
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(rule: TimeAnnouncementRule) {
    setError(null);
    try {
      const response = await authFetch(`/api/time-announcements/${rule.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isActive: !rule.isActive }),
      });
      if (!response.ok) {
        throw new LocalizedApiError(
          await responseMessage(response, t("timeAnnouncements.management.editError"))
        );
      }
      await loadRules(false);
      window.dispatchEvent(new CustomEvent(RULES_CHANGED_EVENT));
    } catch (cause) {
      setError(
        cause instanceof LocalizedApiError
          ? cause.message
          : t("timeAnnouncements.management.editError")
      );
    }
  }

  async function deleteRule(id: string) {
    setError(null);
    try {
      const response = await authFetch(`/api/time-announcements/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!response.ok) {
        throw new LocalizedApiError(
          await responseMessage(response, t("timeAnnouncements.management.deleteError"))
        );
      }
      await loadRules(false);
      window.dispatchEvent(new CustomEvent(RULES_CHANGED_EVENT));
    } catch (cause) {
      setError(
        cause instanceof LocalizedApiError
          ? cause.message
          : t("timeAnnouncements.management.deleteError")
      );
    }
  }

  const title = t("timeAnnouncements.management.title");

  if (loading) {
    return (
      <AdminPanel title={title} data-testid="time-announcements-management">
        <div
          role="status"
          className="text-muted-foreground text-control flex items-center justify-center gap-2 py-10"
        >
          <Loader2 className="size-5 animate-spin" aria-hidden="true" />
          {t("timeAnnouncements.management.loading")}
        </div>
      </AdminPanel>
    );
  }

  return (
    <AdminPanel
      title={title}
      description={t("timeAnnouncements.management.description")}
      data-testid="time-announcements-management"
      actions={
        loadFailed ? undefined : (
          <Button type="button" data-testid="time-announcements-create" onClick={openCreate}>
            <Plus aria-hidden="true" />
            {t("timeAnnouncements.management.create")}
          </Button>
        )
      }
    >
      <ErrorNotice message={error} data-testid="time-announcements-error" />
      {loadFailed ? (
        <div>
          <Button
            type="button"
            variant="secondary"
            data-testid="time-announcements-retry"
            onClick={() => void loadRules(true)}
          >
            {t("timeAnnouncements.management.retry")}
          </Button>
        </div>
      ) : rules.length === 0 ? (
        <p className="text-muted-foreground" data-testid="time-announcements-empty">
          {t("timeAnnouncements.management.noRules")}
        </p>
      ) : (
        <ul className="grid gap-3">
          {rules.map((rule) => (
            <li
              key={rule.id}
              data-testid={`time-announcements-rule-${rule.id}`}
              className="bg-card flex flex-col gap-3 rounded-lg border p-4"
            >
              <div className="flex items-center justify-between gap-2">
                <h3
                  className={cn(
                    "text-3xl font-semibold tabular-nums",
                    !rule.isActive && "opacity-60"
                  )}
                >
                  {rule.time}
                </h3>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`${t("timeAnnouncements.management.edit")} ${rule.time}`}
                    data-testid={`time-announcements-edit-${rule.id}`}
                    onClick={() => openEdit(rule)}
                  >
                    <Pencil aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="text-destructive hover:text-destructive/80"
                    aria-label={`${t("timeAnnouncements.management.delete")} ${rule.time}`}
                    data-testid={`time-announcements-delete-${rule.id}`}
                    onClick={() => setDeleteId(rule.id)}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className={cn("flex items-center gap-2", !rule.isActive && "opacity-60")}>
                  {CANONICAL_WEEKDAY_ORDER.map((day) => {
                    const on = rule.weekDays.includes(day);
                    return (
                      <span
                        key={day}
                        aria-hidden="true"
                        data-testid={`time-announcements-day-${rule.id}-${day}`}
                        data-on={on ? "true" : "false"}
                        className={cn(
                          "flex size-8 items-center justify-center rounded-full text-xs font-bold",
                          on
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground"
                        )}
                      >
                        {t(WEEKDAY_INITIAL_KEYS[day])}
                      </span>
                    );
                  })}
                  <span className="sr-only">
                    {CANONICAL_WEEKDAY_ORDER.filter((day) => rule.weekDays.includes(day))
                      .map((day) => t(WEEKDAY_LABEL_KEYS[day]))
                      .join(", ")}
                  </span>
                </div>
                {!rule.isActive && (
                  <span className="text-muted-foreground text-xs tracking-wide uppercase">
                    {t("timeAnnouncements.management.statusInactive")}
                  </span>
                )}
                <Button
                  type="button"
                  variant="secondary"
                  className="ml-auto"
                  data-testid={`time-announcements-toggle-${rule.id}`}
                  onClick={() => void toggleActive(rule)}
                >
                  {rule.isActive
                    ? t("timeAnnouncements.management.deactivate")
                    : t("timeAnnouncements.management.activate")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={formOpen} onOpenChange={(open) => !open && closeForm()}>
        <DialogContent
          className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-xl"
          closeLabel={t("timeAnnouncements.management.cancel")}
          data-testid="time-announcements-form-dialog"
        >
          <DialogHeader>
            <DialogTitle>
              {editing
                ? t("timeAnnouncements.management.dialogEditTitle")
                : t("timeAnnouncements.management.createTitle")}
            </DialogTitle>
            <DialogDescription>
              {t("timeAnnouncements.management.dialogDescription")}
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submitForm();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="time-announcements-time">
                {t("timeAnnouncements.management.timeLabel")}
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="time-announcements-time"
                  type="time"
                  data-testid="time-announcements-time-input"
                  value={form.time}
                  onChange={(e) => setForm({ ...form, time: e.target.value })}
                  className="w-auto flex-1"
                />
                <Button
                  type="button"
                  variant="secondary"
                  data-testid="time-announcements-test-voice"
                  disabled={!form.time}
                  onClick={() => testVoice(form.time, lang)}
                >
                  <Volume2 aria-hidden="true" />
                  {t("timeAnnouncements.management.testVoice")}
                </Button>
              </div>
              <p className="text-muted-foreground text-xs" data-testid="time-announcements-voice">
                {voiceName
                  ? `${t("timeAnnouncements.management.voiceLabel")}: ${voiceName}`
                  : t("timeAnnouncements.management.noVoice")}
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">
                {t("timeAnnouncements.management.weekdaysLabel")}
              </span>
              <WeekdayPicker
                mode="multi"
                value={form.weekDays}
                onChange={(next) => setForm({ ...form, weekDays: [...next] })}
                labels={weekdayLabels(t)}
                groupLabel={t("timeAnnouncements.management.weekdaysLabel")}
                testIdPrefix="time-announcements-weekday"
              />
            </div>
            <CheckboxField
              checked={form.isActive}
              onChange={(checked) => setForm({ ...form, isActive: checked })}
              label={t("timeAnnouncements.management.activeLabel")}
              data-testid="time-announcements-active-checkbox"
            />
            <ErrorNotice message={formError} data-testid="time-announcements-form-error" />
            <DialogFooter>
              <Button
                type="button"
                variant="secondary"
                data-testid="time-announcements-cancel"
                disabled={saving}
                onClick={closeForm}
              >
                {t("timeAnnouncements.management.cancel")}
              </Button>
              <Button type="submit" data-testid="time-announcements-submit" disabled={!canSubmit}>
                {saving
                  ? editing
                    ? t("timeAnnouncements.management.saving")
                    : t("timeAnnouncements.management.creating")
                  : editing
                    ? t("timeAnnouncements.management.save")
                    : t("timeAnnouncements.management.create")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteId !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteId(null);
        }}
        title={t("timeAnnouncements.management.deleteTitle")}
        description={t("timeAnnouncements.management.deleteConfirm")}
        confirmLabel={t("timeAnnouncements.management.delete")}
        cancelLabel={t("timeAnnouncements.management.cancel")}
        confirmTestId="time-announcements-delete-confirm"
        onConfirm={() => {
          const id = deleteId;
          setDeleteId(null);
          if (id) void deleteRule(id);
        }}
      />
    </AdminPanel>
  );
}
```

Notes for the executor while implementing:

- Adjust formatting with `npx prettier --write` on touched files (the repo has `format:check`).
- `DialogFooter` is exported from `@/components/ui/dialog` (verified). `Button size="icon"` and
  `variant="ghost"|"secondary"` exist in `ui/button.tsx` (verified).
- If `DialogContent` rejects `data-testid` typing, MembersManagement passes it the same way
  (`data-testid="member-form-dialog"`), so it is accepted.
- The `setSaving(false)` before `setFormOpen(false)` in the success path is deliberate (so
  `closeForm`'s saving guard is not what blocks the close); the `finally` stays for the failure path.
- If the load-error test finds both `time-announcements-error` and a hidden Create button, that is
  the intended state (Create hidden, Retry shown).
- If `readResponseMessage`/`LocalizedApiError` keys `activeOverlap`/`invalidRule` are not in the
  existing catalog, they ARE (messages.ts lines 25-27); do not re-add them.

- [ ] Run `npx vitest run tests/client/time-announcements-management.test.tsx` until GREEN. Fix the
      component, not the assertions, unless an assertion contradicts the spec.
- [ ] Run `npm run typecheck` and `npm run lint` (fix `MessageKey` or unused-import findings).

## Task 5: Update the density / landmark / error / weekday tests

**File:** `tests/client/announcements-briefing-admin.test.tsx` (read lines 1-380 again; only the
TimeAnnouncements half changes; the Daily Briefing half must not be touched: other workers edit it).

- [ ] Header comment (lines 1-30): delete the two bullets claiming `ConfirmDialog` is deliberately
      not adopted by TimeAnnouncementsManagement; state that it now uses `ConfirmDialog` for delete
      (`DailyBriefingManagement` still has nothing destructive).
- [ ] Landmark test: region/heading name becomes `"Time announcements"` (matches the sidebar).
      The comment about a second loading AdminPanel still holds (loading panel has the same title).
- [ ] Density test "meets kiosk density collapsed with two rules, then with one rule's edit form
      open": rewrite phases. Phase 1 (collapsed): header "+ Create" (1) + each rule's Edit, Delete,
      Toggle (3 x 2) = **7** controls. Phase 2: click `time-announcements-create` (dialog open): the
      dialog adds time input, Test voice, 7 weekday checkboxes, Active checkbox, Cancel, Submit and the
      Radix close button = 13, so the expected total is **20**. Because Radix portals/aria-hides, do
      NOT trust this arithmetic: print `countInteractiveControls(document.body)` once, confirm it equals
      the sum of the controls you can name in the DOM, then hard-code that number with a comment listing
      the controls. Test names change accordingly (e.g. "...collapsed with two rules, then with the
      create dialog open").
- [ ] Census test "CENSUS FIRES ON REMOVAL": drop the `window.confirm` spy. Flow: click
      `time-announcements-delete-rule-evening`, click `time-announcements-delete-confirm`, wait for the
      row to disappear. Collapsed count 7 -> after removal **4**. Rename the test to
      "...drops its collapsed row's 3 controls (7 -> 4)". Make sure the confirm dialog has closed before
      counting (`waitFor` on the dialog being gone), otherwise its buttons inflate the census.
- [ ] Negative test: still finds `time-announcements-create` (now the header button): keep, but the
      assertions on message text stay valid. Update its title only if it says "Create button" and is
      still correct (it is).
- [ ] Error tests: load failure still asserts `time-announcements-error`, role alert, text
      "Failed to load time announcements."; ALSO assert `time-announcements-retry` is present. Create
      failure test: click `time-announcements-create` first, then fill/submit with
      `time-announcements-submit`, and assert the alert is `time-announcements-form-error` with the
      overlap text.
- [ ] WeekdayPicker tests: both must open the dialog first (`fireEvent.click(screen.getByTestId("time-announcements-create"))`).
      Group-name test: still `findByRole("group", { name: "Días de la semana" })` in `es`. NOTE the
      Radix dialog marks the page behind it `aria-hidden`, which is fine because the picker is inside
      the dialog. POST-order test: time input already `07:00` (keep the explicit `fireEvent.change`
      or drop it), click wed then mon, click `time-announcements-submit`, expect `["mon","wed"]`.
- [ ] `WEEKDAY_LABEL_KEYS` iteration test unchanged.
- [ ] Run `npx vitest run tests/client/announcements-briefing-admin.test.tsx` GREEN (the whole file,
      including the Daily Briefing half).

## Task 6: E2E, admin UI CRUD (new spec file)

`playwright.config.ts` ignores `tests/e2e/time-announcements.spec.ts` unless
`MP_E2E_TIME_ANNOUNCEMENTS=1` (it waits minutes on the real clock), so a UI test added there would
not run in acceptance. Put the admin-UI test in a NEW default-run spec instead.

**File (new):** `tests/e2e/time-announcements-admin.spec.ts`

- [ ] Write it, copying `provision` verbatim from `tests/e2e/time-announcements.spec.ts` (lines
      ~55-66: access gate, bootstrap key, "Provision Device") together with the three constants
      (`ACCESS_TOKEN`, `BOOTSTRAP_KEY`, `ADMIN_PIN`) and importing `unlockAdmin` from `./admin-unlock`
      (no `timezoneId` override needed):

```ts
import { expect, test, type Page } from "@playwright/test";
import { unlockAdmin } from "./admin-unlock";

// ACCESS_TOKEN / BOOTSTRAP_KEY / ADMIN_PIN constants and provision(page): copy from time-announcements.spec.ts

test("admin page: create in the dialog, edit, deactivate, delete through ConfirmDialog", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await provision(page);
  await page.goto("/admin/time-announcements");
  await unlockAdmin(page, ADMIN_PIN);

  let ruleId: string | null = null;
  try {
    // Saturday-only 03:17 cannot collide with the demo seeds (07:00 / 19:00 mon-fri).
    await page.getByTestId("time-announcements-create").click();
    const dialog = page.getByTestId("time-announcements-form-dialog");
    await dialog.getByTestId("time-announcements-time-input").fill("03:17");
    await dialog.getByTestId("time-announcements-weekday-sat").click();
    await dialog.getByTestId("time-announcements-submit").click();
    await expect(dialog).toBeHidden();

    const card = page.getByTestId(/^time-announcements-rule-/).filter({ hasText: "03:17" });
    await expect(card).toHaveCount(1);
    ruleId = (await card.getAttribute("data-testid"))!.replace("time-announcements-rule-", "");

    await card.getByTestId(`time-announcements-edit-${ruleId}`).click();
    await dialog.getByTestId("time-announcements-weekday-sun").click();
    await dialog.getByTestId("time-announcements-submit").click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId(`time-announcements-day-${ruleId}-sun`)).toHaveAttribute(
      "data-on",
      "true"
    );

    await card.getByTestId(`time-announcements-toggle-${ruleId}`).click();
    await expect(card).toContainText(/inactive|inactiva/i);

    await card.getByTestId(`time-announcements-delete-${ruleId}`).click();
    await page.getByTestId("time-announcements-delete-confirm").click();
    await expect(page.getByTestId(`time-announcements-rule-${ruleId}`)).toHaveCount(0);
    ruleId = null;
  } finally {
    // Best-effort cleanup if a step failed before the UI delete ran.
    if (ruleId) await page.request.delete(`/api/time-announcements/${ruleId}`).catch(() => {});
  }
});
```

`page.request` shares the provisioned device cookie, as in the sibling spec's `afterEach`.

- [ ] Run (unique port, spec runs by default; no `MP_E2E_TIME_ANNOUNCEMENTS` needed):
      `PORT=43206 npx playwright test tests/e2e/time-announcements-admin.spec.ts --workers=1`
      (first run builds and starts the server: allow ~3 minutes). Expect PASS. If something differs
      (testid on a checkbox, dialog timing), fix the test or the component, not the intent.
- [ ] The Playwright cohort in `assembly-cohort.json` lists e2e case names per file; the new file
      must be added there (Task 8).

## Task 7: Docs

- [ ] `docs/features/time-announcements.md`: after FR-019 add

```
- **FR-020**: Given the admin Time announcements page, when an admin creates or edits a rule, then a
  single dialog MUST collect time (default 07:00), weekdays and active state, MUST show the voice
  the kiosk will use for the household language, MUST keep the dialog open with the server message
  on a rejected write, and MUST close and refresh the list on success; deleting a rule MUST require
  confirmation in an in-app dialog; a failed list load MUST offer Retry. No API contract changes.
```

(match the file's existing bold-FR formatting and blank-line style) and add one sentence to
User Story 2: the admin page presents rules as cards with an in-dialog editor.

- [ ] `docs/ui/household-contract.md` line 67: extend to
      `` `/admin/time-announcements` — time announcements (card list; create/edit dialog; delete confirmation) ``
      keeping the file's list style.
- [ ] OpenAPI: no change (state this in the commit message). `npm run check:openapi` runs in the gate.

## Task 8: Cohort fixture resync

`tests/fixtures/assembly-cohort.json` pins (a) `testCohorts.runners.vitest.files[<test file>]` =
exact list of case names, and (b) `coveragePolicy.files[<src file>]` with `minimumTotals` and
`minimumRates` floors. Edit by hand to match reality; do not loosen floors beyond what a real run
requires.

- [ ] Produce the observed list: `npm run test:cohorts:stamp` (writes `.quality/candidate.json`,
      prints the candidate id; export `MP_CANDIDATE_ID` to it for the following commands), then
      `npm run test:cohorts:vitest:list` and `npm run test:cohorts:vitest`.
- [ ] Update the case-name arrays for the three test files you changed
      (`tests/client/time-announcements-management.test.tsx`,
      `tests/client/announcements-briefing-admin.test.tsx` (Time announcements cases only),
      `tests/client/time-announcements-speech.test.ts`) from `.quality/vitest-list.json`, keeping the
      file's existing ordering convention. Run `node tools/verify-test-cohorts.mjs --expected tests/fixtures/assembly-cohort.json --raw-dir .quality --candidate "$MP_CANDIDATE_ID" --runners node,vitest`
      (or `npm run check:test-cohorts:standard`) and fix every reported difference.
- [ ] Coverage floors: `npm run check:coverage` reports per-file failures. The two files that can
      move are `src/client/admin/TimeAnnouncementsManagement.tsx` and
      `src/client/time-announcements/speech.ts` (new `voiceNameFor`). Totals floors are counts of
      lines/statements/functions/branches; set them to the new observed totals (they are minimums, a
      rewrite changes the totals) and keep rates >= the previous rates where the real run meets them.
      If a rate falls, add the missing test rather than lowering the floor.
- [ ] Playwright cohort: add `tests/e2e/time-announcements-admin.spec.ts` with its one case name
      under `testCohorts.runners.playwright.files` (look at how neighbouring e2e entries are named, and
      generate the observed list with `npm run test:cohorts:e2e:list`). Without it
      `check:test-cohorts` rejects the new file.
- [ ] Only the files above are touched in this fixture (other workers edit the same JSON; keep the
      diff localized).

## Task 9: Verification gate

- [ ] From a clean, committed tree (commit first per Task 10 step 1, amend later if needed):
      `npm run check:standard`. Must pass completely. Common failures and fixes:
      `format:check` (run `npx prettier --write` on touched files), `check:accessible-names` (icon-only
      buttons need `aria-label`, already set), `check:ui-debt`/`check:ui-catalog` (no new shared
      component was added, so none should move; if `check:ui-debt` complains about `window.confirm` or
      similar counts going DOWN, update the baseline it names), cohort/coverage (Task 8).
- [ ] Affected e2e, unique port (`playwright.config.ts` takes `PORT`, default `BASE_URL` follows it):
      `PORT=43206 npx playwright test tests/e2e/time-announcements-admin.spec.ts tests/e2e/admin-unlock-resilience.spec.ts --workers=3`
      `admin-unlock-resilience.spec.ts` covers the `/admin/time-announcements` primary action
      (`time-announcements-create`).
- [ ] Also run the real-clock spec once, since the panel still dispatches `RULES_CHANGED_EVENT` and
      the page is the entry point of that flow: `PORT=43206 npm run test:e2e:time-announcements`
      (`package.json` sets `MP_E2E_TIME_ANNOUNCEMENTS=1`; it waits real minutes for the announcements to
      fire, ~5-8 minutes total, expected). It does not touch the admin UI, so a failure there would be
      unrelated to this work; report it rather than chasing it.
- [ ] Also run `tests/e2e/accessible-names-audit.spec.ts` the same way if the audit lists admin
      routes (grep it for `time-announcements`; if it does not mention the route skip it).
- [ ] Optional visual check: seed and run the app per the project memory notes on dev servers, open
      `/admin/time-announcements`, compare to `ref-admin-*time*` screenshots if present; never use the
      reference's real DB, and use your own browser tab.

## Task 10: Commit and report

- [ ] Commit on the worktree branch (the spec and plan copies included), message e.g.
      `feat(admin): rework Time announcements with a create/edit dialog and cards` with a body listing:
      dialog create/edit, ConfirmDialog delete (window.confirm removed), Retry, spinner, voice line,
      panel title aligned with the sidebar label, no API change. End the message with the attribution
      lines from your environment's system reminder, when present.
- [ ] Report back: branch name, commit hash, results of `check:standard` and the e2e command (pass
      counts), any floors you changed in `assembly-cohort.json` and why, and any deviation from this
      plan. Do not merge; the parent integrates.
