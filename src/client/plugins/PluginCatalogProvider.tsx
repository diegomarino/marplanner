import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { authFetch } from "@/lib/credential";
import { log } from "@/lib/logger";
import { PLUGIN_IDS, type PluginCatalogEntry, type PluginId } from "../../shared/plugins";

type CatalogStatus = "loading" | "ready" | "error";

export type PluginCatalogFeedbackCode =
  "plugin_lifecycle_busy" | "plugin_lifecycle_failed" | "plugin_catalog_unavailable";

interface PluginCatalogContextValue {
  /**
   * `ready` once any catalog has loaded; it stays `ready` (with the last good catalog) when a
   * later refresh fails. `error` means no catalog has ever loaded.
   */
  status: CatalogStatus;
  plugins: readonly PluginCatalogEntry[];
  /** The most recent fetch failed; an automatic retry is scheduled. */
  failed: boolean;
  /** A catalog fetch is in flight. */
  refreshing: boolean;
  feedback: Readonly<Partial<Record<PluginId, PluginCatalogFeedbackCode>>>;
  pendingActionFocus: PluginId | null;
  clearPendingActionFocus(pluginId: PluginId): void;
  transition(pluginId: PluginId, target: "activate" | "deactivate"): Promise<void>;
  reportFault(
    pluginId: PluginId,
    code: "contribution_render_failed" | "contribution_start_failed"
  ): Promise<void>;
  reload(): Promise<void>;
}

/** Delays before each automatic retry after consecutive failures; the last one repeats. */
export const CATALOG_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 60_000] as const;

class CatalogFetchError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

const PluginCatalogContext = createContext<PluginCatalogContextValue | null>(null);
const EXPECTED_IDS = new Set<string>(PLUGIN_IDS);
const PUBLIC_ERRORS = {
  settings_initialization_failed: "Plugin settings could not be prepared.",
  migration_failed: "Plugin data could not be prepared.",
  runtime_mount_failed: "Plugin services could not be started.",
  drain_failed: "Plugin work could not stop safely.",
  runtime_unmount_failed: "Plugin services could not be stopped.",
  contribution_failed: "A plugin contribution failed.",
  reconciliation_failed: "Plugin recovery requires attention.",
} as const;
const PUBLIC_ERROR_CODES = new Set(Object.keys(PUBLIC_ERRORS));

function isSafePublicError(value: unknown): value is NonNullable<PluginCatalogEntry["error"]> {
  if (value === null || typeof value !== "object") return false;
  const error = value as { code?: unknown; message?: unknown };
  if (typeof error.code !== "string" || !PUBLIC_ERROR_CODES.has(error.code)) return false;
  return error.message === PUBLIC_ERRORS[error.code as keyof typeof PUBLIC_ERRORS];
}

function isCatalogEntry(value: unknown): value is PluginCatalogEntry {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<PluginCatalogEntry>;
  const safeError = candidate.error === null || isSafePublicError(candidate.error);
  return (
    typeof candidate.id === "string" &&
    EXPECTED_IDS.has(candidate.id) &&
    (candidate.state === "active" ||
      candidate.state === "inactive" ||
      candidate.state === "errored") &&
    candidate.trustTier === "first-party" &&
    candidate.contributions !== null &&
    typeof candidate.contributions === "object" &&
    Array.isArray(candidate.requirements) &&
    Array.isArray(candidate.settingsSchema) &&
    safeError
  );
}

function parseCatalog(value: unknown): readonly PluginCatalogEntry[] | null {
  if (value === null || typeof value !== "object") return null;
  const plugins = (value as { plugins?: unknown }).plugins;
  if (
    !Array.isArray(plugins) ||
    plugins.length !== PLUGIN_IDS.length ||
    !plugins.every(isCatalogEntry)
  ) {
    return null;
  }
  if (plugins.some((plugin, index) => plugin.id !== PLUGIN_IDS[index])) return null;
  return plugins;
}

function replacePlugin(
  plugins: readonly PluginCatalogEntry[],
  replacement: PluginCatalogEntry
): readonly PluginCatalogEntry[] {
  return plugins.map((plugin) => (plugin.id === replacement.id ? replacement : plugin));
}

function feedbackCode(status: number, value: unknown): PluginCatalogFeedbackCode {
  if (
    status === 409 &&
    value !== null &&
    typeof value === "object" &&
    (value as { code?: unknown }).code === "plugin_lifecycle_busy"
  ) {
    return "plugin_lifecycle_busy";
  }
  return status === 503 ? "plugin_lifecycle_failed" : "plugin_catalog_unavailable";
}

