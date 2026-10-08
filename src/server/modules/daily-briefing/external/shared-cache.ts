/** Shared daily block cache (* `daily_briefing_block_cache`) — one row per `(date, block_type)` for the three
 * EXTERNAL-source blocks (`weather`, `quoteOfDay`, `onThisDay`, `../blocks/`): FR-019 bounds
 * each source to at most one successful external call per date per household, reused across
 * every member's briefing generated for that date.
 * `createDailyBlockCache(date)` eager-loads every already-persisted row for `date` into memory
 * (v1's `createSharedCache` shape, kept simpler: no async construction — better-
 * sqlite3 reads are synchronous) so repeated `get` calls inside one generation pass never
 * re-query the DB. `set` is write-through: it updates the in-memory copy AND upserts the DB row
 * immediately, so a FRESH cache instance constructed later — a process restart, or simply a later
 * call within the same process — observes the persisted value without sharing the same in-memory
 * `Map` (proven by `tests/integration/daily-briefing-blocks-external.test.ts` "cache survives a
 * fresh cache-instance construction").
 */
import { getDb } from "../../../host-api";

export interface DailyBlockCache {
  /** `undefined` = not cached (never fetched, or fetched-and-failed — see `getOrFetchOnceDaily`). */
  get<T>(blockType: string): T | undefined;
  set<T>(blockType: string, data: T): void;
  /** Re-reads `blockType`'s row DIRECTLY from the DB, bypassing (and, on a hit, refreshing) the
   * in-memory copy — narrows the concurrent-miss window
   * between two overlapping generations (different members, same date). Returns `undefined` when
   * no row is persisted yet. See `getOrFetchOnceDaily`'s doc for how this is used.
   */
  refresh<T>(blockType: string): T | undefined;
}

interface BlockCacheRow {
  block_type: string;
  payload: string;
}

/** Builds a cache scoped to `date`, eager-loading every already-persisted row for that date. */
export function createDailyBlockCache(date: string): DailyBlockCache {
  const memory = new Map<string, unknown>();

  const rows = getDb()
    .prepare("SELECT block_type, payload FROM daily_briefing_block_cache WHERE date = ?")
    .all(date) as BlockCacheRow[];
  for (const row of rows) {
    memory.set(row.block_type, JSON.parse(row.payload));
  }

  return {
    get<T>(blockType: string): T | undefined {
      return memory.has(blockType) ? (memory.get(blockType) as T) : undefined;
    },
    refresh<T>(blockType: string): T | undefined {
      // A broken read (e.g. a dropped/corrupt table — same failure family `set` below
      // tolerates) degrades to "treat as not-yet-persisted" rather than crashing the block: the
      // caller falls through to invoking the fetcher, exactly as if this were a genuine miss.
      let row: { payload: string } | undefined;
      try {
        row = getDb()
          .prepare(
            "SELECT payload FROM daily_briefing_block_cache WHERE date = ? AND block_type = ?"
          )
          .get(date, blockType) as { payload: string } | undefined;
      } catch {
        return undefined;
      }
      if (!row) return undefined;
      const parsed = JSON.parse(row.payload) as T;
      memory.set(blockType, parsed);
      return parsed;
    },
    set<T>(blockType: string, data: T): void {
      memory.set(blockType, data);
      const payload = JSON.stringify(data);
      try {
        getDb()
          .prepare(
            `INSERT INTO daily_briefing_block_cache (date, block_type, payload, created_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(date, block_type) DO UPDATE SET
               payload = excluded.payload,
               created_at = excluded.created_at`
          )
          .run(date, blockType, payload, Date.now());
      } catch (err) {
        // v1 parity: a persist failure is swallowed-with-warn — the in-memory value still
        // serves the REST of this generation pass; only a later process restart would miss it.
        console.warn(
          `daily-briefing.shared-cache.persist-failed: date=${date} blockType=${blockType} error=${String(err)}`
        );
      }
    },
  };
}

/** `fetcher` combinator (v1 `api-cache.ts` `fetchOnceDaily` port, FR-019 allowFailure): a cache
 * HIT returns the cached value with zero calls to `fetcher` — even a legitimately cached `null`
 * (e.g. "no data today") counts as a hit, since `get` returns `undefined` only for a genuine
 * miss. On a miss, a DB refresh narrows — but does not close — the
 * concurrent-overlap window: two members' generations for the SAME date can each construct their
 * own `DailyBlockCache` instance around the same time, both observe a memory miss, and (without
 * this check) both invoke `fetcher` before either persists, doubling the "one external call per
 * source per day" budget FR-019 wants. Since this is a single-process runtime with no
 * cross-request locking, the cheap fix is to `refresh` (re-read the DB directly) right before
 * invoking `fetcher` — if another overlapping generation persisted a row in the meantime, this
 * call adopts it and skips the fetch entirely. This closes the common SEQUENTIAL-overlap window
 * (construct → other request's fetch-and-persist completes → this request's fetch) but is
 * honestly NOT a lock: two requests that both pass the `refresh` check at the same instant (a
 * true simultaneous race) can still both invoke `fetcher` — bounded at exactly 2 calls, and safe
 * because external content here is idempotent (the same day's quote/forecast/on-this-day, not a
 * side effect). On success the result (even `null`) IS cached, so a repeat call for the same date
 * never re-fetches; on a THROWN failure the result is NOT cached ("no negative caching", FR-019/
 * v1 behavior) — the very next generation pass retries the external call instead of
 * being stuck on a transient failure until the date rolls over.
 */
