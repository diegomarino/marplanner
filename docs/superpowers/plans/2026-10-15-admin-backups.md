# Admin Backups parity: implementation plan

> For the executing agent: work in your own worktree on its own branch. The spec and this plan live UNTRACKED in the main checkout (`<maintainer-workspace>`). Step 0 copies them in. Use TDD (write the failing test, see it fail, implement, see it pass). Do not touch the reference repo `<marplanner-v1>` (read-only).

**Goal:** Rework `/admin/backups` for parity with the reference `BackupAdmin` (create/upload success banners, drag-and-drop `.db` zone, colour-coded type pill, relative dates, per-row download spinners, Retry on load error) without changing any restore/delete/error-taxonomy behaviour.

**Spec:** `docs/superpowers/specs/2026-10-15-admin-backups-design.md` (read it first; decision numbers below refer to it).

**Files touched**
- Modify `src/client/admin/BackupsManagement.tsx`
- Modify `src/client/i18n/messages.ts` (en + es, one `// admin-backups` block each, plus es title fix, plus removal of `backups.management.uploadSubmit`)
- Modify tests: `tests/client/backups-management.test.tsx`, `tests/client/backups-telemetry-admin.test.tsx`, `tests/e2e/backups-restore.spec.ts`, `tests/e2e/database-lifecycle-recovery.spec.ts`
- Modify docs: `docs/features/backups.md` (User Story 3), `docs/ui/household-contract.md` (line 66)
- Do NOT add test files (avoids `tests/fixtures/assembly-cohort.json` churn). Do not touch `AdminRoutes.tsx`, `src/shared/index.ts`, OpenAPI, server code.

**Verified facts you rely on**
- `t(key)` takes no params; interpolate with `.replace("{filename}", name)`.
- `useTranslation()` returns `{ t, language }`; `useHouseholdSettings()` gives `timezone`.
- Existing exports of `BackupsManagement.tsx`: `TYPE_KEYS`, `BACKUP_ERROR_KEYS`, `BackupsManagement`. `BackupType` = `scheduled | snapshot | pre-restore | upload`. `SnapshotResult` = `{status:"completed";filename}` | `{status:"already_running"}`. Upload response contains `filename`.
- Download routes: `GET /api/backups/:filename/download` and `/download-sql`, cookie-authenticated, `attachment` responses; `authFetch(path, {credentials:"include"})` is the client wrapper. Use `appUrl()` only for native navigation, not for `authFetch` (existing code passes plain `/api/...` to `authFetch`).
- `ErrorNotice` takes `message`, `className`, `data-testid`; it renders nothing for empty messages.
- `MealsManagement.tsx` ~line 396 shows the Retry pattern: `<Button type="button" variant="secondary" onClick=...>`.
- UI-debt gate (`npm run check:ui-debt`, `tools/dev/count-ui-debt.mjs`) forbids new Tailwind scale colour classes, inline styles and colour literals. Use semantic token classes only. `--success` is NOT defined in `src/client/styles/globals.css`: do not use `success`. Confirm the tokens you use (`primary`, `secondary`, `accent`, `muted`, `destructive`) exist around lines 20-60 of that file.
- `tests/client/backups-telemetry-admin.test.tsx` density tests count interactive controls: empty shelf 3, one row 7, restore panel open 10 and 10, delete-in-flight 11 then 7 (lines ~256-370). Removing the Upload button lowers each by 1 (empty 2, one row 6, panel open 9, 9, 10 then 6). Verify by running, not by trusting these numbers.

---

## Task 0: Set up the branch

- [ ] In your worktree, copy the untracked docs in:
  ```bash
  mkdir -p docs/superpowers/specs docs/superpowers/plans
  cp <maintainer-workspace>/docs/superpowers/specs/2026-10-15-admin-backups-design.md docs/superpowers/specs/
  cp <maintainer-workspace>/docs/superpowers/plans/2026-10-15-admin-backups.md docs/superpowers/plans/
  ```
- [ ] `npm ci` if `node_modules` is absent. Baseline: `npx vitest run tests/client/backups-management.test.tsx tests/client/backups-telemetry-admin.test.tsx tests/client/backups-i18n-parity.test.ts` must be green before you change anything.

## Task 1: i18n keys

New keys (en / es). Add them as ONE contiguous block after `"backups.management.uploadError"` in each locale (the `en` block ends near line 1004, the `es` block near line 2305), headed by a line comment `// admin-backups`:

