# ADR-055 — Technology Stack Baseline

Status: accepted
Date: 2026-06-30
Depends on / constrains: ADR-039 (plugin system), ADR-017/042 (backups), ADR-043 (atomicity/FK),
ADR-014/035 (single-instance runtime), ADR-026 (fresh store), ADR-015 (i18n), ADR-054 (archive-only).

## Decision

The runtime and build entries below reflect the current foundation. Distribution hardening and container acceptance items remain obligations until implemented and tested; this decision alone is not release evidence.

The technology stack, selected for a **single
self-hosted instance, no HA, family-scale concurrency**, but **distributed to many independent
self-hosters** (N users × 1 instance each):

| Layer                  | Choice                                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Language               | **TypeScript**                                                                                                                      |
| Runtime                | **Node.js `>=24.21.0 <25`**, development/CI pinned to **24.21.0**                                                                   |
| Repo shape             | **Single package** (monorepo collapsed; module boundaries via ESLint Rule-B import lint, not package boundaries)                    |
| Datastore              | **SQLite** (embedded, WAL, **STRICT tables**, `busy_timeout` at boot)                                                               |
| DB access / migrations | **Drizzle** (schema = source of truth = query types)                                                                                |
| Backend                | **Fastify** (route-level schema validation)                                                                                         |
| Frontend               | **React + Vite SPA, served by Fastify (same-origin)**; UI kit **shadcn/ui** (Radix + Tailwind, components copied into repo)         |
| Package manager        | **npm**                                                                                                                             |
| Build                  | **Vite** (frontend) + the repository server build script + **`tsc -b`** typecheck                                                   |
| Packaging / deploy     | Built client and server with persistent `DATA_DIR`; the Docker model below is a distribution decision pending packaged verification |

## Rationale (per pillar, abridged — full reasoning in the grill)

- **TypeScript / Node:** the grilled domain already assumes a structurally-typed language
  (discriminated unions, invalid-states-unrepresentable) and ADR-039's in-process first-party plugin
  model is a single-language module system; switching language would invalidate that grilling. Node
  over Bun/Deno for "runs unattended for years" stability + library compat (better-sqlite3, Drizzle,
  Fastify); Deno's sandbox adds nothing because plugins are first-party-trusted.
- **Single package:** Rule-B lint already enforces boundaries → package boundaries are redundant
  machinery; nothing versions/distributes separately. Also eliminated the previous worktree failures at their
  root (pnpm `nodeLinker:isolated` + monorepo symlinks — see ADR-056 worktree-safety).
- **SQLite:** ADR-043 (`PRAGMA foreign_keys`) + ADR-017/042 (single-file backup) already assume it;
  single-instance is the embedded-DB sweet spot. STRICT tables + busy_timeout are correctness wins.
- **Drizzle:** schema = types ⇒ schema↔types drift structurally impossible (matters for a solo
  maintainer whose only other defense is discipline). Kysely runner-up (hand-synced interface =
  drift footgun). Prisma rejected (engine binary, dead weight for embedded).
- **Fastify:** maturity + route-level schema validation = correctness free-win on ADR-028 boundary.
- **React + Vite + shadcn:** real client logic exists (ADR-013/031/051/016); shadcn components are
  copied into the repo (owned/frozen, no external UI lib churn) — same defeat-failure-by-construction
  ethos. SPA served same-origin by Fastify (see ADR-056 `/api` rule).
- **npm:** collapsing the monorepo removed pnpm's workspace rationale; npm ships with Node.

## Distribution model (Q10) — the load-bearing distributable decision

- **Governing principle:** ALL platform variance lives in thin external recipes (compose, fly.toml,
  templates); **the image NEVER** — leaking platform specifics into the image forks the artifact.
- **Phase 1 (committed):** one platform-agnostic Docker image as source-of-truth runtime; config
  100% via env + mounted volume (no baked secrets/paths/host assumptions); SQLite on a persistent
  named volume (ADR-017/042 backups copy the volume file); a reference `infra/docker/compose.yaml`.
- **Phase 2 (additive, on-demand):** per-platform recipes over the SAME image; Fly.io demoted from
  assumed target to one optional recipe. For a SQLite app the only substantial per-PaaS variance is
  **persistent storage for the `.db`** + backup wiring.
- **Cross-cutting requirement imposed backward on ALL prior decisions:** config strictly
  externalized, zero host assumptions (reinforces ADR-039/053 operator-config seam). OPEN: re-scan
  ADR-001..054 for host-coupling.

