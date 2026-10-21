# Operating Marplanner

## Install and storage

Use Node.js `>=24.21.0 <25` (the development and CI pin is `24.21.0`) and npm `11.19.0`. Install from this repository's lockfile and build both client and server:

```sh
npm ci
npm run build
DATA_DIR=/path/to/persistent/marplanner npm start
```

Create `DATA_DIR` first and give the service process write access. The SQLite file defaults to `marplanner.db` inside that directory. `DATABASE_PATH` overrides the filename. A data directory backed by ephemeral container storage will lose household state. On startup the server checks directory writability and runs its ordered migrations. Existing production household databases from an earlier product are not imported automatically.

The server listens on `HOST` (default `0.0.0.0`) and `PORT` (default `3000`). For a local-only trial, set `HOST=127.0.0.1`. Send `SIGINT` or `SIGTERM` for a normal shutdown and allow in-flight work to drain. Use Admin → Backups for a consistent snapshot before data-changing operations. Activate the Backups plugin first. Do not copy a live SQLite database without its transactional snapshot procedure.

## Container installation

The reference recipe uses the official Node `24.21.0` Debian Bookworm slim image
pinned by digest and npm `11.19.0`. Build dependencies stay in intermediate stages;
the runtime includes production dependencies, migrations, built client/server,
and briefing renderer fonts and their license. Installation happens inside Linux;
never copy host `node_modules` into an image.

```sh
cp infra/docker/.env.example infra/docker/.env.local
# Supply unique MP_ACCESS_TOKEN (mpg-...), MP_BOOTSTRAP_KEY (mpk-...), ADMIN_PIN.
docker compose --env-file infra/docker/.env.local -f infra/docker/compose.yaml -p marplanner-home config --quiet
docker compose --env-file infra/docker/.env.local -f infra/docker/compose.yaml -p marplanner-home up --build -d
docker compose --env-file infra/docker/.env.local -f infra/docker/compose.yaml -p marplanner-home port marplanner 3000
```

The published port is automatically allocated on `127.0.0.1`; optionally set
`PUBLISHED_PORT` in the Compose env file. The application listens on container
port `3000`. Discover the actual host address with `port`, including after a
recreation. Each `-p` project gets its own `marplanner-data` volume; always reuse
the same project name for that installation. For concurrent trials, choose
separate project names and leave automatic publication enabled.

`--env-file` supplies Compose interpolation; it does not inject every variable
into the container. The service's `environment` list is the explicit allowlist.
Missing or empty required credentials fail before startup. Optional integrations
stay commented until configured, so empty values do not replace provider defaults.
Use local UniFi `UNIFI_HOST` or cloud `UNIFI_CONSOLE_ID` with the controller's
`UNIFI_SITE_ID` UUID and API key; TLS verification remains enabled by default.
A `BACKUPS_ROOT` override outside `/data` requires a separate persistent mount.
Never enable development bypass or scheduler smoke settings for ordinary operation.

The runtime user is `node` (UID/GID `1000:1000`). A fresh Docker named volume is
initialized from the image's owned `/data` directory. Existing volumes and bind
mounts must already grant that user write access; startup rejects unwritable
storage. Preserve data and verify ownership before switching mount types. Use
local storage suitable for SQLite WAL and run one application instance per volume.
The server and seed CLI refuse a second application instance using the same database.
A stable `<database>.instance-lock.sqlite` sentinel holds an OS-backed exclusive lock
through restore and connection resets; clean exit and process crashes release it.
Never delete or replace this sentinel while an instance runs. Keep the database
and its sentinel together on the same local volume; individual database file
bind mounts and external SQLite writers bypass this cooperative protection.
Database file symlinks and hardlinks are rejected. Directory aliases are supported.

Product SQLite opens reject recognized Linux NFS, SMB and CIFS filesystem types.
Other Linux filesystem types are allowed; macOS and other platforms warn that
classification is unavailable. This check does not certify arbitrary mounts as
safe: use local storage suitable for SQLite WAL. Runtime `BASE_PATH` mounts the built application as described below. Before pending migrations, the server creates
a recovery snapshot as described below; this does not establish full distribution acceptance.

Loopback publication supports local browser access. Remote browser access requires
a trusted external reverse proxy terminating HTTPS and forwarding to the loopback
port. Follow [transport and cookie security](architecture/decisions/ADR-060-deployment-transport-posture-and-cookie-security.md);
remote plain HTTP does not support the intended secure-cookie flow. `/health`
reports process liveness, not provider availability or full release acceptance.