export async function getOrFetchOnceDaily<T>(
  cache: DailyBlockCache,
  blockType: string,
  fetcher: () => Promise<T | null>,
  epochAtInputRead = evictionEpoch
): Promise<T | null> {
  if (epochAtInputRead === evictionEpoch) {
    const cached = cache.get<T | null>(blockType);
    if (cached !== undefined) return cached;

    const justPersisted = cache.refresh<T | null>(blockType);
    if (justPersisted !== undefined) return justPersisted;
  }

  try {
    const data = await fetcher();
    if (evictionEpoch === epochAtInputRead) {
      cache.set(blockType, data);
    } else {
      // A weather-cache eviction ran after this input was gathered — the fetch was almost
      // certainly kicked off with the OLD (now-stale) location/tz, so persisting its result
      // would silently resurrect exactly what the eviction was trying to clear. Discard the
      // WRITE only: this call's own caller still gets the value it already computed (a single
      // in-flight generation seeing its own snapshot through is harmless and expected — this
      // guard protects every OTHER/future reader, not this one), and the next call for this
      // blockType/date observes a genuine cache miss and fetches fresh.
      console.warn(
        `daily-briefing.shared-cache.stale-write-discarded: blockType=${blockType} ` +
          `(an eviction ran after input gathering — the fetch's own input may be stale)`
      );
    }
    return data;
  } catch {
    return null;
  }
}

/** Eviction epoch: P1 TOCTOU): a MODULE-level counter, not a
 * per-cache-instance one — deliberately, because the race it closes spans both sides of that
 * boundary: `evictWeatherCache` is a GLOBAL operation (no `DailyBlockCache` instance of its
 * own), while the write it must invalidate happens via `getOrFetchOnceDaily`'s `cache.set` on
 * whichever instance a given `generateBriefing` call happens to be using. A per-instance counter
 * could not see an eviction triggered by a DIFFERENT instance (or by no instance at all, as here).
 * The race: (1) a generation's weather fetch starts under location A, in flight; (2) an admin
 * changes the location — `evictWeatherCache` deletes the row AND bumps this epoch; (3) the
 * in-flight fetch (still carrying location A's request) resolves and reaches `cache.set`,
 * which would otherwise silently RE-INSERT location A's forecast right after step 2 just
 * cleared it — defeating the eviction and leaking stale data to every subsequent reader for the
 * rest of that date. `getOrFetchOnceDaily` captures this value before fetching, or accepts the epoch
 * captured with immutable local inputs before earlier external awaits, and
 * discards the `cache.set` write (not the return value — see that function's own comment) if
 * the epoch moved during the await.
 */
let evictionEpoch = 0;

export function readBlockCacheEpoch(): number {
  return evictionEpoch;
}

/** Evicts every persisted `weather` cache row, ALL dates: a TRACED guarantee
 * FR-020/SC-005/SC-008, tracing WEATHER-INV-09/AC-08) requires that regeneration
 * — and only regeneration — reflects a new household weather location (OR timezone: tz is a
 * genuine INPUT to `getForecastPort(location, tz)`, `blocks/weather.ts`, not just a display
 * concern), with ZERO cache-hit ordering ever serving the PREVIOUS location's/tz's forecast.
 * FR-019's "one external call per source per day" budget (slice-local, traces nothing) is not
 * actually in tension with that once the cache is invalidated by the exact event that makes it
 * wrong: a weather LOCATION write, or a household LOCALE (timezone) write. Simplest correct
 * scope is unconditionally ALL dates (not just >= today) — a stale historical row is equally
 * wrong to keep, and a bare DELETE is cheap; no dates need reconstructing.
 * Called from `routes/settings.ts`'s `PUT /api/settings` handler, directly, after a successful
 * `weather` OR `locale` object write — a plain CORE-reaches-into-a-plugin-file import (the SAME
 * established pattern as `routes/daily-briefing.ts` importing `modules/daily-briefing/job.ts`
 * directly): Rule B (ADR-039 §2b′, `eslint.config.mjs`'s daily-briefing import-boundary zone)
 * restricts what code INSIDE `modules/daily-briefing/* ` may import OUTWARD — it does not
 * restrict CORE's inbound reach into a plugin's own exports, which routes/daily-briefing.ts
 * already exercises for the exact same module tree. No new event-bus signal was introduced for
 * this: `routes/settings.ts` emits no settings-changed event today, and adding one purely to
 * carry this one narrow signal would be a bigger surface than the fix warrants.
 * Known residual gap (documented, not fixed here): `weather.enabled`/`weather.endpoint` are
 * OPERATOR (deploy-time) config — `getOperatorConfig`/`process.env`-sourced, with NO write
 * surface anywhere in this codebase (no HTTP route ever sets them). A mid-day flip of either
 * requires a process restart to take effect at all, which already clears every in-memory
 * assumption; only the PERSISTED cache could theoretically outlive that, but since restarting is
 * mandatory for the flip to matter, this eviction function is not wired to any operator-config
 * write path — there isn't one to wire it to. See `../blocks/weather.ts`'s * `isWeatherSourceDisabled`/`hasInvalidConfiguredEndpoint` gates for where this limitation lives.
 */
export function evictWeatherCache(): void {
  evictionEpoch += 1;
  getDb().prepare("DELETE FROM daily_briefing_block_cache WHERE block_type = 'weather'").run();
}