export function PluginCatalogProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<CatalogStatus>("loading");
  const [plugins, setPlugins] = useState<readonly PluginCatalogEntry[]>([]);
  const [feedback, setFeedback] = useState<
    Readonly<Partial<Record<PluginId, PluginCatalogFeedbackCode>>>
  >({});
  const [pendingActionFocus, setPendingActionFocus] = useState<PluginId | null>(null);

  const clearPendingActionFocus = useCallback((pluginId: PluginId) => {
    setPendingActionFocus((current) => (current === pluginId ? null : current));
  }, []);

  const [failures, setFailures] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const hasCatalog = useRef(false);
  const failureStreak = useRef(0);
  const latestRequest = useRef(0);
  const inflight = useRef(0);

  const reload = useCallback(async () => {
    const request = ++latestRequest.current;
    inflight.current += 1;
    setRefreshing(true);
    try {
      const result = await authFetch("/api/plugins", { credentials: "include" });
      if (!result.ok) throw new CatalogFetchError(`http_${result.status}`);
      const catalog = parseCatalog(await result.json().catch(() => null));
      if (catalog === null) throw new CatalogFetchError("invalid_catalog");
      // A newer request (for example after a lifecycle action) owns the catalog.
      if (request !== latestRequest.current) return;
      hasCatalog.current = true;
      failureStreak.current = 0;
      setPlugins(catalog);
      setStatus("ready");
      setFailures(0);
    } catch (error) {
      if (request !== latestRequest.current) return;
      // One entry per outage: automatic retries of the same outage stay quiet.
      if (failureStreak.current === 0) {
        log("error", "plugin-catalog", "plugin catalog unavailable", {
          reason: error instanceof CatalogFetchError ? error.reason : "network_error",
        });
      }
      failureStreak.current += 1;
      setFailures(failureStreak.current);
      // Keep the last good catalog: replacing it would hide every plugin entry.
      if (!hasCatalog.current) setStatus("error");
    } finally {
      inflight.current -= 1;
      if (inflight.current === 0) setRefreshing(false);
    }
  }, []);

  /** Background refresh: skipped while another fetch is already in flight. */
  const refresh = useCallback(() => {
    if (inflight.current > 0) return;
    void reload();
  }, [reload]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Lifecycle changes made in another tab, device or API client arrive when this tab returns.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refresh]);

  useEffect(() => {
    if (failures === 0) return;
    const delay = CATALOG_RETRY_DELAYS_MS[Math.min(failures, CATALOG_RETRY_DELAYS_MS.length) - 1];
    const timer = window.setTimeout(refresh, delay);
    return () => window.clearTimeout(timer);
  }, [failures, refresh]);

  const transition = useCallback(
    async (pluginId: PluginId, target: "activate" | "deactivate") => {
      setPendingActionFocus(pluginId);
      setFeedback((current) => ({ ...current, [pluginId]: undefined }));
      setPlugins((current) =>
        current.map((plugin) =>
          plugin.id === pluginId
            ? {
                ...plugin,
                operation: {
                  targetState: target === "activate" ? "active" : "inactive",
                  startedAt: plugin.updatedAt,
                },
              }
            : plugin
        )
      );

      try {
        const result = await authFetch(`/api/plugins/${pluginId}/${target}`, {
          method: "POST",
          credentials: "include",
        });
        const body = (await result.json()) as unknown;
        const returnedPlugin =
          body !== null && typeof body === "object" && "plugin" in body
            ? (body as { plugin: unknown }).plugin
            : body;
        if (isCatalogEntry(returnedPlugin)) {
          setPlugins((current) => replacePlugin(current, returnedPlugin));
        }
        if (!result.ok) {
          setFeedback((current) => ({
            ...current,
            [pluginId]: feedbackCode(result.status, body),
          }));
        }
      } catch {
        setFeedback((current) => ({ ...current, [pluginId]: "plugin_catalog_unavailable" }));
        await reload();
      }
    },
    [reload]
  );

  const reportFault = useCallback(
    async (
      pluginId: PluginId,
      code: "contribution_render_failed" | "contribution_start_failed"
    ) => {
      if (code !== "contribution_render_failed" && code !== "contribution_start_failed") return;
      try {
        const result = await authFetch(`/api/plugins/${pluginId}/fault`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code }),
        });
        const body = (await result.json().catch(() => null)) as unknown;
        const returnedPlugin =
          body !== null && typeof body === "object" && "plugin" in body
            ? (body as { plugin: unknown }).plugin
            : body;
        if (isCatalogEntry(returnedPlugin)) {
          setPlugins((current) => replacePlugin(current, returnedPlugin));
        } else if (result.ok) {
          await reload();
        } else if (!result.ok) {
          await reload();
        }
      } catch {
        await reload();
      }
    },
    [reload]
  );

  const value = useMemo(
    () => ({
      status,
      plugins,
      failed: failures > 0,
      refreshing,
      feedback,
      pendingActionFocus,
      clearPendingActionFocus,
      transition,
      reportFault,
      reload,
    }),
    [
      clearPendingActionFocus,
      failures,
      feedback,
      pendingActionFocus,
      refreshing,
      plugins,
      reload,
      reportFault,
      status,
      transition,
    ]
  );

  return <PluginCatalogContext.Provider value={value}>{children}</PluginCatalogContext.Provider>;
}

export function usePluginCatalog(): PluginCatalogContextValue {
  const value = useContext(PluginCatalogContext);
  if (value === null) throw new Error("usePluginCatalog must be used inside PluginCatalogProvider");
  return value;
}

export function useOptionalPluginCatalog(): PluginCatalogContextValue | null {
  return useContext(PluginCatalogContext);
}
