# UI Contract: Plugin Management and Contributions

## Purpose

This contract fixes the observable plugin UI behavior that is not expressible in OpenAPI: canonical-state presentation, transient busy feedback, contribution hiding, accessibility, responsive behavior, and post-implementation human acceptance. It deliberately leaves visual styling to the established component system.

## Entry and authorization boundary

- `/admin/plugins` is a core-owned admin destination and remains reachable regardless of plugin state.
- It is disclosed only after the existing client-side admin PIN gate is unlocked.
- Loading the page then requests the authenticated catalog with the existing device session. The PIN is never placed in a request, storage record, log, or error.
- An expired/insufficient server credential renders the standard authenticated error/recovery treatment; the client does not reinterpret a successful PIN as server authority.

## Catalog states

Each of the exact nine manifest entries presents:

- localized name and concise contribution description;
- the first-party trust label, declared contribution groups, runtime/compatibility requirements, and settings-schema metadata without configured or default values;
- one toggle button whose visible text is the canonical status label (Active, Inactive, or Needs attention), pressed only when Active, named by the plugin's own label; pressing it activates an inactive or errored plugin and deactivates an active one;
- a muted (grey) card ground while Inactive; Needs attention keeps the normal ground;
- an allow-listed safe error message only for `errored`;
- a transient operation label when `operation` is non-null.

An operation never changes the canonical label. In particular, a target-`inactive` operation continues to show canonical Active plus a visible “Stopping safely…” busy treatment until the terminal response. The plugin's toggle is disabled and `aria-busy` while busy; unrelated plugin controls remain usable.

Repeated submission is prevented in the client but correctness does not depend on it. On HTTP 409, the response's current plugin representation replaces stale local state.

## Global health indicator

- The application shell displays a core-owned aggregate plugin health indicator after the authenticated catalog loads.
- It reveals no plugin metadata before authentication.
- Inactive plugins are neutral and do not degrade health.
- A busy operation is announced as activity, not failure.
- Any `errored` plugin changes the aggregate indicator to attention; activating it opens/navigates to the catalog and focuses the relevant row.
- The indicator never displays a raw exception, path, URL, SQL fragment, credential, or private-network detail.

## Contribution projection

The client derives the following from active manifests only:

- family routes and navigation destinations;
- plugin admin destinations;
- settings panels;
- shell widgets;
- long-lived browser services;
- plugin-specific notices.

Inactive or errored contributions are removed on catalog refresh. A direct URL to a withdrawn route renders a core-owned Plugin unavailable screen with a return action; it does not mount the plugin component or expose retained data. Core destinations and unrelated plugins remain usable.

The existing printing status polling path is retired once printing visibility derives from the shared catalog. Time announcements start only while their contribution is active and stop cleanly when withdrawn.

## Failure containment

- Each mounted client contribution is inside a plugin-scoped error boundary.
- The boundary reports only `contribution_render_failed` or `contribution_start_failed` to the lifecycle fault route.
- Raw client errors may enter internal logging only through the central redactor and never enter the request body or catalog UI.
- A failed plugin contribution is replaced by the core unavailable/attention treatment; the rest of the shell remains mounted.

## Responsive and accessible behavior

- At 320 CSS pixels and wider, plugin name, canonical status, safe error, and primary action remain readable without horizontal page scrolling.
- Wide layouts may use a table; narrow layouts use stacked rows/cards while preserving the same reading and tab order.
- Every status has visible text in addition to color/icon.
- Busy updates and terminal failures use a polite live region; focus remains on the initiating control unless the control disappears, then moves to the row heading/status.
- Disabled controls expose `disabled` and an accessible explanation; no action is hover-only.
- Catalog order is deterministic and matches manifest order.
- Keyboard-only users can unlock admin, reach every row/action, invoke a mutation, perceive busy/terminal results, and return from Plugin unavailable.

## Required implementation fixtures

The UI/e2e test harness must provide deterministic fixtures for:

1. fresh installation: all nine inactive;
2. all nine active (seeded directly; since the 2026-10-16 migration squash every install starts as a fresh lineage with all nine inactive);
3. one active plugin draining while another remains interactive;
4. one errored plugin with each class of safe message represented across automated tests;
5. inactive direct-route navigation;
6. activation and reactivation with retained settings/data;
7. expired credential after a successful PIN unlock.

Fixtures use frozen timestamps and synthetic safe codes. They contain no copied production data, credentials, private URLs, or private paths.

## Human visual acceptance after implementation

**Owner**: maintainer, assisted by the implementing coordinator.  
**Timing**: after automated checks pass and before slice closure. **Evidence:** record desktop and narrow screenshots with the exact tested revision, state and outcome. Keep transient browser output out of the product tree.

The human review must inspect a running build at narrow and wide viewports for fresh, all-active, busy drain, errored, and inactive direct-route states. It must exercise keyboard order, focus retention, live announcements, safe error text, contribution disappearance, and unrelated-plugin continuity. The evidence records viewport, fixture, build SHA, reviewer, decision, and any follow-up. Screenshot generation alone is not acceptance.
