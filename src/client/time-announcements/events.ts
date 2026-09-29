/** Time-announcements window event names.
 * A NEW, side-effect-free module — importing it never triggers `service.tsx`'s * module-import-time `registerShellService(AnnouncementService)` self-registration (see
 * that module's own docblock for why that side effect must never leak into a jsdom render
 * of `<Shell />` / `<AdminGate />`). `service.tsx` re-exports `RULES_CHANGED_EVENT` from
 * here for its own internal use; every other consumer (the admin panel, the panel's jsdom
 * test, the e2e spec) imports directly from this module instead of duplicating the string
 * literal — a single source of truth for the event name, safe to import anywhere.
 */

/** Dispatched by the admin panel after a rule save — the service refetches on it. */
export const RULES_CHANGED_EVENT = "mp:time-announcements-rules-changed";
