import type {
  PluginContentSourceId,
  PluginContributionSummary,
  PluginJobId,
  PluginLifecycleCapability,
  PluginManifest,
  PluginManifestContributionSummary,
  PluginSettingDescriptor,
} from "../../shared/plugins.js";

const CONTENT_SOURCE_PUBLIC_SERVICE_IDS = {
  weather: "weather",
  weatherText: "weather-text",
  meals: "meals",
  reminders: "reminders",
  message: "message",
} as const satisfies Record<PluginContentSourceId, string>;

const JOB_PUBLIC_IDS = {
  "daily-briefing.generate-all": "daily-briefing-generate-all",
  "daily-briefing.retry-15": "daily-briefing-retry-15",
  "daily-briefing.retry-30": "daily-briefing-retry-30",
  "daily-briefing.auto-print-sweep": "daily-briefing-auto-print-sweep",
  "backups.nightly": "backups-nightly",
  "network-devices.poll": "network-devices-poll",
} as const satisfies Record<PluginJobId, string>;

const LIFECYCLE_CAPABILITIES = Object.freeze([
  "activate",
  "deactivate",
] as const satisfies readonly PluginLifecycleCapability[]);

function freezeManifest(manifest: PluginManifest): PluginManifest {
  for (const service of manifest.contributions.services) {
    Object.freeze(service);
  }
  for (const contributionIds of Object.values(manifest.contributions)) {
    Object.freeze(contributionIds);
  }
  Object.freeze(manifest.contributions);
  for (const descriptor of manifest.settingsSchema) {
    Object.freeze(descriptor);
  }
  Object.freeze(manifest.requirements);
  Object.freeze(manifest.settingsSchema);
  return Object.freeze(manifest);
}

function contributions(
  value: PluginManifestContributionSummary
): PluginManifestContributionSummary {
  return value;
}

function settingsSchema(
  value: readonly PluginSettingDescriptor[]
): readonly PluginSettingDescriptor[] {
  return value;
}

export function projectManifestContributions(
  value: PluginManifestContributionSummary
): PluginContributionSummary {
  return {
    routes: value.routes,
    admin: value.admin,
    settings: value.settings,
    widgets: value.widgets,
    services: [
      ...value.services.map(({ id }) => id),
      ...value.contentSources.map((id) => CONTENT_SOURCE_PUBLIC_SERVICE_IDS[id]),
    ],
    jobs: value.jobs.map((id) => JOB_PUBLIC_IDS[id]),
  };
}