```sh
# Stop gracefully; Compose allows 15 seconds for the five-second app drain.
docker compose --env-file infra/docker/.env.local -f infra/docker/compose.yaml -p marplanner-home down
# Rebuild/recreate after preserving a verified pre-change snapshot.
docker compose --env-file infra/docker/.env.local -f infra/docker/compose.yaml -p marplanner-home up --build -d
```

`down` retains the named data volume. Do not use `down -v` for an installation
whose data must survive. Before an upgrade, activate Backups, create a consistent
snapshot and preserve it separately. Automatic pre-migration recovery snapshots
provide a local restore point; they do not replace a separately retained upgrade backup. Never seed at container
startup. The recipe has no provider agent, platform workaround or automatic
publishing/deployment. For container acceptance, build with source provenance labels
from the candidate identity, then run the harness:

```sh
docker build -f infra/docker/Dockerfile -t marplanner:review \
  --label "org.marplanner.candidate=$(node tools/candidate-identity.mjs)" \
  --label "org.opencontainers.image.revision=$(git rev-parse HEAD)" .
npm run check:container -- --image marplanner:review
```

Keep local populated env files outside the candidate directory during validation.
Platform acceptance must be recorded separately for Linux arm64 and amd64.

Legacy deployment variables such as `APP_API_KEY`, `APP_CORS_ORIGIN`,
`SESSION_SECRET`, `SEED_*`, `LOG_DIR`, `NEW_RELIC_*` and `FLY_*` do not configure
this recipe. Use the current credentials and storage contract; old `sqlite.db`
household data is not imported automatically. Telemetry has no external sink
configuration in this image.

## Local development

Copy root `.env.example` to `.env.local`, replace the synthetic credentials, then
run `npm run dev`. The launcher reports distinct API and frontend loopback URLs
and the Chrome CDP port used by optional DEV browser helpers;
`PORT=0` and `WEB_PORT=0` request automatic allocation. Optional explicit nonzero
ports must be distinct and available. Exported variables override `.env.local`.
API watch restarts update the frontend proxy to the new API port while retaining
the frontend origin. `npm run dev -- --open` opens the frontend URL. Standalone
`npx vite` requires `VITE_API_PORT` to identify a live nonzero API port.
The API's discovered port drives the frontend proxy; development data defaults
to `.data/` in each worktree. Browser cookies are scoped to the hostname, so use
separate browser profiles or contexts for simultaneous localhost worktrees to
avoid replacing another worktree's cookies. Optional DEV helpers
`npm run dev:chrome`, `npm run dev:session`
and `npm run dev:session-reset` target a worktree-local Chromium profile via
`CHROME_CDP_PORT` / `CHROME_USER_DATA_DIR` (see `.env.example`); they are not part
of production runtime. `npm run dev:server` remains a standalone API
diagnostic command. Keep synthetic trials separate from household data.

## Credentials and provisioning

The frontend access token, device API credentials and UI PIN serve different purposes. Set unique deployment values for `MP_ACCESS_TOKEN` and `MP_BOOTSTRAP_KEY`; set `ADMIN_PIN` to a unique PIN. `MP_MANAGEMENT_KEY` is optional and seeds an operator integration credential (Bearer on `/api/plugins*`); network-devices management works with the normal provisioned device cookie. **Transport:** ordinary household API calls use the device **cookie** after provisioning. `Authorization: Bearer` is accepted only on `/api/plugins*`. Do not expect a raw management Bearer to authorize general `/api/*` routes. Use the environment supplied by your service manager. For local development only, copy `.env.example` to ignored `.env.local` and replace every example value. `npm start` and seed scripts read that file when present; exported shell variables override it.

Without `MP_ACCESS_TOKEN`, browser access is locked. Without `MP_BOOTSTRAP_KEY`, first-device provisioning is locked. The health endpoint remains available so an operator can distinguish a running process from an authorized session. Provisioning does not echo raw device keys back through an ordinary API read. The UI PIN is advisory and cannot replace backend authorization. Do not log or paste any raw credential, cookie, household data, IP address, or device identifier into an issue.

**This household release has no key creation, listing, revocation or rotation API.** Changing or removing an environment key does not revoke its old persisted credential. Clearing browser cookies removes local access only; database key rows remain until a separately reviewed recovery. Do not treat an environment change as completed rotation. If a credential is compromised, stop the service and restrict access while arranging recovery; this guide does not prescribe live database edits.

There is no `set-pin` endpoint. To replace a forgotten advisory PIN, set `ADMIN_PIN` in the service environment, restart, and provision a browser again with the current bootstrap key. Each successful provisioning stores the configured PIN as an Argon2 hash. Existing device credentials remain valid; this procedure resets the UI PIN and does not rotate API credentials.