| key | en | es |
|---|---|---|
| `backups.management.retry` | Retry | Reintentar |
| `backups.management.snapshotCreated` | Snapshot {filename} created. | Instantánea {filename} creada. |
| `backups.management.uploadSuccess` | Uploaded as {filename}. | Subida como {filename}. |
| `backups.management.uploadDropHint` | Drag a .db backup file here, or choose one. | Arrastra aquí un archivo de copia .db, o elige uno. |
| `backups.management.uploadUnsupported` | Only .db backup files can be uploaded. | Solo se pueden subir archivos de copia .db. |
| `backups.management.uploadingFile` | Uploading {filename}… | Subiendo {filename}… |
| `backups.management.downloadError` | Failed to download this backup. | Error al descargar esta copia de seguridad. |
| `backups.management.downloading` | Downloading… | Descargando… |

Other edits in the same file:
- es `backups.management.title`: change "Copias de Seguridad" to "Copias de seguridad" (equals `admin.sidebar.backups`; the en title "Backups" already matches). Leave `admin.nav.backups` and `plugins.backups.label` untouched.
- Delete `backups.management.uploadSubmit` and `backups.management.uploading` ONLY if nothing else references them (`grep -rn "uploadSubmit\|management.uploading" src tests`); `uploading` is replaced by `uploadingFile`. Keep `uploadFileLabel` (used as the input label).

Verification: `npx vitest run tests/client/backups-i18n-parity.test.ts` (parity: every key in both locales, non-empty).

## Task 2: Pure helpers (TDD)

In `tests/client/backups-management.test.tsx` add a `describe("backups helpers")` that imports `formatRelativeAge`, `isDbFile`, `TYPE_PILL_CLASSES`, `TYPE_KEYS` from `@/admin/BackupsManagement`, and write failing tests first:
- `formatRelativeAge(now - 20_000, now, "en")` is "now"; `now - 5*60_000` is "5 minutes ago"; `now - 3*3_600_000` is "3 hours ago"; `now - 86_400_000` is "yesterday"; `now - 3*86_400_000` is "3 days ago"; `now - 40*86_400_000` is `null`. With `"es"` the 5-minute case equals `new Intl.RelativeTimeFormat("es-ES", {numeric:"auto"}).format(-5,"minute")`. A createdAt slightly in the future (clock skew) returns "now".
- `isDbFile("a.db")`, `isDbFile("A.DB")` true; `isDbFile("a.sql")`, `isDbFile("a.db.sql")`, `isDbFile("db")` false.
- `Object.keys(TYPE_PILL_CLASSES)` equals `Object.keys(TYPE_KEYS)` and no value matches `/\b(bg|text|border)-(red|blue|green|amber|purple|gray|slate|yellow|orange)-\d/`.

Implement in `BackupsManagement.tsx` (exported, above the component):
```ts
export const TYPE_PILL_CLASSES: Record<BackupType, string> = {
  scheduled: "bg-accent text-accent-foreground",
  snapshot: "bg-primary/10 text-primary",
  upload: "bg-secondary text-secondary-foreground",
  "pre-restore": "bg-destructive/10 text-destructive",
};

export function formatRelativeAge(createdAt: number, now: number, language: string): string | null {
  const seconds = Math.max(0, Math.trunc((now - createdAt) / 1000));
  const rtf = new Intl.RelativeTimeFormat(language === "es" ? "es-ES" : "en-GB", { numeric: "auto" });
  if (seconds < 60) return rtf.format(0, "second");
  const minutes = Math.trunc(seconds / 60);
  if (minutes < 60) return rtf.format(-minutes, "minute");
  const hours = Math.trunc(minutes / 60);
  if (hours < 24) return rtf.format(-hours, "hour");
  const days = Math.trunc(hours / 24);
  return days <= 30 ? rtf.format(-days, "day") : null;
}

export function isDbFile(name: string): boolean {
  return name.toLowerCase().endsWith(".db");
}
```
Run `npx vitest run tests/client/backups-management.test.tsx`; helpers tests pass. (If the "now" expectation differs by ICU version, assert against `rtf.format(0, "second")` computed in the test instead of a literal.)

## Task 3: Created column (relative date with absolute title)

