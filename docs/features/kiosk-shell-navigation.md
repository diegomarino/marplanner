# Feature: Kiosk Shell & Navigation (the always-on household client frame)

Behavior reference. The [owning contract](../architecture/contracts/kiosk-shell-navigation.md) defines invariants and extension limits.

Kiosk Shell & Navigation is the always-on household client frame: how the tablet boots, provisions,
lands on the dashboard, runs global runtime behaviors, separates user-facing from admin surfaces, and
surfaces connection health. It owns **no durable server table** — it composes presentation and
coordinates browser-local device state over delegated domains, inventing no domain logic. Admin access
is a client-side unlock only (never a backend PIN gate), and all business dates use the household
timezone.

## User workflows

### User Story 1 — Boot, gate, provision, dashboard

A fresh tablet with no access-gate cookie sees the access-token form; once the gate passes but no device
cookie exists, it sees the provisioning screen where the raw `*` key is entered manually and exchanged
for an httpOnly-cookie-bound device key. A provisioned device lands on the dashboard and never shows
those screens again unless its key is revoked.

### User Story 2 — Enter admin via long-press + PIN

The admin link is visible but needs a sustained ~3s long-press (a casual tap does nothing); the PIN gate
follows, and on the correct PIN ephemeral admin-unlock UI state is set. It re-locks on leaving the admin
subtree, on inactivity, and on refresh — while the backend authorizes purely by API key, never by PIN.

### User Story 3 — Degrade gracefully when a domain is down

When the API is down, each widget shows its own error and the global health indicator becomes prominent
— never a silently empty dashboard — distinguishing a global "no API connection" from a single widget's
local failure.

### Edge Cases

- All "today" computations across widgets use the household timezone, never browser/UTC-local.
- Inactive plugins appear nowhere except `admin/plugins`.
- A pending PWA update waits for an idle-of-edits moment (or the ~4am forced reload) before reloading.
- Time announcements continue even on admin routes; hardware work dispatches once to a capability browser.
- Archived members/children are never resurrected onto user-facing surfaces.

## Requirements

### Functional Requirements

- **FR-001**: Given a device, when it is not yet provisioned and connected, then the shell MUST render nothing household-runtime until the device is provisioned and connected. Contract: KIOSK-SHELL-NAVIGATION-INV-01.

- **FR-002**: Given an admin route, when access is decided, then it MUST be gated by the client-side admin unlock only, and the backend MUST NOT gate on the PIN. Contract: KIOSK-SHELL-NAVIGATION-INV-02.

- **FR-003**: Given any "today"/date computation, when it is performed, then it MUST use the household timezone, and it MUST NOT use browser or UTC-local business dates. Contract: KIOSK-SHELL-NAVIGATION-INV-03.

- **FR-004**: Given the dashboard and user-facing surfaces, when members or children are shown, then they MUST show only active members / active children, and archived references MUST never be resurrected. Contract: KIOSK-SHELL-NAVIGATION-INV-04.

- **FR-005**: Given routing, when routes are defined, then `/members` MUST NOT exist as a child-facing management route. Contract: KIOSK-SHELL-NAVIGATION-INV-05.

- **FR-006**: Given an inactive plugin, when surfaces render, then it MUST be invisible on every user-facing surface and absent from normal admin nav. Contract: KIOSK-SHELL-NAVIGATION-INV-06.

- **FR-007**: Given the unauthenticated surface, when it is served, then it MUST be health-only, and the access gate (a separate token) MUST precede the shell. Contract: KIOSK-SHELL-NAVIGATION-INV-07.

- **FR-008**: Given a device that is unprovisioned (at boot or on any later navigation or refresh), when any surface is requested, then it MUST show the access gate then the provisioning screen, and it MUST never show household data. Contract: KIOSK-SHELL-NAVIGATION-AC-01.

- **FR-009**: Given admin content, when it is reached, then it MUST be reachable only after long-press + PIN, while the backend MUST authorize by API key regardless of PIN state. Contract: KIOSK-SHELL-NAVIGATION-AC-02.

- **FR-010**: Given any widget's "today", when it is computed, then it MUST match the household timezone (the acceptance surface for FR-003/INV-03). Contract: KIOSK-SHELL-NAVIGATION-AC-03.

