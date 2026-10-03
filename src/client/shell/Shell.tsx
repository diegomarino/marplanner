import { appUrl, appPathname } from "@/lib/base-path";
import { useEffect, useState, type ComponentType, type FormEvent, type ReactNode } from "react";

import { AdminUnlockProvider, useAdminUnlock } from "@/lib/adminUnlock";
import { AdminGate } from "@/admin/AdminGate";
import { AdminPanel } from "@/components/AdminPanel";
import { Field } from "@/components/Field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { bumpCredentialGeneration, CREDENTIAL_LOST_EVENT } from "@/lib/credential";
import { HouseholdSettingsProvider } from "@/lib/householdSettings";
import { LanguageProvider } from "@/i18n";
import { messages, resolveLang, type Language, type MessageKey } from "@/i18n/messages";
import { PrinterSessionProvider } from "@/printing/PrinterSession";
import { PluginCatalogProvider } from "@/plugins/PluginCatalogProvider";
import { PluginContribution } from "@/plugins/contributions";
import { HouseholdChrome, UnknownFamilyRoute } from "./HouseholdChrome";
import { resolveHouseholdRoute } from "./routes";
import { log } from "@/lib/logger";

/** Kiosk shell: renders nothing until the device is provisioned.
 * Provisioned state is determined from the presence of the device credential —
 * the non-HttpOnly `mp_provisioned` marker cookie the server sets at provision
 * time (FR-031 / ADR-059) — NOT by probing an authenticated settings endpoint.
 * The pre-provisioning screen therefore renders from browser defaults with no
 * `/api` call. When unprovisioned, the provisioning gate renders (fail-closed).
 * FR-013 (stale marker recovery): the marker can outlive the real device
 * credential if it is revoked/expires server-side. Rather than re-probing on
 * boot (which would violate FR-031/ADR-059), the shell listens for
 * `CREDENTIAL_LOST_EVENT` — dispatched by `authFetch` (`@/lib/credential`)
 * whenever ANY authenticated call 401/403s — and falls back to the
 * provisioning gate immediately, without waiting for a manual refresh.
 * US0 shell hoist: immediately after the
 * `ready` gate, the ENTIRE branch chain below is wrapped in
 * `HouseholdSettingsProvider` -> `LanguageProvider` -> `ShellServices` — one
 * always-mounted node above every route (family surfaces, admin, default
 * alike), in household language, with zero pre-gate network probe (the
 * provisioning early-return above still runs first). The four per-branch
 * `LanguageProvider` wrappers this replaced are gone; `AdminGate`'s own
 * post-unlock `LanguageProvider` is untouched — nested under the hoisted one,
 * it now consumes the parent settings context instead of a second fetch
 * (`@/i18n` D3).
 */

/** True when the device-provisioned marker cookie is present (FR-031). */
function hasProvisionedMarker(): boolean {
  return document.cookie.split(";").some((c) => c.trim().startsWith("mp_provisioned="));
}

/** ShellServices — the US0 hoist's always-mounted headless-runtime-service
 * point (Constitution XIII front-loaded assembly seam). Rendered
 * inside the hoisted `LanguageProvider`, above the per-route branch chain, so
 * anything registered here is present on every route the shell can show —
 * `KIOSK-SHELL-NAVIGATION-AC-07` (announcements half). `children` is the
 * resolved route content (pass-through, unchanged). `registerShellService` is
 * the extensibility seam a headless service — the time-announcements
 * scheduler, — mounts through in a later without a further
 * Shell.tsx edit; this module proves the seam with a jsdom probe
 * (`tests/client/shell-service-mount.test.tsx`) before any real service
 * exists. Registered entries are COMPONENT TYPES, rendered via `<Service />`
 * JSX (never called as a bare function) — each gets its own Fiber, so hooks
 * used inside one registered service stay isolated from its neighbors and
 * from `ShellServices` itself, per React's rules of hooks.
 */
interface ShellServiceRegistration {
  Service: ComponentType;
  plugin?: {
    id: "time-announcements";
    contributionId: "time-announcements-speaker";
  };
}

export type ShellServicePluginContribution = NonNullable<ShellServiceRegistration["plugin"]>;

const shellServiceRegistry = new Map<ComponentType, ShellServiceRegistration>();

/** Register an always-mounted headless service component to render inside `ShellServices`. Returns an unregister function. */
export function registerShellService(
  Service: ComponentType,
  plugin?: ShellServicePluginContribution
): () => void {
  shellServiceRegistry.set(Service, {
    Service,
    plugin:
      (plugin ?? Service.name === "AnnouncementService")
        ? {
            id: "time-announcements",
            contributionId: "time-announcements-speaker",
          }
        : undefined,
  });
  return () => {
    shellServiceRegistry.delete(Service);
  };
}

function ShellServices({ children }: { children: ReactNode }) {
  return (
    <>
      {Array.from(shellServiceRegistry.values()).map(({ Service, plugin }, index) =>
        plugin ? (
          <PluginContribution
            key={`${plugin.id}:${plugin.contributionId}`}
            pluginId={plugin.id}
            group="services"
            contributionId={plugin.contributionId}
          >
            <Service />
          </PluginContribution>
        ) : (
          <Service key={index} />
        )
      )}
      {children}
    </>
  );
}

