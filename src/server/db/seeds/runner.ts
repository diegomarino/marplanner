import { existsSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getDb } from "../client";
import { runMigrations } from "../migrate";
import { beginSeedProfile, completeSeedProfile, type SeedProfileResult } from "./ownership";
import type { SeedContext, SeedMode, SeedModule, SeedRunReport, SeedRunRequest } from "./types";

const PUBLIC_SEED_FILE = /^seed-\d{3}-[a-z0-9][a-z0-9-]*\.(?:[cm]?[jt]s?)$/;
const PRIVATE_SEED_FILE = /^seed[a-z0-9_-]*-PRIVATE\.(?:[cm]?[jt]s?)$/;
const STABLE_MODULE_ID = /^[a-z][a-z0-9]*(?::[a-z0-9][a-z0-9-]*)+$/;

type SeedVisibility = "public" | "private";

interface DiscoveredModule {
  filePath: string;
  visibility: SeedVisibility;
  module: SeedModule;
}

export class SeedRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedRunnerError";
  }
}

export async function runSeedProfile(request: SeedRunRequest): Promise<SeedRunReport> {
  if (!request.disposableTarget) {
    throw new SeedRunnerError("Seed target must be explicitly designated disposable");
  }

  const nowMs = request.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new SeedRunnerError("Seed timestamp must be a non-negative integer");
  }

  try {
    runMigrations(request.migrationsDirectory);
  } catch {
    throw new SeedRunnerError("Seed migration failed");
  }

  const db = getDb();
  const asOfDate = resolveAsOfDate(db, request.asOfDate, nowMs);
  const modules = await discoverModules(request.mode, request.seedsDirectory);
  const marker = beginSeedProfile(db, { asOfDate, nowMs });
  const context: SeedContext = { db, asOfDate, nowMs };

  for (const module of modules) {
    await runModuleInTransaction(db, module, context);
  }

  completeSeedProfile(db, { asOfDate, nowMs });
  let privateModuleIndex = 0;
  return {
    mode: request.mode,
    asOfDate,
    moduleIds: modules.map((module) => {
      if (module.visibility === "public") return module.module.id;
      privateModuleIndex += 1;
      return `private:${String(privateModuleIndex).padStart(2, "0")}`;
    }),
    markerAction: reportMarkerAction(marker),
    status: "complete",
  };
}

async function discoverModules(
  mode: SeedMode,
  requestedDirectory?: string
): Promise<DiscoveredModule[]> {
  const seedsDirectory = requestedDirectory ?? resolve(process.cwd(), "seeds");
  if (!existsSync(seedsDirectory)) return [];

  const candidates = readdirSync(seedsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith("seed"))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

  const publicModules: { filePath: string; visibility: SeedVisibility }[] = [];
  const privateModules: { filePath: string; visibility: SeedVisibility }[] = [];
  for (const candidate of candidates) {
    const isPublic = PUBLIC_SEED_FILE.test(candidate.name);
    const isPrivate = PRIVATE_SEED_FILE.test(candidate.name);
    const visibility = candidate.name.includes("-PRIVATE") ? "private" : "public";
    if (isPublic && isPrivate) {
      throw new SeedRunnerError(`Ambiguous ${visibility} seed module filename`);
    }
    if (!isPublic && !isPrivate) {
      throw new SeedRunnerError(
        visibility === "private"
          ? "Invalid private seed module filename"
          : `Invalid public seed module filename: ${candidate.name}`
      );
    }
    const module = {
      filePath: resolve(seedsDirectory, candidate.name),
      visibility: isPublic ? ("public" as const) : ("private" as const),
    };
    if (isPublic) publicModules.push(module);
    else privateModules.push(module);
  }

  const selected = mode === "public" ? publicModules : [...publicModules, ...privateModules];

  const modules: DiscoveredModule[] = [];
  const ids = new Set<string>();
  for (const candidate of selected) {
    const module = await loadSeedModule(candidate.filePath, candidate.visibility);
    if (ids.has(module.id)) {
      throw new SeedRunnerError(
        `Duplicate seed module ID: ${safeModuleLabel(candidate.visibility, module.id)}`
      );
    }
    ids.add(module.id);
    modules.push({ ...candidate, module });
  }
  return modules;
}

async function loadSeedModule(filePath: string, visibility: SeedVisibility): Promise<SeedModule> {
  let imported: unknown;
  try {
    imported = await import(pathToFileURL(filePath).href);
  } catch {
    throw new SeedRunnerError(
      `Seed module could not be loaded: ${safeModuleLabel(visibility, basename(filePath))}`
    );
  }

  const candidate = (imported as { default?: unknown }).default;
  if (!isSeedModule(candidate)) {
    throw new SeedRunnerError(
      `Invalid seed module: ${safeModuleLabel(visibility, basename(filePath))}`
    );
  }
  return candidate;
}

function isSeedModule(candidate: unknown): candidate is SeedModule {
  if (!candidate || typeof candidate !== "object") return false;
  const value = candidate as Partial<SeedModule>;
  return (
    typeof value.id === "string" &&
    STABLE_MODULE_ID.test(value.id) &&
    typeof value.run === "function"
  );
}

async function runModuleInTransaction(
  db: SeedContext["db"],
  discovered: DiscoveredModule,
  context: SeedContext
): Promise<void> {
  db.exec("BEGIN IMMEDIATE");
  try {
    await discovered.module.run(context);
    db.exec("COMMIT");
  } catch {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The module failure remains the only operator-facing diagnostic.
    }
    throw new SeedRunnerError(
      `Seed module failed: ${safeModuleLabel(discovered.visibility, discovered.module.id)}`
    );
  }
}

function resolveAsOfDate(
  db: SeedContext["db"],
  supplied: string | undefined,
  nowMs: number
): string {
  if (supplied !== undefined) {
    if (!isStrictCalendarDate(supplied)) {
      throw new SeedRunnerError("--as-of must use a valid calendar date");
    }
    return supplied;
  }

  return householdDate(nowMs, householdTimeZone(db));
}

function householdTimeZone(db: SeedContext["db"]): string {
  try {
    const row = db
      .prepare("SELECT data FROM settings_objects WHERE object_name = 'locale'")
      .get() as { data?: unknown } | undefined;
    const parsed = typeof row?.data === "string" ? JSON.parse(row.data) : undefined;
    const timeZone =
      parsed && typeof parsed === "object"
        ? (parsed as { timezone?: unknown }).timezone
        : undefined;
    if (typeof timeZone === "string") {
      new Intl.DateTimeFormat("en", { timeZone });
      return timeZone;
    }
  } catch {
    // A fresh baseline has no locale object yet; use its documented default.
  }
  return "Europe/Madrid";
}

function householdDate(nowMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function isStrictCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function reportMarkerAction(marker: SeedProfileResult): "created" | "repair" | "rerun" {
  return marker.action === "completed" ? "rerun" : marker.action;
}

function safeModuleLabel(visibility: SeedVisibility, value: string): string {
  return visibility === "public" ? value : "private module";
}