- **FR-011**: Given inactive plugins, when surfaces render, then they MUST appear nowhere except `admin/plugins` (the acceptance surface for FR-006/INV-06). Contract: KIOSK-SHELL-NAVIGATION-AC-04.

- **FR-012**: Given an API-down condition, when the dashboard renders, then it MUST produce a prominent global health signal and MUST NOT present a silently empty dashboard. Contract: KIOSK-SHELL-NAVIGATION-AC-05.

- **FR-013**: Given a pending PWA update, when an edit is in progress it MUST NOT reload over that edit, and when the app is idle of edits (or at the ~4am household-local forced reload) it MUST reload. Contract: KIOSK-SHELL-NAVIGATION-AC-06.

- **FR-014**: Given connected browsers, when hardware-claim work (auto-print) is dispatched, then it MUST be dispatched only to capability-registered browsers and executed once, and time announcements MUST continue on admin routes (their firing is client-side per browser — `ADR-051`, scope reconciled by `ADR-065`; the "executed once" clause applies to print/hardware-claim work only). Contract: KIOSK-SHELL-NAVIGATION-AC-07.

- **FR-015**: Given provisioned family-facing routes, when any such route renders, then it MUST share persistent navigation for dashboard, calendar, chores, and meals; administration MUST live only under the PIN-protected `/admin` subtree, and Daily Briefing MUST have no family-facing route. Contract: KIOSK-SHELL-NAVIGATION-INV-08.

- **FR-016**: Given a provisioned household display on the dashboard, when the current day loads, then it MUST show today's agenda, one independently operable chore column per active child, and today's meal summary together, and one widget's failure MUST NOT hide the others. Contract: KIOSK-SHELL-NAVIGATION-AC-08.

- **FR-017**: Given any provisioned family-facing route, when a household member uses the persistent navigation, then dashboard, calendar, chores, and meals MUST be reachable without typing a URL, and Daily Briefing MUST be absent from that navigation and from the family-facing route set. Contract: KIOSK-SHELL-NAVIGATION-AC-09.

- **FR-018**: Given any administration capability that was reachable before shell assembly, when an administrator unlocks `/admin`, then that capability MUST remain reachable and usable under a stable admin destination, and direct entry or refresh MUST return to the requested destination after successful unlock. Contract: KIOSK-SHELL-NAVIGATION-AC-10.

### Key Entities

- **Shell**: the top-level client frame — top bar, route outlet, global runtime services, notifications,
  and the global health indicator. Owns no server table; composes over delegated domains.
- **Admin unlock**: ephemeral client-side UI state granting admin-screen access; not a server session.
  Re-locks on leaving the admin subtree, on inactivity (~5 min, configurable), and on refresh.
- **Provisioning / access-gate state**: the unprovisioned/un-gated boot states — access-token form, then
  device provisioning (raw `*` key entered manually, never via URL) → httpOnly device cookie.
- **Global health/attention indicator**: derived from the connected-session signal; discreet when
  healthy, prominent when action is needed; distinguishes global "no API" from per-widget failure.

## Success Criteria

- **SC-001**: An unprovisioned device exposes 0 household data; the boot path is always access gate →
  provisioning → dashboard.
- **SC-002**: 100% of widget "today" computations match the household timezone; 0 use browser/UTC-local.
- **SC-003**: When the API is down, the global health indicator is prominent in 100% of cases (0 silently
  empty dashboards); a pending PWA update reloads over 0 in-progress edits.

## Assumptions

- Auth & Sessions owns the credential model, the device-key exchange, and the fact that the backend
  authorizes by API key (never PIN); this shell drives the client-side unlock state only.
- Delegated domains own their data; the shell invents no domain logic and reads/writes through their
  APIs. The scheduler / ADR-035 connected-session signal feeds the health indicator and the
  capability-based dispatch of hardware work.
- Long-press duration, inactivity timeout, and refresh-idle threshold are configurable UI params with
  sensible defaults (Open Decision; possible future App Settings).
- No owned server table and no offline data cache in this system; browser-local state is device-local and not
  migrated (ADR-026), with a clear re-provision / admin-unlock path.