## Peer-review hardening (folded, all from the distributable surface)

1. **Single-writer guard (Critical):** at boot, an OS-backed exclusive lock on a stable sentinel SQLite file → refuse
   to start if another instance already holds the DB, with a clear error; Fly recipe sets
   `max_machines_running = 1`. Prevents two VMs sharing one volume opening one WAL → corruption.
   Generalizes to every platform, not just Fly. The installed SQLite dependency
   acquires the sentinel in rollback-journal EXCLUSIVE locking mode with a committed
   write. Its dedicated connection survives product connection resets and restore;
   OS process termination releases ownership. The seed CLI uses the same guard.
   The sentinel is never deleted or replaced while an instance runs.
2. **Network-filesystem guard:** before SQLite opens, `statfs(2)` `f_type` check → refuse recognized Linux NFS/SMB/CIFS
   (WAL is unsafe on network FS; Synology/TrueNAS self-hosters). Other Linux
   filesystem types remain allowed; macOS and other platforms warn that classification
   is unavailable. This is a known-type denylist, not proof every allowed mount is local.
3. **Write serialization:** `busy_timeout` is a retry loop, not a queue → with deliberate multiple
   writers (scheduler/reconciler/briefing, ADR-014/035/053) add **in-process write serialization**
   (single-process makes this trivial) + explicit `SQLITE_BUSY` handling so writes are never silently
   lost. **Pin `better-sqlite3` to a build bundling SQLite ≥ 3.51.3** (pre-3.51.3 WAL-reset
   multi-writer corruption bug); assert the bundled version in `check:standard`.

## Implementation status (2026-10-02)

The portable container recipe supports root-path hosting with one application
instance and a local persistent volume. The server and seed CLI enforce exclusive
storage ownership, and all shared product SQLite opens reject recognized Linux
network filesystem types. Database file symlinks and hardlinks are rejected; parent
directory aliases are canonicalized. Direct external SQLite writers and individual
file bind-mount aliases bypass this cooperative boundary. Runtime `BASE_PATH` and
automatic pre-migration snapshots remain open obligations. Packaging and platform-specific runtime evidence do not establish
full distribution acceptance.

## Acceptance criteria

- A second instance pointed at the same DB volume **fails to start** (advisory-lock guard), not
  corrupts. A network-FS-backed volume is detected and refused/warned at boot.
- Concurrent writes from scheduler + reconciler + briefing never raise an unhandled `SQLITE_BUSY`
  and never silently drop a write; `check:standard` asserts SQLite ≥ 3.51.3.
- The same image runs unmodified from `docker compose up` and from a Fly recipe; no platform string
  appears inside the image.
- STRICT tables reject wrong-typed column writes at the engine level.

## Open questions

- ~~Host-coupling re-scan of ADR-001..054 (config-externalization audit) — tracked, not yet
  executed.~~ **DONE 2026-06-30 (peer-reviewed).** Verdict: ADR-001..036 structurally clean
  (ADR-032/033 over-deliver on portability); no destructive backward ripple. Findings folded into
  [developer verification policy](../../quality/verification.md) § _Operator Configuration & Runtime Environment_: canonical env-var
  scheme (resolves "reserved names" below + ADR-042 backups root + ADR-053 UniFi key); operator-only
  `WEATHER_ENDPOINT`/`WEATHER_ENABLED` (ADR-052); volume UID/GID writability + boot preflight; host
  clock (NTP) precondition.
- ~~Exact reserved data dir / env var names (`DATABASE_PATH`, `DATA_DIR`, `BASE_PATH`) — naming
  only.~~ **Resolved** in the DX contract env-var registry (`DATA_DIR` root; `DATABASE_PATH` /
  `BACKUPS_ROOT` derive from it; plugin keys `MARPLANNER_PLUGIN_<ID>_<KEY>`).
- ~~**OPEN (parked, structural):** `BASE_PATH` × Vite — build-time `base` vs single prebuilt
  image.~~ **RESOLVED at spec level (2026-06-30):** `BASE_PATH` is a **runtime** env (build-arg
  excluded — it would break this image's pull-one-prebuilt distribution); the SPA base path is
  injected at runtime. ADR-056's erroneous "Vite `base` = it" is corrected. Residual = bounded impl
  choice of injection mechanism only. See ADR-056 dev-loop section + DX contract.
