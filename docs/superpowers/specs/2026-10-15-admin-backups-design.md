# Admin Backups page: parity rework (design)

Date: 2026-10-15. Scope: UI-only rework of `/admin/backups` (`src/client/admin/BackupsManagement.tsx`) to match the behaviour and interaction patterns of the reference app's `BackupAdmin` (`<marplanner-v1>/apps/web/src/features/backups/BackupAdmin.tsx`, read-only), while keeping everything our page does better. No backend, shared-type, OpenAPI or migration change.

## Intent

The owner wants our admin pages to reach functional and layout parity with the original app, page by page, keeping our extras. For Backups the gap is presentation and feedback, not capability: the reference names the created file in a success banner, accepts drag-and-drop uploads, colour-codes the backup type, shows relative dates, shows a spinner per download, and offers Retry on load errors. Success criterion: an admin sees clear feedback for every action, and all existing safety behaviour (typed-filename restore, error taxonomy, `.db`-only uploads, retention refusals) is unchanged.

## Current state (verified)

- `BackupsManagement.tsx` (551 lines): raw `authFetch` calls (no react-query), `AdminPanel` frame, `ErrorNotice` for every error, `ConfirmDialog` for delete, inline typed-filename restore panel (`backups-restore-confirm`), a table with columns Filename / Type / Created / Size / Actions, download and download-SQL as `<a download>` links, a file `Input` plus a separate Upload submit button.
- Snapshot success today: silently reloads the list; only `already_running` shows `backups-snapshot-info`.
- Upload success today: silently clears the field and reloads the list.
- Load failure today: `ErrorNotice` plus the "No backups yet" empty state, and no Retry.
- Type column is plain text from `TYPE_KEYS`. Created column is the absolute household-timezone date.
- Spanish panel title is "Copias de Seguridad" while the sidebar label (`admin.sidebar.backups`) is "Copias de seguridad": violates the rule that the heading equals the sidebar label.

## Decisions / Assumptions