export const PLUGIN_MANIFESTS: readonly PluginManifest[] = Object.freeze([
  freezeManifest({
    id: "daily-briefing",
    labelKey: "plugins.dailyBriefing.label",
    descriptionKey: "plugins.dailyBriefing.description",
    trustTier: "first-party",
    contributions: contributions({
      routes: ["daily-briefing-api"],
      admin: ["daily-briefing"],
      settings: ["daily-briefing-settings"],
      widgets: [],
      services: [{ id: "daily-briefing-generator", runtime: "server" }],
      contentSources: [],
      jobs: [
        "daily-briefing.generate-all",
        "daily-briefing.retry-15",
        "daily-briefing.retry-30",
        "daily-briefing.auto-print-sweep",
      ],
    }),
    requirements: ["members", "app-settings", "calendar-local", "day-periods", "routines-chores"],
    settingsSchema: settingsSchema([
      {
        key: "dailyBriefingGenerationTime",
        label: "dailyBriefing.admin.generationTimeLabel",
        valueType: "string",
        required: true,
        sensitive: false,
      },
      {
        key: "dailyBriefingAutoPrintTrigger",
        label: "dailyBriefing.admin.triggerBindingLabel",
        valueType: "enum",
        required: false,
        sensitive: false,
      },
    ]),
    dataNamespace: "daily_briefing",
    runtimeAdapterKey: "daily-briefing",
    adr029Classification: "plugin",
    lifecycleCapabilities: LIFECYCLE_CAPABILITIES,
  }),
  freezeManifest({
    id: "printing",
    labelKey: "plugins.printing.label",
    descriptionKey: "plugins.printing.description",
    trustTier: "first-party",
    contributions: contributions({
      routes: ["printing-api"],
      admin: ["printing"],
      settings: [],
      widgets: ["printer-attention"],
      services: [
        { id: "printing-queue", runtime: "server" },
        { id: "printing-executor", runtime: "browser" },
      ],
      contentSources: [],
      jobs: [],
    }),
    requirements: ["auth-sessions", "app-settings", "kiosk-shell"],
    settingsSchema: settingsSchema([]),
    dataNamespace: "printing",
    runtimeAdapterKey: "printing",
    adr029Classification: "plugin",
    lifecycleCapabilities: LIFECYCLE_CAPABILITIES,
  }),
  freezeManifest({
    id: "weather",
    labelKey: "plugins.weather.label",
    descriptionKey: "plugins.weather.description",
    trustTier: "first-party",
    contributions: contributions({
      routes: ["weather-api"],
      admin: ["weather"],
      settings: ["weather-settings"],
      widgets: ["weather-pill"],
      services: [{ id: "weather-forecast-provider", runtime: "server" }],
      contentSources: ["weather", "weatherText"],
      jobs: [],
    }),
    requirements: ["app-settings"],
    settingsSchema: settingsSchema([
      {
        key: "weatherLat",
        label: "weather.management.latLabel",
        valueType: "number",
        required: false,
        sensitive: true,
      },
      {
        key: "weatherLon",
        label: "weather.management.lonLabel",
        valueType: "number",
        required: false,
        sensitive: true,
      },
      {
        key: "weatherLabel",
        label: "weather.management.labelLabel",
        valueType: "string",
        required: false,
        sensitive: true,
      },
    ]),
    dataNamespace: "weather",
    runtimeAdapterKey: "weather",
    adr029Classification: "plugin",
    lifecycleCapabilities: LIFECYCLE_CAPABILITIES,
  }),
  freezeManifest({
    id: "time-announcements",
    labelKey: "plugins.timeAnnouncements.label",
    descriptionKey: "plugins.timeAnnouncements.description",
    trustTier: "first-party",
    contributions: contributions({
      routes: ["time-announcements-api"],
      admin: ["time-announcements"],
      settings: [],
      widgets: [],
      services: [{ id: "time-announcements-speaker", runtime: "browser" }],
      contentSources: [],
      jobs: [],
    }),
    requirements: ["app-settings", "kiosk-shell"],
    settingsSchema: settingsSchema([]),
    dataNamespace: "time_announcements",
    runtimeAdapterKey: "time-announcements",
    adr029Classification: "plugin",
    lifecycleCapabilities: LIFECYCLE_CAPABILITIES,
  }),
  freezeManifest({
    id: "backups",
    labelKey: "plugins.backups.label",
    descriptionKey: "plugins.backups.description",
    trustTier: "first-party",
    contributions: contributions({
      routes: ["backups-api"],
      admin: ["backups"],
      settings: [],
      widgets: [],
      services: [],
      contentSources: [],
      jobs: ["backups.nightly"],
    }),
    requirements: ["auth-sessions", "app-settings"],
    settingsSchema: settingsSchema([]),
    dataNamespace: "backups",
    runtimeAdapterKey: "backups",
    adr029Classification: "plugin",
    lifecycleCapabilities: LIFECYCLE_CAPABILITIES,
  }),
  freezeManifest({
    id: "network-devices",
    labelKey: "plugins.networkDevices.label",
    descriptionKey: "plugins.networkDevices.description",
    trustTier: "first-party",
    contributions: contributions({
      routes: ["network-devices-api"],
      admin: ["network-devices"],
      settings: [],
      widgets: [],
      services: [{ id: "network-devices-controller", runtime: "server" }],
      contentSources: [],
      jobs: ["network-devices.poll"],
    }),
    requirements: ["members"],
    settingsSchema: settingsSchema([]),
    dataNamespace: "network_devices",
    runtimeAdapterKey: "network-devices",
    adr029Classification: "plugin",
    lifecycleCapabilities: LIFECYCLE_CAPABILITIES,
  }),
  freezeManifest({
    id: "meals-recipes",
    labelKey: "plugins.mealsRecipes.label",
    descriptionKey: "plugins.mealsRecipes.description",
    trustTier: "first-party",
    contributions: contributions({
      routes: ["meals-recipes-api"],
      admin: ["meals"],
      settings: [],
      widgets: ["today-meals"],
      services: [],
      contentSources: ["meals"],
      jobs: [],
    }),
    requirements: ["members", "app-settings"],
    settingsSchema: settingsSchema([]),
    dataNamespace: "meals_recipes",
    runtimeAdapterKey: "meals-recipes",
    adr029Classification: "plugin",
    lifecycleCapabilities: LIFECYCLE_CAPABILITIES,
  }),
  freezeManifest({
    id: "reminders",
    labelKey: "plugins.reminders.label",
    descriptionKey: "plugins.reminders.description",
    trustTier: "first-party",
    contributions: contributions({
      routes: ["reminders-api"],
      admin: ["reminders"],
      settings: [],
      widgets: [],
      services: [],
      contentSources: ["reminders"],
      jobs: [],
    }),
    requirements: ["members", "calendar-local", "app-settings"],
    settingsSchema: settingsSchema([]),
    dataNamespace: "reminders",
    runtimeAdapterKey: "reminders",
    adr029Classification: "plugin",
    lifecycleCapabilities: LIFECYCLE_CAPABILITIES,
  }),
  freezeManifest({
    id: "daily-messages",
    labelKey: "plugins.dailyMessages.label",
    descriptionKey: "plugins.dailyMessages.description",
    trustTier: "first-party",
    contributions: contributions({
      routes: ["daily-messages-api"],
      admin: ["daily-messages"],
      settings: [],
      widgets: [],
      services: [],
      contentSources: ["message"],
      jobs: [],
    }),
    requirements: ["members"],
    settingsSchema: settingsSchema([]),
    dataNamespace: "daily_messages",
    runtimeAdapterKey: "daily-messages",
    adr029Classification: "plugin",
    lifecycleCapabilities: LIFECYCLE_CAPABILITIES,
  }),
]);
