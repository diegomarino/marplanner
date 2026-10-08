import { drizzle } from "drizzle-orm/better-sqlite3";
import type { FastifyInstance } from "fastify";
import type {
  EffectiveSettings,
  LocaleObject,
  PrinterSettings,
  PrinterTransportSettings,
} from "../../../shared";
import type { PluginId } from "../../../shared/plugins.js";
import { DEFAULT_PRINTER_SETTINGS } from "../../../shared/printing";
import { getDb, type DatabaseConnection } from "../../db/client";
import { settingsObjects } from "../../db/schema";
import { evictWeatherCache } from "../daily-briefing/external/shared-cache";
import { WEATHER_DEFAULTS, validateWeather } from "../weather";
import { settingsRoutes } from "../../routes/settings";

export class SettingsValidationError extends Error {
  constructor(message: "unknown_object" | "invalid_settings") {
    super(message);
    this.name = "SettingsValidationError";
  }
}

interface SettingsObjectDef<T extends Record<string, unknown>> {
  defaults: T;
  validate: (payload: unknown) => T | null;
  ownerPluginId: PluginId | null;
}

export type LifecycleEffectiveSettings = Pick<EffectiveSettings, "locale"> &
  Partial<Omit<EffectiveSettings, "locale">>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const LOCALE_DEFAULTS: LocaleObject = {
  timezone: "Europe/Madrid",
  language: "en",
  weekStartDay: 1,
};
const PRINTER_DEFAULTS: PrinterSettings = DEFAULT_PRINTER_SETTINGS;
const PRINTER_TRANSPORT_DEFAULTS: PrinterTransportSettings = {
  deviceId: "",
  name: "",
  serviceUuid: "",
  characteristicUuid: "",
};
const LOCALE_KEYS = new Set(["timezone", "language", "weekStartDay"]);
const PRINTER_KEYS = new Set(["paperWidthDots"]);
const PRINTER_TRANSPORT_KEYS = new Set(["deviceId", "name", "serviceUuid", "characteristicUuid"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidTimeZone(timezone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function validateLocale(payload: unknown): LocaleObject | null {
  if (!isPlainObject(payload) || Object.keys(payload).some((key) => !LOCALE_KEYS.has(key)))
    return null;
  const { timezone, language, weekStartDay } = payload;
  if (typeof timezone !== "string" || timezone.trim().length === 0 || !isValidTimeZone(timezone))
    return null;
  if (language !== "es" && language !== "en") return null;
  if (weekStartDay !== 0 && weekStartDay !== 1) return null;
  return { timezone, language, weekStartDay };
}

function validatePrinter(payload: unknown): PrinterSettings | null {
  if (!isPlainObject(payload) || Object.keys(payload).some((key) => !PRINTER_KEYS.has(key)))
    return null;
  return Number.isInteger(payload.paperWidthDots) && (payload.paperWidthDots as number) > 0
    ? { paperWidthDots: payload.paperWidthDots as number }
    : null;
}

function validatePrinterTransport(payload: unknown): PrinterTransportSettings | null {
  return validatePrinterTransportConfiguration(payload);
}

function validatePrinterTransportConfiguration(payload: unknown): PrinterTransportSettings | null {
  if (
    !isPlainObject(payload) ||
    Object.keys(payload).some((key) => !PRINTER_TRANSPORT_KEYS.has(key))
  )
    return null;
  const { deviceId, name, serviceUuid, characteristicUuid } = payload;
  if (
    typeof deviceId !== "string" ||
    typeof name !== "string" ||
    typeof serviceUuid !== "string" ||
    typeof characteristicUuid !== "string" ||
    !(
      [deviceId, name, serviceUuid, characteristicUuid].every((value) => value.length === 0) ||
      (deviceId.trim().length > 0 &&
        name.trim().length > 0 &&
        UUID.test(serviceUuid) &&
        UUID.test(characteristicUuid))
    )
  )
    return null;
  return {
    deviceId: deviceId.trim(),
    name: name.trim(),
    serviceUuid: serviceUuid.toLowerCase(),
    characteristicUuid: characteristicUuid.toLowerCase(),
  };
}

const REGISTRY = {
  locale: {
    defaults: LOCALE_DEFAULTS,
    validate: validateLocale,
    ownerPluginId: null,
  } as unknown as SettingsObjectDef<Record<string, unknown>>,
  weather: {
    defaults: WEATHER_DEFAULTS,
    validate: validateWeather,
    ownerPluginId: "weather",
  } as unknown as SettingsObjectDef<Record<string, unknown>>,
  printer: {
    defaults: PRINTER_DEFAULTS,
    validate: validatePrinter,
    ownerPluginId: "printing",
  } as unknown as SettingsObjectDef<Record<string, unknown>>,
  printerTransport: {
    defaults: PRINTER_TRANSPORT_DEFAULTS,
    validate: validatePrinterTransport,
    ownerPluginId: "printing",
  } as unknown as SettingsObjectDef<Record<string, unknown>>,
};

type RegisteredObjectName = keyof typeof REGISTRY;

function isRegisteredObjectName(name: unknown): name is RegisteredObjectName {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(REGISTRY, name);
}

function activePluginIds(db: DatabaseConnection): ReadonlySet<PluginId> {
  const lifecycleExists = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'plugin_activation_registry'"
    )
    .get();
  if (!lifecycleExists) return new Set();
  return new Set(
    (
      db
        .prepare(
          "SELECT plugin_id AS pluginId FROM plugin_activation_registry WHERE state = 'active'"
        )
        .all() as Array<{ pluginId: PluginId }>
    ).map(({ pluginId }) => pluginId)
  );
}

/** Insert registered defaults for one plugin without replacing retained configured values. */
export function ensurePluginSettingsDefaults(
  pluginId: PluginId,
  db: DatabaseConnection = getDb(),
  updatedAt: number = Date.now()
): void {
  const insert = db.prepare(
    `INSERT INTO settings_objects (object_name, data, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(object_name) DO NOTHING`
  );
  db.transaction(() => {
    for (const [objectName, definition] of Object.entries(REGISTRY)) {
      if (definition.ownerPluginId !== pluginId) continue;
      insert.run(objectName, JSON.stringify(definition.defaults), updatedAt);
    }
  })();
}

/** Return every core object plus validated objects owned by canonically active plugins. */
export function readEffectiveSettings(
  db: DatabaseConnection = getDb()
): LifecycleEffectiveSettings {
  const rows = drizzle(db).select().from(settingsObjects).all();
  const persisted = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    try {
      const value = JSON.parse(row.data);
      if (isPlainObject(value)) persisted.set(row.objectName, value);
    } catch {
      // Invalid persisted JSON falls back to the effective default rather than escaping this seam.
    }
  }
  const activePlugins = activePluginIds(db);
  const locale =
    validateLocale({ ...LOCALE_DEFAULTS, ...persisted.get("locale") }) ?? LOCALE_DEFAULTS;
  const weather = activePlugins.has("weather")
    ? (validateWeather(persisted.get("weather")) ?? WEATHER_DEFAULTS)
    : null;
  const printer = activePlugins.has("printing")
    ? (validatePrinter(persisted.get("printer")) ?? PRINTER_DEFAULTS)
    : null;
  const printerTransport = activePlugins.has("printing")
    ? (validatePrinterTransportConfiguration(persisted.get("printerTransport")) ??
      PRINTER_TRANSPORT_DEFAULTS)
    : null;
  return {
    locale,
    ...(weather === null ? {} : { weather }),
    ...(printer === null ? {} : { printer }),
    ...(printerTransport === null ? {} : { printerTransport }),
  };
}

/** Reusable whole-object replace seam for routes and seed modules. It validates before writing and
 * persists configuration only; printer transport configuration never creates capability,
 * connectivity, pairing, job, or activity state.
 */
export function writeSettingsObject(
  objectName: unknown,
  settings: unknown,
  db: DatabaseConnection = getDb()
): LifecycleEffectiveSettings {
  if (!isRegisteredObjectName(objectName)) throw new SettingsValidationError("unknown_object");
  const validated = REGISTRY[objectName].validate(settings);
  if (validated === null) throw new SettingsValidationError("invalid_settings");
  db.prepare(
    `INSERT INTO settings_objects (object_name, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(object_name) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
  ).run(objectName, JSON.stringify(validated), Date.now());
  if (objectName === "weather" || objectName === "locale") evictWeatherCache();
  return readEffectiveSettings(db);
}

/** Route registration remains an app concern; seed callers use the domain functions above. */
export async function settingsModule(app: FastifyInstance): Promise<void> {
  await settingsRoutes(app, {
    readEffectiveSettings,
    writeSettingsObject,
    isValidationError: (error) => error instanceof SettingsValidationError,
  });
}
