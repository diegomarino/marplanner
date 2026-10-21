import { createHash, randomUUID } from "node:crypto";
import { getDb } from "../../db/client";
import { isQuiesced, beginRequest, endRequest } from "../../backups/restore";
import type { SynchronizationPhase } from "../../../shared";
import {
  CalendarFeedFetchError,
  fetchIcs,
  fetchIcsResult,
  type FetchIcsDependencies,
} from "./fetch-ics";
import { parseIcs } from "./parse-ics";
import { reconcileExternalCalendar, recordUnchangedSynchronization } from "./reconcile";

export interface CalendarFeedDependencies extends FetchIcsDependencies {
  phaseDelayMs?: number;
}

interface RuntimeState {
  runId: string;
  phase: SynchronizationPhase;
  running: boolean;
  activePromise: Promise<void>;
}

const runtime = new Map<string, RuntimeState>();
const deleting = new Set<string>();
const replacing = new Set<string>();
const lifecycleVersions = new Map<string, number>();
/** UTC day each source was last parsed and reconciled. Feed rows are stored already expanded
 * within a window that moves with the clock, so an unchanged feed (304 or identical body) is
 * still fetched unconditionally and re-materialized once per day; after a restart the first
 * sync of each source does so too. */
const materializedDay = new Map<string, string>();
const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function getExternalSourceLifecycleVersion(sourceId: string): number {
  return lifecycleVersions.get(sourceId) ?? 0;
}

function advanceExternalSourceLifecycle(sourceId: string): void {
  lifecycleVersions.set(sourceId, getExternalSourceLifecycleVersion(sourceId) + 1);
}

export function isExternalSourceDeleting(sourceId: string): boolean {
  return deleting.has(sourceId);
}

export function isExternalSourceReplacing(sourceId: string): boolean {
  return replacing.has(sourceId);
}

export function beginExternalSourceReplacement(
  sourceId: string
): { active: Promise<void>; version: number } | null {
  if (deleting.has(sourceId) || replacing.has(sourceId)) return null;
  advanceExternalSourceLifecycle(sourceId);
  replacing.add(sourceId);
  return {
    active: runtime.get(sourceId)?.running
      ? runtime.get(sourceId)!.activePromise
      : Promise.resolve(),
    version: getExternalSourceLifecycleVersion(sourceId),
  };
}

export function finishExternalSourceReplacement(sourceId: string): void {
  runtime.delete(sourceId);
  materializedDay.delete(sourceId);
  replacing.delete(sourceId);
}

/** Claim deletion before the first await, so every later trigger observes it. */
export function beginExternalSourceDeletion(sourceId: string): Promise<void> | null {
  if (deleting.has(sourceId)) return null;
  advanceExternalSourceLifecycle(sourceId);
  deleting.add(sourceId);
  return runtime.get(sourceId)?.running ? runtime.get(sourceId)!.activePromise : Promise.resolve();
}

export function finishExternalSourceDeletion(sourceId: string): void {
  runtime.delete(sourceId);
  materializedDay.delete(sourceId);
  advanceExternalSourceLifecycle(sourceId);
  deleting.delete(sourceId);
}

function delay(milliseconds: number): Promise<void> {
  return milliseconds > 0
    ? new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
    : Promise.resolve();
}

async function runSynchronization(
  sourceId: string,
  dependencies: CalendarFeedDependencies
): Promise<void> {
  const state = runtime.get(sourceId);
  if (!state) return;
  const setPhase = async (phase: SynchronizationPhase): Promise<void> => {
    state.phase = phase;
    await delay(dependencies.phaseDelayMs ?? 0);
  };

  try {
    const source = getDb()
      .prepare(
        "SELECT feed_url, etag, last_modified, content_hash, last_success_at FROM calendar_external_sources WHERE id = ? AND enabled = 1"
      )
      .get(sourceId) as
      | {
          feed_url: string;
          etag: string | null;
          last_modified: string | null;
          content_hash: string | null;
          last_success_at: number | null;
        }
      | undefined;
    if (!source) throw new Error("external_source_unavailable");

    const now = Date.now();
    getDb()
      .prepare(
        "UPDATE calendar_external_sources SET last_attempt_at = ?, updated_at = ? WHERE id = ?"
      )
      .run(now, now, sourceId);
    await setPhase("requesting");
    await setPhase("downloading");
    const result = dependencies.transport
      ? (() =>
          fetchIcs(source.feed_url, dependencies).then((body) => ({
            kind: "modified" as const,
            body,
            contentHash: createHash("sha256").update(body).digest("hex"),
            etag: null,
            lastModified: null,
          })))()
      : fetchIcsResult(
          source.feed_url,
          materializedDay.get(sourceId) === utcDay(now)
            ? {
                etag: source.etag,
                lastModified: source.last_modified,
                contentHash: source.content_hash,
              }
            : {},
          dependencies
        );
    const fetched = await result;
    await setPhase("parsing");
    let parsed;
    if (fetched.kind === "modified") {
      try {
        parsed = parseIcs(fetched.body);
      } catch (error) {
        throw new Error("parse_failed", { cause: error });
      }
    }
    await setPhase("reconciling");
    try {
      if (parsed && fetched.kind === "modified") {
        reconcileExternalCalendar(sourceId, parsed, fetched);
        materializedDay.set(sourceId, utcDay(now));
      } else {
        if (source.last_success_at === null && fetched.kind === "not_modified")
          throw new CalendarFeedFetchError("unavailable");
        recordUnchangedSynchronization(sourceId, fetched.kind === "unchanged" ? fetched : {});
      }
    } catch (error) {
      if (error instanceof CalendarFeedFetchError) throw error;
      throw new Error("reconcile_failed", { cause: error });
    }
    await setPhase("succeeded");
  } catch (error) {
    const now = Date.now();
    const code =
      error instanceof CalendarFeedFetchError
        ? error.code
        : error instanceof Error &&
            (error.message === "parse_failed" || error.message === "reconcile_failed")
          ? error.message
          : "unavailable";
    getDb()
      .prepare(
        `UPDATE calendar_external_sources
         SET last_error_code = ?, consecutive_failures = consecutive_failures + 1,
             updated_at = ? WHERE id = ?`
      )
      .run(code, now, sourceId);
    await setPhase("failed");
  }
}

/** Starts the first tracer run without allowing a background rejection to escape. */
export function startExternalSourceSynchronization(
  sourceId: string,
  dependencies: CalendarFeedDependencies = {}
): Promise<void> {
  if (isQuiesced() || deleting.has(sourceId) || replacing.has(sourceId)) return Promise.resolve();
  const source = getDb()
    .prepare("SELECT enabled FROM calendar_external_sources WHERE id = ?")
    .get(sourceId) as { enabled: number } | undefined;
  if (source?.enabled !== 1) return Promise.resolve();
  const active = runtime.get(sourceId);
  if (active?.running) return active.activePromise;

  const placeholder = Promise.resolve();
  const state: RuntimeState = {
    runId: randomUUID(),
    phase: "requesting",
    running: true,
    activePromise: placeholder,
  };
  runtime.set(sourceId, state);
  // Manual triggers outlive their HTTP response; retain a restore drain slot until all writes settle.
  beginRequest();
  state.activePromise = runSynchronization(sourceId, dependencies)
    .catch(() => undefined)
    .finally(() => {
      state.running = false;
      endRequest();
    });
  return state.activePromise;
}

export function getExternalSourcePhase(sourceId: string): SynchronizationPhase | null {
  return runtime.get(sourceId)?.phase ?? null;
}
