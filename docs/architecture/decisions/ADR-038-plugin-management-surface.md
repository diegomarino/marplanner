# ADR-038 Plugin Management Surface

Status: accepted
Owner: product / architecture
Decision date: 2026-06-28

## Decision

Plugin lifecycle is managed from a single dedicated admin surface (e.g. `admin/plugins`): **install, uninstall, activate, deactivate**. This is the only place plugins are managed.

### Visibility

- **User-facing surfaces:** inactive plugins are entirely invisible — no nav entry, no widget. The user-facing shell is composed only of active plugins.
- **Admin surfaces:** inactive plugins do not appear scattered as dimmed entries in the normal admin nav either. They appear **only** in the dedicated plugin-management page. This keeps the admin nav clean and is especially important because some plugins are untrusted third-party code (see `ADR-039` plugin trust model).

### Plugin types

Plugins come in two trust tiers, which the management surface distinguishes:

- **Official:** verified, behavior can be presupposed.
- **Unofficial / third-party:** untrusted code; behavior is not known in advance.

The full trust, permission, installation-source, and sandbox model for these tiers is **out of scope for this decision** and is governed by a dedicated Plugin System grill (`ADR-039`, see that decision/grill).

### Lifecycle consequences (already defined elsewhere)

Activating a plugin registers its settings objects with defaults (`ADR-028`/`ADR-029`), mounts its runtime services (`ADR-035`), and adds its nav/widgets. Deactivating reverses this: its settings objects disappear from `GET /settings` (consistent with `ADR-029` "absent object = plugin inactive"), its runtime services unmount, and its nav/widgets disappear. Activate/deactivate is therefore a switch with well-defined, system-wide consequences, not merely a nav toggle.

## Rationale

A single management surface keeps plugin lifecycle in one auditable place. Hiding inactive plugins everywhere except that page keeps both the child-facing surface and the admin nav clean, and avoids surfacing untrusted third-party plugins in ordinary navigation.

## Affected Specs

- `docs/rewrite-spec/15-kiosk-shell-navigation.md` — admin nav, dashboard composition
- `docs/rewrite-spec/03-app-settings-registry.md` — plugin settings objects appear/disappear with activation

## Acceptance Criteria

- Given an inactive plugin, then it has no nav entry or widget on any user-facing route.
- Given an inactive plugin, then it appears only in `admin/plugins`, not in the normal admin nav.
- Given the plugin-management page, then it offers install, uninstall, activate, and deactivate, and distinguishes official from unofficial plugins.
- Given a plugin is deactivated, then its settings objects no longer appear in `GET /settings` and its runtime services are unmounted (`ADR-029`/`ADR-035`).

## Open Questions

- Plugin trust/permission/installation-source/sandbox model — owned by `ADR-039` (Plugin System grill).
- What "activate at first run" looks like — partly here, partly Plugin System grill.

## Traceability

- Related prior: `ADR-029`
- Related: `ADR-028` (settings objects), `ADR-035` (runtime services), `ADR-039` (plugin trust model — to be created)
- Domain grill: `../domain-grills/kiosk-shell-navigation.md`; future `../domain-grills/plugin-system.md`
