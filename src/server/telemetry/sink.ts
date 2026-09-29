import type { TelemetrySinkEnvelope } from "../../shared";

/** External-sink seam (FR-015) — a deploy-level, absent-by-default fan-out point
 * fed AFTER redaction+insert (pipeline: validate -> bound -> flood-check ->
 * redact -> insert -> sink fan-out). No built-in sink ships this module; the value here is the
 * field-restriction guarantee itself: a sink can only ever be handed a `TelemetrySinkEnvelope`,
 * a type that has NO usable `data` property (`data?: never`) — INV-07 as a compile-time
 * property, not a runtime filter that a future refactor could accidentally widen.
 * INV-08 (never a household setting): configuration is read from `process.env` only, lazily on
 * first ingest and cached thereafter via `getActiveSinks` (lazy loading) — NOT "at
 * process start", nothing runs eagerly at module load). There is no settings-table lookup
 * anywhere in this file and no UI surface reads or writes it.
 */

/** A registered external sink. `send` may be sync or async; both paths are fire-and-forget. */
export interface TelemetrySink {
  name: string;
  send(envelope: TelemetrySinkEnvelope): void | Promise<void>;
}

/** The deploy-level env var naming a comma-separated list of BUILT-IN sink names to enable.
 * Documented per D8 "declare-now, enforce-later" (ADR-016): the variable exists and is parsed,
 * but `BUILTIN_SINKS` below is intentionally empty this module, so any configured name resolves
 * to nothing and `loadSinksFromEnv` always returns `[]`. Absent (the default) is the common
 * case and is a pure no-op.
 */
const TELEMETRY_SINKS_ENV_VAR = "TELEMETRY_SINKS";

/** Built-in sink factories keyed by the name an operator may list in `TELEMETRY_SINKS`. Empty
 * this module by design (D8/FR-015: the seam ships, no real sink does) — a future slice adds
 * entries here, never changes the loader's shape.
 * `Object.create(null)` (a null-prototype registry): a plain `{}` literal resolves lookups through
 * `Object.prototype`, so a hostile/typo'd env value like `TELEMETRY_SINKS=constructor` or
 * `=toString` would resolve to an inherited function (`Object.prototype.toString`,
 * `.hasOwnProperty`, `.valueOf`, …) instead of `undefined` — a null-prototype object has no such
 * inherited members, so every lookup that isn't an own property is genuinely `undefined`.
 */
const BUILTIN_SINKS: Readonly<Record<string, () => TelemetrySink>> = Object.freeze(
  Object.create(null) as Record<string, () => TelemetrySink>
);

/** loadSinksFromEnv— pure read of `process.env[TELEMETRY_SINKS_ENV_VAR]`. Unset/blank (the
 * default) -> `[]`. A configured value is split on commas and each name looked up in
 * `BUILTIN_SINKS` via `Object.hasOwn` (own-property only — no prototype-chain names)
 * with a `typeof factory === "function"` guard; since that registry is empty this module, every
 * name is skipped and the result is still `[]`. A factory that itself throws is swallowed and
 * counted rather than propagated — never throws, never partially fails.
 */
export function loadSinksFromEnv(): TelemetrySink[] {
  const raw = process.env[TELEMETRY_SINKS_ENV_VAR];
  if (!raw || raw.trim().length === 0) return [];

  const names = raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  const sinks: TelemetrySink[] = [];
  for (const name of names) {
    if (!Object.hasOwn(BUILTIN_SINKS, name)) continue;
    const factory = BUILTIN_SINKS[name];
    if (typeof factory !== "function") continue;
    try {
      sinks.push(factory());
    } catch {
      sinkFailureCount += 1;
    }
    // An unrecognized name is silently skipped (no built-in ships this module) rather than
    // thrown, so a stale/forward-looking env value never crashes startup.
  }
  return sinks;
}

/** Module-level cache: computed lazily from the environment, on first use, then reused. */
let cachedSinks: TelemetrySink[] | null = null;

/** The active sink list for this process — env-loaded lazily on first call and cached
 * thereafter. TOTAL (defensive fallback): `loadSinksFromEnv` itself never throws (see above),
 * but this function guards regardless — if it ever did, a bare `cachedSinks = loadSinksFromEnv`
 * would leave `cachedSinks` `null` forever, re-attempting (and re-throwing) on every single
 * ingest call. Falling back to `[]` and counting the failure keeps the seam self-healing after
 * one bad attempt instead of poisoned for the life of the process.
 */
