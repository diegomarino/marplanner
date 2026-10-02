# Portable Container Runtime Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task by task. Steps use checkboxes for tracking. This document is a proposal; no runtime change or deployment has been executed.

**Goal:** Provide a reproducible generic container and clear environment examples, adapting the useful deployment conventions from the existing Marplanner repository.

**Architecture:** One Node process serves client and API from the same origin. One persistent local volume stores SQLite and backups. Docker Compose is the reference deployment; provider-specific configuration stays outside the image.

**Tech Stack:** Node 24.21.0, npm 11.19.0, existing lockfile, Fastify, SQLite, Docker and Compose. No new application dependency is planned.

**Spec:** User request to use `../marplanner/` as a working reference, plus `docs/architecture/decisions/ADR-055-stack-baseline.md`, `ADR-056-process-dx-baseline.md`, `ADR-060-deployment-transport-posture-and-cookie-security.md`, and the common checks in the parent repository's `.worktrees/pre-publication-review/PLAN.md`.

**Workspace:** `.worktrees/review-installation-runtime`, branch `review/installation-runtime`, baseline `cd15c9d4c2dcfc8803be6c88d51e92cb2ba52330`.

## Evidence and scope

Reference checkout: `<marplanner-v1>`, HEAD `f4c1c46a316e131fc273541dc2fd715ef0331bd8`. Read `.env.example`, `apps/web/vite.config.ts`, `infra/docker/{Dockerfile,docker-compose.yml,entrypoint.sh}`, root `.dockerignore`, `infra/fly/fly.toml` and `.github/workflows/deploy.yml`. The user reports that deployment works; this investigation inspected its files and did not probe production. Existing unrelated untracked work there was left untouched. No populated environment or database was read or copied.

The current project already has environment-based credentials/storage/listen configuration and a tested built-process lifecycle. It has no maintained Docker build/Compose recipe. The older project is a Node 22/pnpm monorepo; its paths, lockfile and runtime entrypoint cannot be copied verbatim.

| Reference behavior                                  | Decision for this project                                                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Multi-stage image and separate persistent volume    | Reuse the pattern with the current single-package build and Node/npm pins.                                                            |
| Explicit API/web ports per worktree                 | Allocate distinct API and frontend ports automatically; retain explicit overrides and remove the fixed development proxy target.      |
| `.env` local development                            | Keep the current `.env.local` convention.                                                                                             |
| `APP_API_KEY`, optional auth in development         | Use `MP_ACCESS_TOKEN`, `MP_BOOTSTRAP_KEY`, optional `MP_MANAGEMENT_KEY` and `ADMIN_PIN`; preserve fail-closed auth.                   |
| `APP_CORS_ORIGIN`, `SESSION_SECRET`                 | Do not copy: the current same-origin/cookie design has no equivalent configuration contract.                                          |
| `SEED_LEVEL`, `SEED_PROFILE`, personal seed toggles | Do not copy: current seed CLI has explicit public/private modes. Never seed at container startup.                                     |
| New Relic agent, `FLY_*`, `/sbin/lsmod` workaround  | Exclude from the generic image. Existing telemetry has no built-in external sinks.                                                    |
| Shell backup/retention on every boot                | Do not duplicate current backup/migration lifecycle or introduce automatic deletion. Document existing pre-change snapshot procedure. |
| `/api/health`                                       | Use current `/health`.                                                                                                                |
| Root `.dockerignore`                                | Reuse its placement, strengthen private-file exclusions, and verify the final image.                                                  |
| Fly deployment on tag push                          | No publishing or automatic deployment in this plan. A Fly recipe can later consume the same image.                                    |

## Global constraints

