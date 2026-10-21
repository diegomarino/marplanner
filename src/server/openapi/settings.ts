// Code-first OpenAPI: route schemas for the settings HTTP surface.
// These zod schemas are the single source of truth for docs/api/openapi.json
// (npm run generate:openapi). They document the HTTP contract; validation stays in
// src/server/modules/* so error envelopes remain byte-compatible.
import { z } from "zod";
import { component, defineRouteSchemas } from "./zod";
import { AuthForbidden, ErrorSchema, authenticationBackoffResponse } from "./common";

export const LocaleSettings = component(
  "LocaleSettings",
  z.strictObject({
    timezone: z.string().meta({ description: "IANA timezone, e.g. Europe/Madrid" }),
    language: z.enum(["es", "en"]),
    weekStartDay: z.literal([0, 1]).meta({ type: "integer" }),
  }),
  {
    description:
      "The complete canonical locale object — PUT is whole-object replace, so a write MUST carry all three fields (a language-only write would silently reset timezone/weekStartDay to defaults).",
  }
);

export const WeatherLocation = component(
  "WeatherLocation",
  z.strictObject({
    lat: z.number().min(-90).max(90).nullable().optional(),
    lon: z.number().min(-180).max(180).nullable().optional(),
    label: z
      .string()
      .max(80)
      .meta({
        description:
          "Optional free text; absent ⇒ no place label rendered; never reverse-geocoded (WEATHER-INV-08).",
      })
      .optional(),
  }),
  {
    description:
      "Both-or-neither non-null (partial pair rejected on write, WEATHER-INV-02); clearing writes both null as one unit.",
  }
);

export const PrinterSettings = component(
  "PrinterSettings",
  z.strictObject({ paperWidthDots: z.int().min(1) }),
  {
    description:
      "Persisted printer configuration only; it does not assert a connected or capable printer.",
  }
);

export const PrinterTransportSettings = component(
  "PrinterTransportSettings",
  z.strictObject({
    deviceId: z.string().min(1),
    name: z.string().min(1),
    serviceUuid: z.string().meta({ format: "uuid" }),
    characteristicUuid: z.string().meta({ format: "uuid" }),
  }),
  {
    description:
      "Private local transport configuration accepted only while Printing is active; it is not pairing, connectivity, capability, or activity state.",
  }
);

export const EffectiveSettings = component(
  "EffectiveSettings",
  z.strictObject({
    locale: LocaleSettings,
    weather: WeatherLocation.optional(),
    printer: PrinterSettings.optional(),
    printerTransport: PrinterTransportSettings.optional(),
  }),
  {
    description:
      "Core settings and active plugin-owned settings, with defaults filling unpersisted fields. Weather is omitted while its plugin is inactive.",
  }
);

export const WriteSettingsRequest = component(
  "WriteSettingsRequest",
  z.strictObject({
    object: z.enum(["locale", "weather", "printer", "printerTransport"]).meta({
      description:
        "Registered object name. Core locale is always available; inactive plugin-owned objects are not projected by GET /api/settings.\n",
    }),
    settings: z.looseObject({}).meta({
      description:
        "Complete replacement object. The Settings domain rejects unknown or invalid fields and writes a valid object atomically. For `printerTransport`, either all four fields are empty or `deviceId` and `name` are non-empty and `serviceUuid`/`characteristicUuid` are well-formed 128-bit UUIDs (8-4-4-4-12 hex, any version nibble), stored lower-case.\n",
    }),
  })
);

export const settingsSchemas = defineRouteSchemas({
  /** GET /api/settings */
  getSettings: {
    operationId: "getSettings",
    tags: ["settings"],
    summary: "Cold-readable effective settings (valid key only; no admin session/PIN).",
    description: "Available at cold boot with a valid key and no PIN (FR-008/009/011).",
    security: [{ deviceKeyCookie: [] }],
    response: {
      200: {
        description: "Effective settings including the fully-populated locale object.",
        content: { "application/json": { schema: EffectiveSettings } },
      },
      401: {
        description: "No/invalid key (PIN state is irrelevant to this outcome).",
        content: { "application/json": { schema: ErrorSchema } },
      },
      403: {
        description:
          "Revoked/expired credential or denied capability; code distinguishes credential loss from scope denial.",
        content: { "application/json": { schema: AuthForbidden } },
      },
      429: authenticationBackoffResponse,
    },
  },
  /** PUT /api/settings */
  putSettings: {
    operationId: "putSettings",
    tags: ["settings"],
    summary: "Replace one registered settings object.",
    description:
      "Validates the envelope and entire object before persisting it. Successful writes return the current effective settings projection. Unknown object names and invalid settings fail without a partial write. The UI PIN does not authorize this operation.\n",
    security: [{ deviceKeyCookie: [] }],
    body: WriteSettingsRequest,
    response: {
      200: {
        description: "Effective settings after the write.",
        content: { "application/json": { schema: EffectiveSettings } },
      },
      400: {
        description: "Invalid envelope, unknown object, or invalid settings.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      401: {
        description: "No/invalid device key.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      429: authenticationBackoffResponse,
      500: {
        description:
          "Unexpected persistence or server failure; details are not exposed in the response.",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  },
});
