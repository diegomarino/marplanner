# Kiosk Shell & Navigation Domain Contract

Status: maintained contract
Depends on decisions: `ADR-002`, `ADR-005`, `ADR-007`, `ADR-013`, `ADR-023`, `ADR-029`, `ADR-030`, `ADR-031`, `ADR-032`, `ADR-034`, `ADR-035`, `ADR-036`, `ADR-037`, `ADR-038`, `ADR-040`

## Purpose

Kiosk Shell & Navigation is the always-on household client frame. It owns how the tablet boots, provisions, lands on the dashboard, runs global runtime behaviors, separates user-facing from admin surfaces, and surfaces connection health. It owns no durable server table; it composes presentation and coordinates browser-local device state over delegated domains.

## Vocabulary

**Shell** — the top-level client frame: top bar, route outlet, global runtime services, notifications, global health indicator.

**User-facing route** — a household-visible route usable after the device is provisioned, without admin unlock (`/`, calendar, routines, meals). (Renamed from "child-facing": the surface serves all household users.)

**Admin route** — a management route gated by the client-side admin unlock.

**Admin unlock** — ephemeral client-side UI state granting access to admin screens. Not a server session (`ADR-013`).

**Provisioning screen** — the device-setup screen shown on an unprovisioned device (`ADR-036`).

**Global runtime service** — a behavior mounted at shell level, placed by capability (`ADR-035`).

**Global health/attention indicator** — a shell element, discreet when healthy, prominent when action is needed.

## Invariants

- **KIOSK-SHELL-NAVIGATION-INV-01** The shell renders nothing household-runtime until the device is provisioned and connected.
- **KIOSK-SHELL-NAVIGATION-INV-02** Admin route access is gated by the client-side admin unlock only; the backend never gates on PIN (`ADR-007`/`ADR-013`).
- **KIOSK-SHELL-NAVIGATION-INV-03** All "today"/date computation uses the household timezone (`ADR-005`). No browser/UTC-local business dates.
- **KIOSK-SHELL-NAVIGATION-INV-04** Dashboard and user-facing surfaces show active members / active children only; archived references are never resurrected (`ADR-002`/`ADR-025`).
- **KIOSK-SHELL-NAVIGATION-INV-05** `/members` does not exist as a child-facing management route (`ADR-023`).
- **KIOSK-SHELL-NAVIGATION-INV-06** Inactive plugins are invisible on every user-facing surface and absent from normal admin nav (`ADR-038`).
- **KIOSK-SHELL-NAVIGATION-INV-07** The unauthenticated surface is health-only; the access gate (separate token) precedes the shell (`ADR-031`).
- **KIOSK-SHELL-NAVIGATION-INV-08** Every provisioned family-facing route shares persistent navigation for dashboard, calendar, chores, and meals; administration lives only under the PIN-protected `/admin` subtree, and Daily Briefing has no family-facing route.

## Behaviors

**Boot, access gate, provisioning.**
A browser with no access-gate cookie sees the access-token form (`ADR-031`). With the gate passed but no device cookie, it sees the provisioning screen (`ADR-036`): the server URL may be pre-filled from a query param; the raw `*` key is entered manually (never via URL) and exchanged for a minted device key bound to an httpOnly cookie (`ADR-030`/`ADR-032`). A provisioned device never shows these screens again unless its key is revoked. Fail-closed: no credential → locked, never open (`ADR-033`).

**Admin entry and unlock.**
The admin/settings link is visible in the shell but requires a sustained long-press (~3s) to activate; a casual tap does nothing (`ADR-034`). After activation, the PIN gate is presented. On correct PIN, ephemeral admin-unlock UI state is set. It re-locks on three triggers, no grace period: leaving the admin subtree (immediate), inactivity (~5 min, configurable), and page refresh (clears). (`ADR-013`.)

**Global runtime services (capability-based).**
Global server-side services (briefing generation, calendar sync, backups, scheduling decisions) run once regardless of UI. UI-bound services (audio announcements, Bluetooth print delivery, PWA updates, telemetry) run per connected browser. Hardware-bound behaviors split server-side decision from client-side execution; the server hands out each unit of work once via atomic claim to a capability-registered browser; zero-browser work queues with server-side staleness compaction. Time announcements run on all connected routes, including admin. Inactive plugins mount no services. (`ADR-035`.)

**Dashboard.**
The first screen composes today's agenda, active-child chore/routine columns, and today's meals over delegated domains, adapting to orientation. Each widget owns its loading/empty/error state; a partial dashboard is acceptable when one domain is unavailable. Refresh invalidates active widget queries on a timer (default ~5 min) and on interaction, only while visible.