Failing test first (update the two existing date tests, lines ~88 and ~434 of `tests/client/backups-management.test.tsx`): instead of `expect(row).toHaveTextContent(expected)`, assert `row.querySelector("time")` has attribute `title` equal to `expected` (the household-timezone absolute string, both the `Pacific/Kiritimati` en-GB and es-ES cases) and `dateTime` equal to `new Date(createdAt).toISOString()`. Add a test: a backup created 5 minutes ago (use `vi.useFakeTimers` or `Date.now()` minus 5 min as `createdAt`) renders text "5 minutes ago"; a 40-day-old one renders the absolute text.

Implement: replace the `formatCreatedAt` cell with
```tsx
<td className="p-2 align-top">
  <time dateTime={new Date(backup.createdAt).toISOString()} title={formatCreatedAt(backup.createdAt)}>
    {formatRelativeAge(backup.createdAt, Date.now(), language) ?? formatCreatedAt(backup.createdAt)}
  </time>
</td>
```
(Spec decision 7.) The e2e only asserts the cell is non-empty (`backups-restore.spec.ts` ~line 340), still true.

## Task 4: Type pill

Failing test: row contains `data-testid="backups-type-{filename}"` with text equal to the localized label (`Scheduled`) and class list containing the `TYPE_PILL_CLASSES.scheduled` tokens. Implement: in the Type cell render
```tsx
<span data-testid={`backups-type-${backup.filename}`}
  className={cn("inline-block rounded-full px-2.5 py-0.5 text-xs font-medium", TYPE_PILL_CLASSES[backup.type])}>
  {t(TYPE_KEYS[backup.type])}
</span>
```
Import `cn` from `@/lib/utils`. The e2e (`snapshotCells.nth(1)` text /snapshot|instantánea/) and `backups-telemetry-admin` line ~777 ("Subida") keep passing because the text is unchanged.

## Task 5: Success banners for snapshot and upload

Failing tests:
- Snapshot: mock `POST /api/backups/snapshot` returning `{status:"completed", filename:"snapshot-X.db"}` then list; clicking `backups-snapshot-now` shows `backups-snapshot-success` with text "Snapshot snapshot-X.db created." (role `status`). `already_running` still shows `backups-snapshot-info` and NOT the success banner. A second click clears the earlier banner first.
- Upload (see Task 6) shows `backups-upload-success`.

Implement: state `snapshotSuccess: string | null`; in `snapshotNow` clear it at the start; on `result.status === "completed"` set `t("backups.management.snapshotCreated").replace("{filename}", result.filename)` then `await loadBackups()`. Render
```tsx
{snapshotSuccess && (<p role="status" aria-live="polite" data-testid="backups-snapshot-success"
  className="rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-control font-medium text-primary">{snapshotSuccess}</p>)}
```
inside the snapshot card. Starting any new action (snapshot, upload, delete, restore select, download) clears both success banners (add a small `clearBanners()` helper).

## Task 6: Drop zone, immediate `.db`-only upload

Update existing upload tests first (they currently click `backups-upload-submit`):
- `tests/client/backups-management.test.tsx` ~lines 330-395 (upload happy path and 413 refusal): remove the submit click; `fireEvent.change(fileInput, {target:{files:[file]}})` must now trigger the request itself. Keep the assertions on `application/octet-stream` and `File` body. Happy path also asserts `backups-upload-success` shows "Uploaded as upload-20260901-033000-000.db." and the list was refetched.
- `tests/client/backups-telemetry-admin.test.tsx` ~line 699 ("an upload refusal"): remove the submit click.
New tests: choosing `notes.sql` sends NO request to `/api/backups/upload` and shows `backups-upload-error` with the `uploadUnsupported` text; dropping a `.db` file (`fireEvent.drop(screen.getByTestId("backups-upload-dropzone"), {dataTransfer:{files:[file]}})`) uploads it; `dragOver` toggles `data-drag-active="true"` on the zone and `dragLeave` clears it; the input has `accept=".db"`.

