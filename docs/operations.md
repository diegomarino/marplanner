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
The application does not yet enforce a single-writer lock or detect network
filesystems. Runtime `BASE_PATH` support remains unimplemented: serve at `/`.
These open ADR-055/056 obligations are not closed by the container recipe.

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
snapshot and preserve it separately; automatic migrations at boot do not establish
the still-open automatic pre-migration snapshot requirement. Never seed at container
startup. The recipe has no provider agent, platform workaround or automatic
publishing/deployment. For container acceptance, build with source provenance labels
from the maintained candidate inventory, then run the harness:

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
run `npm run dev`. The launcher reports distinct API and frontend loopback URLs;
`PORT=0` and `WEB_PORT=0` request automatic allocation. Optional explicit nonzero
ports must be distinct and available. Exported variables override `.env.local`.
API watch restarts update the frontend proxy to the new API port while retaining
the frontend origin. `npm run dev -- --open` opens the frontend URL. Standalone
`npx vite` requires `VITE_API_PORT` to identify a live nonzero API port.
The API's discovered port drives the frontend proxy; development data defaults
to `.data/` in each worktree. Browser cookies are scoped to the hostname, so use
separate browser profiles or contexts for simultaneous localhost worktrees to
avoid replacing another worktree's cookies. `npm run dev:server` remains a standalone API
diagnostic command. Keep synthetic trials separate from household data.

## Credentials and provisioning

The frontend access token, device API credentials and UI PIN serve different purposes. Set unique deployment values for `MP_ACCESS_TOKEN` and `MP_BOOTSTRAP_KEY`; set `ADMIN_PIN` to a unique PIN. `MP_MANAGEMENT_KEY` is optional and grants operator capabilities where implemented. Use the environment supplied by your service manager. For local development only, copy `.env.example` to ignored `.env.local` and replace every example value. `npm start` and seed scripts read that file when present; exported shell variables override it.

Without `MP_ACCESS_TOKEN`, browser access is locked. Without `MP_BOOTSTRAP_KEY`, first-device provisioning is locked. The health endpoint remains available so an operator can distinguish a running process from an authorized session. Provisioning does not echo raw device keys back through an ordinary API read. The UI PIN is advisory and cannot replace backend authorization. Do not log or paste any raw credential, cookie, household data, IP address, or device identifier into an issue.

Changing or removing an environment key does not revoke its old persisted credential. This release has no key creation, listing, revocation or rotation endpoint, and no routine operator revocation workflow. Do not treat an environment change as completed rotation. If a credential is compromised, stop the service and restrict access while arranging a separately reviewed recovery; this guide does not prescribe live database edits.

There is no `set-pin` endpoint. To replace a forgotten advisory PIN, set `ADMIN_PIN` in the service environment, restart, and provision a browser again with the current bootstrap key. Each successful provisioning stores the configured PIN as an Argon2 hash. Existing device credentials remain valid; this procedure resets the UI PIN and does not rotate API credentials.

## Synthetic seed and checks

`npm run seed` selects the public seed mode. Run it only against a disposable data directory, with synthetic values and the required configuration. The private seed mode is for local overlays; never include its data in a public artifact. See [verification](quality/verification.md) before interpreting test results. Run the full verification tier on isolated synthetic data before accepting a release.

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
and the [backup API contract](api/backups/openapi.yaml) for failure statuses and
retention rules. This procedure does not migrate a legacy household database.

## Isolated verification

Browser tests allocate disposable data and default to `http://localhost:43173`.
Set `PORT` and `BASE_URL` together to use another free loopback port. Avoid a live
server and do not set `PW_REUSE_SERVER=1` against household data. Tests must run
sequentially with other commands that rebuild `dist`. Provider fixtures use local
ports; physical printing, audible speech and controller writes need separate
operator verification.
