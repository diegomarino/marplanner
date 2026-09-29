# Database lifecycle and demo profile contract

This contract covers the installed migration runner, public demo profile, calendar source writes and backup/restore lifecycle. Public seeds target disposable demo storage and refuse unrelated household data.

## Seed module

```ts
export interface SeedContext {
  db: DatabaseConnection;
  asOfDate: string;
  nowMs: number;
}

export interface SeedModule {
  id: string;
  run(context: SeedContext): void | Promise<void>;
}
```

- `id` is globally unique and stable.
- Public filenames match `seed-NNN-*.ts`; private filenames match `seed*-PRIVATE.*`.
- Discovery is lexical and reported before execution.
- The runner migrates and validates the disposable target before the first module.
- On a target with no household/profile rows beyond migration bookkeeping and fixed `day_periods`, it
  creates a `simpsons-demo` marker with `running` status; it marks `complete`
  only after the selected module list succeeds.
- A rerun requires that marker and a successful scan against the profile's complete owned-record
  inventory, including declared singleton Settings keys. Any unrelated row refuses the run unchanged.
- Each module runs in its own transaction and canonicalizes only documented IDs.
- Failure stops the run, exits non-zero, identifies the module, and never logs private payloads.

## CLI

```text
npm run seed -- [--as-of YYYY-MM-DD]
npm run seed:private -- [--as-of YYYY-MM-DD]
```

`seed` executes all public modules. `seed:private` executes that same list first, then all private
overlays. Unknown arguments, invalid dates, invalid/duplicate modules, unsafe destinations, and
module errors fail visibly. Success reports mode, `as-of`, ordered module IDs, and completion, but
not private URLs or device identifiers.

## Calendar source write seam

```ts
interface CalendarExternalSourceInput {
  id: string;
  name: string;
  provider: string;
  feedUrl: string;
  enabled: boolean;
  pollIntervalMin: number;
}

upsertExternalSource(input: CalendarExternalSourceInput): CalendarExternalSourcePrivate
listExternalSources(): CalendarExternalSourcePublic[]
```

The upsert validates scheme, credentials, hostname/address safety, DNS results, label, and interval.
Provider is display-only and normalizes to `google|microsoft|apple|ics_generic`, with unknown input
mapped to `ics_generic`. `CalendarExternalSourcePublic` exposes only a masked URL; the raw stored URL
never reaches clients. The seam does not fetch HTTP, parse iCalendar, create events, or update sync
state. Shared types, OpenAPI, and boundary tests enforce the redacted DTO.

## Restore result extension

The existing union adds:

```ts
{
  status: "unsupported_lineage";
  message: string;
}
```

This means readable migration metadata lacks `0000_current_baseline.sql`. It differs from
`downgrade_rejected` (unknown future identity) and `incompatible_backup` (unreadable SQLite or
metadata). The HTTP status uses the existing incompatible-version rejection class. The stable English
message contains no raw path or database detail.

## Backups UI

No new action is added. Existing list, snapshot, upload, binary/SQL download, typed-name restore,
delete, reload, and safe server-error display remain the contract.

## Private overlays

`.gitignore` contains `seeds/seed*-PRIVATE.*`. Private modules use the same interface and may persist
local configuration only. Tests use synthetic temporary fixtures; real values never appear in Git,
snapshots, logs, or expected output.