Implement (spec decisions 3, 4): replace the upload card with
```tsx
<div data-testid="backups-upload-dropzone" data-drag-active={dragActive ? "true" : "false"}
  className={cn("bg-card rounded-lg border-2 border-dashed p-4 shadow", dragActive ? "border-primary bg-primary/5" : "border-border")}
  onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
  onDragEnter={(e) => { e.preventDefault(); setDragActive(true); }}
  onDragLeave={(e) => { e.preventDefault(); setDragActive(false); }}
  onDrop={(e) => { e.preventDefault(); setDragActive(false); void uploadFile(e.dataTransfer.files[0]); }}>
  <h3 className="mb-1 text-lg font-semibold">{t("backups.management.uploadTitle")}</h3>
  <p className="text-muted-foreground mb-2 text-control">{t("backups.management.uploadDropHint")}</p>
  <Field label={t("backups.management.uploadFileLabel")}>
    <Input ref={fileInputRef} type="file" accept=".db" disabled={uploading}
      data-testid="backups-upload-input" onChange={(e) => void uploadFile(e.target.files?.[0])} />
  </Field>
  {uploading && <p role="status" ...>{t("backups.management.uploadingFile").replace("{filename}", uploadingName)}</p>}
  <ErrorNotice message={uploadError} className="mt-2" data-testid="backups-upload-error" />
  {uploadSuccess && <p role="status" data-testid="backups-upload-success" ...same classes as the snapshot banner...>{uploadSuccess}</p>}
</div>
```
`uploadFile(file?: File)` replaces `submitUpload`: no-op for undefined or while `uploading`; clear banners; if `!isDbFile(file.name)` set `uploadError = t("backups.management.uploadUnsupported")`, reset the input value, return (no request); else POST as today (`content-type: application/octet-stream`, body = the `File`), on success set `uploadSuccess` from the response `filename` and `await loadBackups()`; always reset `fileInputRef.current.value`. Remove `uploadFile` state, `onFileSelected`, `submitUpload` and the submit `Button`. Keep the `UploadResult` type use: `const result = (await response.json()) as UploadResult`.

## Task 7: Per-row download spinners

Failing tests: (a) click `backups-download-{f}` with a deferred `fetch` mock: while pending the button is disabled and contains a spinner (`data-testid` not required; assert `disabled` and `aria-busy="true"`) and ONLY that button (the SQL button of the same row and other rows stay enabled); after resolve (body `new Blob(["x"])`, status 200) `URL.createObjectURL` (stub with `vi.fn(() => "blob:x")`, plus `URL.revokeObjectURL`) was called and an anchor with `download=<filename>` was clicked (spy `HTMLAnchorElement.prototype.click`). (b) SQL variant uses `/api/backups/<filename>/download-sql` and `download` = `<filename>.sql`. (c) A 404/500 response shows `backups-download-error` with the localized `downloadError` text (or the mapped code message, e.g. `not_found`) and re-enables the button.

Implement: state `downloading: string | null` (key `${filename}|db|sql`) and `downloadError: string | null`. Use `Loader2` from `lucide-react` (already a dependency; check `grep -rn "lucide-react" src/client | head -1`) with `className="h-4 w-4 animate-spin"`, `aria-hidden`.
```ts
async function downloadBackup(filename: string, format: "db" | "sql") {
  const key = `${filename}|${format}`;
  if (downloading === key) return;
  clearBanners(); setDownloadError(null); setDownloading(key);
  try {
    const path = `/api/backups/${encodeURIComponent(filename)}/${format === "db" ? "download" : "download-sql"}`;
    const response = await authFetch(path, { credentials: "include" });
    if (!response.ok) throw new LocalizedApiError(await responseMessage(response, t("backups.management.downloadError")));
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = format === "db" ? filename : `${filename}.sql`;
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    URL.revokeObjectURL(url);
  } catch (cause) {
    setDownloadError(cause instanceof LocalizedApiError ? cause.message : t("backups.management.downloadError"));
  } finally { setDownloading(null); }
}
```
Replace the two `<Button asChild><a download>` blocks with `<Button type="button" variant="link" size="sm" data-testid={...same ids...} disabled={downloading === key} aria-busy={downloading === key} onClick=...>` showing the spinner next to the label while busy. Render `<ErrorNotice message={downloadError} data-testid="backups-download-error" />` beside the delete error. Remove the now-unused `appUrl` import if nothing else uses it. e2e clicks (`backups-restore.spec.ts` ~344, `database-lifecycle-recovery.spec.ts` ~100) still produce a Playwright `download` event with the same `suggestedFilename`.

## Task 8: Retry on load error

Failing tests: mock `GET /api/backups` as 500 first, 200 afterwards. Expect the alert "Failed to load backups." (existing assertion in `backups-telemetry-admin.test.tsx` ~line 590 stays valid: `findByRole("alert")` must still find exactly one alert), a `backups-retry` button, NO `backups-empty` element, and after clicking Retry the table appears and the alert is gone. Second test: a refresh failure after a successful first load (e.g. second `GET` 500 after a snapshot) keeps the previously loaded rows visible and shows the notice and Retry.