- Keep Node `24.21.0`, npm `11.19.0`, and the existing lockfile; installation happens inside Linux build stages. Do not copy macOS `node_modules`.
- Secrets are runtime configuration only. No credentials, real databases, private seeds, agent state or worktrees enter build context or image layers.
- No change to auth semantics, database migration history, plugin contracts or production data.
- The first container supports one application instance, one local persistent volume and root-path hosting. HTTPS must terminate at a trusted external proxy for remote browser access.
- A root-path container is a limited deliverable, not full compliance with all ADR obligations. Runtime `BASE_PATH`, single-instance enforcement and network-filesystem checks remain open requirements; this plan does not waive them or close phase 01.
- Public evidence records exact revision/image ID, platform, commands, results and limits. Linux amd64 and arm64 acceptance are separate outcomes; do not advertise an untested platform.
- Keep the existing review inventory accurate: assign new maintained files to phase 01, reopen shared owners for changed Vite/CI/docs/test files, and refresh hashes only after inspection. A new plan file also needs recorded inventory ownership.

## Environment contract

Two examples have different purposes: root `.env.example` documents local development; `infra/docker/.env.example` documents Compose interpolation. Operators copy either to an ignored `.env.local` beside it. Explain explicitly that a Compose CLI env file does not inject every variable into the container: the service environment mapping is the allowlist.

| Setting                                                                                  | Local proposal                                                          | Container proposal / existing behavior                                                                                     |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `HOST`                                                                                   | `127.0.0.1`                                                             | `0.0.0.0` inside the container; existing runtime support.                                                                  |
| `PORT`                                                                                   | `0` under the local launcher; optional explicit API port                | Internal port `3000` in reference Compose; raw image accepts another valid port.                                           |
| `WEB_PORT`                                                                               | `0` under the local launcher; optional explicit frontend port           | New development-only Vite setting; never used by built client.                                                             |
| `VITE_API_PORT`                                                                          | Actual API port discovered by the launcher; never a proxy target of `0` | Development proxy only; no production API hostname baked into assets.                                                      |
| `PUBLISHED_PORT`                                                                         | Not needed for native development                                       | Optional explicit Compose host port; automatic publication by default, independent of container `PORT`.                    |
| `DATA_DIR`                                                                               | `.data` inside the worktree                                             | `/data` named volume; document ownership and persistence.                                                                  |
| `DATABASE_PATH`                                                                          | `marplanner.db`                                                         | `marplanner.db` under `/data`; never reuse the older `sqlite.db`.                                                          |
| `BACKUPS_ROOT`                                                                           | Commented override                                                      | Default `/data/backups`; an override requires a persistent mount.                                                          |
| `MP_ACCESS_TOKEN`, `MP_BOOTSTRAP_KEY`, `ADMIN_PIN`                                       | Existing synthetic example values clearly labeled                       | Required nonempty operator-supplied values; no working defaults in Compose example. Token prefixes remain `mpg-` / `mpk-`. |
| `MP_MANAGEMENT_KEY`                                                                      | Optional, commented                                                     | Optional; explicitly explain that changing it does not revoke persisted credentials.                                       |
| `VITE_DEV_BYPASS_ADMIN_PIN`                                                              | `0`                                                                     | Never enabled in the release build.                                                                                        |
| `UNIFI_API_KEY`, `UNIFI_SITE_ID`, `UNIFI_HOST`, `UNIFI_CONSOLE_ID`, `UNIFI_TLS_INSECURE` | Commented optional integrations                                         | Document local/cloud choices from current client; TLS verification on by default.                                          |
| `WEATHER_ENABLED`, `WEATHER_ENDPOINT`, `QUOTE_ENDPOINT`, `ONTHISDAY_ENDPOINT`            | Commented optional overrides                                            | Preserve current adapter semantics; absent overrides use current providers.                                                |
| `SCHEDULER_DISABLED`                                                                     | Commented diagnostic/test option                                        | Unset during ordinary operation. Smoke job variables belong only in validation.                                            |