function getActiveSinks(): readonly TelemetrySink[] {
  if (cachedSinks === null) {
    try {
      cachedSinks = loadSinksFromEnv();
    } catch {
      cachedSinks = [];
      sinkFailureCount += 1;
    }
  }
  return cachedSinks;
}

/** Test-only seam: inject a fixed sink list (e.g. a fake sink), bypassing env loading. */
export function __setSinksForTests(sinks: TelemetrySink[]): void {
  cachedSinks = sinks;
}

/** Test-only seam: drop the cache so the next `getActiveSinks` call re-reads the env. */
export function __resetSinksForTests(): void {
  cachedSinks = null;
}

/** In-memory only, mirroring the flood-drop counter convention: no persistence, no retry. */
let sinkFailureCount = 0;

/** Test/diagnostic accessor — in-memory counter, not exposed by any route this module. */
export function getSinkFailureCount(): number {
  return sinkFailureCount;
}

/** Test-only reset — avoids cross-test sink-failure-count leakage (module-level state). */
export function __resetSinkFailureCountForTests(): void {
  sinkFailureCount = 0;
}

/** The post-insert fields a caller has on hand right after a successful write. Deliberately
 * carries NO `data` field at all (the sink input omits it) — `writeClientLog` must never hand the
 * sink module raw `data`, not even a value that only gets dropped internally; the earlier shape
 * that accepted-then-discarded `data` here was itself a leak surface.
 */
export type TelemetrySinkSourceEntry = TelemetrySinkEnvelope;

/** The typed 5-field projection (FR-015 / INV-07): currently the identity function, because
 * `TelemetrySinkSourceEntry` IS `TelemetrySinkEnvelope` — there is no wider shape to narrow from.
 * Kept as a named seam (rather than inlined) so a future caller with a richer source shape has
 * one obvious place to project through, and so `dispatchToActiveSinks` reads as "project, then
 * fan out" regardless of how the projection is implemented.
 */
export function projectToSinkEnvelope(entry: TelemetrySinkSourceEntry): TelemetrySinkEnvelope {
  const { level, component, message, receivedAt, eventId } = entry;
  return { level, component, message, receivedAt, eventId };
}

/** fanOutToSinks— dispatch to every active sink. Each sink's `send` is deferred with
 * `setImmediate` (to defer work — NOT `queueMicrotask`: a microtask still runs before
 * Node returns to the event loop/I/O, so it does not actually isolate the caller from a slow
 * synchronous `send` — measured, a 300ms sync sink added ~299ms to the real HTTP response
 * under `queueMicrotask` and only ~0.3ms under `setImmediate`, which runs in the NEXT event-loop
 * "check" phase, after pending I/O — including the response write — gets a turn). The insert has
 * already committed by the time any sink runs, preserving "insert -> sink fan-out" ordering
 * Inside the deferred callback: a sync throw or an async rejection is swallowed and
 * counted, never propagated into the request path. The `.catch` is attached synchronously, in
 * the same `setImmediate` callback tick `send` returns, so a rejected promise is never left
 * unhandled.
 */
export function fanOutToSinks(
  sinks: readonly TelemetrySink[],
  envelope: TelemetrySinkEnvelope
): void {
  for (const sink of sinks) {
    setImmediate(() => {
      try {
        const result = sink.send(envelope);
        if (result && typeof (result as Promise<void>).then === "function") {
          (result as Promise<void>).catch(() => {
            sinkFailureCount += 1;
          });
        }
      } catch {
        sinkFailureCount += 1;
      }
    });
  }
}

/** dispatchToActiveSinks— the convenience entry point `writeClientLog` calls: projects the
 * post-insert entry to the 5-field envelope, then fans it out to whatever `getActiveSinks`
 * currently holds (env-loaded by default, test-injectable via `__setSinksForTests`). Synchronous
 * and total: `getActiveSinks` cannot throw (see above) and `fanOutToSinks` only schedules
 * `setImmediate` callbacks, so this call itself cannot fail — callers still wrap it defensively
 * (index.ts).
 */
export function dispatchToActiveSinks(entry: TelemetrySinkSourceEntry): void {
  fanOutToSinks(getActiveSinks(), projectToSinkEnvelope(entry));
}
