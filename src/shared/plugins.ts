export const PLUGIN_IDS = Object.freeze([
  "daily-briefing",
  "printing",
  "weather",
  "time-announcements",
  "backups",
  "network-devices",
  "meals-recipes",
  "reminders",
  "daily-messages",
] as const);

export type PluginId = (typeof PLUGIN_IDS)[number];
export type PluginState = "active" | "inactive" | "errored";
export type PluginTargetState = "active" | "inactive";
export type PluginTrustTier = "first-party";
export type PluginLifecycleCapability = "activate" | "deactivate";
export type PluginSettingValueType = "string" | "number" | "boolean" | "enum" | "object";
export type PluginServiceRuntime = "server" | "browser";
export type PluginContentSourceId = "weather" | "weatherText" | "meals" | "reminders" | "message";
export type PluginJobId =
  | "daily-briefing.generate-all"
  | "daily-briefing.retry-15"
  | "daily-briefing.retry-30"
  | "daily-briefing.auto-print-sweep"
  | "backups.nightly"
  | "network-devices.poll";
export type PluginRequirementId =
  | "members"
  | "auth-sessions"
  | "app-settings"
  | "kiosk-shell"
  | "calendar-local"
  | "day-periods"
  | "routines-chores"
  | "i18n";

export type PluginPublicErrorCode =
  | "settings_initialization_failed"
  | "migration_failed"
  | "runtime_mount_failed"
  | "drain_failed"
  | "runtime_unmount_failed"
  | "contribution_failed"
  | "reconciliation_failed";

export interface PluginServiceContribution {
  readonly id: string;
  readonly runtime: PluginServiceRuntime;
}

export interface PluginContributionSummary {
  readonly routes: readonly string[];
  readonly admin: readonly string[];
  readonly settings: readonly string[];
  readonly widgets: readonly string[];
  readonly services: readonly string[];
  readonly jobs: readonly string[];
}

export interface PluginManifestContributionSummary extends Omit<
  PluginContributionSummary,
  "services" | "jobs"
> {
  readonly services: readonly PluginServiceContribution[];
  readonly contentSources: readonly PluginContentSourceId[];
  readonly jobs: readonly PluginJobId[];
}

export interface PluginSettingDescriptor {
  readonly key: string;
  readonly label: string;
  readonly valueType: PluginSettingValueType;
  readonly required: boolean;
  readonly sensitive: boolean;
}

export interface PluginManifest {
  readonly id: PluginId;
  readonly labelKey: string;
  readonly descriptionKey: string;
  readonly trustTier: PluginTrustTier;
  readonly contributions: PluginManifestContributionSummary;
  readonly requirements: readonly PluginRequirementId[];
  readonly settingsSchema: readonly PluginSettingDescriptor[];
  readonly dataNamespace: string;
  readonly runtimeAdapterKey: PluginId;
  readonly adr029Classification: "plugin";
  readonly lifecycleCapabilities: readonly PluginLifecycleCapability[];
}

export interface PluginOperationView {
  readonly targetState: PluginTargetState;
  readonly startedAt: string;
}

export interface PluginHealth {
  readonly status: "healthy" | "attention";
  readonly code: PluginPublicErrorCode | null;
}

export interface PluginPublicError {
  readonly code: PluginPublicErrorCode;
  readonly message:
    | "Plugin settings could not be prepared."
    | "Plugin data could not be prepared."
    | "Plugin services could not be started."
    | "Plugin work could not stop safely."
    | "Plugin services could not be stopped."
    | "A plugin contribution failed."
    | "Plugin recovery requires attention.";
}

export interface PluginCatalogEntry {
  readonly id: PluginId;
  readonly label: string;
  readonly description: string;
  readonly trustTier: PluginTrustTier;
  readonly contributions: PluginContributionSummary;
  readonly requirements: readonly string[];
  readonly settingsSchema: readonly PluginSettingDescriptor[];
  readonly state: PluginState;
  readonly operation: PluginOperationView | null;
  readonly health: PluginHealth;
  readonly updatedAt: string;
  readonly error: PluginPublicError | null;
}