Do not add inactive `TELEMETRY_SINKS`, old logging/Storybook/terminal/browser-launcher variables, or `SEED_*` aliases to the normal deployment example. Explain relevant unsupported legacy variables in the operations migration note. Optional settings stay commented so empty strings do not silently override defaults.

## Review focus

1. Two worktrees or Compose projects must not share ports or data accidentally: verify four distinct API/frontend ports for two development stacks, proxy synchronization after restart, and isolated readback; exercise distinct Compose project names.
2. A non-root container must handle volume ownership and reject unwritable storage clearly: test a fresh named volume and a read-only bind mount.
3. The image must contain migrations, fonts and native dependencies: run real database startup and a briefing renderer check inside the image.
4. Client assets must contain neither deployment credentials nor developer bypass/test hooks: inspect image contents and exercise the locked browser flow.
5. Process shutdown must preserve committed state: test SIGTERM during work, restart and API readback with the same volume.

## Task 1: Automatic and separate local API/frontend ports

**Files:** create `tools/dev/start-local.mjs` and `tools/local-runtime.test.mjs`; modify `.env.example`, `.gitignore`, `package.json`, `vite.config.ts`, `src/server/index.ts`, `tools/local-env.test.mjs`, `README.md`, `docs/operations.md`.

**Interfaces:** `npm run dev` coordinates two distinct servers. API `PORT=0` and frontend `WEB_PORT=0` request independent OS-assigned ports by default. After the API starts listening, its actual address is delivered to the launcher through a structured readiness signal; the launcher supplies that address to Vite's proxy before starting the frontend. Preserve explicit nonzero overrides and exported-env precedence over `.env.local`. Production defaults remain separate from these local-launcher defaults.

- [ ] Add a runnable lifecycle check that starts two isolated development stacks simultaneously with automatic ports. Assert four distinct live listener ports, frontend-to-own-API routing, isolated data readback, both URLs reported and shutdown cleanup. The check must fail before the launcher exists.
- [ ] Add checks for explicit occupied ports (clear failure, no silent fallback), invalid port values, early API startup failure, readiness timeout, API restart/proxy synchronization and stopping either failed stack without orphan servers. Verify that environment credentials do not enter client configuration or logs.
- [ ] Implement the minimal launcher with existing Node/Vite facilities. Start the API, receive the actual bound address, configure the frontend proxy and start Vite on its own port. Report labeled API/frontend URLs and open only the frontend when explicitly requested. Never find a free port by opening and closing a temporary socket before the real server binds.
- [ ] Keep each socket owned by its server throughout operation. Preserve the local reload workflow: a backend restart must update the proxy target before requests resume; a browser-facing frontend restart should retain its assigned origin or report a clear failure. The readiness mechanism must work with the chosen watch process rather than assume a wrapper forwards IPC.
- [ ] Make `npm run dev` the coordinated entrypoint, retaining `dev:server` for standalone diagnostics. Keep actual discovered `VITE_API_PORT` internal to coordinated startup; an optional standalone frontend command must require a usable API address rather than use `0` as its target. Use strict occupancy behavior for explicit ports.
- [ ] Update the example to `PORT=0`, `WEB_PORT=0`, loopback host and per-worktree `.data`; explain automatic allocation and explicit overrides. Add `.data/` to ignore rules. Expand existing environment checks without freezing the example to exactly five assignments; keep current `.env.local` support in start/seed scripts.
- [ ] Run `node --test tools/local-env.test.mjs tools/local-runtime.test.mjs`, `npm run typecheck` and `npm run build`. Expected: lifecycle tests pass, two API/frontend pairs work concurrently, and no listener/child survives cleanup. Regress existing entrypoint tests when changing readiness code.
- [ ] Review nomenclature in touched files, update review ownership/evidence, and commit only this task's changes.

## Task 2: Generic production image and Compose example

**Files:** create root `.dockerignore`, `infra/docker/Dockerfile`, `infra/docker/compose.yaml`, `infra/docker/.env.example`; modify `README.md` and `docs/operations.md`.