Implement: render `loadError` with the Retry button
```tsx
{loadError && (<div className="flex flex-wrap items-center gap-3">
  <ErrorNotice message={loadError} />
  <Button type="button" variant="secondary" data-testid="backups-retry" onClick={() => void loadBackups()}>{t("backups.management.retry")}</Button>
</div>)}
```
and change the table block condition to `backups.length === 0 ? (loadError ? null : <empty state>) : <table>`. Also hide the snapshot/upload cards? No: keep them usable.

## Task 9: Fix remaining pinned tests and density counts

- `tests/client/backups-telemetry-admin.test.tsx` density censuses (~lines 256-370): run the file, update each expected count (and the test titles / inline comments naming "the upload button (3 controls)") to the actual number after the Upload submit removal; confirm the delta is exactly -1 per state and that `assertKioskDensityCompliant` still passes (the download buttons and Retry use the shared `Button`, so density tokens apply; the native file `Input` already did).
- `tests/e2e/backups-restore.spec.ts` (~lines 366-367): delete the `backups-upload-submit` click; the `setInputFiles` now uploads, so the next line (`uploadRow` visible) already waits.
- `tests/e2e/database-lifecycle-recovery.spec.ts` (~lines 81-82 and 100-101): delete `await expect(page.getByTestId("backups-upload-submit")).toBeDisabled();` and the submit click; keep `backups-upload-input` visible assertion.
- `grep -rn "backups-upload-submit\|management.uploadSubmit" src tests docs` must return nothing.

## Task 10: Docs

- `docs/features/backups.md`, User Story 3 paragraph (~line 32-37): add that the admin panel accepts a `.db` file by selection or drag-and-drop, uploads it immediately, rejects non-`.db` files before any request, and reports the stored filename on success; downloads show per-row progress. Do not add or renumber FRs; do not touch OpenAPI (no API change).
- `docs/ui/household-contract.md` line 66: extend the entry, e.g. `9. /admin/backups — backups: snapshot with success feedback, drag-and-drop .db upload, colour-coded types, relative dates, typed-filename restore, download with progress`. Keep the numbering.

## Task 11: Verification gate

1. `npx vitest run tests/client/backups-management.test.tsx tests/client/backups-telemetry-admin.test.tsx tests/client/backups-i18n-parity.test.ts tests/client/admin-gate-panel-reset.test.tsx tests/client/admin-routes.test.tsx` all green.
2. Commit the work first (check:standard must run from a clean, committed tree; see Task 12 for commit conventions, a WIP commit is fine and may be amended). Then `npm run check:standard`. If it reports cohort fixture drift (it should not, since no test files were added or renamed), resync `tests/fixtures/assembly-cohort.json` as the repo tooling describes. Fix `format:check` with the repo formatter (see the `format` script in `package.json`), and fix any `check:ui-debt` or `check:accessible-names` failure (the dropzone has a labelled input; the pill and `<time>` are not interactive).
3. `npm run build` must be fresh (check:standard builds it), then run the affected e2e specs with the assigned port:
   ```bash
   PORT=43207 npx playwright test tests/e2e/backups-restore.spec.ts tests/e2e/database-lifecycle-recovery.spec.ts tests/e2e/admin-unlock-resilience.spec.ts --workers=3
   ```
   If a spec needs a precondition (browser install, `dist/`), fix the setup, do not skip the spec.
4. Manual sanity if a dev server is available (do not use or resize the owner's shared Playwright window; open your own tab): create a snapshot, see the green-token banner naming the file; drop a `.sql` file and see the unsupported message; drop a downloaded `.db` and see the upload banner; hover a date to see the absolute time; kill the API to see the load error with Retry.

## Task 12: Commit on the worktree branch and report

- Make sure the spec and plan are included in the branch (Task 0 copy).
- `git add` the files listed under "Files touched" plus the spec and plan; commit on the worktree branch with an English message such as `feat(admin): backups page parity (drop zone, banners, relative dates, download progress, retry)`.
- Note: isolated worktrees may refuse git commands; if so, report the patch (`git diff` output saved to the scratchpad) instead of failing silently.
- Report: branch name, commit hash, the exact commands run for the gate with their results (check:standard and the PORT=43207 e2e run), any test counts you changed (density censuses), and any deviation from the spec.