export function Shell() {
  const [ready, setReady] = useState<boolean>(false);
  // Localized failure/retry copy uses only status and Retry-After, never raw error details.
  const [error, setError] = useState(false);
  const [retryAfter, setRetryAfter] = useState<number | null>();
  const [provisioning, setProvisioning] = useState(false);
  // Determine current path for SPA routing (no router - parse appPathname())
  const [currentPath, setCurrentPath] = useState<string>(appPathname());

  useEffect(() => {
    // FR-031 / ADR-059: provisioned state comes from the device-credential
    // marker cookie, not an authenticated settings probe. No /api call here.
    setReady(hasProvisionedMarker());
  }, []);

  useEffect(() => {
    // FR-013: any authenticated call rejected with 401/403 means the device
    // credential behind the marker is gone (revoked/expired) — fall back to
    // the provisioning gate. `authFetch` has already cleared the marker
    // cookie by the time this fires; the `refresh` fallback (hasProvisionedMarker
    // above) is what handles the case the tab was reloaded instead.
    const handleCredentialLost = () => setReady(false);
    window.addEventListener(CREDENTIAL_LOST_EVENT, handleCredentialLost);
    return () => window.removeEventListener(CREDENTIAL_LOST_EVENT, handleCredentialLost);
  }, []);

  // Handle URL navigation changes for SPA routing
  useEffect(() => {
    const handlePopState = () => setCurrentPath(appPathname());
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  /** Call POST /api/auth/provision with the bootstrap key header.
   * On 200 (body: `{ "provisioned": true }`), mark the cold-read as stale
   * and re-fetch `/api/settings` so the shell reflects the just-provisioned
   * status immediately (ignores any stale pre-provisioning response).
   * See `contracts/openapi.yaml` — `POST /api/auth/provision`.
   */
  const handleProvision = (bootstrapKey: string) => {
    setProvisioning(true);
    setError(false);
    setRetryAfter(undefined);

    fetch(appUrl("/api/auth/provision"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bootstrapKey}`,
      },
    })
      .then((res) => {
        if (res.status === 429) {
          const header = res.headers.get("Retry-After");
          const seconds = header && /^\d+$/.test(header) ? Number(header) : NaN;
          setRetryAfter(Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null);
        }
        if (!res.ok) throw new Error(`Provisioning failed: ${res.status}`);
        return res.json();
      })
      .then(() => {
        // Provision succeeded → the server set the device cookie + the
        // mp_provisioned marker; render the shell. No settings probe needed.
        // Bump the credential generation FIRST (FR-013 race guard): any
        // stale request still in flight under the OLD device key that
        // resolves 401/403 after this point must be ignored, not bounce the
        // freshly-provisioned user back to the gate.
        bumpCredentialGeneration();
        setReady(true);
      })
      .catch((err: unknown) => {
        // The specific detail (a bad status, a thrown network error) is developer-facing
        // diagnostic text (FR-019) — never surfaced to the family; the boolean flag drives the
        // localized, friendly error copy in `ProvisioningScreen`. But DISCARDING it entirely
        // would leave a failed provision with no diagnostic trace anywhere on a kiosk device.
        // INV-12 constrains the family-facing screen, not diagnostics — and the client logger is
        // strictly better than the console here: it feeds telemetry, so a device that will not
        // provision is debuggable from the admin panel rather than only with a laptop plugged
        // into the kiosk. (It also never throws into this catch.)
        log("error", "shell", "provisioning_failed", {
          detail: err instanceof Error ? err.message : String(err),
        });
        setError(true);
      })
      .finally(() => {
        setProvisioning(false);
      });
  };

  if (!ready) {
    return (
      <ProvisioningScreen
        onProvision={handleProvision}
        provisioning={provisioning}
        error={error}
        retryAfter={retryAfter}
      />
    );
  }

  // Provisioned only (fail-closed, FR-031/ADR-059): route content renders
  // AFTER the provisioning gate above, so an unprovisioned device can never
  // bypass the ProvisioningScreen by navigating directly to a route.
  return (
    <HouseholdSettingsProvider>
      <LanguageProvider>
        <PluginCatalogProvider>
          <ProvisionedShell currentPath={currentPath} />
        </PluginCatalogProvider>
      </LanguageProvider>
    </HouseholdSettingsProvider>
  );
}

function ProvisionedShell({ currentPath }: { currentPath: string }) {
  const route = resolveHouseholdRoute(currentPath);
  const routeContent =
    route.kind === "unknown-family" ? (
      <UnknownFamilyRoute />
    ) : route.kind === "family" ? (
      "pluginId" in route ? (
        <PluginContribution
          pluginId={route.pluginId}
          group={route.contributionGroup}
          contributionId={route.contributionId}
          direct
        >
          <route.Component />
        </PluginContribution>
      ) : (
        <route.Component />
      )
    ) : (
      // This branch is the protected admin subtree (known and unknown destinations).
      // AdminUnlockRouteReset clears its in-memory unlock state when this branch is left.
      <AdminGate />
    );

  const chrome = (
    <HouseholdChrome currentPath={currentPath} showWeather={route.kind === "family"}>
      {routeContent}
    </HouseholdChrome>
  );

  const printingScopedChrome = (
    <PluginContribution
      pluginId="printing"
      group="services"
      contributionId="printing-executor"
      withdrawnFallback={chrome}
      errorFallback={chrome}
    >
      <PrinterSessionProvider>{chrome}</PrinterSessionProvider>
    </PluginContribution>
  );

  return (
    <AdminUnlockProvider>
      <AdminUnlockRouteReset active={route.kind === "admin"} />
      <ShellServices>{printingScopedChrome}</ShellServices>
    </AdminUnlockProvider>
  );
}

function AdminUnlockRouteReset({ active }: { active: boolean }) {
  const { setUnlocked } = useAdminUnlock();
  useEffect(() => {
    if (!active) setUnlocked(false);
  }, [active, setUnlocked]);
  return null;
}

/** Resolves the pre-provisioning screen's display language from the BROWSER'S OWN language
 * setting — never from `/api/settings` (FR-019/ADR-031). ADR-031: "The
 * pre-provisioning connection-setup screen renders using the browser's language and a default
 * timezone, converging to household settings once the device is provisioned and holds a key."
 * There is no household to read a language FROM yet — the device has no credential, and FR-031/
 * ADR-059 forbid an authenticated `/api/settings` probe before one exists. This is the same
 * no-boot-probe boundary `AdminGate.tsx` documents for its own pre-unlock chrome (ADR-061), one
 * step earlier in the device's lifecycle: no `LanguageProvider` mounts here at all.
 */
function resolveProvisioningLanguage(): Language {
  const raw = typeof navigator !== "undefined" ? navigator.language : undefined;
  // Lowercased defensively: BCP 47 primary subtags are conventionally lowercase and browsers
  // emit them that way, but resolveLang is case-sensitive and "ES" would silently fall back to
  // English — a wrong-language kiosk with no error anywhere.
  return resolveLang(raw ? raw.split("-")[0].toLowerCase() : undefined);
}

/** In-screen provisioning action (FR-013, FR-019).
 * Renders the access-gate + provisioning UI when the device is not yet
 * provisioned. The user supplies a bootstrap key and clicks "Provision"
 * which calls `POST /api/auth/provision` (per openapi.yaml).
 * On success (200 body `{ "provisioned": true }`) the Shell transitions
 * to the provisioned state and renders children.
 * (token dialect): adopts `AdminPanel` (region + heading landmark,
 * `headingLevel="h1"` — this component IS the page-level surface, same choice
 * `ChoresBoard`/`MealsBoard` make for their own `<h1>`, per `AdminPanel`'s own doc), `Field`
 * (label/input/error association + the `ErrorNotice` live region it owns internally, SC-011) and
 * the density-token `Button`/`Input` primitives — replacing every hand-rolled inline
 * `style={{...}}` and hex/named colour literal the previous version carried.
 */
interface ProvisioningScreenProps {
  onProvision: (key: string) => void;
  provisioning: boolean;
  /** Whether the last provision attempt failed. Deliberately a boolean, not the raw fetch/Error
   * detail (FR-019 / I18N-LOCALIZATION-INV-12: developer-facing diagnostic text stays English
   * always and is therefore never surfaced on this family-facing screen). Retry information
   * comes only from the separate Retry-After value below.
   */
  error: boolean;
  /** Undefined for ordinary failures; null when 429 carries no usable delay. No automatic retry. */
  retryAfter?: number | null;
}

function ProvisioningScreen({
  onProvision,
  provisioning,
  error,
  retryAfter,
}: ProvisioningScreenProps) {
  const [key, setKey] = useState("");
  const language = resolveProvisioningLanguage();
  const t = (messageKey: MessageKey): string =>
    messages[language][messageKey] ?? messages.en[messageKey];

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!key.trim()) return;
    onProvision(key.trim());
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-8">
      <AdminPanel
        headingLevel="h1"
        title={t("provisioning.gate.title")}
        description={t("provisioning.gate.description")}
        className="w-full max-w-[360px]"
        data-testid="provisioning-gate-panel"
      >
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <Field
            label={t("provisioning.gate.bootstrapKeyLabel")}
            error={
              error
                ? retryAfter === undefined
                  ? t("provisioning.gate.error")
                  : retryAfter === null
                    ? t("provisioning.gate.throttled")
                    : t("provisioning.gate.retryAfter").replace("{seconds}", String(retryAfter))
                : null
            }
          >
            <Input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={t("provisioning.gate.bootstrapKeyPlaceholder")}
              autoComplete="off"
              autoFocus
              data-testid="provisioning-gate-input"
            />
          </Field>
          <Button
            type="submit"
            disabled={provisioning || !key.trim()}
            data-testid="provisioning-gate-submit"
          >
            {provisioning ? t("provisioning.gate.submitting") : t("provisioning.gate.submit")}
          </Button>
        </form>
      </AdminPanel>
    </div>
  );
}

export { ProvisioningScreen };
