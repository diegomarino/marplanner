import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { messages } from "../../src/client/i18n/messages.js";
import * as pluginDtoModule from "../../src/shared/plugins.js";
import * as pluginManifestModule from "../../src/server/plugins/manifest.js";
import {
  DAILY_BRIEFING_JOB_ID,
  DAILY_BRIEFING_RETRY_15_JOB_ID,
  DAILY_BRIEFING_RETRY_30_JOB_ID,
} from "../../src/server/modules/daily-briefing/job.js";
import { AUTO_PRINT_SWEEP_JOB_ID } from "../../src/server/modules/daily-briefing/trigger.js";
import { BACKUPS_JOB_ID } from "../../src/server/backups/job.js";
import { NETWORK_DEVICES_POLL_JOB_ID } from "../../src/server/modules/network-devices/poll.js";

const { PLUGIN_IDS } = pluginDtoModule;
const { PLUGIN_MANIFESTS } = pluginManifestModule;

const ADR_029_CANDIDATES = [
  "members",
  "auth-sessions",
  "app-settings",
  "kiosk-shell",
  "calendar-local",
  "day-periods",
  "routines-chores",
  "i18n",
  "daily-briefing",
  "printing",
  "weather",
  "time-announcements",
  "backups",
  "network-devices",
  "meals-recipes",
  "reminders",
  "daily-messages",
  "external-calendar-sync",
] as const;

const CORE_CANDIDATES = [
  "members",
  "auth-sessions",
  "app-settings",
  "kiosk-shell",
  "calendar-local",
  "day-periods",
  "routines-chores",
  "i18n",
] as const;

const DELIVERED_PLUGIN_IDS = [
  "daily-briefing",
  "printing",
  "weather",
  "time-announcements",
  "backups",
  "network-devices",
  "meals-recipes",
  "reminders",
  "daily-messages",
] as const;

const EXPECTED_DECLARATIONS = {
  "daily-briefing": {
    contributions: {
      routes: ["daily-briefing-api"],
      admin: ["daily-briefing"],
      settings: ["daily-briefing-settings"],
      widgets: [],
      services: [{ id: "daily-briefing-generator", runtime: "server" }],
      contentSources: [],
      jobs: [
        DAILY_BRIEFING_JOB_ID,
        DAILY_BRIEFING_RETRY_15_JOB_ID,
        DAILY_BRIEFING_RETRY_30_JOB_ID,
        AUTO_PRINT_SWEEP_JOB_ID,
      ],
    },
    requirements: ["members", "app-settings", "calendar-local", "day-periods", "routines-chores"],
    settingsSchema: [
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
    ],
  },
  printing: {
    contributions: {
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
    },
    requirements: ["auth-sessions", "app-settings", "kiosk-shell"],
    settingsSchema: [],
  },
  weather: {
    contributions: {
      routes: ["weather-api"],
      admin: ["weather"],
      settings: ["weather-settings"],
      widgets: ["weather-pill"],
      services: [{ id: "weather-forecast-provider", runtime: "server" }],
      contentSources: ["weather", "weatherText"],
      jobs: [],
    },
    requirements: ["app-settings"],
    settingsSchema: [
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
    ],
  },
  "time-announcements": {
    contributions: {
      routes: ["time-announcements-api"],
      admin: ["time-announcements"],
      settings: [],
      widgets: [],
      services: [{ id: "time-announcements-speaker", runtime: "browser" }],
      contentSources: [],
      jobs: [],
    },
    requirements: ["app-settings", "kiosk-shell"],
    settingsSchema: [],
  },
  backups: {
    contributions: {
      routes: ["backups-api"],
      admin: ["backups"],
      settings: [],
      widgets: [],
      services: [],
      contentSources: [],
      jobs: [BACKUPS_JOB_ID],
    },
    requirements: ["auth-sessions", "app-settings"],
    settingsSchema: [],
  },
  "network-devices": {
    contributions: {
      routes: ["network-devices-api"],
      admin: ["network-devices"],
      settings: [],
      widgets: [],
      services: [{ id: "network-devices-controller", runtime: "server" }],
      contentSources: [],
      jobs: [NETWORK_DEVICES_POLL_JOB_ID],
    },
    requirements: ["members"],
    settingsSchema: [],
  },
  "meals-recipes": {
    contributions: {
      routes: ["meals-recipes-api"],
      admin: ["meals"],
      settings: [],
      widgets: ["today-meals"],
      services: [],
      contentSources: ["meals"],
      jobs: [],
    },
    requirements: ["members", "app-settings"],
    settingsSchema: [],
  },
  reminders: {
    contributions: {
      routes: ["reminders-api"],
      admin: ["reminders"],
      settings: [],
      widgets: [],
      services: [],
      contentSources: ["reminders"],
      jobs: [],
    },
    requirements: ["members", "calendar-local", "app-settings"],
    settingsSchema: [],
  },
  "daily-messages": {
    contributions: {
      routes: ["daily-messages-api"],
      admin: ["daily-messages"],
      settings: [],
      widgets: [],
      services: [],
      contentSources: ["message"],
      jobs: [],
    },
    requirements: ["members"],
    settingsSchema: [],
  },
} as const;

