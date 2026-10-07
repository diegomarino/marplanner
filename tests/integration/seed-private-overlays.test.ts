import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { runSeedProfile } from "../../src/server/db/seeds/runner";
import { listExternalSources } from "../../src/server/modules/calendar";
import { useIsolatedDb } from "../helpers/db";

const AS_OF_DATE = "2026-09-23";
const NOW_MS = 1_790_121_600_000;
const PRIVATE_DEVICE_ID = ["placeholder", "device", "transport", "id"].join("-");
const PRIVATE_FEED_URL = ["https://calendar.example.invalid", "placeholder-marininos.ics"].join(
  "/"
);
const SETTINGS_MODULE_URL = pathToFileURL(
  join(process.cwd(), "src/server/modules/settings/index.ts")
).href;
const CALENDAR_MODULE_URL = pathToFileURL(
  join(process.cwd(), "src/server/modules/calendar/index.ts")
).href;
const tempDirectories: string[] = [];

describe("private seed overlays", () => {
  useIsolatedDb();

  afterEach(() => {
    for (const directory of tempDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("requires the public base before a private overlay can run", async () => {
    const privateOnlyDirectory = makeDirectory("mp-private-only-");
    writeFileSync(
      join(privateOnlyDirectory, "seed-900-printer-PRIVATE.mjs"),
      privatePrinterModuleSource()
    );

    await expect(
      runSeedProfile({
        mode: "private",
        asOfDate: AS_OF_DATE,
        nowMs: NOW_MS,
        disposableTarget: true,
        seedsDirectory: privateOnlyDirectory,
      })
    ).rejects.toThrow("Seed module failed: private module");
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM settings_objects").get()).toEqual({
      count: 0,
    });
  });

  // These synthetic overlays enforce the public prerequisite/order proof; they do not impose a
  // runner-wide ban on dependency-free private modules.
  it("runs the public base first, then private overlays lexically and without leaking values", async () => {
    const gitStatusBefore = gitStatus();
    const seedsDirectory = makeOverlayDirectory();

    const publicReport = await runSeedProfile({
      mode: "public",
      asOfDate: AS_OF_DATE,
      nowMs: NOW_MS,
      disposableTarget: true,
      seedsDirectory,
    });
    expect(publicReport).toEqual({
      mode: "public",
      asOfDate: AS_OF_DATE,
      moduleIds: ["public:base"],
      markerAction: "created",
      status: "complete",
    });

    const publicRead = await readPublicSurfaces();
    expect(publicRead.settingsResponse.statusCode).toBe(200);
    expect(publicRead.settingsResponse.body).toEqual(
      JSON.stringify({
        locale: { timezone: "Europe/Madrid", language: "es", weekStartDay: 1 },
        weather: { lat: null, lon: null },
        printer: { paperWidthDots: 576 },
        // APP-SETTINGS-REGISTRY-AC-06: printing active → cold-read fills empty transport defaults.
        printerTransport: {
          deviceId: "",
          name: "",
          serviceUuid: "",
          characteristicUuid: "",
        },
      })
    );
    expect(JSON.stringify(publicRead.settings)).not.toContain(PRIVATE_DEVICE_ID);
    expect(publicRead.calendarResponse.statusCode).toBe(200);
    expect(publicRead.calendar).toEqual([
      {
        id: "demo:calendar:source:public-base",
        name: "Public placeholder calendar",
        provider: "ics_generic",
        maskedUrl: "https://public.example.invalid/***",
        enabled: true,
        pollIntervalMin: 60,
        phase: null,
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastErrorCode: null,
        consecutiveFailures: 0,
        lastImportedCount: 0,
        lastSkippedCount: 0,
      },
    ]);

    const firstCapture = await captureConsole(() =>
      runSeedProfile({
        mode: "private",
        asOfDate: AS_OF_DATE,
        nowMs: NOW_MS,
        disposableTarget: true,
        seedsDirectory,
      })
    );
    const firstReport = firstCapture.value;

    expect(firstReport).toEqual({
      mode: "private",
      asOfDate: AS_OF_DATE,
      moduleIds: ["public:base", "private:01", "private:02"],
      markerAction: "rerun",
      status: "complete",
    });
    expectPersistedOverlayRows();

    const privateCalendarResponse = await readCalendarSurface();
    expect(privateCalendarResponse.statusCode).toBe(200);
    expect(JSON.parse(privateCalendarResponse.body)).toEqual([
      {
        id: "demo:calendar:source:marininos",
        name: "Mariñitos family calendar",
        provider: "ics_generic",
        maskedUrl: "https://calendar.example.invalid/***",
        enabled: true,
        pollIntervalMin: 60,
        phase: null,
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastErrorCode: null,
        consecutiveFailures: 0,
        lastImportedCount: 0,
        lastSkippedCount: 0,
      },
      {
        id: "demo:calendar:source:public-base",
        name: "Public placeholder calendar",
        provider: "ics_generic",
        maskedUrl: "https://public.example.invalid/***",
        enabled: true,
        pollIntervalMin: 60,
        phase: null,
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastErrorCode: null,
        consecutiveFailures: 0,
        lastImportedCount: 0,
        lastSkippedCount: 0,
      },
    ]);
    expect(privateCalendarResponse.body).not.toContain(PRIVATE_FEED_URL);

    const reportOutput = JSON.stringify(firstReport);
    const publicReadOutput = `${publicRead.settingsResponse.body}\n${publicRead.calendarResponse.body}\n${privateCalendarResponse.body}`;
    const gitOutput = `${gitStatus()}\n${gitLog()}`;
    expect(gitStatus()).toBe(gitStatusBefore);
    for (const value of [PRIVATE_DEVICE_ID, PRIVATE_FEED_URL]) {
      expect(publicReadOutput).not.toContain(value);
      expect(reportOutput).not.toContain(value);
      expect(firstCapture.consoleOutput).not.toContain(value);
      expect(gitOutput).not.toContain(value);
      expect(trackedArtifactsContaining(value)).toEqual([]);
      expect(committedArtifactsContaining(value)).toEqual([]);
    }
    expect(gitOutput).not.toContain("seed-900-printer-PRIVATE.mjs");
    expect(gitOutput).not.toContain("seed-910-calendar-PRIVATE.mjs");

    const secondCapture = await captureConsole(() =>
      runSeedProfile({
        mode: "private",
        asOfDate: AS_OF_DATE,
        nowMs: NOW_MS + 1,
        disposableTarget: true,
        seedsDirectory,
      })
    );
    const secondReport = secondCapture.value;
    expect(secondReport).toMatchObject({
      moduleIds: ["public:base", "private:01", "private:02"],
      markerAction: "rerun",
      status: "complete",
    });
    expect(JSON.stringify(secondReport)).not.toContain(PRIVATE_DEVICE_ID);
    expect(JSON.stringify(secondReport)).not.toContain(PRIVATE_FEED_URL);
    expect(secondCapture.consoleOutput).not.toContain(PRIVATE_DEVICE_ID);
    expect(secondCapture.consoleOutput).not.toContain(PRIVATE_FEED_URL);
    expectPersistedOverlayRows();
  });

  it("redacts private values from failed-module diagnostics", async () => {
    const seedsDirectory = makeDirectory("mp-private-failure-");
    writeFileSync(join(seedsDirectory, "seed-010-base.mjs"), publicBaseModuleSource());
    writeFileSync(
      join(seedsDirectory, "seed-900-printer-PRIVATE.mjs"),
      failingPrivateModuleSource()
    );

    let message = "";
    try {
      await runSeedProfile({
        mode: "private",
        asOfDate: AS_OF_DATE,
        nowMs: NOW_MS,
        disposableTarget: true,
        seedsDirectory,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }

    expect(message).toBe("Seed module failed: private module");
    expect(message).not.toContain(PRIVATE_DEVICE_ID);
    expect(message).not.toContain(PRIVATE_FEED_URL);
  });
});

function makeOverlayDirectory(): string {
  const directory = makeDirectory("mp-private-overlay-");
  writeFileSync(join(directory, "seed-010-base.mjs"), publicBaseModuleSource());
  writeFileSync(join(directory, "seed-900-printer-PRIVATE.mjs"), privatePrinterModuleSource());
  writeFileSync(join(directory, "seed-910-calendar-PRIVATE.mjs"), privateCalendarModuleSource());
  return directory;
}

function makeDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

async function readPublicSurfaces() {
  const deviceKey = "seed-private-overlay-public-read-key";
  const deviceKeyId = "seed-private-overlay-public-read-device";
  getDb()
    .prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    )
    .run(deviceKeyId, hashKey(deviceKey), NOW_MS);
  const { buildApp } = await import("../../src/server/app.ts");
  const app = await buildApp();
  try {
    const settingsResponse = await app.inject({
      method: "GET",
      url: "/api/settings",
      cookies: { mp_device_key: deviceKey },
    });
    const calendarResponse = await app.inject({
      method: "GET",
      url: "/api/calendar/external-sources",
      cookies: { mp_device_key: deviceKey },
    });
    return {
      settingsResponse,
      calendarResponse,
      settings: JSON.parse(settingsResponse.body) as Record<string, unknown>,
      calendar: JSON.parse(calendarResponse.body) as unknown[],
    };
  } finally {
    await app.close();
    getDb().prepare("DELETE FROM api_keys WHERE id = ?").run(deviceKeyId);
  }
}

async function readCalendarSurface() {
  const deviceKey = "seed-private-overlay-calendar-read-key";
  const deviceKeyId = "seed-private-overlay-calendar-read-device";
  getDb()
    .prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    )
    .run(deviceKeyId, hashKey(deviceKey), NOW_MS);
  const { buildApp } = await import("../../src/server/app.ts");
  const app = await buildApp();
  try {
    return await app.inject({
      method: "GET",
      url: "/api/calendar/external-sources",
      cookies: { mp_device_key: deviceKey },
    });
  } finally {
    await app.close();
    getDb().prepare("DELETE FROM api_keys WHERE id = ?").run(deviceKeyId);
  }
}

async function captureConsole<T>(operation: () => Promise<T>): Promise<{
  value: T;
  consoleOutput: string;
}> {
  const output: string[] = [];
  const methods = ["debug", "info", "log", "warn", "error"] as const;
  const spies = methods.map((method) =>
    vi.spyOn(console, method).mockImplementation((...args) => {
      output.push(args.map((argument) => String(argument)).join(" "));
    })
  );
  try {
    return { value: await operation(), consoleOutput: output.join("\n") };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

function expectPersistedOverlayRows(): void {
  expect(getDb().prepare("SELECT id, display_name, role FROM members ORDER BY id").all()).toEqual([
    { id: "demo:member:public-base", display_name: "Public placeholder", role: "parent" },
  ]);
  expect(
    getDb().prepare("SELECT object_name, data FROM settings_objects ORDER BY object_name").all()
  ).toEqual([
    { object_name: "printer", data: JSON.stringify({ paperWidthDots: 576 }) },
    {
      object_name: "printerTransport",
      data: JSON.stringify({
        deviceId: PRIVATE_DEVICE_ID,
        name: "Placeholder printer",
        serviceUuid: "00000000-0000-4000-8000-000000000001",
        characteristicUuid: "00000000-0000-4000-8000-000000000002",
      }),
    },
  ]);
  expect(
    getDb()
      .prepare(
        "SELECT id, name, provider, feed_url, enabled, poll_interval_min FROM calendar_external_sources ORDER BY id"
      )
      .all()
  ).toEqual([
    {
      id: "demo:calendar:source:marininos",
      name: "Mariñitos family calendar",
      provider: "ics_generic",
      feed_url: PRIVATE_FEED_URL,
      enabled: 1,
      poll_interval_min: 60,
    },
    {
      id: "demo:calendar:source:public-base",
      name: "Public placeholder calendar",
      provider: "ics_generic",
      feed_url: "https://public.example.invalid/base.ics",
      enabled: 1,
      poll_interval_min: 60,
    },
  ]);
  expect(listExternalSources()).toEqual([
    {
      id: "demo:calendar:source:marininos",
      name: "Mariñitos family calendar",
      provider: "ics_generic",
      maskedUrl: "https://calendar.example.invalid/***",
      enabled: true,
      pollIntervalMin: 60,
      phase: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastErrorCode: null,
      consecutiveFailures: 0,
      lastImportedCount: 0,
      lastSkippedCount: 0,
    },
    {
      id: "demo:calendar:source:public-base",
      name: "Public placeholder calendar",
      provider: "ics_generic",
      maskedUrl: "https://public.example.invalid/***",
      enabled: true,
      pollIntervalMin: 60,
      phase: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastErrorCode: null,
      consecutiveFailures: 0,
      lastImportedCount: 0,
      lastSkippedCount: 0,
    },
  ]);
}

function publicBaseModuleSource(): string {
  return `import { writeSettingsObject } from ${JSON.stringify(SETTINGS_MODULE_URL)};
import { upsertExternalSource } from ${JSON.stringify(CALENDAR_MODULE_URL)};

export default {
  id: "public:base",
  async run(context) {
    context.db.prepare("INSERT INTO members (id, display_name, role, created_at, updated_at) VALUES ('demo:member:public-base', 'Public placeholder', 'parent', ?, ?) ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, role = excluded.role, updated_at = excluded.updated_at").run(context.nowMs, context.nowMs);
    writeSettingsObject("printer", { paperWidthDots: 576 }, context.db);
    await upsertExternalSource({ id: "demo:calendar:source:public-base", name: "Public placeholder calendar", provider: "ics_generic", feedUrl: "https://public.example.invalid/base.ics", enabled: true, pollIntervalMin: 60 }, { lookup: async () => [{ address: "1.1.1.1", family: 4 }] });
  }
};`;
}

function privatePrinterModuleSource(): string {
  return `import { readEffectiveSettings, writeSettingsObject } from ${JSON.stringify(SETTINGS_MODULE_URL)};

export default {
  id: "private:printer",
  run(context) {
    const publicBase = context.db.prepare("SELECT COUNT(*) AS count FROM members WHERE id = 'demo:member:public-base'").get();
    const publicSettings = readEffectiveSettings(context.db);
    if (publicBase.count !== 1 || publicSettings.printer.paperWidthDots !== 576) throw new Error("public base required");
    const settings = writeSettingsObject("printerTransport", ${JSON.stringify({
      deviceId: PRIVATE_DEVICE_ID,
      name: "Placeholder printer",
      serviceUuid: "00000000-0000-4000-8000-000000000001",
      characteristicUuid: "00000000-0000-4000-8000-000000000002",
    })}, context.db);
    if (settings.printerTransport?.deviceId !== ${JSON.stringify(PRIVATE_DEVICE_ID)}) throw new Error("private printer configuration was not accepted");
  }
};`;
}

function privateCalendarModuleSource(): string {
  return `import { listExternalSources, upsertExternalSource } from ${JSON.stringify(CALENDAR_MODULE_URL)};
import { readEffectiveSettings } from ${JSON.stringify(SETTINGS_MODULE_URL)};

export default {
  id: "private:calendar",
  async run(context) {
    const settings = readEffectiveSettings(context.db);
    const publicSource = listExternalSources().find((source) => source.id === "demo:calendar:source:public-base");
    if (settings.printerTransport?.deviceId !== ${JSON.stringify(PRIVATE_DEVICE_ID)} || !publicSource || publicSource.maskedUrl !== "https://public.example.invalid/***") throw new Error("public base required");
    await upsertExternalSource({ id: "demo:calendar:source:marininos", name: "Mariñitos family calendar", provider: "ics_generic", feedUrl: ${JSON.stringify(PRIVATE_FEED_URL)}, enabled: true, pollIntervalMin: 60 }, { lookup: async () => [{ address: "1.1.1.1", family: 4 }] });
  }
};`;
}

function failingPrivateModuleSource(): string {
  return `export default {
  id: "private:failure",
  run() {
    throw new Error(${JSON.stringify(`${PRIVATE_DEVICE_ID} ${PRIVATE_FEED_URL}`)});
  }
};`;
}

function gitStatus(): string {
  return spawnSync("git", ["status", "--short"], {
    cwd: process.cwd(),
    encoding: "utf8",
  }).stdout.trim();
}

function gitLog(): string {
  return spawnSync("git", ["log", "-1", "--format=%B"], {
    cwd: process.cwd(),
    encoding: "utf8",
  }).stdout;
}

function trackedArtifactsContaining(value: string): string[] {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .filter((file) => readFileSync(file, "utf8").includes(value));
}

function committedArtifactsContaining(value: string): string[] {
  const result = spawnSync("git", ["grep", "-l", "-F", "--", value, "HEAD", "--"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  return result.status === 0 && result.stdout.trim() !== "" ? result.stdout.trim().split("\n") : [];
}