1. Port behaviour, not mechanism. Keep our raw `authFetch` state code; do not introduce react-query (the reference hook layer is not used elsewhere in our app).
2. Keep, unchanged: typed-exact-filename restore panel and its test ids, `BACKUP_ERROR_KEYS` error taxonomy, `lastBackupError`/`lastPruneError` surfaces, `already_running` notice, delete `ConfirmDialog`, household-timezone formatting, download-SQL (FR-006/FR-012 keep `download-sql` as read-only export), reload after successful restore.
3. Upload stays `.db`-only (FR-006, BACKUPS-INV-06). The file input gets `accept=".db"`; additionally a client-side pre-flight rejects any selected or dropped file whose name does not end in `.db` (case-insensitive) with a new localized message, before any request. The server remains the authority (it validates the SQLite header; it never sees a client filename).
4. Upload happens immediately on file selection or drop (reference behaviour); the separate Upload submit button (`backups-upload-submit`) is removed. Only the first file of a multi-file drop is used. The native file input stays visible (keeps `backups-upload-input` visible, which `tests/e2e/database-lifecycle-recovery.spec.ts` asserts) inside a dashed drop zone. The drop zone is a plain container with drag handlers; it is NOT a `role="button"` (no nested interactive elements).
5. Success banners are one shared in-page status block (`role="status"`, `aria-live="polite"`) per action: snapshot created ("Snapshot {filename} created."), upload done ("Uploaded as {filename}."). A new action clears the previous banner of the same action; a banner stays until the next action of any kind on the page (no dismiss button, YAGNI). Strings with a filename use the repo's `t(key).replace("{filename}", name)` convention (`t` takes no params). Errors keep using `ErrorNotice` (SC-011). `already_running` keeps its current `backups-snapshot-info` element.
6. Type pill: colour-coded by `BackupType` using SEMANTIC TOKEN classes only (`bg-primary/10 text-primary`, `bg-muted text-muted-foreground`, `bg-destructive/10 text-destructive`, `bg-secondary text-secondary-foreground`, `bg-accent text-accent-foreground`). No Tailwind scale colour classes (`bg-blue-100` etc.): `npm run check:ui-debt` enforces fixed baselines, and `--success` is mapped but not defined in `globals.css`, so do not use `success`. The pill keeps the existing localized label text (tests and e2e read it), so colour is never the only signal. Mapping: scheduled -> accent, snapshot -> primary, upload -> secondary, pre-restore -> destructive (it is the protected, rollback lane).
7. Relative dates: the Created cell renders `<time dateTime={ISO} title={absolute household-tz date}>` with a relative label from `Intl.RelativeTimeFormat(locale, { numeric: "auto" })` ("now", "5 minutes ago", "yesterday") for ages up to 30 days, and the absolute date as the visible text beyond that. Locale follows the app language (`es` -> `es-ES`, else `en-GB`, same mapping as today's `formatCreatedAt`). Labels are computed at render time; there is no ticking timer (the list reloads after every action).
8. Per-row download spinners: DB and SQL downloads become buttons that `authFetch` the file, turn the response into a Blob and trigger a save through a temporary anchor (`download` attribute = `filename` or `${filename}.sql`). While in flight the clicked button shows a spinner and is disabled (state keyed by `filename + format`). Failure shows an `ErrorNotice` (`backups-download-error`) with new key `backups.management.downloadError`, using the server code message when present. Test ids `backups-download-{filename}` and `backups-download-sql-{filename}` are kept on the buttons. Assumption: backups are household-sized (the upload cap is 64 MiB), so buffering a Blob in memory is acceptable.
9. Load error: a failed list load shows the `ErrorNotice` plus a Retry button (`backups-retry`, new key `backups.management.retry`, `variant="secondary"` like `MealsManagement`), and suppresses the empty state and table. A failed refresh after a successful action keeps the already-loaded rows and shows the same notice and Retry. Retry re-runs `loadBackups`.
10. i18n: all new strings in `src/client/i18n/messages.ts`, en + es, in ONE contiguous block per locale placed directly after the last existing `backups.management.*` key (`backups.management.uploadError`), headed by the comment `// admin-backups`. Fix the es title to "Copias de seguridad" (sentence case, equals the sidebar label); the en title "Backups" already equals the sidebar. Remove the now-unused `backups.management.uploadSubmit` key (en + es) and its use.
11. Heading rule: heading text equals the sidebar label in both locales (decision 10).
12. No new shared primitive and no Sheet/Dialog is needed on this page; the existing `ConfirmDialog`, `Field`, `ErrorNotice`, `AdminPanel`, `Button`, `Input` are reused.
13. Seeds: no backups seed is needed; the page is exercised through the real snapshot action. No seed change.
14. Docs: update `docs/features/backups.md` User Story 3 (drag-and-drop zone, immediate upload, `.db` only, success feedback) and the `docs/ui/household-contract.md` line 66 entry. No FR number is added or changed, no OpenAPI change.

## Rejected alternatives

- Hidden input plus a styled button (reference look): rejected because an existing e2e asserts the input is visible and it hurts nothing to keep the native control; the drop zone still gives the reference interaction.
- Keep `<a download>` links and fake a spinner: rejected, a spinner that does not track the real transfer is misleading.
- Accept `.sql` in the dropzone like the reference: rejected by FR-006 / BACKUPS-INV-06.
- Adopt react-query for this page: rejected, one-file scope, no other admin page uses it.

## Component structure (single file, same exports)

`BackupsManagement.tsx` keeps `TYPE_KEYS`, `BACKUP_ERROR_KEYS`, `BackupsManagement`. New exported pure helpers in the same file (exports are already used by tests): `TYPE_PILL_CLASSES: Record<BackupType, string>`, `formatRelativeAge(createdAt, now, language): string | null`, `isDbFile(name): boolean`. New local state: `snapshotSuccess`, `uploadSuccess`, `dragActive`, `downloading: string | null` (key `${filename}|db` or `|sql`), `downloadError`. `loadError` rendering and `retry` button as in decision 9.

## Test ids

Kept: `backups-management`, `backups-snapshot-now`, `backups-snapshot-info`, `backups-snapshot-error`, `backups-delete-error`, `backups-empty`, `backups-table`, `backups-row-{f}`, `backups-download-{f}`, `backups-download-sql-{f}`, `backups-restore-select-{f}`, `backups-delete-{f}`, `backups-delete-confirm|cancel`, `backups-restore-confirm`, `backups-restore-confirm-input`, `backups-restore-submit`, `backups-restore-cancel`, `backups-restore-error`, `backups-upload-input`, `backups-upload-error`, `backups-last-backup-error`, `backups-last-prune-error`.
New: `backups-snapshot-success`, `backups-upload-success`, `backups-upload-dropzone`, `backups-download-error`, `backups-retry`, `backups-type-{f}` (pill).
Removed: `backups-upload-submit`.

## Error handling

All failure paths keep their current messages; additions: unsupported extension (`backups.management.uploadUnsupported`, shown in `backups-upload-error`, no request sent), download failure (`backups-download-error`), load failure with Retry. Server code messages continue to route through `BACKUP_ERROR_KEYS`.

## Testing strategy

Vitest component tests extend `tests/client/backups-management.test.tsx` (no new test file, so `tests/fixtures/assembly-cohort.json` needs no new entries; still run the cohort check in `check:standard`). Tests pinned to the old behaviour are updated: absolute-date text assertions move to the `<time title>` attribute; upload tests drop the submit click; density censuses in `tests/client/backups-telemetry-admin.test.tsx` lose one control (the submit button); two e2e specs drop `backups-upload-submit`.
E2E: `tests/e2e/backups-restore.spec.ts` and `tests/e2e/database-lifecycle-recovery.spec.ts` (both spawn their own server from `dist/`, so `npm run build` must be fresh), plus `tests/e2e/admin-unlock-resilience.spec.ts` (touches `backups-snapshot-now`).

## Open questions

None for the owner. (Flagged for awareness: Blob-buffered downloads, decision 8.)