const PROHIBITED_API_SHAPES = [
  "install",
  "installPlugin",
  "uninstall",
  "uninstallPlugin",
  "upload",
  "uploadBundle",
  "marketplace",
  "marketplaceUrl",
  "loader",
  "loadPlugin",
  "dynamicLoading",
  "registerPlugin",
  "runtimeRegistration",
] as const;

const EXPECTED_SOURCE_EXPORTS = {
  "src/shared/plugins.ts": [
    "PLUGIN_IDS",
    "PluginCatalogEntry",
    "PluginContentSourceId",
    "PluginContributionSummary",
    "PluginHealth",
    "PluginId",
    "PluginJobId",
    "PluginLifecycleCapability",
    "PluginManifest",
    "PluginManifestContributionSummary",
    "PluginOperationView",
    "PluginPublicError",
    "PluginPublicErrorCode",
    "PluginRequirementId",
    "PluginServiceContribution",
    "PluginServiceRuntime",
    "PluginSettingDescriptor",
    "PluginSettingValueType",
    "PluginState",
    "PluginTargetState",
    "PluginTrustTier",
  ],
  "src/server/plugins/manifest.ts": ["PLUGIN_MANIFESTS", "projectManifestContributions"],
} as const;

const CONTENT_SOURCE_PUBLIC_IDS = {
  weather: "weather",
  weatherText: "weather-text",
  meals: "meals",
  reminders: "reminders",
  message: "message",
} as const;

const JOB_PUBLIC_IDS = {
  [DAILY_BRIEFING_JOB_ID]: "daily-briefing-generate-all",
  [DAILY_BRIEFING_RETRY_15_JOB_ID]: "daily-briefing-retry-15",
  [DAILY_BRIEFING_RETRY_30_JOB_ID]: "daily-briefing-retry-30",
  [AUTO_PRINT_SWEEP_JOB_ID]: "daily-briefing-auto-print-sweep",
  [BACKUPS_JOB_ID]: "backups-nightly",
  [NETWORK_DEVICES_POLL_JOB_ID]: "network-devices-poll",
} as const;

function isProhibitedApiName(name: string): boolean {
  const normalized = name.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return [
    "uninstall",
    "install",
    "upload",
    "marketplace",
    "dynamicload",
    "loader",
    "loadplugin",
    "register",
    "registration",
  ].some((token) => normalized.includes(token));
}

function collectExportedNames(sourceText: string): string[] {
  const source = ts.createSourceFile(
    "module.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const names = new Set<string>();

  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (!statement.exportClause) {
        names.add("*");
      } else if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          names.add(element.name.text);
          if (element.propertyName) names.add(element.propertyName.text);
        }
      } else {
        names.add("*");
        names.add(statement.exportClause.name.text);
      }
      continue;
    }

    if (ts.isExportAssignment(statement)) {
      names.add("default");
      if (ts.isIdentifier(statement.expression)) names.add(statement.expression.text);
      continue;
    }

    const isExported =
      ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (!isExported) continue;

    const isDefault =
      ts.canHaveModifiers(statement) &&
      ts
        .getModifiers(statement)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
    if (isDefault) names.add("default");

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
      }
      continue;
    }

    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name
    ) {
      names.add(statement.name.text);
    }
  }

  return [...names].sort();
}