**Interfaces:** consume current `npm ci`, `npm run build`, `dist/server/index.js`, `dist/client`, `drizzle/`, native runtime dependencies and copied font assets. Produce a locally tagged image `marplanner:review` and a Compose service `marplanner` with a project-scoped `marplanner-data` volume.

- [ ] Run `docker build -f infra/docker/Dockerfile -t marplanner:review .` before adding packaging; record failure because the Dockerfile is absent. Task 3 adds behavioral acceptance after this task produces the image. Do not treat a text assertion against Dockerfile contents as runtime proof.
- [ ] Build using a pinned official Debian slim Node 24.21.0 base, resolving an actual available digest during implementation; verify npm 11.19.0 in the build. Separate build and production dependencies; no compiler/dev tools in final runtime unless demonstrated necessary.
- [ ] Set `WORKDIR /app`, copy required outputs plus `drizzle/`, include fonts/licenses and production dependencies. Create `/data` with ownership for the non-root runtime user. Use direct exec-form `node dist/server/index.js`; rely on the existing application boot/migration lifecycle. No custom entrypoint or background agent is needed.
- [ ] Configure `NODE_ENV=production`, `HOST=0.0.0.0`, `PORT=3000`, `DATA_DIR=/data` and `DATABASE_PATH=marplanner.db`; ensure browser test/bypass flags are absent at build time. Use a Node-based `/health` check that observes runtime `PORT`.
- [ ] Exclude real env files, `.data/`, SQLite files and sidecars, backups, private seed overlays, `.git`, `.worktrees`, dependencies, caches and agent/evidence directories from context. Use explicit runtime copies; no broad `COPY . .` into the runtime image.
- [ ] Define Compose publication on host loopback with an automatically assigned host port by default and an optional `PUBLISHED_PORT` override; discover the actual published address from Compose. Keep the built-image internal port at `3000`, project-scoped volume, required credential interpolation and explicit optional integration mappings. No fixed `container_name`, global volume name, source bind mount or automatic seeds. Allow a stop grace period longer than the app's current five-second drain deadline.
- [ ] Verify `docker compose --env-file infra/docker/.env.local -f infra/docker/compose.yaml -p installation-review config --quiet` with synthetic settings. Missing required credentials must fail; do not print interpolated secrets into evidence.
- [ ] Build the image and verify a synthetic fresh boot, `/health` and non-root user. Task 3 owns complete behavioral acceptance. Document remote HTTPS/proxy requirements and persistent-volume ownership before committing.

## Task 3: Container lifecycle and browser acceptance

**Files:** create `tools/container-smoke.mjs`; modify `package.json` to add `check:container`; reuse existing critical-flow expectations and synthetic API payloads. Add browser configuration only if existing harness cannot target the container without rebuilding/spawning a host server.

**Interfaces:** `node tools/container-smoke.mjs --image marplanner:review` consumes an already-built image. It exits nonzero on failure and writes sanitized results to `.quality/container/`. Use Node stdlib subprocess/fetch/assert helpers and current Playwright dependency; no new framework.

- [ ] Implement one focused harness with uniquely named containers/volumes and OS-assigned loopback host ports. Cleanup in `finally` must remove only resources created by this run; retain diagnostic logs and fail on unverifiable cleanup.
- [ ] Assert fresh `/health`, unauthorized API denial, locked gate, device provisioning, admin/member creation, process restart, persisted member and device readback. Run the browser against the container, not the old critical-flow spec's independently spawned host process.
- [ ] Assert two separate volumes remain isolated; run the same image with a different internal `PORT`; confirm migrations/font rendering and production native-module loading. Reject a read-only data mount with nonzero exit and a useful error.
- [ ] Send SIGTERM during the existing two-write smoke job and require both writes plus clean exit; separately restart the normal image with the same volume and verify committed data. Missing credentials must leave browser/API access locked.
- [ ] Inspect the final image and built client for synthetic secret canaries, private materials and dev bypass/test flags. Check runtime user is non-root. Capture gate/provisioning screenshots at desktop and touch viewports and assess visible errors/focus/overflow; record needed UI fixes separately.
- [ ] Run `npm run check:container -- --image marplanner:review`. Expected: all named cases pass, no leaked resources, sanitized evidence includes source revision, image ID and tested architecture. Record first failure and final success for each implementation repair.

