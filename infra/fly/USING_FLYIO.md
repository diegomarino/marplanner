# Running Marplanner on Fly.io

Fly runs the same image as every other recipe (`infra/docker/Dockerfile`); this directory only
adds the platform layer. Two git-ignored files describe your deployment, and nothing
deployment-specific is committed:

| File                 | Holds                                                | Template                     |
| -------------------- | ---------------------------------------------------- | ---------------------------- |
| `infra/fly/fly.toml` | App name, region, volume, machine size, health check | `infra/fly/fly.toml.example` |
| `.env.fly`           | Production credentials, pushed to Fly as secrets     | [below](#envfly)             |

Fly runs **one machine**: SQLite lives on the volume and the boot single-writer guard refuses a
second instance, so every deploy uses `--ha=false`.

## Prerequisites

- `flyctl` (`brew install flyctl`), logged in with `fly auth login`.
- Node and npm as in the [local development](../../docs/operations.md#local-development) setup,
  so the repository checks can run before a deploy.

## First-time setup

```sh
fly apps create <app>
fly volumes create <volume> --app <app> --region <region> --size 1
cp infra/fly/fly.toml.example infra/fly/fly.toml   # set app, primary_region and [[mounts]].source
```

Then create `.env.fly` at the repository root and run `npm run deploy:fly -- --dry-run` to check
it without changing anything.

### `.env.fly`

```sh
# Every key in this file becomes a Fly secret on each deploy.
MP_ACCESS_TOKEN=mpg-<random>      # web access gate
MP_BOOTSTRAP_KEY=mpk-<random>     # provisions devices
ADMIN_PIN=<4-6 digits>            # advisory Admin PIN (the keypad enters digits only)
# MP_MANAGEMENT_KEY=mpk-<random>  # optional operator credential for /api/plugins*
```

Use unique values: the deploy refuses the defaults published in this repository
(`mpg-local-change-me`, `mpk-local-bootstrap-change-me`, PINs `0000` and `1234`). Generate a token
with `echo "mpg-$(openssl rand -hex 24)"`. In `.env.fly`, quote any value that contains `#` or
spaces, because an unquoted `#` starts a comment there. The deploy then re-encodes each value for
`fly secrets import`, which has its own quoting rules, so what Fly stores is exactly what the file
says. Values cannot span lines.

Non-secret settings (`NODE_ENV`, `PORT`, `DATA_DIR`) stay in `[env]` of `fly.toml`.

## Deploying

```sh
npm run deploy:fly
```

Run it from the repository root with a clean working tree. In order, it:

1. **Pre-flight**: finds `flyctl` and your login, reads `fly.toml`, validates `.env.fly`.
2. **Git**: refuses uncommitted changes and records the commit being deployed.
3. **Checks**: `npm run check:fast`.
4. **Secrets**: stages every key in `.env.fly` with `fly secrets import --stage` (values go
   through stdin and are never printed) and reports keys new to Fly and keys on Fly that are
   missing from `.env.fly`.
5. **Deploy**: `fly deploy --ha=false --remote-only` with the commit as build arguments; Fly
   builds the image remotely, so local Docker is not needed.
6. **Health**: waits for `GET /health`.
7. **Release**: waits until `/api/telemetry/system-status` reports the deployed commit, so an old
   machine still answering during the rollout is not mistaken for success.
8. **Smoke**: `GET`s every read route in `docs/api/openapi.json` and fails on any 5xx. Routes of
   plugins that are not activated yet answer `503 plugin_unavailable` and are reported as skipped,
   so a fresh deployment passes before you turn plugins on in Admin. A plugin in the `errored`
   state (`/api/plugins`) still fails the smoke, naming the plugin and its error code.

| Flag            | Effect                                                              |
| --------------- | ------------------------------------------------------------------- |
| `--dry-run`     | Pre-flight, git and the secrets plan only; changes nothing          |
| `--full`        | Run `check:standard` instead of `check:fast`                        |
| `--skip-checks` | Skip the repository checks                                          |
| `--skip-smoke`  | Skip the smoke test                                                 |
| `--allow-dirty` | Deploy with uncommitted changes                                     |
| `--prune`       | Unset Fly secrets that are not in `.env.fly`                        |
| `--reprovision` | Provision a new smoke device (see [ADMIN_PIN](#rotating-admin_pin)) |
| `--url <url>`   | Public URL when it is not `https://<app>.fly.dev`                   |

Pass flags after `--`, for example `npm run deploy:fly -- --dry-run`. The smoke test also runs on
its own: `npm run smoke:deploy [-- --url <url>]`.

## Secrets

`.env.fly` is the source of truth. Fly treats an unchanged value as a no-op, and the deploy
restarts the machine once for both new code and new secrets. To see what Fly holds (names and
digests, never values):

```sh
fly secrets list --config infra/fly/fly.toml
```

Removing a key from `.env.fly` does not remove it from Fly; deploy with `--prune` to do that.
Rotating `MP_BOOTSTRAP_KEY` or `MP_MANAGEMENT_KEY` does not revoke credentials already issued:
[retire them](#devices-and-the-smoke-device) afterwards.

### Rotating `ADMIN_PIN`

The server stores `ADMIN_PIN` only when a device provisions, so editing it in `.env.fly` and
deploying is not enough. Deploy with `--reprovision`: the smoke test provisions a fresh device,
which applies the new PIN. Then retire the previous smoke device.

## Devices and the smoke device

The smoke test needs a provisioned device. It provisions one the first time and caches its key in
`infra/fly/.smoke-device` (git-ignored, mode `0600`); later deploys reuse it. That file is a
full-access production credential that never expires: keep it private and retire it if the
machine it lives on is lost.

Credentials are managed offline with the `devices` command, inside the machine:

```sh
fly ssh console --config infra/fly/fly.toml -C "node dist/server/devices.js list"
fly ssh console --config infra/fly/fly.toml -C "node dist/server/devices.js label <id> deploy-smoke"
fly ssh console --config infra/fly/fly.toml -C "node dist/server/devices.js revoke <id>"
```

A revoked smoke device is replaced automatically on the next deploy.

## Data on the volume

The database and backups live under `/data` on the volume. Use Admin → Backups for consistent
snapshots and download them to separate storage; see
[snapshot and restore](../../docs/operations.md#snapshot-and-restore). Fly also takes daily volume
snapshots:

```sh
fly volumes list --config infra/fly/fly.toml
fly volumes snapshots list <volume-id> --config infra/fly/fly.toml
```

Never copy the live SQLite file out of the machine; take an Admin snapshot instead.

## SSH and logs

```sh
fly ssh console --config infra/fly/fly.toml
fly logs --config infra/fly/fly.toml
fly status --config infra/fly/fly.toml
```

## Troubleshooting

- **The new machine refuses to start because another instance holds the database**: a second
  machine exists. Scale back with `fly scale count 1 --config infra/fly/fly.toml`; always deploy
  with `npm run deploy:fly` (which passes `--ha=false`).
- **Release check keeps reporting the old commit**: the rollout did not finish. Check
  `fly status` and `fly logs`; the previous release keeps serving until the new one is healthy.
- **Smoke reports `401` or `403`**: the smoke device was refused even after one re-provision. Check that
  `MP_BOOTSTRAP_KEY` in `.env.fly` matches the deployed secret.