describe("first-party plugin manifest inventory", () => {
  it("maps every ADR-029 candidate to the closed delivered cohort", () => {
    expect(ADR_029_CANDIDATES).toHaveLength(18);
    expect(new Set(ADR_029_CANDIDATES).size).toBe(18);
    expect([...CORE_CANDIDATES, ...DELIVERED_PLUGIN_IDS, "external-calendar-sync"].sort()).toEqual(
      [...ADR_029_CANDIDATES].sort()
    );
    expect(PLUGIN_IDS).toEqual(DELIVERED_PLUGIN_IDS);

    const manifestIds = PLUGIN_MANIFESTS.map(({ id }) => id);
    expect(manifestIds).toEqual(DELIVERED_PLUGIN_IDS);
    expect(new Set(manifestIds).size).toBe(manifestIds.length);
    expect(manifestIds).not.toContain("external-calendar-sync");
    for (const coreId of CORE_CANDIDATES) {
      expect(manifestIds).not.toContain(coreId);
    }
  });

  it("matches the canonical contribution, requirement, and settings matrix exactly", () => {
    expect(
      Object.fromEntries(
        PLUGIN_MANIFESTS.map((manifest) => [
          manifest.id,
          {
            contributions: manifest.contributions,
            requirements: manifest.requirements,
            settingsSchema: manifest.settingsSchema,
          },
        ])
      )
    ).toEqual(EXPECTED_DECLARATIONS);

    for (const manifest of PLUGIN_MANIFESTS) {
      expect(manifest.trustTier).toBe("first-party");
      expect(manifest.adr029Classification).toBe("plugin");
      expect(manifest.lifecycleCapabilities).toEqual(["activate", "deactivate"]);
      for (const descriptor of manifest.settingsSchema) {
        expect(descriptor.key).toMatch(/^[a-z][A-Za-z0-9]*$/);
        expect(Object.hasOwn(messages.en, descriptor.label), descriptor.label).toBe(true);
        expect(Object.hasOwn(messages.es, descriptor.label), descriptor.label).toBe(true);
      }
    }
  });

  it("projects every internal contribution exactly once into the closed public shape", () => {
    const project = Reflect.get(pluginManifestModule, "projectManifestContributions");
    expect(project).toBeTypeOf("function");
    if (typeof project !== "function") return;

    for (const manifest of PLUGIN_MANIFESTS) {
      const projected = project(manifest.contributions);
      expect(Object.keys(projected).sort()).toEqual([
        "admin",
        "jobs",
        "routes",
        "services",
        "settings",
        "widgets",
      ]);
      expect(projected).toEqual({
        routes: manifest.contributions.routes,
        admin: manifest.contributions.admin,
        settings: manifest.contributions.settings,
        widgets: manifest.contributions.widgets,
        services: [
          ...manifest.contributions.services.map(({ id }) => id),
          ...manifest.contributions.contentSources.map(
            (id) => CONTENT_SOURCE_PUBLIC_IDS[id as keyof typeof CONTENT_SOURCE_PUBLIC_IDS]
          ),
        ],
        jobs: manifest.contributions.jobs.map(
          (id) => JOB_PUBLIC_IDS[id as keyof typeof JOB_PUBLIC_IDS]
        ),
      });

      for (const contributionIds of Object.values(projected) as readonly (readonly string[])[]) {
        expect(contributionIds).toEqual([...new Set(contributionIds)]);
        for (const id of contributionIds) expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      }
    }
  });

  it("fails closed on the complete TypeScript export surface", () => {
    for (const shape of PROHIBITED_API_SHAPES) {
      expect(isProhibitedApiName(shape), shape).toBe(true);
    }

    const representativeSource = [
      "export interface InstallPluginRequest {}",
      "export type DynamicPluginLoader = () => void;",
      "export const registerPlugin = () => undefined;",
    ].join("\n");
    expect(collectExportedNames(representativeSource)).toEqual([
      "DynamicPluginLoader",
      "InstallPluginRequest",
      "registerPlugin",
    ]);
    expect(collectExportedNames(representativeSource).filter(isProhibitedApiName)).toEqual([
      "DynamicPluginLoader",
      "InstallPluginRequest",
      "registerPlugin",
    ]);

    const exportDeclarationSource = [
      "const installPlugin = () => undefined;",
      "interface DynamicPluginLoader {}",
      "export { installPlugin };",
      "export type { DynamicPluginLoader };",
      'export { registerPlugin } from "./registry.js";',
    ].join("\n");
    expect(collectExportedNames(exportDeclarationSource)).toEqual([
      "DynamicPluginLoader",
      "installPlugin",
      "registerPlugin",
    ]);
    expect(collectExportedNames(exportDeclarationSource).filter(isProhibitedApiName)).toEqual([
      "DynamicPluginLoader",
      "installPlugin",
      "registerPlugin",
    ]);

    for (const [file, expectedExports] of Object.entries(EXPECTED_SOURCE_EXPORTS)) {
      const exportedNames = collectExportedNames(
        readFileSync(resolve(process.cwd(), file), "utf8")
      );
      expect(exportedNames, file).toEqual([...expectedExports].sort());
      expect(exportedNames.filter(isProhibitedApiName), file).toEqual([]);
    }
  });

  it("cannot be expanded or rewritten through runtime registration", () => {
    expect(Object.isFrozen(PLUGIN_IDS)).toBe(true);
    expect(Object.isFrozen(PLUGIN_MANIFESTS)).toBe(true);
    for (const manifest of PLUGIN_MANIFESTS) {
      expect(Object.isFrozen(manifest)).toBe(true);
      expect(Object.isFrozen(manifest.contributions)).toBe(true);
      for (const contributionIds of Object.values(manifest.contributions)) {
        expect(Object.isFrozen(contributionIds)).toBe(true);
      }
      for (const service of manifest.contributions.services) {
        expect(Object.isFrozen(service)).toBe(true);
      }
      expect(Object.isFrozen(manifest.requirements)).toBe(true);
      expect(Object.isFrozen(manifest.settingsSchema)).toBe(true);
      for (const descriptor of manifest.settingsSchema) {
        expect(Object.isFrozen(descriptor)).toBe(true);
      }
    }

    expect(Reflect.set(PLUGIN_MANIFESTS, PLUGIN_MANIFESTS.length, PLUGIN_MANIFESTS[0])).toBe(false);
    expect(PLUGIN_MANIFESTS.map(({ id }) => id)).toEqual(DELIVERED_PLUGIN_IDS);
  });
});