## One-click cloud demo

The README buttons deploy `infra/docker/Dockerfile` (repository root as build context) to Render, Koyeb, Railway or DigitalOcean App Platform, each in the visitor's own account. All four use port 3000, the `GET /health` check and the same environment; `DATA_DIR=/data` comes from the image:

```
MP_ACCESS_TOKEN=mpg-local-change-me
MP_BOOTSTRAP_KEY=mpk-local-bootstrap-change-me
ADMIN_PIN=0000
MP_SEED_ON_EMPTY=true
PORT=3000
```

These are the public defaults from `.env.example`. While a credential equals a public default, the access gate prefills the token, the provisioning screen prefills the bootstrap key and the admin PIN screen shows the PIN, each with a notice that it must be changed. The server only ever reports values that already appear in this repository (`src/shared/default-credentials.ts`), through the SPA shell's `mp-default-credentials` meta tag; it adds no unauthenticated endpoint. Operator-chosen values never reach the page.

**First-boot seed.** With `MP_SEED_ON_EMPTY=true` (or `1`) the server seeds the public Simpsons profile in-process right after migrations, before the bootstrap key is reconciled. It never selects the private profile. The boot log says what happened:

- no seed marker: the profile is seeded (`Seed on empty: demo profile seeded as of …`);
- a marker left `running` by a boot that stopped mid-seed: the profile is rerun on that boot's as-of date to repair it;
- a `complete` marker: skipped (`… already seeded, skipping`);
- household data or another profile in the database: a warning, and nothing is changed;
- any other seed failure: an error is logged and the partial profile is discarded, so the server starts empty and the next boot seeds from scratch.

Rows the server writes on its own (`api_keys`, `admin_config`, `client_log`: reconciled keys, provisioned devices and their PIN, browser telemetry) do not count as household data for this seed, so a later boot can still seed or repair after the server has run. The `npm run seed:*` commands keep the strict rule.

None of these outcomes stops the server from starting. The production bundle has no `seeds/` directory and no TypeScript loader, so `scripts/seed-bundle-plugin.mjs` compiles every public `seeds/seed-NNN-*.ts` into `dist/server/index.js` at build time; the build fails if a `*PRIVATE*` file would be included, and `.dockerignore` keeps those out of the image context.

**One instance, and what persists.** The server refuses a second process on the same database, so every template runs exactly one instance. Render's free web services and Koyeb's free instance have no persistent storage and App Platform has no volumes: each restart, redeploy or (on Render and Koyeb) idle spin-down starts from an empty database, which the next boot reseeds. On Railway, attaching a volume at `/data` keeps data; Railway then stops the old deployment before starting the new one, with a short downtime.