## Task 4: CI, operational documentation and review handoff

**Files:** modify `.github/workflows/full-gate.yml`, `docs/operations.md`, `README.md`, ADR-055 and ADR-056 only where status/evidence needs clarification. Review-package inventory/checklists are maintained in the parent repository.

**Interfaces:** consume the image and `check:container` command. Produce Linux image acceptance in CI alongside existing full application gate; no registry push or provider deployment.

- [ ] Add a container build/acceptance step to the existing full gate and retain `.quality/container/` on failure. Initially certify only the architecture that actually runs; an arm64 claim requires its own run.
- [ ] Document native development, Compose project isolation, runtime secret injection, volume ownership, HTTPS termination, explicit backup-before-change procedure and no automatic legacy database import.
- [ ] State precise remaining ADR gaps below. Do not change accepted requirements to erase them; any scope reduction needs a separate explicit decision.
- [ ] Run affected checks and the full candidate gate. Reconcile file inventory, hashes/modes and reopened phase owners; include this plan and all new files. Do not mark phase 01 passed while required inspection or acceptance remains pending.
- [ ] Review the full diff and record validation before a scoped commit. Stop before push, image publication or deployment.

## Remaining obligations beyond this first container deliverable

These require separate bounded designs/tests before phase 01 can be called fully conformant, or an explicit reviewed change to the governing requirements:

- Runtime subpath hosting (`BASE_PATH`): touches API routes, gate actions/redirects, client URLs, assets and cookie scope. The reference deployment does not supply a proven solution; do not transplant a build-time Vite base and call it runtime support.
- Single-instance enforcement and network-filesystem policy: coordinate startup, shutdown and database/restore ownership; document single-instance/local-volume operation meanwhile. Compose's one service is not an application-level lock.
- Dependency advisory triage: resolve the retained phase 01 findings against exact packages and reachable behavior; do not run forced upgrades as packaging work.
- Complete owned-file/context review, naming cleanup and gate/provisioning visual polish from the existing phase 01 inspection.
- Fly/provider-specific recipe and real remote HTTPS acceptance remain untested until explicitly exercised. A successful local image is not evidence of deployment on every provider.

## Plan validation

Before implementation, verify every proposed environment setting has an existing reader or an explicit task adding it; keep legacy-only settings out. Check source/runtime file paths, task dependencies, required acceptance coverage and review ownership. No product tests are claimed by this planning document.

## Documentation checked

Docker environment behavior was checked through Context7 (`/docker/docs`) on 2026-10-02:

- [Compose interpolation and --env-file](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/)
- [Service environment configuration](https://docs.docker.com/compose/how-tos/environment-variables/set-environment-variables/)
- [Container environment precedence](https://docs.docker.com/compose/how-tos/environment-variables/envvars-precedence/)

Self-review: task order is environment -> image -> behavioral acceptance -> CI; no task requires implementation from a later task to complete. Every proposed new setting is assigned to local Vite or Compose; unsupported legacy settings are explicitly excluded. Packaging does not close the remaining runtime/ADR obligations. Only this plan was created in the phase worktree; product configuration and runtime remain unchanged.

### Accepted local-port clarification

The user confirmed that each development worktree needs two separate listeners: API and frontend. Each requests an automatic port, and coordinated startup discovers the API port before configuring the frontend proxy. Explicit ports remain optional. This clarification replaces manual per-worktree port assignment; it does not itself authorize implementation of the plan.