**Global health/attention indicator.**
Derived from the connected-session signal (`ADR-035`), discreet/near-invisible when healthy and prominent when action is needed (API disconnected, lost Bluetooth printer, long-pending update). It distinguishes "no API connection" (global) from a single widget's local failure (per-widget). It is the aggregation point for actionable conditions.

**PWA updates.**
A pending update applies by auto-reload as soon as nothing editable is in progress (no open form/editor with unsaved input, not in PIN entry/provisioning); quick taps and read-only viewing do not block it. A daily forced reload at ~4am household-local guarantees update pickup and a clean slate.

**Offline.**
No offline/read-through data cache in this system. API-down shows per-widget errors plus the global health indicator. A real offline mode is deferred.

**Plugin management.**
Plugin lifecycle (install/uninstall/activate/deactivate) is managed only from `admin/plugins` (`ADR-038`). Activation registers settings objects (`ADR-028`/`ADR-029`), mounts runtime services (`ADR-035`), and adds nav/widgets; deactivation reverses all three. Official vs unofficial trust tiers are distinguished; the trust/permission/sandbox model is owned by the Plugin System grill (`ADR-039`).

## Interfaces

Conceptual:

- Boot → access gate → provisioning → dashboard.
- Admin entry (long-press) → PIN gate → admin unlock → admin routes.
- Global health indicator (read of connection signal).
- Plugin management surface (`admin/plugins`).
- Delegated reads/writes through owning-domain APIs (the shell invents no domain logic).

## Events

(ADR-040.) **Emits: none. Subscribes: none.** The shell is a **client frame** and owns no
server table, so it is not a participant in the server-side in-process event bus
(`ADR-040` is in-memory and server-side). The cross-domain information it needs flows by
**pull**: delegated-domain HTTP reads for widgets, and the **connection/health signal**
(`ADR-035`) for the global health indicator — not bus notifications. Client-side
coordination (admin-unlock state, PWA reload, dashboard refresh timers) is browser-local,
outside the domain-event model entirely.

## Data / Setup Contract

- No owned server table. Browser-local state (device cookie, ephemeral admin unlock, caches) is device-local and not migrated; the product provides a clear re-provision/admin-unlock path.
- Credentials follow `ADR-037` (`mpk-` keys via CSPRNG, `mpg-` gate token, failure-based rate limiting only).
- The dashboard tolerates partial availability of delegated domains and inactive plugins.

## Acceptance Criteria

- **KIOSK-SHELL-NAVIGATION-AC-01** An unprovisioned device shows access gate then provisioning, never household data.
- **KIOSK-SHELL-NAVIGATION-AC-02** Admin content is reachable only after long-press + PIN; the backend authorizes by API key regardless of PIN.
- **KIOSK-SHELL-NAVIGATION-AC-03** "Today" on every widget matches the household timezone.
- **KIOSK-SHELL-NAVIGATION-AC-04** Inactive plugins appear nowhere except `admin/plugins`.
- **KIOSK-SHELL-NAVIGATION-AC-05** API-down produces a prominent global health signal, not a silently empty dashboard.
- **KIOSK-SHELL-NAVIGATION-AC-06** A pending PWA update never reloads over an in-progress edit; it reloads when idle of edits or at ~4am.
- **KIOSK-SHELL-NAVIGATION-AC-07** Time announcements continue on admin routes; auto-print/announcement work is dispatched only to capability-registered browsers and executed once.
- **KIOSK-SHELL-NAVIGATION-AC-08** Given a provisioned household display on the dashboard, when the current day loads, then today's agenda, one independently operable chore column per active child, and today's meal summary are visible together; one widget's failure does not hide the others.
- **KIOSK-SHELL-NAVIGATION-AC-09** Given any provisioned family-facing route, when a household member uses the persistent navigation, then dashboard, calendar, chores, and meals are reachable without typing a URL; Daily Briefing is absent from that navigation and from the family-facing route set.
- **KIOSK-SHELL-NAVIGATION-AC-10** Given any administration capability that was reachable before shell assembly, when an administrator unlocks `/admin`, then that capability remains reachable and usable under a stable admin destination; direct entry or refresh returns to the requested destination after successful unlock.

## Open Decisions

- Plugin trust/permission/installation/sandbox model — Plugin System grill (`ADR-039`).
- "Activate a plugin at first run" UX — partly `ADR-038`, partly Plugin System grill.
- Long-press duration, inactivity timeout, refresh-idle threshold — configurable UI params with sensible defaults; possible future App Settings.