**Moving to real use.** Changing `MP_BOOTSTRAP_KEY` or `ADMIN_PIN` later does not revoke the default bootstrap key or devices already provisioned (see [credentials](#credentials-and-provisioning)), and the demo household stays in the database. On a host that keeps data, start real use on fresh storage: set your own `MP_ACCESS_TOKEN`, `MP_BOOTSTRAP_KEY` and `ADMIN_PIN`, remove `MP_SEED_ON_EMPTY`, and attach a new volume (or edit the values on the deploy form before the first boot).

**Per-host files.** `render.yaml` is the Render Blueprint (free plan). Koyeb has no manifest: the README button URL carries the builder, Dockerfile path, free instance type, a single instance (`instances_max=1`), the port, the HTTP health check and the environment. The health check uses `hc_protocol[3000]=http`, `hc_path[3000]=/health`, `hc_method[3000]=get` and `hc_grace_period[3000]=30`. Koyeb's button documentation does not list these parameters, but the control panel's deploy page parses them and its own "Deploy to Koyeb button" generator emits them. If a later Koyeb release drops them, the service falls back to Koyeb's default TCP check on port 3000; set the HTTP check on `/health` under the service's Health checks settings. `railway.json` sets the Dockerfile builder, health check and restart policy. `.do/deploy.template.yaml` is the App Platform template, on the smallest paid size because App Platform's free tier covers static sites only. All buttons need the GitHub repository to be public.

**Publishing the Railway template (maintainer, once).** Railway's button opens a published template, which only the maintainer's account can create:

1. In the Railway dashboard, open the workspace's **Templates** page and choose **New Template**.
2. Add a service from the GitHub repository `diegomarino/marplanner-project`, branch `main`. Railway reads `railway.json` for the build, health check and restart policy.
3. Add the five variables listed above to the service.
4. Optionally right-click the service and attach a volume mounted at `/data`, so the demo survives restarts.
5. Choose **Create Template**, then publish it from the Templates page.
6. Copy the template code from its URL (`https://railway.com/deploy/<code>`) and replace `RAILWAY_TEMPLATE_CODE` in the README button.

## Synthetic seed and checks

The public demo configures all 21 Daily Briefing block types, including `onThisDay`
for its opted-in members, and supplies Calendar highlights for music lessons and
pharmacy visits. Blocks use their normal data/provider requirements when a briefing
is later generated; seeding itself creates no generated snapshots or provider cache.
All dated demo content is derived from the as-of date: calendar events, meals, daily
messages and chore-completion history fill the previous, current and next household
weeks, and a rerun on a later date moves them forward and drops the stale rows.

`npm run seed:public` selects only the public seed mode. Run it only against a disposable data directory, with synthetic values and the required configuration. Its final module activates all nine installed plugins through the normal lifecycle, preserving configured settings. Repeating the profile reactivates plugins disabled in the demo; it does not generate briefings, print, fetch feeds or execute scheduled jobs. `npm run seed` and `npm run seed:all` run public then private profiles, so private overlays run after demo activation. The private seed mode is for local overlays; never include its data in a public artifact. See [verification](quality/verification.md) before interpreting test results. Run the full verification tier on isolated synthetic data before accepting a release.

## Plugins and integrations

Open Admin with a long press on the family header and enter the advisory PIN.
Admin → Plugins distinguishes Active, Inactive and Needs attention. Activation
creates defaults where needed; deactivation drains owned work and hides its UI,
routes and jobs. Installed code and persisted plugin data remain present.

Configure the household timezone and members before authoring routines, reminders,
meals and briefings. Core calendar and chores remain available without optional
plugins. Weather needs a location. Network Devices requires operator controller
configuration and a management credential; ordinary device credentials cannot
manage it. Spoken time requires browser speech support. Printing requires pairing
from a supported browser with an explicit user gesture. These integrations do not
become live merely because their configuration form is available.

## Runtime subpath hosting

The same built application/image can serve at `/` or a nested path such as
`BASE_PATH=/family/planner`. Set this environment value at process/container startup;
no rebuild is needed. Unset, empty and `/` use the root. A trailing slash is normalized.
Use plain absolute path segments; dot segments, escapes, queries, fragments and
repeated separators are rejected before startup. The application mounts its gate,
API, SPA routes and client assets under this path. `/health` remains at the origin
root for infrastructure probes.

A reverse proxy must preserve the configured prefix when forwarding requests.
Publish the app at `/family/planner/`; the bare mount redirects before access gating.
The server injects the mount into the HTML shell before loading relative client
assets. Native navigation/download links and telemetry use the same mount. Local
Vite development remains at `/`: leave `BASE_PATH` unset when using `npm run dev`.

Gate/device cookies and the provisioning marker use the mount's trailing-slash
cookie path; root deployments retain `Path=/`. Marker deletion uses that same path.
Cookie Path prevents ordinary sibling-path cookie delivery; it is not a security
boundary between applications sharing an origin. Use separate origins for mutually
untrusted applications. After changing an installation's mount, provision at the
new location; old-path cookies may remain until browser cleanup. TLS and existing
credential requirements still apply.

Focused source checks do not establish built-browser or container acceptance for
a release. Verify root and nested mounts against the same unchanged artifact before
publishing runtime subpath support.

## Pre-migration recovery snapshots

The shared migration runner used by boot, seed and restore creates a consistent
logical SQLite snapshot using synchronous `VACUUM INTO` before applying pending migration SQL. It writes a unique private
`BACKUPS_ROOT/pre-migration/snapshot-<unique>/database.db` file, defaulting to
`DATA_DIR/backups/pre-migration/snapshot-<unique>/database.db`. The snapshot includes committed WAL data. Creation uses a temporary `.pending.db`
file, fsyncs it, renames it to `database.db`, and fsyncs its containing directory
before migration ledger or schema writes. Newly created directory parents are
also synced. New recovery directories use mode `0700` and snapshots use `0600`. If snapshot creation or flushing fails, startup aborts without
applying pending migrations. A fresh database with pending migrations also gets a
snapshot; a database with no pending migrations does not. A SQL failure retains the
snapshot for recovery. Failed attempts may leave `.pending.db` or attempt
directories, and a failed final directory sync may leave `database.db` without a
successful completion record. Use only completed, independently verified snapshots
for recovery.

During restore, this migration snapshot captures the restored older candidate
before its upgrade. It is distinct from the pre-restore snapshot of the original
active database. A migration-snapshot failure during restore invokes the existing
rollback to that original pre-restore state; rollback failure keeps the server
quiesced and requires the recovery procedure below.

These files contain household data and credentials. Keep their directory private
and on persistent storage. Reserve disk space for another complete logical database
before an upgrade. Recovery snapshots accumulate: there is no automatic pruning.
Operators may remove obsolete recovery files only after verifying a separate
recoverable backup and confirming the files are no longer needed. These snapshots
are for offline recovery and do not appear in the Admin backup shelf.

For offline recovery, stop every application and seed process using the database,
disable automatic restarts, and exclude external SQLite writers. Preserve the
original database, any matching WAL/SHM sidecars, the recovery snapshot and the
ownership sentinel separately before arranging a swap. Restore the consistent
snapshot as the database with fresh sidecars, retaining the stable ownership
sentinel; do not pair the restored snapshot with the original WAL/SHM. Never delete
WAL files from a live database or remove the sentinel to bypass an owner. Keep the
original recovery materials until the restored instance and its household state
have been verified. Re-running the same failed upgrade is not recovery: use a
reviewed runtime/migration correction before restarting.

`VACUUM INTO` is a logical snapshot, not an exact physical-byte copy. It preserves
explicit declared IDs but may change implicit SQLite rowids.
The migration runner itself does not provide automatic rollback; restore uses the
separate rollback procedure below. Versioning policy, arbitrary historical upgrade
compatibility and `SKIP_MIGRATION` are explicitly deferred until after launch, not
launch gates or available recovery features. Continue to use verified backups and
the offline recovery procedure above. Runtime subpath hosting is configured as
described in its own section.

## Snapshot and restore

1. In Admin → Backups, create a snapshot and download it to separate storage.
2. To restore, select the intended snapshot and type its exact filename to confirm.
3. The server checks compatibility, blocks new API work, drains requests and jobs,
   takes a pre-restore snapshot, swaps the database and reconciles plugin state.
4. Wait for completion and reload the browser. Check members, calendar, plugin
   state and the backup shelf before resuming household use.

A drain timeout leaves the active database unchanged. A swap or migration failure
attempts rollback. If rollback itself fails, the server remains quiesced and names
the pre-restore snapshot: stop the process, preserve the full data directory, and
recover from that verified snapshot before starting again. Do not repeatedly
submit restore or delete the recovery snapshot. Backups may contain credentials
and household data; protect downloads and restrict data-directory permissions.

See [backup behavior](features/backups.md), [recovery architecture](architecture/database-lifecycle.md)
and the [backup API contract](api/openapi.json) for failure statuses and
retention rules. This procedure does not migrate a legacy household database.

## Isolated verification

Browser tests allocate disposable data and default to `http://localhost:43173`.
Set `PORT` and `BASE_URL` together to use another free loopback port. Avoid a live
server and do not set `PW_REUSE_SERVER=1` against household data. Tests must run
sequentially with other commands that rebuild `dist`. Provider fixtures use local
ports; physical printing, audible speech and controller writes need separate
operator verification.

## Weekday integrity at startup

Before serving requests or starting scheduled jobs, the server validates persisted
weekday codes (`mon` through `sun`) and their JSON masks. A `Weekday integrity failed`
error names the table, column and row. Startup stops without modifying that row; inspect
and correct the recurrence data before restarting. Invalid masks are never silently
converted into rules that match no days. Seed modules undergo the same check before
commit and roll back if they introduce invalid weekday data.

Live restore checks weekday integrity after applying any required migrations and
before activating the replacement runtime. An invalid backup returns
`incompatible_backup` and rolls back to the pre-restore snapshot. The recovered
snapshot is checked too; if recovery fails, traffic and scheduled work remain
quiesced for manual recovery.

## Find event subscriber failures

Open Administration → Telemetry and select **Subscriber failures**, or filter by
level `error` and component `event-bus`. The authenticated diagnostic query is
`GET /api/telemetry/client-log?level=error&component=event-bus`.

Each row has message `event-bus.subscriber-failed`, its normal telemetry event ID,
and diagnostic data containing `failureId`, event name, subscriber identity and
redacted error details. Production subscriber names identify the reacting module;
event payloads are omitted. These logs use the existing telemetry retention policy.
Browser ingest reserves the `event-bus` component for internal diagnostics. Internal
failures bypass browser flood admission. If storage is unavailable, the same stable
code and failure ID are written to redacted stderr; the admin database query cannot
show rows that could not be persisted. Logging never retries the subscriber action.
