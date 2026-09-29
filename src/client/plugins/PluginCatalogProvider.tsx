import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { authFetch } from "@/lib/credential";
import { PLUGIN_IDS, type PluginCatalogEntry, type PluginId } from "../../shared/plugins";

type CatalogStatus = "loading" | "ready" | "error";

export type PluginCatalogFeedbackCode =
  "plugin_lifecycle_busy" | "plugin_lifecycle_failed" | "plugin_catalog_unavailable";

interface PluginCatalogContextValue {
  status: CatalogStatus;
  plugins: readonly PluginCatalogEntry[];
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

  const reload = useCallback(async () => {
    setStatus("loading");
    try {
      const result = await authFetch("/api/plugins", { credentials: "include" });
      if (!result.ok) throw new Error("catalog unavailable");
      const catalog = parseCatalog(await result.json());
      if (catalog === null) throw new Error("invalid catalog");
      setPlugins(catalog);
      setStatus("ready");
    } catch {
      setPlugins([]);
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

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
      feedback,
      pendingActionFocus,
      clearPendingActionFocus,
      transition,
      reportFault,
      reload,
    }),
    [
      clearPendingActionFocus,
      feedback,
      pendingActionFocus,
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
